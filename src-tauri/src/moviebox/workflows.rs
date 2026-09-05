//! Approved preparation intents outlive the review dialog and application restarts.
use super::{now, strv, Runtime};
use crate::acquisition::AcquisitionState;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

impl Runtime {
    pub(super) fn queue_wait(
        &self,
        id: &str,
        destination: &str,
        window: &str,
        zone: &str,
        rule: Option<&Value>,
    ) -> Result<Value, String> {
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Workflow unavailable")?;
        if let Some(existing) = self.get("bundle-wait", id)? {
            return Ok(existing);
        }
        let saved = self
            .get("bundle-plan", id)?
            .ok_or("Bundle review expired")?;
        let media = self
            .get("media", strv(&saved["request"], "id"))?
            .ok_or("Title metadata missing")?;
        self.destination(&media, destination, None, "check.mkv")?;
        super::scheduler::window_open(window, zone, now())?;
        if !saved["plan"]["rows"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|r| matches!(strv(r, "status"), "ready" | "pending"))
        }) {
            return Err("No source candidates to prepare".into());
        }
        let mut intent = json!({"id":id,"title":saved["plan"]["title"],"season":saved["plan"]["season"],"mediaId":saved["request"]["id"],"destination":destination,"window":window,"timezone":zone,"state":"waiting","message":"Waiting for cloud preparation","nextCheckAt":now(),"revision":1});
        if let Some(rule) = rule {
            if self
                .get("rule", strv(rule, "id"))?
                .as_ref()
                .is_none_or(|r| r["revision"] != rule["revision"] || r["status"] == "paused")
            {
                return Err("Rule changed during this check".into());
            }
            intent["ruleId"] = rule["id"].clone();
            intent["ruleRevision"] = rule["revision"].clone();
        }
        self.set_plan_subtitles(id, rule)?;
        self.put("bundle-wait", id, &intent)?;
        self.log(
            "info",
            "bridge",
            "Bundle approved for background preparation",
            Some(id),
        )?;
        Ok(intent)
    }
    pub(super) fn control_wait(&self, id: &str, action: &str) -> Result<Value, String> {
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Workflow unavailable")?;
        if self.get("bundle", id)?.is_some() {
            return Err("Files are already queued; use the bundle download controls".into());
        }
        let mut intent = self
            .get("bundle-wait", id)?
            .ok_or("Preparation task not found")?;
        let state = match action {
            "pause" => "paused",
            "cancel" => "canceled",
            "resume" | "retry" => "waiting",
            _ => return Err("Unknown preparation action".into()),
        };
        intent["state"] = json!(state);
        intent["revision"] = json!(intent["revision"].as_u64().unwrap_or(0) + 1);
        intent["nextCheckAt"] = json!(now());
        intent["message"] = json!(match state {
            "paused" => "Preparation paused; provider cloud work may continue",
            "canceled" => "Local intent canceled; cloud files retained",
            _ => "Waiting for cloud preparation",
        });
        if matches!(action, "retry" | "resume") {
            // An explicit resume approves this intent independently of an edited/deleted rule.
            intent
                .as_object_mut()
                .ok_or("Invalid preparation")?
                .remove("ruleId");
            intent
                .as_object_mut()
                .ok_or("Invalid preparation")?
                .remove("ruleRevision");
        }
        if action == "retry" {
            let saved = self.get("bundle-plan", id)?.ok_or("Review missing")?;
            let binding: super::providers::Binding =
                serde_json::from_value(saved["binding"].clone()).unwrap_or_default();
            for pick in saved["picks"].as_array().into_iter().flatten() {
                let key = binding.task_id(strv(&pick["source"]["raw"], "infoHash"));
                self.put("cloud-retry", &key, &json!(true))?;
            }
        }
        self.put("bundle-wait", id, &intent)?;
        Ok(Value::Null)
    }
    // Called while workflow_commit is held. Reconcile the atomic queue commit after a crash,
    // and serialize final approval against pause/cancel and monitoring edits.
    fn reconcile_wait(&self, intent: &Value) -> Result<bool, String> {
        let id = strv(intent, "id");
        let Some(mut latest) = self.get("bundle-wait", id)? else {
            return Ok(true);
        };
        if latest["revision"] != intent["revision"] || latest["state"] != "waiting" {
            return Ok(true);
        }
        if self.get("bundle", id)?.is_some() {
            latest["state"] = json!("queued");
            latest["message"] = json!("Verified files already queued");
            self.put("bundle-wait", id, &latest)?;
            return Ok(true);
        }
        if let Some(rule_id) = intent["ruleId"].as_str() {
            if self
                .get("rule", rule_id)?
                .as_ref()
                .is_none_or(|r| r["status"] == "paused" || r["revision"] != intent["ruleRevision"])
            {
                latest["state"] = json!("paused");
                latest["message"] =
                    json!("Monitoring rule changed. Resume to continue this request manually.");
                self.put("bundle-wait", id, &latest)?;
                return Ok(true);
            }
        }
        Ok(false)
    }
    async fn advance_wait(&self, app: &AppHandle, intent: &Value) -> Result<(), String> {
        let id = strv(intent, "id");
        if !super::scheduler::window_open(strv(intent, "window"), strv(intent, "timezone"), now())?
        {
            return Ok(());
        }
        {
            let _guard = self
                .workflow_commit
                .lock()
                .map_err(|_| "Workflow unavailable")?;
            if self.reconcile_wait(intent)? {
                return Ok(());
            }
        }
        let result = self.prepare_bundle(id).await;
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Workflow unavailable")?;
        if self.reconcile_wait(intent)? {
            return Ok(());
        }

        // Pause/cancel changes revision while network I/O is in flight. Never enqueue stale intent.
        let mut latest = self
            .get("bundle-wait", id)?
            .ok_or("Preparation intent removed")?;
        if latest["revision"] != intent["revision"] || strv(&latest, "state") != "waiting" {
            return Ok(());
        }
        latest["nextCheckAt"] = json!(now() + 30_000);
        match result {
            Err(error) => {
                latest["message"] = json!(error);
                latest["state"] = json!("needs_attention");
            }
            Ok(plan) => {
                let rows = plan["rows"].as_array().ok_or("Invalid bundle rows")?;
                let pending = rows.iter().filter(|r| r["status"] == "pending").count();
                let ready = rows.iter().filter(|r| r["status"] == "ready").count();
                latest["message"] = json!(format!(
                    "{ready} files verified · {pending} waiting for metadata"
                ));
                let saved = self.get("bundle-plan", id)?.ok_or("Review missing")?;
                let binding =
                    serde_json::from_value::<super::providers::Binding>(saved["binding"].clone())
                        .unwrap_or_default();
                let failed = saved["picks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| {
                        self.get(
                            "cloud-task",
                            &binding.task_id(strv(&p["source"]["raw"], "infoHash")),
                        )
                        .ok()
                        .flatten()
                    })
                    .find(|t| t["phase"] == "error");
                if let Some(task) = failed {
                    latest["state"] = json!("needs_attention");
                    latest["message"] = task["message"].clone();
                } else if pending == 0 {
                    if ready > 0 {
                        self.enqueue_bundle(
                            app,
                            &app.state::<AcquisitionState>(),
                            id,
                            strv(intent, "destination"),
                            strv(intent, "window"),
                            strv(intent, "timezone"),
                        )?;
                        latest["state"] = json!("queued");
                        latest["message"] =
                            json!("Verified files queued; unmatched episodes remain unresolved");
                    } else {
                        latest["state"] = json!("needs_attention");
                        latest["message"] =
                            json!("No unambiguous episode files found. Review other sources.");
                    }
                }
            }
        }
        self.put("bundle-wait", id, &latest)?;
        let _ = app.emit("movibox://backend-changed", ());
        Ok(())
    }
}
pub(super) fn start(runtime: Runtime, app: AppHandle) {
    super::subtitles::start(runtime.clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            for intent in runtime
                .list("bundle-wait")
                .unwrap_or_default()
                .into_iter()
                .filter(|v| {
                    v["state"] == "waiting" && v["nextCheckAt"].as_i64().unwrap_or(0) <= now()
                })
            {
                if let Err(error) = runtime.advance_wait(&app, &intent).await {
                    let id = strv(&intent, "id");
                    let _ = runtime.log("error", "bridge", &error, Some(id));
                    if let Ok(_guard) = runtime.workflow_commit.lock() {
                        if let Ok(Some(mut latest)) = runtime.get("bundle-wait", id) {
                            if latest["revision"] == intent["revision"]
                                && latest["state"] == "waiting"
                            {
                                latest["state"] = json!("needs_attention");
                                latest["message"] = json!(error);
                                let _ = runtime.put("bundle-wait", id, &latest);
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::moviebox::tests::test_runtime;
    #[test]
    fn approval_survives_restart_and_canceled_revision_cannot_commit() {
        let path = std::env::temp_dir().join(format!("workflow-{}.sqlite", uuid::Uuid::new_v4()));
        let runtime = test_runtime(&path);
        runtime
            .put("media", "owned", &json!({"title":"Owned"}))
            .unwrap();
        runtime.put("bundle-plan","review",&json!({"request":{"id":"owned"},"plan":{"title":"Owned","season":1,"rows":[{"status":"pending"}]}})).unwrap();
        let destination = path.with_extension("downloads");
        let intent = runtime
            .queue_wait(
                "review",
                destination.to_str().unwrap(),
                "Any time",
                "UTC",
                None,
            )
            .unwrap();
        drop(runtime);
        let runtime = test_runtime(&path);
        assert_eq!(
            runtime.get("bundle-wait", "review").unwrap().unwrap(),
            intent
        );
        runtime.control_wait("review", "cancel").unwrap();
        assert!(runtime.reconcile_wait(&intent).unwrap());
        assert!(runtime.get("bundle", "review").unwrap().is_none());
        drop(runtime);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn changed_rules_pause_intents_and_existing_queue_commit_is_recovered() {
        let runtime = test_runtime(std::path::Path::new(":memory:"));
        let intent =
            json!({"id":"review","state":"waiting","revision":1,"ruleId":"rule","ruleRevision":1});
        runtime.put("rule", "rule", &json!({"revision":2})).unwrap();
        runtime.put("bundle-wait", "review", &intent).unwrap();
        assert!(runtime.reconcile_wait(&intent).unwrap());
        assert_eq!(
            runtime.get("bundle-wait", "review").unwrap().unwrap()["state"],
            "paused"
        );
        runtime.control_wait("review", "resume").unwrap();
        let resumed = runtime.get("bundle-wait", "review").unwrap().unwrap();
        assert!(resumed.get("ruleId").is_none());
        assert!(!runtime.reconcile_wait(&resumed).unwrap());
        runtime
            .put("bundle", "review", &json!({"id":"review"}))
            .unwrap();
        assert!(runtime.reconcile_wait(&resumed).unwrap());
        assert_eq!(
            runtime.get("bundle-wait", "review").unwrap().unwrap()["state"],
            "queued"
        );
        assert!(runtime.control_wait("review", "cancel").is_err());
    }
}
