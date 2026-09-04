//! Native ownership for Movie Box. The webview renders snapshots; it never runs workers.
mod activity;
mod backup;
mod bridge;
mod catalog;
pub(crate) mod commands;
mod indexers;
mod player;
mod providers;
mod requests;
mod scheduler;
mod searches;
mod sources;
mod subtitle_policy;
mod subtitles;
mod tmdb;
pub(crate) mod updates;
mod workflows;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::acquisition::{AcquisitionJob, AcquisitionState};

pub(crate) use sources::resolve_job;

#[derive(Clone)]
pub struct Runtime {
    db: Arc<Mutex<Connection>>,
    client: reqwest::Client,
    running_rules: Arc<Mutex<HashSet<String>>>,
    credential: Arc<Mutex<Option<String>>>,
    workflow_commit: Arc<Mutex<()>>,
    search_workers:
        Arc<Mutex<std::collections::HashMap<String, futures_util::future::AbortHandle>>>,
    interactive_search: Arc<Mutex<Option<(String, futures_util::future::AbortHandle)>>>,
    preparation: Arc<tokio::sync::Mutex<()>>,
    subtitle_wake: Arc<tokio::sync::Notify>,
    subtitle_commit: Arc<Mutex<()>>,
    requests: requests::Coordinator,
    #[cfg(test)]
    provider_url: Option<String>,
}

pub(crate) fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub(crate) fn strv<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub(crate) fn number(value: &Value, key: &str, default: f64) -> f64 {
    value[key]
        .as_f64()
        .or_else(|| value[key].as_str()?.parse().ok())
        .unwrap_or(default)
}
pub(crate) fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
pub(crate) fn safe_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(160)
        .collect();
    let name = name.trim().trim_matches('.');
    if name.is_empty() {
        "Untitled".into()
    } else {
        name.into()
    }
}

impl Runtime {
    pub fn new(app: &AppHandle, acquisition: &AcquisitionState) -> Result<Self, String> {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            std::fs::set_permissions(
                root.join("movibox.sqlite3"),
                std::fs::Permissions::from_mode(0o600),
            )
            .map_err(|e| e.to_string())?;
        }
        let runtime = Self {
            db: acquisition.db.clone(),
            client: reqwest::Client::builder()
                .user_agent("MoviBox/0.9.21")
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .map_err(|e| e.to_string())?,
            running_rules: Arc::default(),
            credential: Arc::default(),
            workflow_commit: Arc::default(),
            search_workers: Arc::default(),
            interactive_search: Arc::default(),
            preparation: Arc::default(),
            subtitle_wake: Arc::default(),
            subtitle_commit: Arc::default(),
            requests: requests::Coordinator::default(),
            #[cfg(test)]
            provider_url: None,
        };
        runtime.initialize_documents()?;
        if runtime.get("settings", "preferences")?.is_none() {
            // Minimal Linux installs may not define an XDG Downloads directory.
            let downloads = app
                .path()
                .download_dir()
                .or_else(|_| app.path().home_dir().map(|home| home.join("Downloads")))
                .map_err(|e| e.to_string())?;
            runtime.put("settings", "preferences", &json!({
                "provider":false,"addons":[{"id":"cinemeta","name":"Cinemeta","url":"https://v3-cinemeta.strem.io/manifest.json","enabled":true}],
                "folder":downloads.join("MoviBox"),
                "movieFolder":"Movies","seriesFolder":"Series","background":true,"autoStart":false,
                "catchUp":true,"concurrency":"3","retries":"3","bandwidth":"Unlimited","reserve":"10",
                "maxSize":"40","duplicates":true,"sourcePreference":"Cached first","sourceTimeout":"20 seconds",
                "quality":"1080p or better","language":"Any language","timezone":"UTC","transferWindow":"Any time",
                "setupComplete":false
            }))?;
        }
        // Never silently migrate preview jobs or provider keys from browser storage.
        runtime.log(
            "info",
            "runtime",
            "Native backend started; unfinished work will be recovered",
            None,
        )?;
        Ok(runtime)
    }
    fn initialize_documents(&self) -> Result<(), String> {
        self.db.lock().map_err(|_| "Database unavailable")?.execute_batch(
            "CREATE TABLE IF NOT EXISTS moviebox_documents (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
             CREATE TABLE IF NOT EXISTS moviebox_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, area TEXT NOT NULL, message TEXT NOT NULL, subject TEXT);")
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub(crate) fn get(&self, kind: &str, id: &str) -> Result<Option<Value>, String> {
        let raw: Option<String> = self
            .db
            .lock()
            .map_err(|_| "Database unavailable")?
            .query_row(
                "SELECT payload FROM moviebox_documents WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
    }
    pub(crate) fn put(&self, kind: &str, id: &str, value: &Value) -> Result<(), String> {
        self.db.lock().map_err(|_| "Database unavailable")?.execute(
            "INSERT INTO moviebox_documents(kind,id,payload) VALUES (?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
            params![kind,id,value.to_string()]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub(crate) fn remove(&self, kind: &str, id: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "Database unavailable")?
            .execute(
                "DELETE FROM moviebox_documents WHERE kind=?1 AND id=?2",
                params![kind, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub(crate) fn list(&self, kind: &str) -> Result<Vec<Value>, String> {
        let db = self.db.lock().map_err(|_| "Database unavailable")?;
        let mut stmt = db
            .prepare("SELECT payload FROM moviebox_documents WHERE kind=?1 ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([kind], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub(crate) fn prefs(&self) -> Result<Value, String> {
        self.get("settings", "preferences")?
            .ok_or("Settings missing".into())
    }
    pub(crate) fn key(&self) -> Result<String, String> {
        let mut cached = self
            .credential
            .lock()
            .map_err(|_| "Credential store unavailable")?;
        if let Some(key) = &*cached {
            return Ok(key.clone());
        }
        let key = keyring::Entry::new("app.movibox.backend", "torbox")
            .map_err(|_| "OS credential store unavailable")?
            .get_password()
            .map_err(|_| "Connect TorBox in Settings before preparing torrents")?;
        *cached = Some(key.clone());
        Ok(key)
    }
    pub(crate) fn log(
        &self,
        level: &str,
        area: &str,
        message: &str,
        subject: Option<&str>,
    ) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "Database unavailable")?;
        // Callers supply fixed messages or sanitized errors, never response bodies or URLs.
        db.execute(
            "INSERT INTO moviebox_logs(at,level,area,message,subject) VALUES (?1,?2,?3,?4,?5)",
            params![now(), level, area, message, subject],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "DELETE FROM moviebox_logs WHERE id <= (SELECT MAX(id)-5000 FROM moviebox_logs)",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn logs(&self, subject: Option<&str>) -> Result<Vec<Value>, String> {
        let db = self.db.lock().map_err(|_| "Database unavailable")?;
        let mut stmt = db.prepare("SELECT at,level,area,message FROM moviebox_logs WHERE (?1 IS NULL OR subject=?1) ORDER BY id DESC LIMIT 200").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([subject], |r| Ok(json!({"at":r.get::<_,i64>(0)?,"level":r.get::<_,String>(1)?,"area":r.get::<_,String>(2)?,"message":r.get::<_,String>(3)?}))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub(crate) fn destination(
        &self,
        media: &Value,
        requested: &str,
        season: Option<i32>,
        filename: &str,
    ) -> Result<String, String> {
        let p = self.prefs()?;
        let root = if requested.is_empty() {
            PathBuf::from(strv(&p, "folder"))
        } else {
            PathBuf::from(requested)
        };
        if !root.is_absolute()
            || root
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("Choose an absolute destination with the folder picker".into());
        }
        let title = safe_name(strv(media, "title"));
        let folder = if let Some(s) = season {
            root.join(safe_name(strv(&p, "seriesFolder")))
                .join(title)
                .join(format!("Season {s:02}"))
        } else {
            root.join(safe_name(strv(&p, "movieFolder"))).join(format!(
                "{} ({})",
                title,
                safe_name(strv(media, "year"))
            ))
        };
        let folder = if strv(&p, "naming") == "Title / Quality" {
            folder.join(safe_name(strv(&p, "quality")))
        } else {
            folder
        };
        Ok(folder.join(safe_name(filename)).to_string_lossy().into())
    }
    fn snapshot(&self, acquisition: &AcquisitionState) -> Result<Value, String> {
        let mut preferences = self.prefs()?;
        // Capability URLs may contain tokens. Only return the public origin to the renderer.
        if let Some(addons) = preferences["addons"].as_array_mut() {
            for addon in addons {
                if let Some(cached) = self.get("manifest", strv(addon, "id"))? {
                    addon["capabilities"] = json!(cached["manifest"]["resources"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|r| r.as_str().or_else(|| r["name"].as_str()))
                        .collect::<Vec<_>>());
                }
                if let Ok(url) = url::Url::parse(strv(addon, "url")) {
                    addon["url"] = json!(url.origin().ascii_serialization());
                }
            }
        }
        if let Some(accounts) = preferences["providerAccounts"].as_object_mut() {
            for account in accounts.values_mut() {
                if let Some(v) = account.as_object_mut() {
                    v.remove("account");
                }
            }
        }
        let mut jobs = acquisition.list_jobs()?;
        jobs.sort_by_key(|j| {
            (
                -j.source_context["queuePriority"].as_i64().unwrap_or(0),
                -j.created_at,
            )
        });
        let subtitle_tasks = self.list("subtitle-job")?;
        let ui_jobs: Vec<Value> = jobs.iter().filter(|j| self.get("hidden-job",&j.id).ok().flatten().is_none()).map(|job| {
            let events = self.logs(Some(&job.id)).unwrap_or_default().iter().take(30).map(|v| format!("{} · {}",strv(v,"level"),strv(v,"message"))).collect::<Vec<_>>();
            json!({"id":job.id,"mediaId":job.media_id,"label":job.title,"quality":job.stream_label.clone().unwrap_or_default(),
                "size":((job.total_bytes.unwrap_or(job.received_bytes) as f64 / 1e9)*100.0).round()/100.0,
                "progress":if job.status=="done" {100.0} else {job.total_bytes.filter(|n| *n>0).map(|n| (job.received_bytes as f64/n as f64*100.0).min(100.0)).unwrap_or(0.0)},
                "status":match job.status.as_str(){"downloading"=>"active","done"=>"completed","paused"=>"paused","scheduled"=>"scheduled","preparing"|"needsResolution"=>"preparing","error"=>"failed","canceled"|"canceling"=>"canceled",_=>"queued"},
                "speed":0,"receivedBytes":job.received_bytes,"createdAt":job.created_at,"updatedAt":job.updated_at,"completedAt":job.completed_at,"attempt":job.attempt.max(1),"destination":job.path,
                "subtitlePolicy":job.source_context["subtitlePolicy"],"provider":job.provider,"cloud":job.source_context["cloud"],"subtitles":subtitle_tasks.iter().filter(|t|t["jobId"]==job.id).collect::<Vec<_>>(),"bundleId":job.source_context["bundleId"],"ruleId":job.source_context["ruleId"],"trigger":if job.source_context["ruleId"].as_str().is_some(){"monitoring"}else{"manual"},"episodes":bridge::job_episodes(job),"season":job.season.unwrap_or(1),"events":events,"error":job.error})
        }).collect();
        let mut history = acquisition
            .list_history()?
            .into_iter()
            .map(|entry| serde_json::to_value(entry).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        for entry in &mut history {
            entry["events"] = json!(self
                .logs(entry["jobId"].as_str())?
                .iter()
                .take(30)
                .map(|value| format!("{} · {}", strv(value, "level"), strv(value, "message")))
                .collect::<Vec<_>>());
        }
        let mut library = self.list("library")?;
        for file in &mut library {
            file["missing"] = json!(!Path::new(strv(file, "path")).is_file());
        }
        let file_paths: std::collections::HashMap<_, _> = library
            .iter()
            .map(|file| (strv(file, "id"), strv(file, "path")))
            .collect();
        let health_jobs: Vec<_> = jobs
            .iter()
            .cloned()
            .map(|mut job| {
                if let Some(path) = file_paths.get(job.id.as_str()) {
                    job.path = (*path).to_owned();
                }
                job
            })
            .collect();
        let mut bundles = self.list("bundle")?;
        for bundle in &mut bundles {
            let members = health_jobs
                .iter()
                .filter(|j| j.source_context["bundleId"] == bundle["id"])
                .collect::<Vec<_>>();
            bundle["health"] = self.subtitle_health(&members, &subtitle_tasks);
        }
        for file in &mut library {
            file["subtitles"] = json!(subtitle_tasks
                .iter()
                .filter(|t| t["jobId"] == file["id"])
                .collect::<Vec<_>>());
        }
        let job_lookup: std::collections::HashMap<_, _> =
            jobs.iter().map(|job| (job.id.as_str(), job)).collect();
        let public_subtitles = subtitle_tasks.iter().map(|task| {
            let job = job_lookup.get(strv(task, "jobId"));
            json!({"id":task["id"],"jobId":task["jobId"],"language":task["language"],"state":task["state"],"message":task["message"],"reason":task["reason"],"nextCheckAt":task["nextCheckAt"],"quotaUntil":task["quotaUntil"],
                "ruleId":task["policy"]["ruleId"].as_str().or_else(||job.and_then(|j|j.source_context["ruleId"].as_str())),"label":job.map(|j|j.title.as_str()).unwrap_or("Downloaded video"),"bundleId":job.map(|j|&j.source_context["bundleId"]),"season":job.and_then(|j|j.season),"episodes":job.map(|j|bridge::job_episodes(j))})
        }).collect::<Vec<_>>();
        Ok(
            json!({"subtitleTasks":public_subtitles,"searches":self.public_searches()?,"recentSearches":self.recent_searches()?,"watchStates":self.list("watch-state")?,"preparations":self.list("bundle-wait")?,"indexers":self.public_indexers()?,"bundles":bundles,"version":1,"scenario":"normal","preferences":preferences,"jobs":ui_jobs,"history":history,"rules":self.list("rule")?,"library":library,"media":self.list("media")?,"logs":self.logs(None)?}),
        )
    }
}

pub(crate) fn job_changed(app: &AppHandle, job: &AcquisitionJob, previous: &str) {
    let Some(runtime) = app.try_state::<Runtime>() else {
        return;
    };
    if previous != job.status {
        let _ = runtime.log(
            if job.status == "error" {
                "error"
            } else {
                "info"
            },
            "download",
            &format!("Download {}", job.status),
            Some(&job.id),
        );
    }
    if previous != job.status && matches!(job.status.as_str(), "done" | "error") {
        if let Ok(p) = runtime.prefs() {
            if flag(&p, "notifications")
                && flag(
                    &p,
                    if job.status == "done" {
                        "notifyComplete"
                    } else {
                        "notifyError"
                    },
                )
                && !quiet_hours(&p)
            {
                use tauri_plugin_notification::NotificationExt;
                let status = if job.status == "done" {
                    "Download complete"
                } else {
                    "Download needs attention"
                };
                let body = if flag(&p, "notifyTitles") {
                    format!("{}: {status}", job.title)
                } else {
                    status.into()
                };
                if app
                    .notification()
                    .builder()
                    .title("Movie Box")
                    .body(body)
                    .show()
                    .is_err()
                {
                    let _ = runtime.log(
                        "warning",
                        "notifications",
                        "System notification could not be shown",
                        None,
                    );
                }
            }
        }
    }
    if job.status == "done" {
        let _ = runtime.schedule_subtitles(job);
    }
    if job.status == "done"
        && runtime
            .get("hidden-library", &job.id)
            .ok()
            .flatten()
            .is_none()
    {
        let file = json!({"id":job.id,"mediaId":job.media_id,"quality":job.stream_label,"size":job.received_bytes as f64/1e9,
            "missing":false,"bundleId":job.source_context["bundleId"],"episodes":bridge::job_episodes(job),"season":job.season.unwrap_or(1),"path":job.path});
        if let Err(error) = runtime.put("library", &job.id, &file) {
            eprintln!("[movibox] Could not index completed file: {error}");
        }
    }
    let _ = app.emit("movibox://backend-changed", ());
}

pub fn start(runtime: Runtime, app: AppHandle) {
    updates::start(app.clone());
    let prefs = runtime.prefs().unwrap_or_default();
    crate::tray::tray_set_prefs(
        app.clone(),
        crate::tray::TrayPrefs {
            close_to_tray: flag(&prefs, "background"),
            always_on_top: false,
            pause_minimized: false,
            pause_unfocused: false,
        },
    );
    if let Some(acquisition) = app.try_state::<AcquisitionState>() {
        for job in acquisition.list_jobs().unwrap_or_default() {
            if job.status == "done" && runtime.get("library", &job.id).ok().flatten().is_none() {
                job_changed(&app, &job, "done");
            }
        }
    }
    searches::start(runtime.clone(), app.clone());
    workflows::start(runtime.clone(), app.clone());
    scheduler::start(runtime, app);
}

pub(crate) fn concurrency(app: &AppHandle) -> usize {
    app.try_state::<Runtime>()
        .and_then(|r| r.prefs().ok())
        .map(|p| number(&p, "concurrency", 3.0).clamp(1.0, 16.0) as usize)
        .unwrap_or(3)
}
pub(crate) fn retry_limit(app: &AppHandle) -> u32 {
    app.try_state::<Runtime>()
        .and_then(|r| r.prefs().ok())
        .map(|p| number(&p, "retries", 3.0).clamp(0.0, 10.0) as u32)
        .unwrap_or(3)
}
pub(crate) fn download_policy(
    app: &AppHandle,
    job: &AcquisitionJob,
) -> crate::download::DownloadPolicy {
    let Some(runtime) = app.try_state::<Runtime>() else {
        return crate::download::DownloadPolicy::default();
    };
    let p = runtime.prefs().unwrap_or_default();
    let window = job.source_context["window"]
        .as_str()
        .unwrap_or(strv(&p, "transferWindow"))
        .to_string();
    let zone = job.source_context["timezone"]
        .as_str()
        .unwrap_or(strv(&p, "timezone"))
        .to_string();
    let bandwidth = strv(&p, "bandwidth")
        .split_whitespace()
        .next()
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0);
    crate::download::DownloadPolicy {
        allowed: Arc::new(move || scheduler::window_open(&window, &zone, now()).unwrap_or(false)),
        bytes_per_second: bandwidth * 1_000_000 / concurrency(app) as u64,
        reserve_bytes: (number(&p, "reserve", 10.0).max(0.0) * 1e9) as u64,
        max_bytes: (number(&p, "maxSize", 40.0).max(0.0) * 1e9) as u64,
    }
}

fn quiet_hours(p: &Value) -> bool {
    use chrono::Timelike;
    let zone = strv(p, "timezone")
        .parse::<chrono_tz::Tz>()
        .unwrap_or(chrono_tz::UTC);
    let hour = chrono::Utc::now().with_timezone(&zone).hour();
    match strv(p, "quietHours") {
        "22:00–08:00" => hour >= 22 || hour < 8,
        "23:00–07:00" => hour >= 23 || hour < 7,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
