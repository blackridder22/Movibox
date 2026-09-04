use super::{flag, now, strv, Runtime};
use crate::acquisition::AcquisitionState;
use chrono::{TimeZone, Timelike};
use serde_json::{json, Value};
use std::str::FromStr;
use tauri::{AppHandle, Emitter, Manager};

pub(super) fn next_rule_check(rule: &Value, after: i64) -> Result<Option<i64>, String> {
    match rule.get("scheduleMode") {
        Some(Value::String(mode)) if mode == "manual" => Ok(None),
        None | Some(Value::Null) => next_check(rule, after).map(Some),
        Some(Value::String(mode)) if mode == "scheduled" => next_check(rule, after).map(Some),
        _ => Err("Choose manual-only or scheduled checks".into()),
    }
}

fn rule_due(rule: &Value, at: i64) -> bool {
    strv(rule, "scheduleMode") != "manual"
        && !flag(rule, "running")
        && matches!(strv(rule, "status"), "active" | "error")
        && rule["nextCheckAt"].as_i64().is_some_and(|next| next <= at)
}

fn recover_rule(rule: &mut Value, at: i64) {
    if flag(rule, "running") {
        rule["running"] = json!(false);
        rule["nextCheckAt"] = if strv(rule, "scheduleMode") == "manual" {
            Value::Null
        } else {
            json!(at)
        };
        if strv(rule, "scheduleMode") == "manual" {
            rule["result"] = json!("Manual check interrupted. Use Run now to check again; existing downloads and subtitle tasks resume separately.");
        }
    }
}

pub(super) fn next_check(rule: &Value, after: i64) -> Result<i64, String> {
    let zone = chrono_tz::Tz::from_str(strv(rule, "timezone"))
        .map_err(|_| "Choose a valid IANA timezone")?;
    let expression = match strv(rule, "frequency") {
        "30 minutes" => "*/30 * * * *",
        "1 hour" => "0 * * * *",
        "6 hours" => "0 */6 * * *",
        "12 hours" => "0 */12 * * *",
        "Daily" => "0 0 * * *",
        "Custom schedule" => strv(rule, "cron"),
        _ => return Err("Choose a valid check frequency".into()),
    };
    if expression.split_whitespace().count() != 5 {
        return Err("Use a five-field cron expression".into());
    }
    let cron = croner::Cron::from_str(expression).map_err(|_| "Invalid cron expression")?;
    let date = zone
        .timestamp_millis_opt(after)
        .single()
        .ok_or("Invalid schedule time")?;
    cron.find_next_occurrence(&date, false)
        .map(|d| d.timestamp_millis())
        .map_err(|_| "This schedule has no future occurrence".into())
}
pub(crate) fn window_open(window: &str, zone: &str, at: i64) -> Result<bool, String> {
    let zone = chrono_tz::Tz::from_str(zone).map_err(|_| "Invalid timezone")?;
    let hour = zone
        .timestamp_millis_opt(at)
        .single()
        .ok_or("Invalid time")?
        .hour();
    match window {
        "Any time" | "" => Ok(true),
        "Overnight · 00:00–07:00" => Ok(hour < 7),
        "Evening · 18:00–23:00" => Ok((18..23).contains(&hour)),
        _ => Err("Invalid download window".into()),
    }
}
impl Runtime {
    fn update_rule_revision(
        &self,
        id: &str,
        revision: &Value,
        value: &Value,
    ) -> Result<(), String> {
        let changed = self.db.lock().map_err(|_| "Database unavailable")?.execute(
            "UPDATE moviebox_documents SET payload=?1 WHERE kind='rule' AND id=?2 AND json_extract(payload,'$.revision')=?3",
            rusqlite::params![serde_json::to_string(value).map_err(|e|e.to_string())?, id, revision.as_i64().unwrap_or(0)],
        ).map_err(|e|e.to_string())?;
        if changed == 0 {
            return Err("Rule changed during this check".into());
        }
        Ok(())
    }

    pub(super) fn save_rule(&self, mut rule: Value) -> Result<Value, String> {
        let id = strv(&rule, "id").to_string();
        if id.is_empty() || strv(&rule, "name").trim().is_empty() {
            return Err("Give the rule a name".into());
        }
        let media = self
            .get("media", strv(&rule, "mediaId"))?
            .ok_or("Select a title from Discover first")?;
        if strv(&rule, "destination").is_empty() {
            return Err("Choose a destination".into());
        }
        self.destination(&media, strv(&rule, "destination"), None, "check.mkv")?;
        window_open(strv(&rule, "window"), strv(&rule, "timezone"), now())?;
        self.subtitle_policy(Some(&rule))?;
        let old = self.get("rule", &id)?;
        rule["createdAt"] = old
            .as_ref()
            .and_then(|v| v.get("createdAt"))
            .cloned()
            .unwrap_or(json!(now()));
        rule["revision"] = json!(
            old.as_ref()
                .and_then(|v| v["revision"].as_u64())
                .unwrap_or(0)
                + 1
        );
        rule["nextCheckAt"] = json!(next_rule_check(&rule, now())?);
        rule["history"] = old
            .as_ref()
            .map(|v| v["history"].clone())
            .unwrap_or(json!([]));
        rule["result"] = json!(if strv(&rule, "status") == "paused" {
            "Paused by you"
        } else if strv(&rule, "scheduleMode") == "manual" {
            "Manual only · ready to run"
        } else {
            "Waiting for next check"
        });
        rule["status"] = json!(if strv(&rule, "status") == "paused" {
            "paused"
        } else {
            "active"
        });
        rule["running"] = json!(false);
        self.put("rule", &id, &rule)?;
        self.log("info", "scheduler", "Monitoring rule saved", Some(&id))?;
        Ok(rule)
    }
    pub(super) fn run_rule(
        &self,
        app: AppHandle,
        id: String,
        automatic: bool,
    ) -> Result<(), String> {
        let _guard = self
            .workflow_commit
            .lock()
            .map_err(|_| "Workflow unavailable")?;
        let mut rule = self.get("rule", &id)?.ok_or("Monitoring rule not found")?;
        if automatic && !rule_due(&rule, now()) {
            return Ok(());
        }
        let next = next_rule_check(&rule, now())?;
        {
            let mut running = self
                .running_rules
                .lock()
                .map_err(|_| "Scheduler unavailable")?;
            if !running.insert(id.clone()) {
                return Err("This rule is already checking".into());
            }
        }
        rule["running"] = json!(true);
        rule["result"] = json!("Checking sources…");
        rule["nextCheckAt"] = json!(next);
        if let Err(error) = self.update_rule_revision(&id, &rule["revision"], &rule) {
            self.running_rules
                .lock()
                .map_err(|_| "Scheduler unavailable")?
                .remove(&id);
            return Err(error);
        }
        let runtime = self.clone();
        let _ = app.emit("movibox://backend-changed", ());
        tauri::async_runtime::spawn(async move {
            let subtitle_result = app
                .state::<AcquisitionState>()
                .list_jobs()
                .and_then(|jobs| runtime.queue_rule_subtitles(&rule, &jobs, false));
            let result = runtime.check_rule(&app, &rule).await;
            if let Ok(Some(mut latest)) = runtime.get("rule", &id) {
                if latest["revision"] == rule["revision"] {
                    latest["running"] = json!(false);
                    latest["lastCheckedAt"] = json!(now());
                    let message = match result {
                        Ok((queued, missing, failed, pending)) => {
                            latest["status"] = json!(if !flag(&latest, "future")
                                && missing == 0
                                && failed == 0
                                && pending == 0
                                && queued == 0
                            {
                                "complete"
                            } else {
                                "active"
                            });
                            format!("{queued} queued · {pending} downloading · {missing} waiting for a source · {failed} failed")
                        }
                        Err(error) => {
                            latest["status"] = json!("error");
                            error
                        }
                    };
                    let message = match subtitle_result {
                        Ok(report) => {
                            latest["subtitleRepair"] = report.clone();
                            if flag(&rule, "subtitleExisting") {
                                format!("{message} · {} subtitle tasks queued · {} missing videos skipped",report["queued"],report["missing"])
                            } else {
                                message
                            }
                        }
                        Err(error) => {
                            format!("{message} · Subtitle repair needs attention: {error}")
                        }
                    };
                    latest["result"] = json!(message);
                    let mut history = latest["history"].as_array().cloned().unwrap_or_default();
                    history.insert(
                        0,
                        json!(format!(
                            "{} · {}",
                            chrono::Utc::now().format("%Y-%m-%d %H:%M UTC"),
                            message
                        )),
                    );
                    history.truncate(100);
                    latest["history"] = json!(history);
                    let _ = runtime.update_rule_revision(&id, &rule["revision"], &latest);
                    let _ = runtime.log(
                        if strv(&latest, "status") == "error" {
                            "error"
                        } else {
                            "info"
                        },
                        "scheduler",
                        &message,
                        Some(&id),
                    );
                }
            }
            if let Ok(mut running) = runtime.running_rules.lock() {
                running.remove(&id);
            }
            let _ = app.emit("movibox://backend-changed", ());
        });
        Ok(())
    }
    async fn check_rule(
        &self,
        app: &AppHandle,
        rule: &Value,
    ) -> Result<(usize, usize, usize, usize), String> {
        let id = strv(rule, "mediaId");
        let cached = self
            .get("media", id)?
            .ok_or("Title is no longer available")?;
        let kind = strv(&cached, "kind");
        let media = self.detail(id, kind).await?;
        let mut targets = Vec::new();
        let mut skipped_watched = 0usize;
        if kind == "movie" {
            if self.is_watched(id, None, None)? {
                skipped_watched += 1;
            } else {
                targets.push((None, None))
            }
        } else {
            for episode in media["episodes"].as_array().into_iter().flatten() {
                let s = episode["season"].as_i64().unwrap_or(0) as i32;
                let e = episode["episode"].as_i64().unwrap_or(0) as i32;
                if s < 1
                    || e < 1
                    || rule["season"]
                        .as_i64()
                        .is_some_and(|v| v != 0 && v != s as i64)
                {
                    continue;
                }
                if rule["episodes"]
                    .as_array()
                    .is_some_and(|es| !es.is_empty() && !es.contains(&json!(e)))
                {
                    continue;
                }
                if self.is_watched(id, Some(s), Some(e))? {
                    skipped_watched += 1;
                    continue;
                }
                let Ok(date) = chrono::DateTime::parse_from_rfc3339(strv(episode, "released"))
                else {
                    continue;
                };
                let cutoff = if flag(rule, "future") {
                    now()
                } else {
                    rule["createdAt"].as_i64().unwrap_or(now())
                };
                if date.timestamp_millis() <= cutoff {
                    targets.push((Some(s), Some(e)))
                }
            }
        }
        if targets.is_empty() {
            return Ok((0, usize::from(skipped_watched == 0), 0, 0));
        }
        let acquisition = app.state::<AcquisitionState>();
        let (mut queued, mut missing, mut failed, mut pending) = (0, 0, 0, 0);
        if kind == "series" {
            let mut seasons = std::collections::BTreeMap::<i32, Vec<i32>>::new();
            for (season, episode) in targets {
                if let (Some(s), Some(e)) = (season, episode) {
                    seasons.entry(s).or_default().push(e);
                }
            }
            for (season, episodes) in seasons {
                let current = self.get("rule", strv(rule, "id"))?;
                if current.as_ref().is_none_or(|v| {
                    v["revision"] != rule["revision"] || strv(v, "status") == "paused"
                }) {
                    break;
                }
                let plan = tokio::time::timeout(
                    std::time::Duration::from_secs(180),
                    self.plan_bundle(
                        super::bridge::BundleRequest {
                            id: id.into(),
                            season,
                            episodes,
                            quality: strv(rule, "quality").into(),
                            language: strv(rule, "language").into(),
                            method: "Season pack".into(),
                        },
                        &acquisition,
                    ),
                )
                .await
                .map_err(|_| "Scheduled source search timed out")??;
                let review = serde_json::to_value(&plan).map_err(|e| e.to_string())?;
                if plan.rows.iter().any(|r| r.status == "pending") {
                    let current = self.get("rule", strv(rule, "id"))?;
                    if current.as_ref().is_none_or(|v| {
                        v["revision"] != rule["revision"] || v["status"] == "paused"
                    }) {
                        break;
                    }
                    self.queue_wait(
                        &plan.id,
                        strv(rule, "destination"),
                        strv(rule, "window"),
                        strv(rule, "timezone"),
                        Some(rule),
                    )?;
                    pending += plan
                        .rows
                        .iter()
                        .filter(|r| matches!(r.status.as_str(), "pending" | "ready"))
                        .count();
                    missing += plan.rows.iter().filter(|r| r.status == "missing").count();
                    continue;
                }
                let rows = review["rows"]
                    .as_array()
                    .ok_or("Bundle coverage unavailable")?;
                let ready = rows.iter().filter(|r| strv(r, "status") == "ready").count();
                missing += rows
                    .iter()
                    .filter(|r| strv(r, "status") == "missing")
                    .count();
                pending += rows
                    .iter()
                    .filter(|r| strv(r, "status") == "pending")
                    .count();
                if ready > 0 {
                    let _guard = self
                        .workflow_commit
                        .lock()
                        .map_err(|_| "Workflow unavailable")?;
                    let current = self.get("rule", strv(rule, "id"))?;
                    if current.as_ref().is_none_or(|v| {
                        v["revision"] != rule["revision"] || strv(v, "status") == "paused"
                    }) {
                        break;
                    }
                    self.set_plan_subtitles(&plan.id, Some(rule))?;
                    self.enqueue_bundle(
                        app,
                        &acquisition,
                        &plan.id,
                        strv(rule, "destination"),
                        strv(rule, "window"),
                        strv(rule, "timezone"),
                    )?;
                    queued += ready;
                }
                self.log(
                    "info",
                    "scheduler",
                    &format!("Season {season} reviewed through bundle {}", plan.id),
                    Some(strv(rule, "id")),
                )?;
            }
            return Ok((queued, missing, failed, pending));
        }
        for (season, episode) in targets {
            let latest = self.get("rule", strv(rule, "id"))?;
            if latest
                .as_ref()
                .is_none_or(|v| v["revision"] != rule["revision"] || strv(v, "status") == "paused")
            {
                break;
            }
            let existing = acquisition.list_jobs()?.into_iter().find(|j| {
                j.media_id == id
                    && j.season == season
                    && j.episode == episode
                    && !matches!(j.status.as_str(), "error" | "canceled")
                    && (j.status != "done" || std::path::Path::new(&j.path).is_file())
            });
            if let Some(existing) = existing {
                if existing.status != "done" {
                    pending += 1;
                }
                continue;
            }
            if flag(rule, "skipExisting")
                && self.list("library")?.iter().any(|f| {
                    strv(f, "mediaId") == id
                        && std::path::Path::new(strv(f, "path")).is_file()
                        && episode.is_none_or(|e| {
                            f["season"].as_i64() == season.map(i64::from)
                                && f["episodes"]
                                    .as_array()
                                    .is_some_and(|es| es.contains(&json!(e)))
                        })
                })
            {
                continue;
            }
            match self
                .sources(
                    id,
                    kind,
                    season,
                    episode,
                    strv(rule, "quality"),
                    strv(rule, "language"),
                )
                .await
            {
                Ok(sources) => {
                    if let Some(source) = sources.first() {
                        let _guard = self
                            .workflow_commit
                            .lock()
                            .map_err(|_| "Workflow unavailable")?;
                        let current = self.get("rule", strv(rule, "id"))?;
                        if current.as_ref().is_none_or(|v| {
                            v["revision"] != rule["revision"] || strv(v, "status") == "paused"
                        }) {
                            break;
                        }
                        match self.enqueue_source(
                            app,
                            &acquisition,
                            strv(source, "id"),
                            strv(rule, "destination"),
                            strv(rule, "window"),
                            strv(rule, "timezone"),
                            Some(self.subtitle_policy(Some(rule))?),
                            Some(strv(rule, "id")),
                        ) {
                            Ok(_) => queued += 1,
                            Err(error) => {
                                failed += 1;
                                self.log("error", "scheduler", &error, Some(strv(rule, "id")))?;
                            }
                        }
                    } else {
                        missing += 1
                    }
                }
                Err(error) => {
                    // Configuration or provider failures should stay visible on the rule,
                    // instead of being summarized as an unexplained failed count.
                    return Err(error);
                }
            }
        }
        Ok((queued, missing, failed, pending))
    }
}
pub(super) fn start(runtime: Runtime, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // A crash during a check retries once; missed ticks never replay as a burst.
        if let Ok(rules) = runtime.list("rule") {
            for mut rule in rules {
                if flag(&rule, "running") {
                    recover_rule(&mut rule, now());
                    let _ = runtime.put("rule", strv(&rule, "id"), &rule);
                }
            }
        }
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(15));
        let mut previous_tick = 0;
        loop {
            timer.tick().await;
            let time = now();
            let catch_up = runtime.prefs().map(|p| flag(&p, "catchUp")).unwrap_or(true);
            if let Ok(rules) = runtime.list("rule") {
                for mut rule in rules {
                    if !rule_due(&rule, time) {
                        continue;
                    }
                    if !catch_up && time - previous_tick > 90_000 {
                        if let Ok(next) = next_rule_check(&rule, time) {
                            rule["nextCheckAt"] = json!(next);
                            let _ = runtime.put("rule", strv(&rule, "id"), &rule);
                        }
                        continue;
                    }
                    if runtime
                        .running_rules
                        .lock()
                        .map(|r| r.len() >= 2)
                        .unwrap_or(true)
                    {
                        break;
                    }
                    let _ = runtime.run_rule(app.clone(), strv(&rule, "id").into(), true);
                }
            }
            previous_tick = time;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_rules_never_become_due_even_after_restart_or_a_stale_timestamp() {
        let mut rule = json!({"scheduleMode":"manual","frequency":"Custom schedule","cron":"invalid unused cron","timezone":"UTC","status":"active","running":true,"nextCheckAt":1});
        assert_eq!(next_rule_check(&rule, 1000).unwrap(), None);
        recover_rule(&mut rule, 2000);
        assert_eq!(rule["running"], false);
        assert!(rule["nextCheckAt"].is_null());
        rule["nextCheckAt"] = json!(1);
        assert!(!rule_due(&rule, 5000));
        rule["status"] = json!("error");
        assert!(!rule_due(&rule, 5000));
        let legacy =
            json!({"frequency":"Daily","timezone":"UTC","status":"active","nextCheckAt":1});
        assert!(next_rule_check(&legacy, 1000).unwrap().is_some());
        assert!(rule_due(&legacy, 5000));
        rule["scheduleMode"] = json!("invalid");
        assert!(next_rule_check(&rule, 1000).is_err());
    }
    #[test]
    fn guided_weekly_schedule_keeps_local_time_across_dst() {
        let rule = json!({"frequency":"Custom schedule","cron":"15 9 * * 1","timezone":"America/New_York"});
        let start = chrono::DateTime::parse_from_rfc3339("2026-10-31T16:00:00Z")
            .unwrap()
            .timestamp_millis();
        let expected = chrono::DateTime::parse_from_rfc3339("2026-11-02T14:15:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(next_check(&rule, start).unwrap(), expected);
    }
    #[test]
    fn guided_monthly_schedule_skips_missing_dates_and_advances_years() {
        for (cron, start, expected) in [
            (
                "15 9 31 * *",
                "2026-04-01T00:00:00Z",
                "2026-05-31T09:15:00Z",
            ),
            ("0 8 1 * *", "2026-12-01T08:00:00Z", "2027-01-01T08:00:00Z"),
        ] {
            let rule = json!({"frequency":"Custom schedule","cron":cron,"timezone":"UTC"});
            let start = chrono::DateTime::parse_from_rfc3339(start)
                .unwrap()
                .timestamp_millis();
            let expected = chrono::DateTime::parse_from_rfc3339(expected)
                .unwrap()
                .timestamp_millis();
            assert_eq!(next_check(&rule, start).unwrap(), expected);
        }
    }
    #[test]
    fn cron_validates_timezone_and_advances_over_dst() {
        let mut rule = json!({"frequency":"Custom schedule","cron":"30 2 * * *","timezone":"America/New_York"});
        let start = chrono::DateTime::parse_from_rfc3339("2026-03-08T06:59:00Z")
            .unwrap()
            .timestamp_millis();
        let next = next_check(&rule, start).unwrap();
        assert!(next > start);
        assert!(next < start + 2 * 86_400_000);
        rule["timezone"] = json!("Not/A_Timezone");
        assert!(next_check(&rule, start).is_err());
        rule["timezone"] = json!("UTC");
        rule["cron"] = json!("bad cron");
        assert!(next_check(&rule, start).is_err());
    }
    #[test]
    fn cron_day_of_month_and_weekday_have_unix_or_semantics() {
        let rule = json!({"frequency":"Custom schedule","cron":"0 0 1 * 1","timezone":"UTC"});
        let start = chrono::DateTime::parse_from_rfc3339("2026-08-02T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            next_check(&rule, start).unwrap(),
            chrono::DateTime::parse_from_rfc3339("2026-08-03T00:00:00Z")
                .unwrap()
                .timestamp_millis()
        );
    }
    #[test]
    fn overnight_window_uses_selected_timezone() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-08-29T09:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert!(window_open("Overnight · 00:00–07:00", "America/Anchorage", at).unwrap());
        assert!(!window_open("Overnight · 00:00–07:00", "UTC", at).unwrap());
    }
}
