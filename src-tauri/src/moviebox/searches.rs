//! Manual discovery survives navigation and restart; completion never approves acquisition.
use super::{now, strv, Runtime};
use crate::acquisition::AcquisitionState;
use futures_util::future::{AbortHandle, Abortable};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

impl Runtime {
    pub(super) fn create_search(&self, input: &Value) -> Result<Value, String> {
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Search store unavailable")?;
        let request = &input["request"];
        let media = self
            .get("media", strv(request, "id"))?
            .ok_or("Open the title before finding sources")?;
        let kind = strv(input, "kind");
        let request = match kind {
            "bundle" => serde_json::to_value(
                serde_json::from_value::<super::bridge::BundleRequest>(request.clone())
                    .map_err(|_| "Invalid bundle request")?,
            )
            .map_err(|_| "Invalid bundle request")?,
            "sources" => {
                json!({"id":media["id"],"kind":media["kind"],"season":request["season"],"episode":request["episode"],"quality":request["quality"],"language":request["language"]})
            }
            _ => return Err("Unknown search type".into()),
        };
        let preferences = self.prefs()?;
        let context = json!({"provider":preferences["defaultProvider"],"preference":preferences["sourcePreference"],"quality":preferences["quality"],"language":preferences["language"]});
        let mut existing = self.list("search-job")?;
        existing.sort_by_key(|s| std::cmp::Reverse(s["createdAt"].as_i64().unwrap_or(0)));
        if let Some(found) = existing.iter().find(|s| {
            s["kind"] == kind
                && s["request"] == request
                && s["context"] == context
                && (matches!(strv(s, "state"), "queued" | "running")
                    || input["force"] != true
                        && s["state"] == "complete"
                        && s["updatedAt"].as_i64().unwrap_or(0) > now() - 30 * 60_000)
        }) {
            return self.search_result(strv(found, "id"));
        }
        if existing
            .iter()
            .filter(|s| matches!(strv(s, "state"), "queued" | "running"))
            .count()
            >= 10
        {
            return Err("Ten searches are already queued. Finish or cancel one first.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let task = json!({"id":id,"kind":kind,"mediaId":media["id"],"title":media["title"],"request":request,"context":context,"destination":input["destination"],"state":"queued","message":"Waiting to search sources","createdAt":now(),"updatedAt":now()});
        self.put("search-job", &id, &task)?;
        for old in existing
            .iter()
            .filter(|s| !matches!(strv(s, "state"), "queued" | "running"))
            .skip(49)
        {
            self.remove("search-job", strv(old, "id"))?;
        }
        Ok(task)
    }
    pub(super) fn search_result(&self, id: &str) -> Result<Value, String> {
        let mut task = self.get("search-job", id)?.ok_or("Search not found")?;
        if task["kind"] == "bundle" && task["state"] == "complete" {
            if let Ok(plan) = self.bundle_plan(strv(&task["result"], "id")) {
                task["result"] = plan;
            }
        }
        Ok(task)
    }
    pub(super) fn public_searches(&self) -> Result<Vec<Value>, String> {
        let mut tasks = self.list("search-job")?;
        tasks.sort_by_key(|s| std::cmp::Reverse(s["createdAt"].as_i64().unwrap_or(0)));
        for task in &mut tasks {
            if let Some(v) = task.as_object_mut() {
                v.remove("result");
                v.remove("context");
            }
        }
        Ok(tasks)
    }
    pub(super) fn cancel_background_search(&self, id: &str) -> Result<(), String> {
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Search store unavailable")?;
        let mut task = self.get("search-job", id)?.ok_or("Search not found")?;
        if matches!(strv(&task, "state"), "queued" | "running") {
            task["state"] = json!("canceled");
            task["message"] = json!("Canceled by you");
            task["updatedAt"] = json!(now());
            self.put("search-job", id, &task)?;
            if let Some(handle) = self
                .search_workers
                .lock()
                .map_err(|_| "Search worker unavailable")?
                .remove(id)
            {
                handle.abort();
            }
        }
        Ok(())
    }
    pub(super) fn finish_search(
        &self,
        id: &str,
        result: Result<Value, String>,
    ) -> Result<(), String> {
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Search store unavailable")?;
        let mut task = self.get("search-job", id)?.ok_or("Search not found")?;
        if !matches!(strv(&task, "state"), "queued" | "running") {
            return Ok(());
        }
        match result {
            Ok(result) => {
                task["result"] = result;
                task["state"] = json!("complete");
                task["message"] =
                    json!("Sources ready to review. Nothing downloaded automatically.");
            }
            Err(error) => {
                task["state"] = json!("error");
                task["message"] = json!(error);
            }
        }
        task["updatedAt"] = json!(now());
        self.put("search-job", id, &task)?;
        self.log(
            if task["state"] == "error" {
                "warning"
            } else {
                "info"
            },
            "search",
            strv(&task, "message"),
            Some(id),
        )
    }
    pub(super) fn recover_searches(&self) -> Result<(), String> {
        for mut task in self.list("search-job")? {
            if task["state"] == "running" {
                task["state"] = json!("queued");
                task["message"] = json!("Resuming search after restart");
                self.put("search-job", strv(&task, "id"), &task)?;
            }
        }
        Ok(())
    }
    async fn execute_search(&self, app: &AppHandle, task: &Value) -> Result<Value, String> {
        let r = &task["request"];
        if task["kind"] == "bundle" {
            let request = serde_json::from_value(r.clone()).map_err(|_| "Invalid saved search")?;
            let plan = self
                .plan_bundle(request, &app.state::<AcquisitionState>())
                .await?;
            serde_json::to_value(plan).map_err(|_| "Could not save bundle review".into())
        } else {
            self.search_sources(
                strv(r, "id"),
                strv(r, "kind"),
                r["season"].as_i64().map(|n| n as i32),
                r["episode"].as_i64().map(|n| n as i32),
                strv(r, "quality"),
                strv(r, "language"),
            )
            .await
        }
    }
}
pub(super) fn start(runtime: Runtime, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = runtime.recover_searches();
        loop {
            let mut tasks = runtime.list("search-job").unwrap_or_default();
            tasks.sort_by_key(|t| t["createdAt"].as_i64().unwrap_or(0));
            for mut task in tasks.into_iter().filter(|t| t["state"] == "queued") {
                let id = strv(&task, "id").to_owned();
                let Ok(_guard) = runtime.workflow_commit.lock() else {
                    break;
                };
                let Ok(mut workers) = runtime.search_workers.lock() else {
                    break;
                };
                if workers.len() >= 2 {
                    break;
                }
                if runtime
                    .get("search-job", &id)
                    .ok()
                    .flatten()
                    .is_none_or(|t| t["state"] != "queued")
                {
                    continue;
                }
                let (handle, registration) = AbortHandle::new_pair();
                workers.insert(id.clone(), handle);
                task["state"] = json!("running");
                task["message"] = json!("Searching sources in the background…");
                let _ = runtime.put("search-job", &id, &task);
                let r = runtime.clone();
                let a = app.clone();
                tauri::async_runtime::spawn(async move {
                    let work = async {
                        tokio::time::timeout(
                            std::time::Duration::from_secs(300),
                            r.execute_search(&a, &task),
                        )
                        .await
                        .map_err(|_| {
                            "Search timed out; results can be retried without changing downloads"
                                .to_string()
                        })?
                    };
                    if let Ok(result) = Abortable::new(work, registration).await {
                        let _ = r.finish_search(&id, result);
                    }
                    if let Ok(mut workers) = r.search_workers.lock() {
                        workers.remove(&id);
                    }
                    let _ = a.emit("movibox://backend-changed", ());
                });
                let _ = app.emit("movibox://backend-changed", ());
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_restart_and_cancel_do_not_approve_or_duplicate_searches() {
        let path = std::env::temp_dir().join(format!("search-{}.sqlite", uuid::Uuid::new_v4()));
        let runtime = crate::moviebox::tests::test_runtime(&path);
        runtime
            .put(
                "media",
                "owned",
                &json!({"id":"owned","kind":"series","title":"Owned"}),
            )
            .unwrap();
        let input = json!({"kind":"bundle","request":{"id":"owned","season":1,"episodes":[1,2]},"destination":"/tmp/owned"});
        let mut task = runtime.create_search(&input).unwrap();
        let id = strv(&task, "id").to_owned();
        assert_eq!(runtime.create_search(&input).unwrap()["id"], id);
        task["state"] = json!("running");
        runtime.put("search-job", &id, &task).unwrap();
        drop(runtime);
        let recovered = crate::moviebox::tests::test_runtime(&path);
        recovered.recover_searches().unwrap();
        assert_eq!(
            recovered.get("search-job", &id).unwrap().unwrap()["state"],
            "queued"
        );
        recovered.cancel_background_search(&id).unwrap();
        recovered
            .finish_search(&id, Ok(json!({"id":"late-plan"})))
            .unwrap();
        assert_eq!(
            recovered.get("search-job", &id).unwrap().unwrap()["state"],
            "canceled"
        );
        let next = recovered.create_search(&input).unwrap();
        assert_ne!(next["id"], id);
        recovered
            .finish_search(strv(&next, "id"), Ok(json!({"id":"ready-plan"})))
            .unwrap();
        assert_eq!(recovered.create_search(&input).unwrap()["id"], next["id"]);
        assert!(recovered.list("bundle").unwrap().is_empty());
        assert!(recovered.list("bundle-wait").unwrap().is_empty());
        assert!(recovered
            .public_searches()
            .unwrap()
            .iter()
            .all(|s| s.get("result").is_none()));
        drop(recovered);
        std::fs::remove_file(path).unwrap();
    }
}
