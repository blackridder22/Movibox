//! Portable recovery data only. Credentials, private service URLs and download intents stay local.
use super::{now, strv, Runtime};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::Path,
};

const LIMIT: u64 = 32 * 1024 * 1024;
const PREFS: &[&str] = &[
    "folder",
    "movieFolder",
    "seriesFolder",
    "naming",
    "reserve",
    "cleanup",
    "quality",
    "language",
    "maxSize",
    "concurrency",
    "bandwidth",
    "retries",
    "duplicates",
    "frequency",
    "cron",
    "timezone",
    "transferWindow",
    "catchUp",
    "sidebarCollapsed",
    "theme",
    "accent",
    "density",
    "radius",
    "glass",
    "shadows",
    "motion",
    "customCursor",
    "notifications",
    "notifyComplete",
    "notifyError",
    "notifyMatch",
    "notifyTitles",
    "notifySound",
    "quietHours",
    "shortcuts",
    "sourcePreference",
    "sourceTimeout",
    "subtitlesEnabled",
    "subtitleLanguage",
    "subtitleAddons",
    "subtitleExactOnly",
    "catalogLanguage",
    "autoCheckUpdates",
];
const MEDIA: &[&str] = &[
    "id",
    "title",
    "description",
    "year",
    "kind",
    "genre",
    "genres",
    "runtime",
    "rating",
    "episodes",
    "tmdbId",
    "catalog",
    "aliases",
    "externalIds",
];
const RULE: &[&str] = &[
    "scheduleMode",
    "id",
    "mediaId",
    "name",
    "quality",
    "language",
    "frequency",
    "cron",
    "timezone",
    "window",
    "destination",
    "skipExisting",
    "future",
    "season",
    "seasons",
    "episodes",
    "subtitleMode",
    "subtitleLanguages",
    "subtitleExisting",
    "createdAt",
];
const LIBRARY: &[&str] = &[
    "id", "mediaId", "quality", "size", "episodes", "season", "path",
];
const RECENT_SEARCH: &[&str] = &["id", "query", "mediaId", "title", "kind", "searchedAt"];
const WATCH_STATE: &[&str] = &["mediaId", "movieWatchedAt", "episodes", "updatedAt"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Data {
    format: String,
    version: u32,
    app_version: String,
    platform: String,
    created_at: i64,
    preferences: Value,
    media: Vec<Value>,
    rules: Vec<Value>,
    library: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    recent_searches: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    watch_states: Vec<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    data: Data,
    checksum: String,
}

fn selected(value: &Value, fields: &[&str]) -> Value {
    let mut result = Value::Object(
        fields
            .iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect(),
    );
    if let Some(ids) = result.get_mut("externalIds") {
        *ids = selected(ids, &["imdb", "tmdb", "tvdb"]);
    }
    result
}

fn checksum(data: &Data) -> Result<String, String> {
    let bytes = serde_json::to_vec(data).map_err(|_| "Could not encode backup")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn snapshot(db: &Connection) -> Result<Data, String> {
    let mut data = Data {
        format: "movibox-backup".into(),
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        created_at: now(),
        preferences: json!({}),
        media: vec![],
        rules: vec![],
        library: vec![],
        recent_searches: vec![],
        watch_states: vec![],
    };
    let mut stmt = db.prepare("SELECT kind,id,payload FROM moviebox_documents WHERE kind IN ('settings','media','rule','library','recent-search','watch-state') ORDER BY kind,id").map_err(|_| "Could not read backup records")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "Could not read backup records")?;
    for row in rows {
        let (kind, id, raw) = row.map_err(|_| "Could not read backup record")?;
        let value: Value = serde_json::from_str(&raw).map_err(|_| "A saved record is invalid")?;
        match kind.as_str() {
            "settings" if id == "preferences" => data.preferences = selected(&value, PREFS),
            "media" => data.media.push(selected(&value, MEDIA)),
            "rule" => data.rules.push(selected(&value, RULE)),
            "library" => data.library.push(selected(&value, LIBRARY)),
            "recent-search" => data.recent_searches.push(selected(&value, RECENT_SEARCH)),
            "watch-state" => data.watch_states.push(selected(&value, WATCH_STATE)),
            _ => {}
        }
    }
    Ok(data)
}

fn write_archive(path: &Path, data: Data) -> Result<(), String> {
    let checksum = checksum(&data)?;
    let bytes = serde_json::to_vec_pretty(&Archive { data, checksum })
        .map_err(|_| "Could not encode backup")?;
    if bytes.len() as u64 > LIMIT {
        return Err("Backup exceeds the 32 MB limit".into());
    }
    let parent = path
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("Choose an existing backup folder")?;
    let mut file =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "Could not create backup file")?;
    file.write_all(&bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Could not finish writing backup")?;
    file.persist_noclobber(path).map_err(|_| {
        "Could not save backup. Choose a new filename; existing files are never overwritten."
    })?;
    Ok(())
}

fn read_archive(path: &Path) -> Result<Archive, String> {
    let file = std::fs::File::open(path).map_err(|_| "Could not open backup")?;
    if !file
        .metadata()
        .map_err(|_| "Could not inspect backup")?
        .is_file()
    {
        return Err("Choose a backup file".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read backup")?;
    if bytes.len() as u64 > LIMIT {
        return Err("Backup exceeds the 32 MB limit".into());
    }
    let archive: Archive =
        serde_json::from_slice(&bytes).map_err(|_| "This is not a valid Movie Box backup")?;
    let data = &archive.data;
    if data.format != "movibox-backup" || data.version != 1 {
        return Err("Unsupported backup format or version".into());
    }
    if checksum(data)? != archive.checksum {
        return Err("Backup integrity check failed; no data was changed".into());
    }
    validate(data)?;
    Ok(archive)
}

fn typed_fields(
    value: &Value,
    strings: &[&str],
    bools: &[&str],
    numbers: &[&str],
) -> Result<(), String> {
    for key in strings {
        if value.get(*key).is_some_and(|v| {
            !v.is_string()
                || v.as_str()
                    .is_some_and(|s| s.len() > 16_384 || s.contains('\0'))
        }) {
            return Err(format!("Invalid text field in backup: {key}"));
        }
    }
    for key in bools {
        if value.get(*key).is_some_and(|v| !v.is_boolean()) {
            return Err(format!("Invalid switch in backup: {key}"));
        }
    }
    for key in numbers {
        if value
            .get(*key)
            .is_some_and(|v| !v.is_number() || v.as_f64().is_some_and(|n| n < 0.0))
        {
            return Err(format!("Invalid number in backup: {key}"));
        }
    }
    Ok(())
}
fn array_field(value: &Value, key: &str, predicate: fn(&Value) -> bool) -> Result<(), String> {
    if let Some(items) = value.get(key) {
        if !items
            .as_array()
            .is_some_and(|items| items.len() <= 20_000 && items.iter().all(predicate))
        {
            return Err(format!("Invalid list in backup: {key}"));
        }
    }
    Ok(())
}
fn validate(data: &Data) -> Result<(), String> {
    if !data.preferences.is_object() {
        return Err("Invalid backup preferences".into());
    }
    let booleans = [
        "cleanup",
        "duplicates",
        "catchUp",
        "sidebarCollapsed",
        "glass",
        "shadows",
        "customCursor",
        "notifications",
        "notifyComplete",
        "notifyError",
        "notifyMatch",
        "notifyTitles",
        "notifySound",
        "subtitleAddons",
        "subtitleExactOnly",
        "subtitlesEnabled",
        "autoCheckUpdates",
    ];
    let strings: Vec<_> = PREFS
        .iter()
        .copied()
        .filter(|key| !booleans.contains(key) && *key != "shortcuts")
        .collect();
    typed_fields(&data.preferences, &strings, &booleans, &[])?;
    if data.preferences.get("shortcuts").is_some_and(|v| {
        !v.as_object().is_some_and(|o| {
            o.len() <= 100
                && o.values()
                    .all(|v| v.as_str().is_some_and(|s| s.len() < 256))
        })
    }) {
        return Err("Invalid shortcuts in backup".into());
    }
    let mut media_ids = HashSet::new();
    for (kind, records) in [
        ("media", &data.media),
        ("rule", &data.rules),
        ("library", &data.library),
    ] {
        if records.len() > 20_000 {
            return Err("Backup contains too many records".into());
        }
        let mut ids = HashSet::new();
        for value in records {
            let id = strv(value, "id");
            if !value.is_object() || id.is_empty() || id.len() > 512 || !ids.insert(id) {
                return Err(format!(
                    "Backup contains an invalid or duplicate {kind} record"
                ));
            }
            if kind == "media" {
                if strv(value, "title").is_empty()
                    || !["movie", "series"].contains(&strv(value, "kind"))
                {
                    return Err("Invalid title in backup".into());
                }
                typed_fields(
                    value,
                    &[
                        "title",
                        "description",
                        "year",
                        "genre",
                        "runtime",
                        "catalog",
                    ],
                    &[],
                    &["rating", "tmdbId"],
                )?;
                array_field(value, "genres", Value::is_string)?;
                array_field(value, "aliases", Value::is_string)?;
                if value.get("externalIds").is_some_and(|ids| {
                    !ids.as_object()
                        .is_some_and(|ids| ids.values().all(|v| v.is_null() || v.is_string()))
                }) {
                    return Err("Invalid external title IDs in backup".into());
                }
                array_field(value, "episodes", |v| {
                    v.is_object()
                        && v["title"].is_string()
                        && v["season"].is_u64()
                        && v["episode"].is_u64()
                        && v["released"].is_string()
                })?;
                media_ids.insert(id);
            } else if !media_ids.contains(strv(value, "mediaId")) {
                return Err(
                    "Backup is missing title metadata required by a rule or library file".into(),
                );
            }
            if kind == "rule" {
                if strv(value, "name").trim().is_empty() || strv(value, "destination").is_empty() {
                    return Err("Invalid monitoring rule in backup".into());
                }
                typed_fields(
                    value,
                    &[
                        "name",
                        "quality",
                        "language",
                        "frequency",
                        "cron",
                        "timezone",
                        "window",
                        "destination",
                        "subtitleMode",
                        "scheduleMode",
                    ],
                    &["skipExisting", "future", "subtitleExisting"],
                    &["season", "createdAt"],
                )?;
                for key in ["episodes", "seasons"] {
                    array_field(value, key, Value::is_u64)?;
                }
                array_field(value, "subtitleLanguages", Value::is_string)?;
                super::scheduler::next_rule_check(value, now())?;
                super::scheduler::window_open(
                    strv(value, "window"),
                    strv(value, "timezone"),
                    now(),
                )?;
            }
            if kind == "library" {
                array_field(value, "episodes", Value::is_u64)?;
                if strv(value, "path").is_empty() {
                    return Err("A library record has no file path".into());
                }
                typed_fields(value, &["quality", "path"], &[], &["size", "season"])?;
            }
        }
    }
    if data.recent_searches.len() > 20 || data.watch_states.len() > 20_000 {
        return Err("Backup contains too many activity records".into());
    }
    let mut recent_ids = HashSet::new();
    for value in &data.recent_searches {
        let id = strv(value, "id");
        if !value.is_object()
            || id.is_empty()
            || id.len() > 512
            || !recent_ids.insert(id)
            || (strv(value, "query").is_empty() && strv(value, "mediaId").is_empty())
        {
            return Err("Backup contains an invalid recent search".into());
        }
        if ["query", "mediaId", "title", "kind"].iter().any(|key| {
            value.get(*key).is_some_and(|field| {
                !field.is_null()
                    && (!field.is_string()
                        || field
                            .as_str()
                            .is_some_and(|text| text.len() > 16_384 || text.contains('\0')))
            })
        }) || !value["searchedAt"].is_i64()
        {
            return Err("Backup contains an invalid recent search".into());
        }
    }
    let mut watch_ids = HashSet::new();
    for value in &data.watch_states {
        let media_id = strv(value, "mediaId");
        if !value.is_object()
            || !media_ids.contains(media_id)
            || !watch_ids.insert(media_id)
            || value["episodes"].as_array().is_none_or(|episodes| {
                episodes.len() > 20_000
                    || episodes.iter().any(|episode| {
                        !episode.is_object()
                            || !episode["season"].is_u64()
                            || !episode["episode"].is_u64()
                            || !episode["watchedAt"].is_i64()
                    })
            })
        {
            return Err("Backup contains invalid watch progress".into());
        }
        typed_fields(value, &[], &[], &["movieWatchedAt", "updatedAt"])?;
    }
    Ok(())
}

fn summary(archive: &Archive) -> Value {
    let data = &archive.data;
    json!({"checksum":archive.checksum,"createdAt":data.created_at,"appVersion":data.app_version,"platform":data.platform,
        "rules":data.rules.len(),"library":data.library.len(),"titles":data.media.len(),"watchStates":data.watch_states.len(),"recentSearches":data.recent_searches.len(),
        "missingFiles":data.library.iter().filter(|v| !Path::new(strv(v,"path")).is_file()).count(),
        "differentPlatform":data.platform!=std::env::consts::OS})
}

// Called with the database locked, so a worker cannot enqueue between this check and commit.
fn ensure_idle(db: &Connection) -> Result<(), String> {
    let table: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='acquisition_jobs')",
            [],
            |r| r.get(0),
        )
        .map_err(|_| "Could not check downloads")?;
    if table {
        let active: i64 = db.query_row("SELECT COUNT(*) FROM acquisition_jobs WHERE status NOT IN ('done','canceled','error','paused')", [], |r| r.get(0)).map_err(|_| "Could not check downloads")?;
        if active > 0 {
            return Err("Pause active downloads before restoring a backup".into());
        }
    }
    let busy: i64 = db.query_row("SELECT COUNT(*) FROM moviebox_documents WHERE (kind='bundle-wait' AND json_extract(payload,'$.state') IN ('waiting','preparing')) OR (kind='search-job' AND json_extract(payload,'$.state') IN ('queued','running')) OR (kind='subtitle-job' AND json_extract(payload,'$.state') IN ('queued','searching','downloading','running','retrying'))", [], |r| r.get(0)).map_err(|_| "Could not check background tasks")?;
    if busy > 0 {
        return Err(
            "Finish or pause background preparation and subtitle/search tasks before restoring"
                .into(),
        );
    }
    Ok(())
}

pub(super) fn latest_recovery(folder: &Path) -> Option<Value> {
    let mut entries = std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "movibox-backup")
        })
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in entries.into_iter().take(32) {
        if let Ok(archive) = read_archive(&path) {
            let mut result = summary(&archive);
            result["path"] = json!(path);
            return Some(result);
        }
    }
    None
}

impl Runtime {
    pub(super) fn ensure_update_idle(&self) -> Result<(), String> {
        let running = self
            .running_rules
            .lock()
            .map_err(|_| "Scheduler unavailable")?;
        let db = self.db.lock().map_err(|_| "Database unavailable")?;
        ensure_idle(&db)?;
        let rules: i64 = db.query_row("SELECT COUNT(*) FROM moviebox_documents WHERE kind='rule' AND COALESCE(json_extract(payload,'$.status'),'active') NOT IN ('paused','complete')", [], |r| r.get(0)).map_err(|_| "Could not check monitoring rules")?;
        if rules > 0 || !running.is_empty() {
            return Err("Pause monitoring rules before installing an update".into());
        }
        Ok(())
    }
    pub(super) fn export_backup(&self, path: &Path) -> Result<Value, String> {
        if !path.is_absolute() {
            return Err("Choose a backup destination".into());
        }
        let data = snapshot(&*self.db.lock().map_err(|_| "Database unavailable")?)?;
        validate(&data)?;
        write_archive(path, data)?;
        let _ = self.log(
            "info",
            "backup",
            "Recovery backup exported; credentials and media files excluded",
            None,
        );
        Ok(json!({"saved":true}))
    }

    pub(super) fn preview_backup(&self, path: &Path) -> Result<Value, String> {
        Ok(summary(&read_archive(path)?))
    }

    pub(super) fn restore_backup(
        &self,
        path: &Path,
        expected: &str,
        safety_dir: &Path,
    ) -> Result<Value, String> {
        let archive = read_archive(path)?;
        if archive.checksum != expected {
            return Err("Backup changed since preview. Review it again before restoring.".into());
        }
        let _workflow = self
            .workflow_commit
            .lock()
            .map_err(|_| "Workflow unavailable")?;
        let running = self
            .running_rules
            .lock()
            .map_err(|_| "Scheduler unavailable")?;
        if !running.is_empty() {
            return Err("Wait for monitoring checks to finish before restoring".into());
        }
        let _subtitles = self
            .subtitle_commit
            .lock()
            .map_err(|_| "Subtitle queue unavailable")?;
        if self
            .list("subtitle-job")?
            .iter()
            .any(|task| task["state"] == "running")
        {
            return Err("Wait for the current subtitle search to finish before restoring".into());
        }
        let mut db = self.db.lock().map_err(|_| "Database unavailable")?;
        ensure_idle(&db)?;
        let previous = snapshot(&db)?;
        std::fs::create_dir_all(safety_dir).map_err(|_| "Could not create recovery folder")?;
        let safety = safety_dir.join(format!(
            "before-restore-{}.movibox-backup",
            uuid::Uuid::new_v4()
        ));
        write_archive(&safety, previous)?;
        let transaction = db.transaction().map_err(|_| "Could not start restore")?;
        let raw: String = transaction
            .query_row(
                "SELECT payload FROM moviebox_documents WHERE kind='settings' AND id='preferences'",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "Could not read current settings")?;
        let mut prefs: Value =
            serde_json::from_str(&raw).map_err(|_| "Invalid saved preferences")?;
        for (key, value) in selected(&archive.data.preferences, PREFS)
            .as_object()
            .ok_or("Invalid preferences")?
        {
            if key == "folder"
                && (archive.data.platform != std::env::consts::OS
                    || !Path::new(value.as_str().unwrap_or("")).is_absolute())
            {
                continue;
            }
            prefs[key] = value.clone();
        }
        // OS registrations and authenticated connections are deliberately not restored.
        transaction.execute("UPDATE moviebox_documents SET payload=?1 WHERE kind='settings' AND id='preferences'", [prefs.to_string()]).map_err(|_| "Could not restore settings")?;
        let mut revisions = std::collections::HashMap::new();
        {
            let mut stmt = transaction.prepare("SELECT id,COALESCE(json_extract(payload,'$.revision'),0) FROM moviebox_documents WHERE kind='rule'").map_err(|_| "Could not read rule revisions")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|_| "Could not read rule revisions")?;
            for row in rows {
                let (id, revision) = row.map_err(|_| "Invalid saved rule revision")?;
                revisions.insert(id, revision);
            }
        }
        transaction
            .execute(
                "DELETE FROM moviebox_documents WHERE kind IN ('rule','library','recent-search','watch-state')",
                [],
            )
            .map_err(|_| "Could not replace recovery records")?;
        for (kind, records, fields) in [
            ("media", &archive.data.media, MEDIA),
            ("rule", &archive.data.rules, RULE),
            ("library", &archive.data.library, LIBRARY),
            (
                "recent-search",
                &archive.data.recent_searches,
                RECENT_SEARCH,
            ),
            ("watch-state", &archive.data.watch_states, WATCH_STATE),
        ] {
            for original in records {
                let mut value = selected(original, fields);
                let id = if kind == "watch-state" {
                    strv(&value, "mediaId").to_owned()
                } else {
                    strv(&value, "id").to_owned()
                };
                if kind == "rule" {
                    let defaults = json!({"quality":"Any quality", "language":"Any language", "cron":"", "skipExisting":true, "future":false, "season":1});
                    for (key, default) in defaults.as_object().unwrap() {
                        if value.get(key).is_none() {
                            value[key] = default.clone();
                        }
                    }
                    value["status"] = json!("paused");
                    value["running"] = json!(false);
                    value["revision"] =
                        json!(revisions.get(&id).copied().unwrap_or(0).saturating_add(1));
                    value["history"] = json!([]);
                    value["result"] =
                        json!("Restored paused; review destination and resume when ready");
                    value["nextCheckAt"] = json!(super::scheduler::next_rule_check(&value, now())?);
                }
                if kind == "media" {
                    let artwork: Option<String> = transaction.query_row("SELECT json_extract(payload,'$.poster') FROM moviebox_documents WHERE kind='media' AND id=?1", [&id], |r| r.get(0)).ok();
                    value["poster"] = json!(artwork.unwrap_or_default());
                    let defaults = json!({"year":"", "genre":"", "genres":[], "runtime":"", "rating":0, "episodes":[]});
                    for (key, default) in defaults.as_object().unwrap() {
                        if value.get(key).is_none() {
                            value[key] = default.clone();
                        }
                    }
                }
                if kind == "library" {
                    value["missing"] = json!(!Path::new(strv(&value, "path")).is_file());
                    transaction
                        .execute(
                            "DELETE FROM moviebox_documents WHERE kind='hidden-library' AND id=?1",
                            [&id],
                        )
                        .map_err(|_| "Could not restore library visibility")?;
                }
                transaction.execute("INSERT INTO moviebox_documents(kind,id,payload) VALUES (?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload", params![kind,id,value.to_string()]).map_err(|_| "Could not restore record")?;
            }
        }
        transaction
            .commit()
            .map_err(|_| "Could not commit restore; original data retained")?;
        drop(db);
        let _ = self.log("info", "backup", "Backup restored atomically; monitoring rules paused, video files and credentials unchanged", None);
        let mut result = summary(&archive);
        result["safetyBackup"] = json!(safety);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seeded(path: &Path) -> Runtime {
        let runtime = crate::moviebox::tests::test_runtime(path);
        runtime.put("settings","preferences",&json!({"theme":"Light","folder":"/tmp/movies","addons":[{"url":"https://secret.invalid/token/manifest.json"}],"providerAccounts":{"torbox":{"connected":true}},"autoStart":true})).unwrap();
        runtime.put("media","film",&json!({"id":"film","title":"Owned film","kind":"movie","poster":"https://secret.invalid/art"})).unwrap();
        runtime.put("rule","rule",&json!({"id":"rule","mediaId":"film","name":"Owned rule","destination":"/tmp/movies","frequency":"Daily","timezone":"UTC","window":"Any time","status":"active","revision":8})).unwrap();
        runtime
            .put(
                "library",
                "file",
                &json!({"id":"file","mediaId":"film","path":"/missing/owned.mkv","size":1,"episodes":[1,2],"season":1}),
            )
            .unwrap();
        runtime
            .record_recent_search(&json!({"query":"Owned film"}))
            .unwrap();
        runtime
            .set_watched(&json!({"mediaId":"film","watched":true}))
            .unwrap();
        runtime
    }
    #[test]
    fn backup_keeps_manual_only_rules_and_subtitle_repair_preference() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = seeded(&dir.path().join("db"));
        let mut rule = runtime.get("rule", "rule").unwrap().unwrap();
        rule["scheduleMode"] = json!("manual");
        rule["subtitleExisting"] = json!(true);
        rule["subtitleMode"] = json!("custom");
        rule["subtitleLanguages"] = json!(["French"]);
        runtime.put("rule", "rule", &rule).unwrap();
        let path = dir.path().join("manual.movibox-backup");
        runtime.export_backup(&path).unwrap();
        let preview = runtime.preview_backup(&path).unwrap();
        runtime
            .put(
                "subtitle-job",
                "active",
                &json!({"id":"active","state":"running"}),
            )
            .unwrap();
        assert!(runtime
            .restore_backup(
                &path,
                strv(&preview, "checksum"),
                &dir.path().join("blocked")
            )
            .is_err());
        assert!(!dir.path().join("blocked").exists());
        runtime.remove("subtitle-job", "active").unwrap();
        runtime
            .restore_backup(
                &path,
                strv(&preview, "checksum"),
                &dir.path().join("recovery"),
            )
            .unwrap();
        let restored = runtime.get("rule", "rule").unwrap().unwrap();
        assert_eq!(restored["scheduleMode"], "manual");
        assert_eq!(restored["subtitleExisting"], true);
        assert!(restored["nextCheckAt"].is_null());
    }
    #[test]
    fn recovery_is_atomic_paused_and_preserves_connections_and_video_files() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = seeded(&dir.path().join("data.sqlite"));
        let path = dir.path().join("copy.movibox-backup");
        runtime.export_backup(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("secret.invalid"));
        assert!(!text.contains("providerAccounts"));
        assert!(!text.contains("autoStart"));
        let preview = runtime.preview_backup(&path).unwrap();
        assert_eq!(preview["missingFiles"], 1);
        assert_eq!(preview["recentSearches"], 1);
        assert_eq!(preview["watchStates"], 1);
        runtime.put("settings","preferences",&json!({"theme":"Dark","providerAccounts":{"torbox":{"connected":true}},"autoStart":true})).unwrap();
        let result = runtime
            .restore_backup(
                &path,
                strv(&preview, "checksum"),
                &dir.path().join("recovery"),
            )
            .unwrap();
        assert_eq!(runtime.prefs().unwrap()["theme"], "Light");
        assert_eq!(runtime.prefs().unwrap()["autoStart"], true);
        assert_eq!(
            runtime.prefs().unwrap()["providerAccounts"]["torbox"]["connected"],
            true
        );
        let rule = runtime.get("rule", "rule").unwrap().unwrap();
        assert_eq!(rule["status"], "paused");
        assert_eq!(rule["revision"], 9);
        assert!(!Path::new("/missing/owned.mkv").exists());
        assert!(runtime.is_watched("film", None, None).unwrap());
        assert_eq!(runtime.recent_searches().unwrap().len(), 1);
        let safety = read_archive(Path::new(strv(&result, "safetyBackup"))).unwrap();
        assert_eq!(safety.data.preferences["theme"], "Dark");
        let reopened = crate::moviebox::tests::test_runtime(&dir.path().join("data.sqlite"));
        assert_eq!(
            reopened.get("rule", "rule").unwrap().unwrap()["status"],
            "paused"
        );
    }
    #[test]
    fn corrupt_or_changed_backup_cannot_mutate_database() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = seeded(&dir.path().join("data.sqlite"));
        let path = dir.path().join("copy.movibox-backup");
        runtime.export_backup(&path).unwrap();
        let original = runtime.get("rule", "rule").unwrap();
        assert!(runtime
            .restore_backup(&path, "changed", &dir.path().join("recovery"))
            .is_err());
        let mut archive: Archive = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        archive.data.preferences["theme"] = json!("Dark");
        std::fs::write(&path, serde_json::to_vec(&archive).unwrap()).unwrap();
        assert!(runtime.preview_backup(&path).is_err());
        assert_eq!(runtime.get("rule", "rule").unwrap(), original);
        assert!(!dir.path().join("recovery").exists());
    }
    #[test]
    fn invalid_records_and_future_formats_are_rejected_without_overwriting_backups() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = seeded(&dir.path().join("data.sqlite"));
        let path = dir.path().join("copy.movibox-backup");
        runtime.export_backup(&path).unwrap();
        assert!(runtime.export_backup(&path).is_err());
        let mut data = read_archive(&path).unwrap().data;
        data.rules[0]["mediaId"] = json!("missing");
        let bad = dir.path().join("bad.movibox-backup");
        write_archive(&bad, data.clone()).unwrap();
        assert!(runtime.preview_backup(&bad).is_err());
        data.version = 2;
        let future = dir.path().join("future.movibox-backup");
        write_archive(&future, data).unwrap();
        assert!(runtime.preview_backup(&future).is_err());
    }
    #[test]
    fn active_work_blocks_restore_before_any_safety_file_or_database_change() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = seeded(&dir.path().join("data.sqlite"));
        let path = dir.path().join("copy.movibox-backup");
        runtime.export_backup(&path).unwrap();
        let preview = runtime.preview_backup(&path).unwrap();
        runtime
            .put("bundle-wait", "wait", &json!({"state":"waiting"}))
            .unwrap();
        assert!(runtime
            .restore_backup(
                &path,
                strv(&preview, "checksum"),
                &dir.path().join("recovery")
            )
            .is_err());
        assert_eq!(
            runtime.get("rule", "rule").unwrap().unwrap()["status"],
            "active"
        );
        assert!(!dir.path().join("recovery").exists());
    }
    #[test]
    fn malformed_settings_and_episode_payloads_are_rejected_even_with_valid_checksums() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = seeded(&dir.path().join("data.sqlite"));
        let data = snapshot(&runtime.db.lock().unwrap()).unwrap();
        for (index, altered) in [
            {
                let mut d = data.clone();
                d.preferences["shortcuts"] = json!([]);
                d
            },
            {
                let mut d = data.clone();
                d.preferences["theme"] = json!({"bad":true});
                d
            },
            {
                let mut d = data.clone();
                d.rules[0]["episodes"] = json!(["1"]);
                d
            },
            {
                let mut d = data.clone();
                d.media[0]["episodes"] = json!([{"episode":1}]);
                d
            },
        ]
        .into_iter()
        .enumerate()
        {
            let path = dir.path().join(format!("invalid-{index}.movibox-backup"));
            write_archive(&path, altered).unwrap();
            assert!(runtime.preview_backup(&path).is_err());
        }
    }
}
