use super::super::{now, number, safe_name, strv, Runtime};
use super::{
    planner::{choices, select_picks},
    StoredPlan,
};
use crate::acquisition::{self, AcquisitionState, EnqueueAcquisition};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, State};

impl Runtime {
    pub(in crate::moviebox) fn bundle_plan(&self, id: &str) -> Result<Value, String> {
        let saved = self
            .get("bundle-plan", id)?
            .ok_or("Bundle review expired; find sources again")?;
        Ok(saved["plan"].clone())
    }
    pub(in crate::moviebox) async fn prepare_bundle(&self, id: &str) -> Result<Value, String> {
        let mut saved: StoredPlan = serde_json::from_value(
            self.get("bundle-plan", id)?
                .ok_or("Bundle review expired")?,
        )
        .map_err(|e| e.to_string())?;
        if self.get("bundle", id)?.is_some() {
            return Err(
                "This bundle is already queued; find sources again for remaining episodes".into(),
            );
        }
        let mut seen = HashSet::new();
        let mut candidates = Vec::new();
        let mut warnings = Vec::new();
        let mut inspected = false;
        let selected = saved
            .plan
            .rows
            .iter()
            .filter(|r| r.status != "existing")
            .map(|r| r.episode)
            .collect::<Vec<_>>();
        for pick in &saved.picks {
            let mut source = pick.source.clone();
            let hash = strv(&source["raw"], "infoHash").to_lowercase();
            if hash.is_empty() {
                candidates.push(pick.clone());
                continue;
            }
            if !seen.insert(hash.clone()) {
                continue;
            }
            if !pick.verified {
                let task = self.cloud_task(&saved.binding, &hash).await?;
                if !task.files.is_empty() {
                    inspected = true;
                    source["files"] = json!(task.files);
                } else {
                    warnings.push(format!("{}: {}", saved.binding.label(), task.message));
                }
            }

            candidates.extend(choices(
                &source,
                saved.request.season,
                &selected,
                (number(&self.prefs()?, "maxSize", 40.0) * 1e9) as u64,
            ));
        }
        if inspected {
            let gaps = selected
                .iter()
                .filter(|e| {
                    !candidates
                        .iter()
                        .any(|p| p.verified && p.episodes.contains(e))
                })
                .copied()
                .collect::<Vec<_>>();
            let mut seen = HashSet::new();
            for batch in gaps.chunks(3) {
                let reports = futures_util::future::join_all(batch.iter().map(|episode| {
                    self.search_sources(
                        &saved.request.id,
                        "series",
                        Some(saved.request.season),
                        Some(*episode),
                        &saved.request.quality,
                        &saved.request.language,
                    )
                }))
                .await;
                for report in reports {
                    let report = report?;
                    self.collect_choices(
                        &report,
                        &saved.request,
                        &selected,
                        &mut seen,
                        &mut candidates,
                    )?;
                    saved.plan.reports.push(report);
                    if saved.plan.reports.len() > 50 {
                        saved.plan.reports.remove(0);
                    }
                }
            }
        }
        saved.picks = select_picks(candidates, &selected, &saved.request.method);
        for row in &mut saved.plan.rows {
            if row.status == "existing" {
                continue;
            }
            let pick = saved
                .picks
                .iter()
                .find(|p| p.episodes.contains(&row.episode));
            row.status = if pick.is_some_and(|p| p.verified) {
                "ready"
            } else if pick.is_some() {
                "pending"
            } else {
                "missing"
            }
            .into();
            row.reason = match row.status.as_str() {
                "ready" => "Episode mapped from the source file list",
                "pending" => "Cloud preparation pending; Queue and wait continues automatically",
                _ => "Prepared files do not cover this episode unambiguously",
            }
            .into();
            row.filename = pick.and_then(|p| p.filename.clone());
            row.size = pick.and_then(|p| p.size);
            row.source_id = pick.map(|p| strv(&p.source["display"], "id").into());
            row.source_name = pick.map(|p| strv(&p.source["display"], "name").into());
            row.quality = pick.map(|p| strv(&p.source["display"], "quality").into());
            row.pack = pick.is_some_and(|p| super::super::flag(&p.source["display"], "pack"));
            if pick.is_some_and(|p| p.verified && p.filename.is_none()) {
                row.reason = "Episode-scoped add-on link; file contents not inspected".into();
            }
        }
        saved.plan.source_count = saved
            .picks
            .iter()
            .map(|p| {
                let hash = strv(&p.source["raw"], "infoHash");
                if hash.is_empty() {
                    p.key.clone()
                } else {
                    hash.into()
                }
            })
            .collect::<HashSet<_>>()
            .len();
        saved.plan.total_bytes = saved.picks.iter().filter_map(|p| p.size).sum();
        saved.plan.warnings = warnings;
        self.log(
            "info",
            "bridge",
            &format!(
                "Preparation checked: {} ready, {} still unresolved",
                saved
                    .plan
                    .rows
                    .iter()
                    .filter(|r| r.status == "ready")
                    .count(),
                saved
                    .plan
                    .rows
                    .iter()
                    .filter(|r| matches!(r.status.as_str(), "pending" | "missing"))
                    .count()
            ),
            Some(id),
        )?;
        self.put(
            "bundle-plan",
            id,
            &serde_json::to_value(&saved).map_err(|e| e.to_string())?,
        )?;
        serde_json::to_value(saved.plan).map_err(|e| e.to_string())
    }
    pub(in crate::moviebox) fn enqueue_bundle(
        &self,
        app: &AppHandle,
        acquisition: &AcquisitionState,
        id: &str,
        destination: &str,
        window: &str,
        zone: &str,
    ) -> Result<Value, String> {
        if let Some(bundle) = self.get("bundle", id)? {
            return Ok(bundle);
        }
        let saved: StoredPlan = serde_json::from_value(
            self.get("bundle-plan", id)?
                .ok_or("Bundle review expired")?,
        )
        .map_err(|e| e.to_string())?;
        let media = self
            .get("media", &saved.request.id)?
            .ok_or("Title metadata missing")?;
        let policy = saved
            .subtitle_policy
            .clone()
            .unwrap_or(self.subtitle_policy(None)?);
        let mut inputs = Vec::new();
        for pick in saved.picks.iter().filter(|p| p.verified) {
            let episodes = pick
                .episodes
                .iter()
                .map(|e| format!("E{e:02}"))
                .collect::<String>();
            let original = pick.filename.as_deref().unwrap_or_else(|| {
                pick.source["raw"]["behaviorHints"]["filename"]
                    .as_str()
                    .unwrap_or("")
            });
            let ext = std::path::Path::new(original)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("mkv");
            let filename = if strv(&self.prefs()?, "naming") == "Original file names"
                && !original.is_empty()
            {
                safe_name(
                    std::path::Path::new(original)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(original),
                )
            } else {
                format!(
                    "{} S{:02}{episodes}.{ext}",
                    safe_name(strv(&media, "title")),
                    saved.request.season
                )
            };
            let path =
                self.destination(&media, destination, Some(saved.request.season), &filename)?;
            let source = &pick.source;
            inputs.push(EnqueueAcquisition{media_id:saved.request.id.clone(),media_type:"series".into(),title:filename,subtitle:None,poster:media["poster"].as_str().map(String::from),season:Some(saved.request.season),episode:pick.episodes.first().copied(),stream_label:Some(strv(&source["display"],"quality").into()),provider:Some(if strv(&source["raw"],"infoHash").is_empty(){"Direct"}else{saved.binding.label()}.into()),info_hash:source["raw"]["infoHash"].as_str().map(String::from),file_index:None,
                source_context:json!({"moviebox":true,"providerBinding":saved.binding,"subtitlePolicy":policy,"ruleId":saved.rule_id,"bundleId":id,"episodes":pick.episodes,"plannedFilename":pick.filename,"source":source,"sourceId":source["display"]["id"],"media":media,"window":window,"timezone":zone,"destination":destination,"skipDuplicates":true}),url:String::new(),headers:HashMap::new(),path,scheduled_at:None});
        }
        if inputs.is_empty() {
            return Err("No ready file mappings or episode-scoped links. Prepare candidates or find other sources first.".into());
        }
        let unresolved = saved
            .plan
            .rows
            .iter()
            .filter(|r| matches!(r.status.as_str(), "missing" | "pending"))
            .map(|r| r.episode)
            .collect::<Vec<_>>();
        let bundle = json!({"id":id,"mediaId":saved.request.id,"title":saved.plan.title,"season":saved.request.season,"createdAt":now(),"sourceCount":inputs.iter().map(|i|i.info_hash.clone().unwrap_or_else(||strv(&i.source_context,"sourceId").into())).collect::<HashSet<_>>().len(),"rows":saved.plan.rows,"unresolved":unresolved});
        let result =
            acquisition::enqueue_bundle_native(app.clone(), acquisition, id, bundle, inputs)?;
        self.log(
            "info",
            "bridge",
            "Reviewed bundle sources queued; unresolved episodes were not substituted",
            Some(id),
        )?;
        Ok(result)
    }
    pub(in crate::moviebox) fn control_bundle(
        &self,
        app: &AppHandle,
        state: State<'_, AcquisitionState>,
        id: &str,
        action: &str,
    ) -> Result<Value, String> {
        if !["pause", "resume", "retry", "cancel"].contains(&action) {
            return Err("Unknown bundle action".into());
        }
        self.get("bundle", id)?.ok_or("Bundle not found")?;
        for job in state
            .list_jobs()?
            .into_iter()
            .filter(|j| strv(&j.source_context, "bundleId") == id)
        {
            match action {
                "pause"
                    if matches!(
                        job.status.as_str(),
                        "queued" | "scheduled" | "preparing" | "downloading"
                    ) =>
                {
                    acquisition::acquisition_pause(app.clone(), state.clone(), job.id)?;
                }
                "resume" if job.status == "paused" => {
                    acquisition::acquisition_resume(app.clone(), state.clone(), job.id)?;
                }
                "retry" if job.status == "error" => {
                    self.retry_cloud_job(&job)?;
                    state.update_job(&job.id, |j| {
                        j.url.clear();
                        j.attempt = 0;
                    })?;
                    acquisition::acquisition_retry(app.clone(), state.clone(), job.id)?;
                }
                "cancel" if job.status != "done" => {
                    acquisition::acquisition_cancel(app.clone(), state.clone(), job.id)?;
                }
                _ => {}
            }
        }
        self.log(
            "info",
            "bridge",
            &format!("Bundle action: {action}"),
            Some(id),
        )?;
        Ok(Value::Null)
    }
}
