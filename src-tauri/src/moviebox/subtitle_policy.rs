use super::{flag, now, strv, Runtime};
use crate::acquisition::{AcquisitionJob, AcquisitionState};
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn languages(value: &Value) -> Result<Vec<String>, String> {
    let values = value
        .as_array()
        .ok_or("Choose at least one subtitle language")?;
    let mut result = Vec::new();
    for v in values {
        let code = super::bridge::matching::language_code(v.as_str().unwrap_or(""));
        if !["en", "fr", "es", "pt", "de", "it", "ja", "ko"].contains(&code.as_str()) {
            return Err("Unsupported subtitle language".into());
        }
        if !result.contains(&code) {
            result.push(code);
        }
    }
    if result.is_empty() || result.len() > 4 {
        return Err("Choose one to four subtitle languages".into());
    }
    Ok(result)
}

pub(super) fn sidecar_exists(path: &str, lang: &str) -> bool {
    ["srt", "vtt", "ass"].iter().any(|ext| {
        Path::new(path)
            .with_extension(format!("{lang}.{ext}"))
            .is_file()
    })
}

fn rule_matches_video(rule: &Value, job: &AcquisitionJob) -> bool {
    if job.status != "done" || job.media_id != strv(rule, "mediaId") {
        return false;
    }
    if job.media_type == "movie" {
        return true;
    }
    let season = rule["season"].as_i64().unwrap_or(0);
    if season != 0 && job.season.map(i64::from) != Some(season) {
        return false;
    }
    let selected = rule["episodes"].as_array().cloned().unwrap_or_default();
    selected.is_empty()
        || super::bridge::job_episodes(job).iter().any(|episode| {
            selected
                .iter()
                .any(|n| n.as_i64() == Some(i64::from(*episode)))
        })
}

impl Runtime {
    pub(super) fn queue_rule_subtitles(
        &self,
        rule: &Value,
        jobs: &[AcquisitionJob],
        retry_failed: bool,
    ) -> Result<Value, String> {
        let policy = self.subtitle_policy(Some(rule))?;
        let mut queued = 0;
        let mut missing = 0;
        let mut videos = 0;
        if flag(rule, "subtitleExisting") && flag(&policy, "enabled") {
            let files: std::collections::HashMap<String, Value> = self
                .list("library")?
                .into_iter()
                .map(|file| (strv(&file, "id").to_owned(), file))
                .collect();
            for job in jobs.iter().filter(|job| rule_matches_video(rule, job)) {
                let mut job = job.clone();
                if let Some(file) = files.get(&job.id) {
                    job.path = strv(file, "path").into();
                }
                if !Path::new(&job.path).is_file() {
                    missing += 1;
                    continue;
                }
                videos += 1;
                for lang in policy["languages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    queued += usize::from(self.queue_subtitle_task(
                        &job,
                        lang,
                        &policy,
                        retry_failed,
                        true,
                    )?);
                }
            }
        }
        Ok(json!({"queued":queued,"videos":videos,"missing":missing}))
    }

    pub(super) fn subtitle_policy(&self, rule: Option<&Value>) -> Result<Value, String> {
        let prefs = self.prefs()?;
        let mode = rule.map(|r| strv(r, "subtitleMode")).unwrap_or("global");
        let (enabled, selected) = match mode {
            "off" => (false, vec![]),
            "custom" => (true, languages(&rule.unwrap()["subtitleLanguages"])?),
            "global" | "" => (
                flag(&prefs, "subtitlesEnabled"),
                languages(&json!([prefs["subtitleLanguage"]
                    .as_str()
                    .unwrap_or("English")]))?,
            ),
            _ => return Err("Unknown subtitle policy".into()),
        };
        Ok(
            json!({"enabled":enabled,"languages":selected,"exactOnly":flag(&prefs,"subtitleExactOnly"),"addons":prefs["subtitleAddons"].as_bool().unwrap_or(true),"ruleId":rule.map(|r|&r["id"])}),
        )
    }

    pub(super) fn set_plan_subtitles(&self, id: &str, rule: Option<&Value>) -> Result<(), String> {
        let mut saved = self
            .get("bundle-plan", id)?
            .ok_or("Bundle review expired")?;
        saved["subtitlePolicy"] = self.subtitle_policy(rule)?;
        if let Some(rule) = rule {
            saved["ruleId"] = rule["id"].clone();
        } else if let Some(object) = saved.as_object_mut() {
            object.remove("ruleId");
        }
        self.put("bundle-plan", id, &saved)
    }

    pub(super) fn queue_subtitle_task(
        &self,
        job: &AcquisitionJob,
        lang: &str,
        policy: &Value,
        repair: bool,
        library: bool,
    ) -> Result<bool, String> {
        let _guard = self
            .subtitle_commit
            .lock()
            .map_err(|_| "Subtitle queue unavailable")?;
        let id = format!("{}:{lang}", job.id);
        if let Some(task) = self.get("subtitle-job", &id)? {
            if !repair || matches!(strv(&task, "state"), "queued" | "running" | "retrying") {
                return Ok(false);
            }
            if task["quotaUntil"].as_i64().unwrap_or(0) > now() {
                return Ok(false);
            }
            if task["state"] == "done"
                && (sidecar_exists(&job.path, lang) || strv(&task, "message").contains("embedded"))
            {
                return Ok(false);
            }
        }
        self.put("subtitle-job", &id, &json!({"id":id,"jobId":job.id,"language":lang,"state":"queued","message":"Waiting to find missing subtitles","nextCheckAt":now(),"attempts":0,"policy":policy,"videoPath":job.path,"library":library,"revision":uuid::Uuid::new_v4().to_string()}))?;
        self.subtitle_wake.notify_one();
        Ok(true)
    }

    pub(super) fn find_subtitles(
        &self,
        acquisition: &AcquisitionState,
        input: &Value,
    ) -> Result<Value, String> {
        let id = strv(input, "id");
        let selected = languages(&input["languages"])?;
        let mut policy = self.subtitle_policy(None)?;
        policy["enabled"] = json!(true);
        policy["languages"] = json!(selected);
        let mut jobs = match strv(input, "target") {
            "bundle" => {
                self.get("bundle", id)?.ok_or("Bundle not found")?;
                acquisition
                    .list_jobs()?
                    .into_iter()
                    .filter(|j| j.source_context["bundleId"] == id)
                    .collect::<Vec<_>>()
            }
            "job" | "library" => vec![acquisition
                .load_job(id)?
                .ok_or("Downloaded video not found")?],
            _ => return Err("Unknown subtitle target".into()),
        };
        let library = strv(input, "target") == "library";
        if library {
            let file = self.get("library", id)?.ok_or("Library entry not found")?;
            jobs[0].path = strv(&file, "path").into();
        }
        let mut queued = 0;
        let mut available = 0;
        for job in jobs
            .iter()
            .filter(|j| j.status == "done" && Path::new(&j.path).is_file())
        {
            available += 1;
            for lang in &selected {
                queued += usize::from(self.queue_subtitle_task(job, lang, &policy, true, library)?);
            }
        }
        if available == 0 {
            return Err("No completed local videos are available for subtitle repair".into());
        }
        self.log(
            "info",
            "subtitles",
            &format!("{queued} subtitle tasks queued; video files stay unchanged"),
            Some(id),
        )?;
        Ok(json!({"queued":queued,"videos":available}))
    }

    pub(super) fn subtitle_health(&self, jobs: &[&AcquisitionJob], tasks: &[Value]) -> Value {
        let by_key: std::collections::HashMap<_, _> = tasks
            .iter()
            .map(|task| ((strv(task, "jobId"), strv(task, "language")), task))
            .collect();
        let member_ids: std::collections::HashSet<_> =
            jobs.iter().map(|job| job.id.as_str()).collect();
        let available: std::collections::HashSet<_> = jobs
            .iter()
            .filter(|job| job.status == "done" && Path::new(&job.path).is_file())
            .map(|job| job.id.as_str())
            .collect();
        let mut wanted = std::collections::BTreeSet::new();
        for job in jobs {
            if flag(&job.source_context["subtitlePolicy"], "enabled") {
                for lang in job.source_context["subtitlePolicy"]["languages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    wanted.insert(lang.to_owned());
                }
            }
        }
        for task in tasks
            .iter()
            .filter(|task| member_ids.contains(strv(task, "jobId")))
        {
            wanted.insert(strv(task, "language").to_owned());
        }
        let subtitles=wanted.into_iter().map(|lang| {
            let mut ready=0; let mut waiting=0; let mut failed=0;
            for job in jobs {
                let task=by_key.get(&(job.id.as_str(),lang.as_str()));
                if available.contains(job.id.as_str()) && (sidecar_exists(&job.path,&lang) || task.is_some_and(|t|t["state"]=="done" && strv(t,"message").contains("embedded"))) { ready+=1; }
                else if task.is_some_and(|t|matches!(strv(t,"state"),"queued"|"running"|"retrying")) { waiting+=1; }
                else if task.is_some_and(|t|t["state"]=="needs_attention") { failed+=1; }
            }
            json!({"language":lang,"ready":ready,"total":jobs.len(),"waiting":waiting,"failed":failed})
        }).collect::<Vec<_>>();
        json!({"videos":available.len(),"total":jobs.len(),"subtitles":subtitles})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rule_repairs_only_selected_existing_videos_and_does_not_loop_failed_searches() {
        let root = std::env::temp_dir().join(format!("rule-subtitles-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let runtime = crate::moviebox::tests::test_runtime(&root.join("db"));
        let video = root.join("Owned.mkv");
        std::fs::write(&video, b"owned video bytes").unwrap();
        let mut job:AcquisitionJob=serde_json::from_value(json!({"id":"owned","mediaId":"owned","mediaType":"series","title":"Owned","subtitle":null,"poster":null,"season":1,"episode":1,"streamLabel":null,"provider":null,"infoHash":null,"fileIndex":null,"sourceContext":{},"url":"","headers":{},"path":video,"status":"done","receivedBytes":17,"totalBytes":17,"error":null,"attempt":0,"scheduledAt":null,"createdAt":0,"updatedAt":1,"completedAt":1})).unwrap();

        let rule = json!({"id":"repair-rule","mediaId":"owned","season":1,"episodes":[1],"subtitleExisting":true,"subtitleMode":"custom","subtitleLanguages":["French"]});
        let mut excluded = job.clone();
        excluded.id = "excluded".into();
        excluded.episode = Some(2);
        assert_eq!(
            runtime
                .queue_rule_subtitles(&rule, &[job.clone(), excluded], true)
                .unwrap()["queued"],
            1
        );
        assert!(runtime
            .get("subtitle-job", "excluded:fr")
            .unwrap()
            .is_none());
        let mut task = runtime.get("subtitle-job", "owned:fr").unwrap().unwrap();
        assert_eq!(task["policy"]["ruleId"], "repair-rule");
        task["state"] = json!("needs_attention");
        runtime.put("subtitle-job", "owned:fr", &task).unwrap();
        assert_eq!(
            runtime
                .queue_rule_subtitles(&rule, &[job.clone()], false)
                .unwrap()["queued"],
            0
        );
        assert_eq!(
            runtime
                .queue_rule_subtitles(&rule, &[job.clone()], true)
                .unwrap()["queued"],
            1
        );
        let mut other_season = job.clone();
        other_season.season = Some(2);
        assert!(!rule_matches_video(&rule, &other_season));
        job.media_type = "movie".into();
        job.season = None;
        job.episode = None;
        assert!(rule_matches_video(&rule, &job));
        job.media_id = "another".into();
        assert!(!rule_matches_video(&rule, &job));
        let off = json!({"subtitleExisting":true,"subtitleMode":"off"});
        assert_eq!(
            runtime.queue_rule_subtitles(&off, &[job], true).unwrap()["queued"],
            0
        );
        assert_eq!(std::fs::read(&video).unwrap(), b"owned video bytes");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn queued_policy_is_frozen_and_completed_files_can_be_repaired_without_video_changes() {
        let root = std::env::temp_dir().join(format!("subtitle-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let runtime = crate::moviebox::tests::test_runtime(&root.join("db"));
        runtime.put("settings","preferences",&json!({"subtitlesEnabled":false,"subtitleLanguage":"English","subtitlesEnabledAt":100})).unwrap();
        let policy = runtime
            .subtitle_policy(Some(
                &json!({"subtitleMode":"custom","subtitleLanguages":["French","English"]}),
            ))
            .unwrap();
        assert_eq!(policy["languages"], json!(["fr", "en"]));
        assert_eq!(
            runtime
                .subtitle_policy(Some(&json!({"subtitleMode":"off"})))
                .unwrap()["enabled"],
            false
        );
        let video = root.join("Owned.mkv");
        std::fs::write(&video, b"owned video bytes").unwrap();
        let mut job:AcquisitionJob=serde_json::from_value(json!({"id":"owned","mediaId":"owned","mediaType":"series","title":"Owned","subtitle":null,"poster":null,"season":1,"episode":1,"streamLabel":null,"provider":null,"infoHash":null,"fileIndex":null,"sourceContext":{"subtitlePolicy":policy},"url":"","headers":{},"path":video,"status":"done","receivedBytes":17,"totalBytes":17,"error":null,"attempt":0,"scheduledAt":null,"createdAt":0,"updatedAt":1,"completedAt":1})).unwrap();
        runtime.schedule_subtitles(&job).unwrap();
        assert_eq!(runtime.list("subtitle-job").unwrap().len(), 2);
        runtime.put("settings","preferences",&json!({"subtitlesEnabled":true,"subtitleLanguage":"German","subtitlesEnabledAt":100})).unwrap();
        runtime.schedule_subtitles(&job).unwrap();
        assert_eq!(runtime.list("subtitle-job").unwrap().len(), 2);
        job.id = "old-video".into();
        job.source_context = json!({});
        runtime.schedule_subtitles(&job).unwrap();
        assert!(runtime
            .get("subtitle-job", "old-video:de")
            .unwrap()
            .is_none());
        assert!(runtime
            .queue_subtitle_task(&job, "fr", &policy, true, false)
            .unwrap());
        assert!(!runtime
            .queue_subtitle_task(&job, "fr", &policy, true, false)
            .unwrap());
        assert_eq!(std::fs::read(&video).unwrap(), b"owned video bytes");
        assert!(languages(&json!(["../../escape"])).is_err());
        job.id = "concurrent".into();
        let count = std::thread::scope(|scope| {
            let threads = (0..16)
                .map(|_| {
                    scope.spawn(|| {
                        runtime
                            .queue_subtitle_task(&job, "fr", &policy, true, false)
                            .unwrap()
                    })
                })
                .collect::<Vec<_>>();
            threads
                .into_iter()
                .map(|thread| usize::from(thread.join().unwrap()))
                .sum::<usize>()
        });
        assert_eq!(count, 1, "simultaneous clicks must only create one task");
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
