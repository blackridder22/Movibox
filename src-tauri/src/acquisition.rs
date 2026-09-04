use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::download::{DownloadEnd, DownloadEvent, DownloadSink};

const ACQUISITION_EVENT: &str = "movibox://acquisition-updated";
#[allow(dead_code)]
const AUTOMATION_EVENT: &str = "movibox://automation-due";
const DEFAULT_CHECK_INTERVAL_MINUTES: i64 = 360;
static ENQUEUE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone)]
pub struct AcquisitionState {
    pub(crate) db: Arc<Mutex<Connection>>,
    tasks: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    slots: Arc<Semaphore>,
    transfers: Arc<Mutex<usize>>,
}

// A paused transfer holds its slot until its file writer actually stops.
struct TransferSlot(Arc<Mutex<usize>>);
impl TransferSlot {
    fn claim(active: &Arc<Mutex<usize>>, limit: usize) -> Option<Self> {
        let mut count = active.lock().ok()?;
        if *count >= limit {
            return None;
        }
        *count += 1;
        Some(Self(active.clone()))
    }
}
impl Drop for TransferSlot {
    fn drop(&mut self) {
        if let Ok(mut count) = self.0.lock() {
            *count = count.saturating_sub(1);
        }
    }
}
fn worker_can_update(status: &str, cancel: &AtomicBool) -> bool {
    !cancel.load(Ordering::Relaxed)
        && !matches!(status, "paused" | "canceled" | "canceling" | "done")
}

impl AcquisitionState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("resolve app data directory: {error}"))?;
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("create app data directory: {error}"))?;
        let connection = Connection::open(dir.join("movibox.sqlite3"))
            .map_err(|error| format!("open acquisition database: {error}"))?;
        Self::from_connection(connection)
    }

    pub(crate) fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 CREATE TABLE IF NOT EXISTS acquisition_jobs (
                   id TEXT PRIMARY KEY NOT NULL,
                   payload TEXT NOT NULL,
                   status TEXT NOT NULL,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS acquisition_jobs_status
                   ON acquisition_jobs(status, updated_at DESC);
                 CREATE TABLE IF NOT EXISTS acquisition_history (
                   id TEXT PRIMARY KEY NOT NULL,
                   job_id TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   status TEXT NOT NULL,
                   finished_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS acquisition_history_finished
                   ON acquisition_history(finished_at DESC);
                 CREATE INDEX IF NOT EXISTS acquisition_history_job
                   ON acquisition_history(job_id, finished_at DESC);
                 CREATE TABLE IF NOT EXISTS acquisition_metadata (
                   key TEXT PRIMARY KEY NOT NULL,
                   value TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS automation_rules (
                   meta_id TEXT PRIMARY KEY NOT NULL,
                   payload TEXT NOT NULL,
                   enabled INTEGER NOT NULL,
                   next_check_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS automation_rules_due
                   ON automation_rules(enabled, next_check_at);",
            )
            .map_err(|error| format!("initialize acquisition database: {error}"))?;
        let state = Self {
            db: Arc::new(Mutex::new(connection)),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(16)),
            transfers: Arc::default(),
        };
        let needs_history_backfill = state
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?
            .query_row(
                "SELECT value FROM acquisition_metadata WHERE key='history-backfill-v1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_none();
        if needs_history_backfill {
            for job in state.list_jobs()? {
                state.record_history(&job, "")?;
            }
            state
                .db
                .lock()
                .map_err(|_| "acquisition database lock poisoned".to_string())?
                .execute(
                    "INSERT INTO acquisition_metadata (key, value) VALUES ('history-backfill-v1', 'complete')",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(state)
    }

    pub(crate) fn task_running(&self, id: &str) -> bool {
        self.tasks
            .lock()
            .map(|tasks| tasks.contains_key(id))
            .unwrap_or(true)
    }
    pub(crate) fn save_job(&self, job: &AcquisitionJob) -> Result<(), String> {
        let payload = serde_json::to_string(job).map_err(|error| error.to_string())?;
        self.db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?
            .execute(
                "INSERT INTO acquisition_jobs (id, payload, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                   payload=excluded.payload,
                   status=excluded.status,
                   updated_at=excluded.updated_at",
                params![job.id, payload, job.status, job.created_at, job.updated_at],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn load_job(&self, id: &str) -> Result<Option<AcquisitionJob>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        let payload = db
            .query_row(
                "SELECT payload FROM acquisition_jobs WHERE id=?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        payload
            .map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
            .transpose()
    }

    pub(crate) fn update_job(
        &self,
        id: &str,
        update: impl FnOnce(&mut AcquisitionJob),
    ) -> Result<AcquisitionJob, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        let raw = db
            .query_row(
                "SELECT payload FROM acquisition_jobs WHERE id=?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "download job not found".to_string())?;
        let mut job: AcquisitionJob =
            serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let previous_status = job.status.clone();
        update(&mut job);
        job.updated_at = now_ms();
        let payload = serde_json::to_string(&job).map_err(|error| error.to_string())?;
        db.execute(
            "UPDATE acquisition_jobs SET payload=?2, status=?3, updated_at=?4 WHERE id=?1",
            params![job.id, payload, job.status, job.updated_at],
        )
        .map_err(|error| error.to_string())?;
        archive_history(&db, &job, &previous_status)?;
        Ok(job)
    }

    pub(crate) fn list_jobs(&self) -> Result<Vec<AcquisitionJob>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        let mut statement = db
            .prepare("SELECT payload FROM acquisition_jobs ORDER BY created_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut jobs = Vec::new();
        for row in rows {
            let raw = row.map_err(|error| error.to_string())?;
            if let Ok(job) = serde_json::from_str(&raw) {
                jobs.push(job);
            }
        }
        Ok(jobs)
    }

    fn record_history(&self, job: &AcquisitionJob, previous_status: &str) -> Result<(), String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        archive_history(&db, job, previous_status)
    }

    pub(crate) fn list_history(&self) -> Result<Vec<AcquisitionHistoryEntry>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        let mut statement = db
            .prepare("SELECT payload FROM acquisition_history ORDER BY finished_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut history = Vec::new();
        for row in rows {
            let raw = row.map_err(|error| error.to_string())?;
            if let Ok(mut entry) = serde_json::from_str::<AcquisitionHistoryEntry>(&raw) {
                entry.file_exists = Path::new(&entry.destination).is_file();
                history.push(entry);
            }
        }
        Ok(history)
    }

    pub(crate) fn load_history(&self, id: &str) -> Result<Option<AcquisitionHistoryEntry>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        let payload = db
            .query_row(
                "SELECT payload FROM acquisition_history WHERE id=?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        payload
            .map(|raw| {
                let mut entry: AcquisitionHistoryEntry =
                    serde_json::from_str(&raw).map_err(|error| error.to_string())?;
                entry.file_exists = Path::new(&entry.destination).is_file();
                Ok(entry)
            })
            .transpose()
    }

    pub(crate) fn remove_history(&self, ids: &[String]) -> Result<usize, String> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?;
        let transaction = db.transaction().map_err(|error| error.to_string())?;
        let mut removed = 0;
        for id in ids.iter().take(1_000) {
            removed += transaction
                .execute("DELETE FROM acquisition_history WHERE id=?1", params![id])
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(removed)
    }

    pub(crate) fn clear_history(&self) -> Result<usize, String> {
        self.db
            .lock()
            .map_err(|_| "acquisition database lock poisoned".to_string())?
            .execute("DELETE FROM acquisition_history", [])
            .map_err(|error| error.to_string())
    }

    fn list_rules(&self) -> Result<Vec<AutomationRule>, String> {
        let db = self
            .db
            .lock()
            .map_err(|_| "automation database lock poisoned".to_string())?;
        let mut statement = db
            .prepare("SELECT payload FROM automation_rules ORDER BY updated_at DESC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut rules = Vec::new();
        for row in rows {
            let raw = row.map_err(|error| error.to_string())?;
            if let Ok(rule) = serde_json::from_str(&raw) {
                rules.push(rule);
            }
        }
        Ok(rules)
    }

    fn due_rules(&self) -> Result<Vec<AutomationRule>, String> {
        let now = now_ms();
        Ok(self
            .list_rules()?
            .into_iter()
            .filter(|rule| rule.enabled && rule.next_check_at <= now)
            .collect())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionJob {
    pub id: String,
    pub media_id: String,
    pub media_type: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub poster: Option<String>,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    pub stream_label: Option<String>,
    pub provider: Option<String>,
    pub info_hash: Option<String>,
    pub file_index: Option<i32>,
    #[serde(default)]
    pub source_context: Value,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub path: String,
    pub status: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub attempt: u32,
    #[serde(default)]
    pub scheduled_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionHistoryEntry {
    pub id: String,
    pub job_id: String,
    pub media_id: String,
    pub label: String,
    pub status: String,
    pub quality: String,
    pub provider: Option<String>,
    pub destination: String,
    pub size: f64,
    pub season: i32,
    pub episodes: Vec<i32>,
    pub attempt: u32,
    pub started_at: i64,
    pub finished_at: i64,
    pub trigger: String,
    pub rule_id: Option<String>,
    pub bundle_id: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub file_exists: bool,
}

fn archive_history(
    db: &Connection,
    job: &AcquisitionJob,
    previous_status: &str,
) -> Result<(), String> {
    if previous_status == job.status
        || !matches!(job.status.as_str(), "done" | "error" | "canceled")
    {
        return Ok(());
    }
    let finished_at = job.completed_at.unwrap_or(job.updated_at);
    let status = match job.status.as_str() {
        "done" => "completed",
        "error" => "failed",
        _ => "canceled",
    };
    let history_id = format!("{}:{}:{}", job.id, status, finished_at);
    if db
        .query_row(
            "SELECT 1 FROM acquisition_history WHERE id=?1",
            params![history_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }
    let attempt = {
        let mut statement = db
            .prepare("SELECT payload FROM acquisition_history WHERE job_id=?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![job.id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut highest = 0;
        for row in rows {
            if let Ok(entry) = serde_json::from_str::<AcquisitionHistoryEntry>(
                &row.map_err(|error| error.to_string())?,
            ) {
                highest = highest.max(entry.attempt);
            }
        }
        highest.saturating_add(1)
    };
    let episodes = job.source_context["episodes"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_i64().map(|number| number as i32))
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| job.episode.into_iter().collect());
    let rule_id = job.source_context["ruleId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let entry = AcquisitionHistoryEntry {
        id: history_id,
        job_id: job.id.clone(),
        media_id: job.media_id.clone(),
        label: job.title.clone(),
        status: status.into(),
        quality: job.stream_label.clone().unwrap_or_default(),
        provider: job.provider.clone(),
        destination: job.path.clone(),
        size: ((job.total_bytes.unwrap_or(job.received_bytes) as f64 / 1e9) * 100.0).round()
            / 100.0,
        season: job.season.unwrap_or(1),
        episodes,
        attempt,
        started_at: job.created_at,
        finished_at,
        trigger: if rule_id.is_some() {
            "monitoring"
        } else {
            "manual"
        }
        .into(),
        rule_id,
        bundle_id: job.source_context["bundleId"]
            .as_str()
            .map(ToOwned::to_owned),
        error: job.error.clone(),
        file_exists: Path::new(&job.path).is_file(),
    };
    let payload = serde_json::to_string(&entry).map_err(|error| error.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO acquisition_history (id, job_id, payload, status, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            entry.id,
            entry.job_id,
            payload,
            entry.status,
            entry.finished_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueAcquisition {
    pub media_id: String,
    pub media_type: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub poster: Option<String>,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    pub stream_label: Option<String>,
    pub provider: Option<String>,
    pub info_hash: Option<String>,
    pub file_index: Option<i32>,
    #[serde(default)]
    pub source_context: Value,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub path: String,
    pub scheduled_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeSelection {
    pub season: i32,
    pub episode: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRule {
    pub meta_id: String,
    pub media_type: String,
    pub title: String,
    pub poster: Option<String>,
    #[serde(default)]
    pub meta: Value,
    #[serde(default)]
    pub seasons: Vec<i32>,
    #[serde(default)]
    pub episodes: Vec<EpisodeSelection>,
    pub include_future: bool,
    pub missing_only: bool,
    #[serde(default)]
    pub unwatched_only: bool,
    pub quality_profile: String,
    #[serde(default)]
    pub audio_language: Option<String>,
    #[serde(default)]
    pub subtitle_language: Option<String>,
    pub destination: Option<String>,
    pub enabled: bool,
    pub check_interval_minutes: i64,
    pub next_check_at: i64,
    pub last_checked_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRuleInput {
    pub meta_id: String,
    pub media_type: String,
    pub title: String,
    pub poster: Option<String>,
    #[serde(default)]
    pub meta: Value,
    #[serde(default)]
    pub seasons: Vec<i32>,
    #[serde(default)]
    pub episodes: Vec<EpisodeSelection>,
    pub include_future: bool,
    pub missing_only: bool,
    #[serde(default)]
    pub unwatched_only: bool,
    pub quality_profile: Option<String>,
    pub audio_language: Option<String>,
    pub subtitle_language: Option<String>,
    pub destination: Option<String>,
    pub enabled: Option<bool>,
    pub check_interval_minutes: Option<i64>,
    pub next_check_at: Option<i64>,
}

#[tauri::command]
pub fn acquisition_list(state: State<'_, AcquisitionState>) -> Result<Vec<AcquisitionJob>, String> {
    state.list_jobs()
}

#[tauri::command]
pub fn acquisition_enqueue(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
    input: EnqueueAcquisition,
) -> Result<AcquisitionJob, String> {
    enqueue_native(app, &state, input)
}

pub(crate) fn enqueue_native(
    app: AppHandle,
    state: &AcquisitionState,
    input: EnqueueAcquisition,
) -> Result<AcquisitionJob, String> {
    let _guard = ENQUEUE_LOCK.lock().map_err(|_| "Queue unavailable")?;
    let existing = state.list_jobs()?.into_iter().find(|job| {
        job.media_id == input.media_id
            && job.media_type == input.media_type
            && job.season == input.season
            && job.episode == input.episode
            && !matches!(job.status.as_str(), "error" | "canceled")
            && (job.status != "done"
                || (Path::new(&job.path).is_file()
                    && input.source_context["skipDuplicates"] != false
                    && job.stream_label.as_deref().unwrap_or("").split('·').next()
                        == input
                            .stream_label
                            .as_deref()
                            .unwrap_or("")
                            .split('·')
                            .next()))
    });
    if let Some(job) = existing {
        return Ok(job);
    }
    let job = build_job(input, &state.list_jobs()?);
    state.save_job(&job)?;
    emit_job(&app, &job);
    spawn_job(state.clone(), app, job.id.clone());
    Ok(job)
}

fn build_job(input: EnqueueAcquisition, reserved: &[AcquisitionJob]) -> AcquisitionJob {
    let now = now_ms();
    let scheduled_at = input.scheduled_at.filter(|value| *value > now);
    let mut path = unique_path(&input.path);
    if reserved
        .iter()
        .any(|j| j.path == path && !matches!(j.status.as_str(), "canceled" | "error"))
    {
        let original = Path::new(&path);
        let parent = original.parent().unwrap_or(Path::new(""));
        let stem = original
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("download");
        let extension = original
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("mkv");
        path = unique_path(
            &parent
                .join(format!("{stem}-{}.{extension}", Uuid::new_v4()))
                .to_string_lossy(),
        );
    }
    AcquisitionJob {
        id: Uuid::new_v4().to_string(),
        media_id: input.media_id,
        media_type: input.media_type,
        title: input.title,
        subtitle: input.subtitle,
        poster: input.poster,
        season: input.season,
        episode: input.episode,
        stream_label: input.stream_label,
        provider: input.provider,
        info_hash: input.info_hash,
        file_index: input.file_index,
        source_context: input.source_context,
        url: input.url,
        headers: input.headers,
        path,
        status: if scheduled_at.is_some() {
            "scheduled".to_string()
        } else {
            "queued".to_string()
        },
        received_bytes: 0,
        total_bytes: None,
        error: None,
        attempt: 0,
        scheduled_at,
        created_at: now,
        updated_at: now,
        completed_at: None,
    }
}

/// Persist the group and all its file jobs in one transaction before starting workers.
pub(crate) fn enqueue_bundle_native(
    app: AppHandle,
    state: &AcquisitionState,
    id: &str,
    bundle: Value,
    inputs: Vec<EnqueueAcquisition>,
) -> Result<Value, String> {
    let (bundle, jobs) = persist_bundle(state, id, bundle, inputs)?;
    for job in jobs {
        emit_job(&app, &job);
        spawn_job(state.clone(), app.clone(), job.id);
    }
    Ok(bundle)
}

pub(crate) fn persist_bundle(
    state: &AcquisitionState,
    id: &str,
    mut bundle: Value,
    inputs: Vec<EnqueueAcquisition>,
) -> Result<(Value, Vec<AcquisitionJob>), String> {
    let _guard = ENQUEUE_LOCK.lock().map_err(|_| "Queue unavailable")?;
    let mut reserved = state.list_jobs()?;
    let mut db = state.db.lock().map_err(|_| "Queue unavailable")?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let saved: Option<String> = tx
        .query_row(
            "SELECT payload FROM moviebox_documents WHERE kind='bundle' AND id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(saved) = saved {
        return Ok((
            serde_json::from_str(&saved).map_err(|e| e.to_string())?,
            Vec::new(),
        ));
    }
    let mut jobs = Vec::new();
    for input in inputs {
        let episodes = input.source_context["episodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        // A concurrent manual/scheduled request must not take ownership of another job.
        if reserved.iter().any(|j| {
            j.media_id == input.media_id
                && j.season == input.season
                && !matches!(j.status.as_str(), "canceled" | "error")
                && (j.status != "done" || Path::new(&j.path).is_file())
                && episodes.iter().any(|e| {
                    j.source_context["episodes"]
                        .as_array()
                        .is_some_and(|es| es.contains(e))
                        || j.episode.map(|n| serde_json::json!(n)).as_ref() == Some(e)
                })
        }) {
            return Err("An episode was queued while this review was open. Find sources again to refresh coverage.".into());
        }
        let job = build_job(input, &reserved);
        reserved.push(job.clone());
        jobs.push(job);
    }
    bundle["jobIds"] = serde_json::json!(jobs.iter().map(|j| &j.id).collect::<Vec<_>>());
    tx.execute(
        "INSERT INTO moviebox_documents(kind,id,payload) VALUES('bundle',?1,?2)",
        params![id, bundle.to_string()],
    )
    .map_err(|e| e.to_string())?;
    for job in &jobs {
        tx.execute("INSERT INTO acquisition_jobs(id,payload,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5)",params![job.id,serde_json::to_string(job).map_err(|e|e.to_string())?,job.status,job.created_at,job.updated_at]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(db);
    Ok((bundle, jobs))
}

#[tauri::command]
pub fn acquisition_pause(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
    id: String,
) -> Result<AcquisitionJob, String> {
    let current = state.load_job(&id)?.ok_or("Download not found")?;
    if matches!(current.status.as_str(), "done" | "canceled") {
        return Err("This download cannot be paused".into());
    }
    let job = state.update_job(&id, |job| {
        if !matches!(job.status.as_str(), "done" | "canceled") {
            job.status = "paused".into();
        }
    })?;
    if let Some(flag) = state
        .tasks
        .lock()
        .map_err(|_| "download task lock poisoned".to_string())?
        .get(&id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    emit_job(&app, &job);
    Ok(job)
}

#[tauri::command]
pub fn acquisition_resume(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
    id: String,
) -> Result<AcquisitionJob, String> {
    if state.load_job(&id)?.is_some_and(|j| j.status == "done") {
        return Err("This download is already complete".into());
    }
    let now = now_ms();
    let job = state.update_job(&id, |job| {
        job.status = if job.scheduled_at.is_some_and(|at| at > now) {
            "scheduled".to_string()
        } else {
            "queued".to_string()
        };
        job.error = None;
    })?;
    emit_job(&app, &job);
    spawn_job(state.inner().clone(), app, id);
    Ok(job)
}

#[tauri::command]
pub fn acquisition_pause_all(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
) -> Result<Vec<AcquisitionJob>, String> {
    let ids: Vec<String> = state
        .list_jobs()?
        .into_iter()
        .filter(|job| {
            matches!(
                job.status.as_str(),
                "queued" | "scheduled" | "downloading" | "preparing"
            )
        })
        .map(|job| job.id)
        .collect();
    let mut updated = Vec::with_capacity(ids.len());
    for id in ids {
        updated.push(acquisition_pause(app.clone(), state.clone(), id)?);
    }
    Ok(updated)
}

#[tauri::command]
pub fn acquisition_resume_all(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
) -> Result<Vec<AcquisitionJob>, String> {
    let ids: Vec<String> = state
        .list_jobs()?
        .into_iter()
        .filter(|job| job.status == "paused")
        .map(|job| job.id)
        .collect();
    let mut updated = Vec::with_capacity(ids.len());
    for id in ids {
        updated.push(acquisition_resume(app.clone(), state.clone(), id)?);
    }
    Ok(updated)
}

#[tauri::command]
pub fn acquisition_cancel(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
    id: String,
) -> Result<AcquisitionJob, String> {
    let job = state.update_job(&id, |job| {
        if job.status != "done" {
            job.status = "canceled".into();
        }
    })?;
    if let Some(flag) = state
        .tasks
        .lock()
        .map_err(|_| "download task lock poisoned".to_string())?
        .get(&id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    emit_job(&app, &job);
    Ok(job)
}

#[tauri::command]
pub fn acquisition_retry(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
    id: String,
) -> Result<AcquisitionJob, String> {
    let job = state.update_job(&id, |job| {
        job.status = "queued".to_string();
        job.error = None;
        job.completed_at = None;
        job.attempt = 0;
        job.scheduled_at = None;
    })?;
    emit_job(&app, &job);
    spawn_job(state.inner().clone(), app, id);
    Ok(job)
}

#[tauri::command]
pub fn acquisition_refresh_source(
    app: AppHandle,
    state: State<'_, AcquisitionState>,
    id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    provider: Option<String>,
    source_context: Option<Value>,
) -> Result<AcquisitionJob, String> {
    let job = state.update_job(&id, |job| {
        job.url = url;
        job.headers = headers.unwrap_or_default();
        if provider.is_some() {
            job.provider = provider;
        }
        if let Some(context) = source_context {
            job.source_context = context;
        }
        job.status = "queued".to_string();
        job.error = None;
        job.attempt = 0;
        job.scheduled_at = None;
    })?;
    emit_job(&app, &job);
    spawn_job(state.inner().clone(), app, id);
    Ok(job)
}

#[tauri::command]
pub fn acquisition_remove(
    state: State<'_, AcquisitionState>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    if let Some(flag) = state
        .tasks
        .lock()
        .map_err(|_| "download task lock poisoned".to_string())?
        .get(&id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    let job = state.load_job(&id)?;
    state
        .db
        .lock()
        .map_err(|_| "acquisition database lock poisoned".to_string())?
        .execute("DELETE FROM acquisition_jobs WHERE id=?1", params![id])
        .map_err(|error| error.to_string())?;
    if delete_file {
        if let Some(job) = job {
            let _ = std::fs::remove_file(&job.path);
            let _ = std::fs::remove_file(format!("{}.part", job.path));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn acquisition_reveal(state: State<'_, AcquisitionState>, id: String) -> Result<(), String> {
    let job = state
        .load_job(&id)?
        .ok_or_else(|| "download job not found".to_string())?;
    reveal_path(Path::new(&job.path))
}

#[tauri::command]
pub fn acquisition_open(state: State<'_, AcquisitionState>, id: String) -> Result<(), String> {
    let job = state
        .load_job(&id)?
        .ok_or_else(|| "download job not found".to_string())?;
    if job.status != "done" || !Path::new(&job.path).is_file() {
        return Err("download is not complete".to_string());
    }
    open_path(Path::new(&job.path))
}

#[tauri::command]
pub fn automation_list(state: State<'_, AcquisitionState>) -> Result<Vec<AutomationRule>, String> {
    state.list_rules()
}

#[tauri::command]
pub fn automation_due(state: State<'_, AcquisitionState>) -> Result<Vec<AutomationRule>, String> {
    state.due_rules()
}

#[tauri::command]
pub fn automation_upsert(
    state: State<'_, AcquisitionState>,
    input: AutomationRuleInput,
) -> Result<AutomationRule, String> {
    let now = now_ms();
    let existing = state
        .list_rules()?
        .into_iter()
        .find(|rule| rule.meta_id == input.meta_id);
    let interval = input
        .check_interval_minutes
        .unwrap_or(DEFAULT_CHECK_INTERVAL_MINUTES)
        .clamp(15, 10_080);
    let rule = AutomationRule {
        meta_id: input.meta_id,
        media_type: input.media_type,
        title: input.title,
        poster: input.poster,
        meta: input.meta,
        seasons: input.seasons,
        episodes: input.episodes,
        include_future: input.include_future,
        missing_only: input.missing_only,
        unwatched_only: input.unwatched_only,
        quality_profile: input
            .quality_profile
            .unwrap_or_else(|| "balanced".to_string()),
        audio_language: input.audio_language,
        subtitle_language: input.subtitle_language,
        destination: input.destination,
        enabled: input.enabled.unwrap_or(true),
        check_interval_minutes: interval,
        next_check_at: input.next_check_at.unwrap_or(now).max(now),
        last_checked_at: existing.as_ref().and_then(|rule| rule.last_checked_at),
        created_at: existing.as_ref().map(|rule| rule.created_at).unwrap_or(now),
        updated_at: now,
    };
    let payload = serde_json::to_string(&rule).map_err(|error| error.to_string())?;
    state
        .db
        .lock()
        .map_err(|_| "automation database lock poisoned".to_string())?
        .execute(
            "INSERT INTO automation_rules (meta_id, payload, enabled, next_check_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(meta_id) DO UPDATE SET
               payload=excluded.payload,
               enabled=excluded.enabled,
               next_check_at=excluded.next_check_at,
               updated_at=excluded.updated_at",
            params![
                rule.meta_id,
                payload,
                rule.enabled,
                rule.next_check_at,
                rule.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(rule)
}

#[tauri::command]
pub fn automation_mark_checked(
    state: State<'_, AcquisitionState>,
    meta_id: String,
) -> Result<AutomationRule, String> {
    let mut rule = state
        .list_rules()?
        .into_iter()
        .find(|rule| rule.meta_id == meta_id)
        .ok_or_else(|| "automation rule not found".to_string())?;
    let now = now_ms();
    rule.last_checked_at = Some(now);
    rule.next_check_at = now + rule.check_interval_minutes * 60_000;
    if !rule.include_future {
        rule.enabled = false;
    }
    rule.updated_at = now;
    save_rule(&state, &rule)?;
    Ok(rule)
}

#[tauri::command]
pub fn automation_remove(
    state: State<'_, AcquisitionState>,
    meta_id: String,
) -> Result<(), String> {
    state
        .db
        .lock()
        .map_err(|_| "automation database lock poisoned".to_string())?
        .execute(
            "DELETE FROM automation_rules WHERE meta_id=?1",
            params![meta_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn completed_on_disk(job: &AcquisitionJob) -> bool {
    job.status == "downloading"
        && !Path::new(&format!("{}.part", job.path)).exists()
        && std::fs::metadata(&job.path)
            .is_ok_and(|m| m.is_file() && m.len() >= 512 * 1024 && Some(m.len()) == job.total_bytes)
}

pub fn resume_pending(state: AcquisitionState, app: AppHandle) {
    if let Ok(jobs) = state.list_jobs() {
        for job in jobs {
            if completed_on_disk(&job) {
                if let Ok(updated) = state.update_job(&job.id, |j| {
                    j.status = "done".into();
                    j.received_bytes = j.total_bytes.unwrap_or(0);
                    j.completed_at = Some(now_ms());
                    j.error = None;
                }) {
                    emit_job(&app, &updated);
                }
                continue;
            }
            if job.status == "canceling" {
                let _ = state.update_job(&job.id, |j| j.status = "canceled".into());
            } else if matches!(
                job.status.as_str(),
                "queued"
                    | "downloading"
                    | "interrupted"
                    | "scheduled"
                    | "preparing"
                    | "needsResolution"
            ) {
                let _ = state.update_job(&job.id, |j| j.status = "queued".into());
                spawn_job(state.clone(), app.clone(), job.id);
            }
        }
    }
}

#[allow(dead_code)]
pub fn start_automation_scheduler(state: AcquisitionState, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            let due = state.due_rules().unwrap_or_default();
            if due.is_empty() {
                continue;
            }
            let _ = app.emit(AUTOMATION_EVENT, due.clone());
            let defer_until = now_ms() + 15 * 60_000;
            for mut rule in due {
                rule.next_check_at = defer_until;
                rule.updated_at = now_ms();
                let _ = save_rule(&state, &rule);
            }
        }
    });
}

pub(crate) fn spawn_job(state: AcquisitionState, app: AppHandle, id: String) {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let Ok(mut tasks) = state.tasks.lock() else {
            return;
        };
        if tasks.contains_key(&id) {
            return;
        }
        tasks.insert(id.clone(), cancel.clone());
    }
    tauri::async_runtime::spawn(async move {
        let mut source_refreshes = 0;
        let mut preparation_failures = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                finish_stopped(&state, &app, &id);
                return;
            }
            let Some(mut job) = state.load_job(&id).ok().flatten() else {
                break;
            };
            if matches!(
                job.status.as_str(),
                "paused" | "canceled" | "canceling" | "done" | "error"
            ) {
                break;
            }
            let policy = crate::moviebox::download_policy(&app, &job);
            if job.scheduled_at.is_some_and(|at| at > now_ms()) || !(policy.allowed)() {
                if job.status != "scheduled" {
                    set_status(&state, &cancel, &app, &id, "scheduled", None);
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            }
            if job.source_context["moviebox"] == true && job.url.is_empty() {
                set_status(&state, &cancel, &app, &id, "preparing", None);
                let resolution = tokio::select! {
                    value = crate::moviebox::resolve_job(&app,&state,&job,&cancel) => value,
                    _ = crate::download::wait_cancelled(&cancel) => { finish_stopped(&state,&app,&id); return; }
                };
                match resolution {
                    Ok(Some((url, headers))) => {
                        if let Ok(updated) = state.update_job(&id, |j| {
                            if worker_can_update(&j.status, &cancel) {
                                j.url = url;
                                j.headers = headers;
                                j.status = "queued".into();
                            }
                        }) {
                            job = updated;
                            preparation_failures = 0;
                        }
                    }
                    Ok(None) => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    }
                    Err(error) => {
                        preparation_failures += 1;
                        if preparation_failures <= crate::moviebox::retry_limit(&app) {
                            set_status(&state, &cancel, &app, &id, "preparing", Some(error));
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(2_u64.pow(preparation_failures.min(6)))) => {},
                                _ = crate::download::wait_cancelled(&cancel) => { finish_stopped(&state, &app, &id); return; }
                            }
                            continue;
                        }
                        set_status(&state, &cancel, &app, &id, "error", Some(error));
                        break;
                    }
                }
            }
            if job.url.trim().is_empty() {
                set_status(
                    &state,
                    &cancel,
                    &app,
                    &id,
                    "needsResolution",
                    Some("A fresh source is required".into()),
                );
                break;
            }
            let permit = tokio::select! {
                permit=state.slots.clone().acquire_owned()=>permit,
                _=crate::download::wait_cancelled(&cancel)=>{finish_stopped(&state,&app,&id);return;}
            };
            let Ok(permit) = permit else { break };
            if cancel.load(Ordering::Relaxed) {
                drop(permit);
                finish_stopped(&state, &app, &id);
                return;
            }
            let first_ready = state
                .list_jobs()
                .unwrap_or_default()
                .into_iter()
                .filter(|j| {
                    j.status == "queued"
                        && !j.url.is_empty()
                        && j.scheduled_at.is_none_or(|at| at <= now_ms())
                })
                .min_by_key(|j| {
                    (
                        -j.source_context["queuePriority"].as_i64().unwrap_or(0),
                        j.created_at,
                    )
                });
            if first_ready.is_some_and(|j| j.id != id) {
                drop(permit);
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                continue;
            }
            let Some(transfer) =
                TransferSlot::claim(&state.transfers, crate::moviebox::concurrency(&app))
            else {
                drop(permit);
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                continue;
            };
            match state.update_job(&id, |j| {
                if worker_can_update(&j.status, &cancel) {
                    j.status = "downloading".into();
                    j.error = None;
                    j.attempt = j.attempt.saturating_add(1);
                }
            }) {
                Ok(updated) if updated.status == "downloading" => {
                    job = updated;
                    emit_job(&app, &job);
                }
                _ => {
                    drop(transfer);
                    drop(permit);
                    finish_stopped(&state, &app, &id);
                    return;
                }
            }
            let progress_state = state.clone();
            let progress_app = app.clone();
            let progress_id = id.clone();
            let sink: DownloadSink = Arc::new(move |event| {
                let (received, total) = match event {
                    DownloadEvent::Started { total, resumed } => (resumed, total),
                    DownloadEvent::Progress { received, total } => (received, total),
                    DownloadEvent::Done { received } => (received, Some(received)),
                    _ => return,
                };
                if let Ok(updated) = progress_state.update_job(&progress_id, |j| {
                    j.received_bytes = received;
                    j.total_bytes = total;
                }) {
                    emit_job(&progress_app, &updated);
                }
            });
            let outcome = crate::download::run_download_with_policy(
                &job.url,
                &job.path,
                &job.headers,
                &cancel,
                &sink,
                &policy,
            )
            .await;
            drop(transfer);
            drop(permit);
            if outcome.is_err() && cancel.load(Ordering::Relaxed) {
                finish_stopped(&state, &app, &id);
                return;
            }
            match outcome {
                Ok(()) => {
                    if let Ok(updated) = state.update_job(&id, |j| {
                        j.status = "done".into();
                        j.completed_at = Some(now_ms());
                        j.error = None;
                    }) {
                        emit_job(&app, &updated);
                    }
                    break;
                }
                Err(DownloadEnd::Deferred) => {
                    set_status(&state, &cancel, &app, &id, "scheduled", None);
                    continue;
                }
                Err(DownloadEnd::Canceled(_)) => {
                    finish_stopped(&state, &app, &id);
                    return;
                }
                Err(DownloadEnd::Failed(message)) => {
                    if source_needs_refresh(&message)
                        && job.source_context["moviebox"] == true
                        && source_refreshes < 2
                    {
                        source_refreshes += 1;
                        let _ = state.update_job(&id, |j| j.url.clear());
                        set_status(
                            &state,
                            &cancel,
                            &app,
                            &id,
                            "queued",
                            Some("Refreshing expired source link".into()),
                        );
                        continue;
                    }
                    let max = crate::moviebox::retry_limit(&app);
                    if job.attempt <= max && !source_needs_refresh(&message) {
                        set_status(&state, &cancel, &app, &id, "queued", Some(message));
                        tokio::select! {
                            _=tokio::time::sleep(std::time::Duration::from_secs(2_u64.pow(job.attempt.min(6)+1)))=>{},
                            _=crate::download::wait_cancelled(&cancel)=>{finish_stopped(&state,&app,&id);return;}
                        }
                        continue;
                    }
                    set_status(&state, &cancel, &app, &id, "error", Some(message));
                    break;
                }
            }
        }
        finish_stopped(&state, &app, &id);
    });
}
fn set_status(
    state: &AcquisitionState,
    cancel: &AtomicBool,
    app: &AppHandle,
    id: &str,
    status: &str,
    error: Option<String>,
) {
    if let Ok(job) = state.update_job(id, |j| {
        if worker_can_update(&j.status, cancel) {
            j.status = status.into();
            j.error = error;
        }
    }) {
        emit_job(app, &job);
    }
}

fn finish_stopped(state: &AcquisitionState, app: &AppHandle, id: &str) {
    // Remove first: a resume racing with cleanup must either see no worker or be
    // observed here. Never overwrite a persisted pause/cancel with worker state.
    remove_task(state, id);
    if state
        .load_job(id)
        .ok()
        .flatten()
        .is_some_and(|j| matches!(j.status.as_str(), "queued" | "scheduled"))
    {
        spawn_job(state.clone(), app.clone(), id.into());
    }
}

fn remove_task(state: &AcquisitionState, id: &str) {
    if let Ok(mut tasks) = state.tasks.lock() {
        tasks.remove(id);
    }
}

fn emit_job(app: &AppHandle, job: &AcquisitionJob) {
    static STATUSES: std::sync::LazyLock<Mutex<HashMap<String, String>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    let previous = STATUSES
        .lock()
        .ok()
        .and_then(|mut statuses| statuses.insert(job.id.clone(), job.status.clone()))
        .unwrap_or_default();
    crate::moviebox::job_changed(app, job, &previous);
    if job.source_context["moviebox"] != true {
        let _ = app.emit(ACQUISITION_EVENT, job);
    }
}

fn save_rule(state: &AcquisitionState, rule: &AutomationRule) -> Result<(), String> {
    let payload = serde_json::to_string(rule).map_err(|error| error.to_string())?;
    state
        .db
        .lock()
        .map_err(|_| "automation database lock poisoned".to_string())?
        .execute(
            "UPDATE automation_rules SET payload=?2, enabled=?3, next_check_at=?4, updated_at=?5
             WHERE meta_id=?1",
            params![
                rule.meta_id,
                payload,
                rule.enabled,
                rule.next_check_at,
                rule.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn unique_path(value: &str) -> String {
    let path = PathBuf::from(value);
    if !path.exists() && !PathBuf::from(format!("{}.part", value)).exists() {
        return value.to_string();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 2..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = parent.join(name);
        let raw = candidate.to_string_lossy().to_string();
        if !candidate.exists() && !PathBuf::from(format!("{}.part", raw)).exists() {
            return raw;
        }
    }
    value.to_string()
}

pub(crate) fn source_needs_refresh(message: &str) -> bool {
    ["HTTP 401", "HTTP 403", "HTTP 404"]
        .iter()
        .any(|needle| message.contains(needle))
}

pub(crate) fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status();
    #[cfg(windows)]
    let status = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .status();
    status
        .map_err(|error| format!("reveal file: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "the operating system could not reveal the file".to_string())
}

pub(crate) fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(path).status();
    #[cfg(windows)]
    let status = std::process::Command::new("explorer").arg(path).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(path).status();
    status
        .map_err(|error| format!("open file: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| "the operating system could not open the file".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_recognizes_atomic_rename_before_database_completion() {
        let path = std::env::temp_dir().join(format!("moviebox-recovery-{}.mkv", Uuid::new_v4()));
        std::fs::write(&path, vec![1_u8; 600_000]).unwrap();
        let mut job: AcquisitionJob = serde_json::from_value(serde_json::json!({
            "id":"recovery", "mediaId":"test", "mediaType":"movie", "title":"Test", "url":"", "path":path,
            "status":"downloading", "receivedBytes":500_000, "totalBytes":600_000, "attempt":1, "createdAt":0, "updatedAt":0
        })).unwrap();
        assert!(completed_on_disk(&job));
        job.total_bytes = Some(700_000);
        assert!(!completed_on_disk(&job));
        job.total_bytes = Some(600_000);
        std::fs::write(format!("{}.part", job.path), b"partial").unwrap();
        assert!(!completed_on_disk(&job));
        std::fs::remove_file(format!("{}.part", job.path)).unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn transfer_limit_is_atomic_and_releases_after_writer_stops() {
        let active = Arc::new(Mutex::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(20));
        let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        std::thread::scope(|scope| {
            for _ in 0..20 {
                let (active, barrier, peak) = (active.clone(), barrier.clone(), peak.clone());
                scope.spawn(move || {
                    barrier.wait();
                    if let Some(_slot) = TransferSlot::claim(&active, 3) {
                        peak.fetch_max(*active.lock().unwrap(), Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    }
                });
            }
        });
        assert!((1..=3).contains(&peak.load(Ordering::SeqCst)));
        assert_eq!(*active.lock().unwrap(), 0);
        assert!(TransferSlot::claim(&active, 1).is_some());
    }

    #[test]
    fn stale_worker_cannot_overwrite_pause_cancel_or_resume_intent() {
        let canceled = AtomicBool::new(false);
        assert!(worker_can_update("preparing", &canceled));
        for status in ["paused", "canceled", "done"] {
            assert!(!worker_can_update(status, &canceled));
        }
        canceled.store(true, Ordering::Relaxed);
        assert!(!worker_can_update("queued", &canceled));
    }

    #[test]
    fn expired_source_statuses_request_fresh_resolution() {
        assert!(source_needs_refresh("download failed: HTTP 401"));
        assert!(source_needs_refresh("server returned HTTP 403"));
        assert!(source_needs_refresh("HTTP 404 Not Found"));
        assert!(!source_needs_refresh("HTTP 500 Internal Server Error"));
    }

    #[test]
    fn unique_path_preserves_existing_downloads_and_partial_files() {
        let root = std::env::temp_dir().join(format!("movibox-acquisition-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create test directory");
        let target = root.join("Episode.mkv");
        std::fs::write(&target, b"complete").expect("write completed file");
        assert_eq!(
            unique_path(&target.to_string_lossy()),
            root.join("Episode (2).mkv").to_string_lossy()
        );

        let second = root.join("Episode (2).mkv");
        std::fs::write(format!("{}.part", second.to_string_lossy()), b"partial")
            .expect("write partial file");
        assert_eq!(
            unique_path(&target.to_string_lossy()),
            root.join("Episode (3).mkv").to_string_lossy()
        );

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn history_keeps_each_terminal_attempt_without_touching_media() {
        let state = AcquisitionState::from_connection(Connection::open_in_memory().unwrap())
            .expect("create acquisition state");
        let path = std::env::temp_dir().join(format!("movibox-history-{}.mkv", Uuid::new_v4()));
        std::fs::write(&path, b"video").expect("write completed media");
        let job: AcquisitionJob = serde_json::from_value(serde_json::json!({
            "id":"history-job", "mediaId":"movie", "mediaType":"movie", "title":"Movie",
            "streamLabel":"1080p", "provider":"TorBox", "sourceContext":{"moviebox":true},
            "url":"", "path":path, "status":"queued", "receivedBytes":5,
            "totalBytes":5, "attempt":1, "createdAt":100, "updatedAt":100
        }))
        .unwrap();
        state.save_job(&job).expect("save job");
        state
            .update_job(&job.id, |item| {
                item.status = "done".into();
                item.completed_at = Some(200);
            })
            .expect("complete first attempt");
        state
            .update_job(&job.id, |item| {
                item.status = "queued".into();
                item.completed_at = None;
            })
            .expect("retry job");
        state
            .update_job(&job.id, |item| {
                item.status = "error".into();
                item.error = Some("provider unavailable".into());
            })
            .expect("fail second attempt");

        let history = state.list_history().expect("list history");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].attempt, 2);
        assert_eq!(history[0].status, "failed");
        assert_eq!(history[1].attempt, 1);
        assert_eq!(history[1].status, "completed");
        let ids = history
            .iter()
            .map(|entry| entry.id.clone())
            .collect::<Vec<_>>();
        assert_eq!(state.remove_history(&ids).unwrap(), 2);
        assert!(state.list_history().unwrap().is_empty());
        assert!(path.is_file());
        assert!(state.load_job(&job.id).unwrap().is_some());
        std::fs::remove_file(path).expect("remove completed media");
    }

    #[test]
    fn cleared_history_stays_cleared_after_restart() {
        let path = std::env::temp_dir().join(format!("movibox-history-{}.sqlite3", Uuid::new_v4()));
        {
            let state = AcquisitionState::from_connection(Connection::open(&path).unwrap())
                .expect("create acquisition state");
            let job: AcquisitionJob = serde_json::from_value(serde_json::json!({
                "id":"restart-job", "mediaId":"movie", "mediaType":"movie", "title":"Movie",
                "sourceContext":{"moviebox":true}, "url":"", "path":"/missing/movie.mkv",
                "status":"queued", "receivedBytes":0, "attempt":1, "createdAt":100, "updatedAt":100
            }))
            .unwrap();
            state.save_job(&job).unwrap();
            state
                .update_job(&job.id, |item| item.status = "error".into())
                .unwrap();
            assert_eq!(state.list_history().unwrap().len(), 1);
            state.clear_history().unwrap();
        }
        let reopened = AcquisitionState::from_connection(Connection::open(&path).unwrap())
            .expect("reopen acquisition state");
        assert!(reopened.list_history().unwrap().is_empty());
        assert!(reopened.load_job("restart-job").unwrap().is_some());
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.to_string_lossy()));
        }
    }
}
