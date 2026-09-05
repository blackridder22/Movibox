//! Optional post-download work. Subtitle errors never change the video job's status.
use super::{
    catalog::{addon_root, http_url, supports},
    flag, now,
    requests::{Lane, RequestError},
    strv, Runtime,
};
use crate::acquisition::{AcquisitionJob, AcquisitionState};
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager};
const API: &str = "https://api.opensubtitles.com/api/v1";

#[derive(Debug)]
struct SubtitleError {
    reason: &'static str,
    error: RequestError,
}
impl std::ops::Deref for SubtitleError {
    type Target = RequestError;
    fn deref(&self) -> &Self::Target {
        &self.error
    }
}
impl From<RequestError> for SubtitleError {
    fn from(mut error: RequestError) -> Self {
        let reason = match error.status {
            Some(401 | 403) => "authentication",
            Some(406) => "quota",
            Some(429) => "rate_limited",
            _ if error.terminal => "failed",
            _ => "provider_unavailable",
        };
        if reason == "authentication" {
            error.message = "Subtitle provider rejected access. Check your API key, account and subscription in Settings.".into();
        }
        Self { reason, error }
    }
}
impl SubtitleError {
    fn problem(reason: &'static str, message: &str, terminal: bool) -> Self {
        Self {
            reason,
            error: RequestError {
                message: message.into(),
                terminal,
                retry_at: now() + 300_000,
                status: None,
            },
        }
    }
}

#[cfg(test)]
#[path = "live_acceptance.rs"]
mod live_acceptance;

pub(super) fn file_hash(path: &Path) -> Result<(String, u64), String> {
    let mut file = std::fs::File::open(path).map_err(|_| "Video file unavailable")?;
    let size = file
        .metadata()
        .map_err(|_| "Video metadata unavailable")?
        .len();
    if size < 131072 {
        return Err("Video is too small for an OpenSubtitles hash".into());
    }
    let mut hash = size;
    let mut block = [0u8; 65536];
    for offset in [0, size - 65536] {
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| "Video seek failed")?;
        file.read_exact(&mut block)
            .map_err(|_| "Video hash read failed")?;
        for word in block.chunks_exact(8) {
            hash = hash.wrapping_add(u64::from_le_bytes(
                word.try_into().map_err(|_| "Invalid hash block")?,
            ));
        }
    }
    Ok((format!("{hash:016x}"), size))
}
fn language(value: &str) -> String {
    super::bridge::matching::language_code(value)
}
fn auth_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.movibox.backend", "opensubtitles")
        .map_err(|_| "Credential store unavailable".into())
}
fn api_base(host: &str) -> Result<String, String> {
    match host.trim_start_matches("https://").trim_end_matches('/') {
        "api.opensubtitles.com" => Ok(API.into()),
        "vip-api.opensubtitles.com" => Ok("https://vip-api.opensubtitles.com/api/v1".into()),
        _ => Err("OpenSubtitles returned an unrecognized API host".into()),
    }
}
fn release_name(value: &str) -> String {
    let path = Path::new(value);
    let name = if path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "mkv"
                    | "mp4"
                    | "avi"
                    | "m4v"
                    | "mov"
                    | "webm"
                    | "mpg"
                    | "mpeg"
                    | "ts"
                    | "m2ts"
                    | "srt"
                    | "vtt"
                    | "ass"
                    | "ssa"
            )
        }) {
        path.file_stem()
    } else {
        path.file_name()
    };
    name.and_then(|v| v.to_str())
        .unwrap_or(value)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn release_codec_score(release: &str, video_codec: &str) -> u8 {
    if video_codec.is_empty() {
        return 1;
    }
    let tokens = release.to_ascii_lowercase();
    let codecs: Vec<&str> = tokens
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(|token| match token {
            "xvid" | "divx" => Some("mpeg4"),
            "x264" | "h264" | "avc" => Some("h264"),
            "x265" | "h265" | "hevc" => Some("hevc"),
            "theora" => Some("theora"),
            "av1" => Some("av1"),
            _ => None,
        })
        .collect();
    if codecs.contains(&video_codec) {
        2
    } else if codecs.is_empty() {
        1
    } else {
        0
    }
}

fn write_sidecar(video: &Path, lang: &str, bytes: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "Subtitle encoding is unsupported; expected UTF-8")?;
    let ext = if text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("WEBVTT")
    {
        "vtt"
    } else if text.contains("[Script Info]") && text.contains("[Events]") {
        "ass"
    } else if text.contains(" --> ") {
        "srt"
    } else {
        return Err("Provider did not return a supported subtitle file".into());
    };
    if !lang.chars().all(|c| c.is_ascii_alphabetic() || c == '-') {
        return Err("Invalid subtitle language".into());
    }
    let path = video.with_extension(format!("{lang}.{ext}"));
    if path.exists() {
        return Ok("Existing subtitles kept".into());
    }
    let temp = video.with_extension(format!("{}.subtitle.part", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "Could not create subtitle file")?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| "Could not save subtitle file")?;
        match std::fs::hard_link(&temp, &path) {
            Ok(()) => Ok("Subtitle saved beside the video".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Ok("Existing subtitles kept".into())
            }
            Err(_) => Err("Could not finalize subtitle file".into()),
        }
    })();
    let _ = std::fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subtitle_release_matching_preserves_encode_tags_and_demotes_codec_conflicts() {
        assert_eq!(
            release_name("Sintel.2010.x264.mkv"),
            release_name("Sintel.2010.x264")
        );
        assert_ne!(
            release_name("Sintel.2010.x264"),
            release_name("Sintel.2010.Xvid")
        );
        assert_eq!(release_codec_score("Sintel.2010.x264", "h264"), 2);
        assert_eq!(release_codec_score("Sintel (2010)", "h264"), 1);
        assert_eq!(release_codec_score("Sintel.2010.Xvid-VODO", "h264"), 0);
        assert_eq!(release_codec_score("Sintel.2010.theora.french", "h264"), 0);
        assert_eq!(release_codec_score("Sintel.2010.Xvid-VODO", ""), 1);
    }
    #[test]
    fn hash_uses_both_file_ends_and_sidecars_never_overwrite_existing_files() {
        let root = std::env::temp_dir().join(format!("subtitle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("Owned.mkv");
        let mut bytes = vec![0u8; 131072];
        bytes[0] = 1;
        bytes[131064] = 2;
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(
            file_hash(&path).unwrap(),
            ("0000000000020003".into(), 131072)
        );
        let subtitle = b"1\n00:00:00,000 --> 00:00:01,000\nOwned fixture\n";
        write_sidecar(&path, "en", subtitle).unwrap();
        write_sidecar(
            &path,
            "en",
            b"2\n00:00:00,000 --> 00:00:01,000\nReplacement\n",
        )
        .unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("en.srt")).unwrap(),
            subtitle
        );
        assert!(write_sidecar(&path, "fr", b"<html>Service error</html>").is_err());
        assert!(!path.with_extension("fr.srt").exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn credentials_cannot_be_redirected_to_an_arbitrary_api_host() {
        assert_eq!(
            api_base("https://vip-api.opensubtitles.com/").unwrap(),
            "https://vip-api.opensubtitles.com/api/v1"
        );
        assert!(api_base("https://api.opensubtitles.com.attacker.invalid").is_err());
    }
    #[tokio::test]
    async fn missing_french_subtitles_follow_redirects_and_skip_a_broken_candidate() {
        use axum::{
            body::Body,
            http::{Request, Response, StatusCode},
            Router,
        };
        let root = std::env::temp_dir().join(format!("subtitle-flow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let video = root.join("Owned S01E02.mkv");
        let original = vec![0u8; 131072];
        std::fs::write(&video, &original).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let endpoint = base.clone();
        let app = Router::new().fallback(move |request: Request<Body>| {
            let base = endpoint.clone();
            async move {
                let path = request.uri().path();
                let value = if path == "/manifest.json" {
                    json!({"id":"owned","name":"Owned subtitles","types":["series"],"resources":["subtitles"]})
                } else if path.starts_with("/subtitles/") {
                    assert!(path.contains("owned:1:2") || path.contains("owned%3A1%3A2"));
                    json!({"subtitles":[{"lang":"eng","url":format!("{base}/wrong")},{"lang":"fre","url":format!("{base}/broken")},{"lang":"fr","url":format!("{base}/redirect")}]})
                } else if path == "/redirect" {
                    return Response::builder().status(StatusCode::MOVED_PERMANENTLY).header("Location", "/french.srt").body(Body::empty()).unwrap();
                } else if path == "/french.srt" {
                    return Response::new(Body::from("1\n00:00:00,000 --> 00:00:01,000\nBonjour\n"));
                } else {
                    return Response::builder().status(StatusCode::NOT_FOUND).body(Body::empty()).unwrap();
                };
                Response::new(Body::from(value.to_string()))
            }
        });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let runtime = crate::moviebox::tests::test_runtime(&root.join("db"));
        runtime.put("settings", "preferences", &json!({"subtitlesEnabled":false,"addons":[{"url":format!("{base}/manifest.json"),"enabled":true}]})).unwrap();
        let job: AcquisitionJob = serde_json::from_value(json!({"id":"owned-job","mediaId":"owned","mediaType":"series","title":"Owned","subtitle":null,"poster":null,"season":1,"episode":2,"streamLabel":null,"provider":null,"infoHash":null,"fileIndex":null,"sourceContext":{},"url":"","headers":{},"path":video,"status":"done","receivedBytes":131072,"totalBytes":131072,"error":null,"attempt":0,"scheduledAt":null,"createdAt":0,"updatedAt":1,"completedAt":1})).unwrap();
        let result = runtime
            .acquire_subtitle(&job, "fr", &json!({"enabled":true,"addons":true}))
            .await
            .unwrap();
        assert!(result.contains("Subtitle saved"));
        assert!(std::fs::read_to_string(video.with_extension("fr.srt"))
            .unwrap()
            .contains("Bonjour"));
        assert!(!video.with_extension("en.srt").exists());
        assert_eq!(std::fs::read(&video).unwrap(), original);
        server.abort();
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}
impl Runtime {
    pub(super) fn import_subtitle(
        &self,
        job: &AcquisitionJob,
        id: &str,
        source: &Path,
    ) -> Result<(), String> {
        let _guard = self
            .subtitle_commit
            .lock()
            .map_err(|_| "Subtitle queue unavailable")?;
        let mut task = self
            .get("subtitle-job", id)?
            .ok_or("Subtitle task not found")?;
        if task["jobId"] != job.id || job.status != "done" {
            return Err("Choose a completed video".into());
        }
        if matches!(strv(&task, "state"), "queued" | "running") {
            return Err("Wait for the current subtitle search to finish before importing".into());
        }
        let file = self.get("library", &job.id)?;
        let video = Path::new(file.as_ref().map(|f| strv(f, "path")).unwrap_or(&job.path));
        if !video.is_file() {
            return Err("Locate the missing video in Library first".into());
        }
        if !source.is_absolute()
            || !source
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| ["srt", "vtt", "ass"].contains(&e.to_ascii_lowercase().as_str()))
        {
            return Err("Choose a local SRT, VTT or ASS subtitle file".into());
        }
        let input =
            std::fs::File::open(source).map_err(|_| "Could not read the selected subtitle")?;
        let metadata = input
            .metadata()
            .map_err(|_| "Could not inspect the selected subtitle")?;
        if !metadata.is_file() || metadata.len() > 5 * 1024 * 1024 {
            return Err("Subtitle must be a regular file smaller than 5 MB".into());
        }
        let mut bytes = Vec::new();
        input
            .take(5 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read subtitle contents")?;
        if bytes.len() > 5 * 1024 * 1024 {
            return Err("Subtitle exceeds 5 MB".into());
        }
        let message = write_sidecar(video, strv(&task, "language"), &bytes)?;
        task["state"] = json!("done");
        task["reason"] = Value::Null;
        task["message"] = json!(format!(
            "{message}. Manually selected; playback timing needs review."
        ));
        task["revision"] = json!(uuid::Uuid::new_v4().to_string());
        self.put("subtitle-job", id, &task)?;
        self.log(
            "info",
            "subtitles",
            "Manually selected subtitle saved; existing video and subtitles preserved",
            Some(&job.id),
        )?;
        Ok(())
    }

    pub(super) async fn connect_subtitles(&self, input: &Value) -> Result<Value, String> {
        let key = strv(input, "key").trim();
        if !(8..=512).contains(&key.len()) {
            return Err("Enter your OpenSubtitles API key".into());
        }
        let mut auth = json!({"key":key,"base":API,"token":"","expiresAt":0});
        let username = strv(input, "username").trim();
        let password = strv(input, "password");
        if !username.is_empty() || !password.is_empty() {
            if username.is_empty() || password.is_empty() {
                return Err("Enter both username and password, or leave both blank".into());
            }
            let response = self
                .requests
                .json(
                    self.client
                        .post(format!("{API}/login"))
                        .header("Api-Key", key)
                        .json(&json!({"username":username,"password":password})),
                    Lane::Provider,
                    0,
                )
                .await
                .map_err(|e| e.to_string())?;
            let token = strv(&response, "token");
            if token.is_empty() {
                return Err("OpenSubtitles did not authorize this account".into());
            }
            auth["token"] = json!(token);
            auth["base"] = json!(api_base(strv(&response, "base_url"))?);
            auth["expiresAt"] = json!(now() + 23 * 3600_000);
        } else {
            self.requests
                .json(
                    self.client
                        .get(format!("{API}/infos/languages"))
                        .header("Api-Key", key),
                    Lane::Provider,
                    0,
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        auth_entry()?
            .set_password(&auth.to_string())
            .map_err(|_| "Could not save subtitle credentials")?;
        let mut p = self.prefs()?;
        p["subtitlesAccount"] =
            json!({"connected":true,"signedIn":!strv(&auth,"token").is_empty()});
        self.put("settings", "preferences", &p)?;
        Ok(json!({"connected":true}))
    }
    pub(super) fn retry_subtitles(&self, id: &str) -> Result<(), String> {
        let _guard = self
            .subtitle_commit
            .lock()
            .map_err(|_| "Subtitle queue unavailable")?;
        let mut task = self
            .get("subtitle-job", id)?
            .ok_or("Subtitle task not found")?;
        if matches!(strv(&task, "state"), "queued" | "running") {
            return Ok(());
        }
        if task["state"] == "done" {
            return Err("Subtitles are already available".into());
        }
        if task["quotaUntil"].as_i64().unwrap_or(0) > now()
            || (matches!(strv(&task, "reason"), "rate_limited" | "quota")
                && task["nextCheckAt"].as_i64().unwrap_or(0) > now())
        {
            return Err(
                "Subtitle provider cooldown has not finished yet; see the next attempt time".into(),
            );
        }
        let preferences = self.prefs()?;
        if !task["policy"].is_object() {
            task["policy"] = json!({});
        }
        task["policy"]["exactOnly"] = json!(flag(&preferences, "subtitleExactOnly"));
        task["policy"]["addons"] = json!(preferences["subtitleAddons"].as_bool().unwrap_or(true));
        task["state"] = json!("queued");
        task["message"] =
            json!("Waiting to retry missing subtitles with current matching settings");
        task["reason"] = Value::Null;
        task["nextCheckAt"] = json!(now());
        task["attempts"] = json!(0);
        task["revision"] = json!(uuid::Uuid::new_v4().to_string());
        self.put("subtitle-job", id, &task)?;
        self.subtitle_wake.notify_one();
        Ok(())
    }
    pub(super) fn schedule_subtitles(&self, job: &AcquisitionJob) -> Result<(), String> {
        if job.status != "done" {
            return Ok(());
        }
        let policy = if let Some(policy) = job.source_context.get("subtitlePolicy") {
            policy.clone()
        } else {
            let p = self.prefs()?;
            if job.completed_at.unwrap_or(0) < p["subtitlesEnabledAt"].as_i64().unwrap_or(i64::MAX)
            {
                return Ok(());
            }
            self.subtitle_policy(None)?
        };
        if !flag(&policy, "enabled") {
            return Ok(());
        }
        for lang in policy["languages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            self.queue_subtitle_task(job, lang, &policy, false, false)?;
        }
        Ok(())
    }
    pub(super) async fn run_subtitle_jobs(&self, app: &AppHandle) -> Result<bool, String> {
        let acquisition = app.state::<AcquisitionState>();
        let mut task = {
            let _guard = self
                .subtitle_commit
                .lock()
                .map_err(|_| "Subtitle queue unavailable")?;
            let Some(mut task) = self.list("subtitle-job")?.into_iter().find(|t| {
                matches!(strv(t, "state"), "queued" | "retrying")
                    && t["nextCheckAt"].as_i64().unwrap_or(0) <= now()
            }) else {
                return Ok(false);
            };
            task["state"] = json!("running");
            task["message"] = json!("Checking existing tracks and searching subtitle providers");
            self.put("subtitle-job", strv(&task, "id"), &task)?;
            task
        };
        let id = strv(&task, "id").to_owned();
        let Some(mut job) = acquisition
            .load_job(strv(&task, "jobId"))?
            .filter(|j| j.status == "done")
        else {
            task["state"] = json!("canceled");
            task["message"] = json!("Video download is no longer available");
            self.put("subtitle-job", &id, &task)?;
            return Ok(true);
        };
        if let Some(file) = self.get("library", &job.id)? {
            job.path = strv(&file, "path").into();
        }
        if !Path::new(&job.path).is_file() {
            task["state"] = json!("needs_attention");
            task["message"] = json!("Video file is missing; locate it in Library before retrying");
            task["reason"] = json!("file_missing");
            self.put("subtitle-job", &id, &task)?;
            return Ok(true);
        }
        task["state"] = json!("running");
        self.put("subtitle-job", &id, &task)?;
        let _ = app.emit("movibox://backend-changed", ());
        let policy = match task.get("policy") {
            Some(policy) => policy.clone(),
            None => self.subtitle_policy(None)?,
        };
        let result = self
            .acquire_subtitle(&job, strv(&task, "language"), &policy)
            .await;
        let _guard = self
            .subtitle_commit
            .lock()
            .map_err(|_| "Subtitle queue unavailable")?;
        if self.get("subtitle-job", &id)?.is_none_or(|latest| {
            latest["revision"] != task["revision"] || latest["state"] != "running"
        }) {
            return Ok(true);
        }
        let attempts = task["attempts"].as_u64().unwrap_or(0) + 1;
        task["attempts"] = json!(attempts);
        match result {
            Ok(message) => {
                task["state"] = json!("done");
                task["reason"] = Value::Null;
                task["message"] = json!(message);
            }
            Err(SubtitleError { reason, error }) => {
                task["reason"] = json!(reason);
                task["state"] = json!(if error.terminal || attempts >= 4 {
                    "needs_attention"
                } else {
                    "retrying"
                });
                if error.status == Some(406) {
                    task["quotaUntil"] = json!(error.retry_at);
                }
                task["message"] = json!(error.message);
                task["nextCheckAt"] = json!(error.retry_at.max(now() + 60_000));
            }
        }
        self.put("subtitle-job", &id, &task)?;
        self.log(
            if task["state"] == "done" {
                "info"
            } else {
                "warning"
            },
            "subtitles",
            strv(&task, "message"),
            Some(&job.id),
        )?;
        let _ = app.emit("movibox://backend-changed", ());
        Ok(true)
    }
    async fn acquire_subtitle(
        &self,
        job: &AcquisitionJob,
        lang: &str,
        policy: &Value,
    ) -> Result<String, SubtitleError> {
        let path = PathBuf::from(&job.path);
        for ext in ["srt", "vtt", "ass"] {
            if path.with_extension(format!("{lang}.{ext}")).is_file() {
                return Ok("Existing subtitles kept".into());
            }
        }
        let mut video_codec = String::new();
        let probe = tokio::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,codec_name:stream_tags=language:stream_disposition=forced",
                "-of",
                "json",
            ])
            .arg(&path)
            .kill_on_drop(true)
            .output();
        if let Ok(Ok(output)) = tokio::time::timeout(std::time::Duration::from_secs(8), probe).await
        {
            if output.stdout.len() < 1024 * 1024 {
                if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
                    video_codec = value["streams"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|s| strv(s, "codec_type") == "video")
                        .map(|s| strv(s, "codec_name").to_owned())
                        .unwrap_or_default();
                    if value["streams"].as_array().into_iter().flatten().any(|s| {
                        strv(s, "codec_type") == "subtitle"
                            && !strv(&s["tags"], "language").is_empty()
                            && language(strv(&s["tags"], "language")) == lang
                            && s["disposition"]["forced"] != 1
                    }) {
                        return Ok("Preferred subtitle language is embedded in the video".into());
                    }
                }
            }
        }
        let hash_path = path.clone();
        let (hash, size) = tokio::task::spawn_blocking(move || file_hash(&hash_path))
            .await
            .map_err(|_| RequestError::from("Video hash task failed"))?
            .map_err(|message| SubtitleError::problem("file_unavailable", &message, true))?;
        let p = self
            .prefs()
            .map_err(|_| RequestError::from("Subtitle settings unavailable"))?;
        let filename = job.source_context["plannedFilename"]
            .as_str()
            .or_else(|| job.source_context["source"]["raw"]["behaviorHints"]["filename"].as_str())
            .unwrap_or(&job.title);
        let mut candidates = Vec::<(u64, String)>::new();
        let mut addon_failed = false;
        let mut provider_available = false;
        let mut rejected_matches = false;
        let multi_episode = job.source_context["episodes"]
            .as_array()
            .is_some_and(|e| e.len() > 1);
        if policy["addons"].as_bool().unwrap_or(true) && !multi_episode {
            let resource = match (job.season, job.episode) {
                (Some(s), Some(e)) => format!("{}:{s}:{e}", job.media_id),
                _ => job.media_id.clone(),
            };
            for addon in p["addons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| flag(a, "enabled"))
            {
                let manifest = match self.manifest(addon).await {
                    Ok(m) => m,
                    Err(_) => {
                        addon_failed = true;
                        continue;
                    }
                };
                if !supports(&manifest, "subtitles", &job.media_type, &resource) {
                    continue;
                }
                provider_available = true;
                let mut url = addon_root(strv(addon, "url"))
                    .map_err(|_| RequestError::from("Invalid subtitle add-on"))?;
                let extra = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("videoHash", &hash)
                    .append_pair("videoSize", &size.to_string())
                    .append_pair("filename", filename)
                    .finish();
                url.path_segments_mut()
                    .map_err(|_| RequestError::from("Invalid subtitle URL"))?
                    .pop_if_empty()
                    .push("subtitles")
                    .push(&job.media_type)
                    .push(&resource)
                    .push(&format!("{extra}.json"));
                match self
                    .requests
                    .json(self.client.get(url), Lane::Search, 60_000)
                    .await
                {
                    Ok(value) => {
                        for sub in value["subtitles"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|s| language(strv(s, "lang")) == lang)
                        {
                            candidates.push((1, strv(sub, "url").to_owned()));
                        }
                    }
                    Err(_) => {
                        addon_failed = true;
                    }
                }
            }
        }
        let auth = if p["subtitlesAccount"]["connected"] == true {
            auth_entry()
                .ok()
                .and_then(|e| e.get_password().ok())
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        } else {
            None
        };
        if p["subtitlesAccount"]["connected"] == true && auth.is_none() {
            return Err(SubtitleError::problem(
                "authentication",
                "OpenSubtitles credentials unavailable; reconnect in Settings",
                true,
            ));
        }
        provider_available |= auth.is_some();
        let quota_until = self
            .get("subtitle-quota", "opensubtitles")
            .ok()
            .flatten()
            .and_then(|v| v["until"].as_i64())
            .unwrap_or(0);
        let api_result: Result<Option<(String, &str)>, RequestError> = async {
            let mut selected_api = None;
            if let Some(auth) = auth
                .as_ref()
                .filter(|_| p["subtitlesAccount"]["connected"] == true && quota_until <= now())
            {
                if !strv(auth, "token").is_empty()
                    && auth["expiresAt"].as_i64().unwrap_or(0) < now()
                {
                    return Err(RequestError {
                        message: "OpenSubtitles sign-in expired; reconnect in Settings".into(),
                        retry_at: 0,
                        terminal: true,
                        status: Some(401),
                    });
                }
                let base = api_base(strv(auth, "base").trim_end_matches("/api/v1"))
                    .map_err(|_| RequestError::from("Invalid subtitle API host"))?;
                let mut query = vec![("languages", lang.to_owned()), ("moviehash", hash.clone())];
                if job.media_id.starts_with("tt") {
                    query.push(("imdb_id", job.media_id.trim_start_matches("tt").into()));
                }
                if let Some(s) = job.season {
                    query.push(("season_number", s.to_string()));
                }
                if let Some(e) = job.episode {
                    query.push(("episode_number", e.to_string()));
                }
                let mut req = self
                    .client
                    .get(format!("{base}/subtitles"))
                    .header("Api-Key", strv(auth, "key"))
                    .query(&query);
                if !strv(auth, "token").is_empty() {
                    req = req.bearer_auth(strv(auth, "token"));
                }
                let results = self.requests.json(req, Lane::Provider, 60_000).await?;
                let mut matches = results["data"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| {
                        let a = &r["attributes"];
                        if strv(a, "language") != lang {
                            return None;
                        }
                        if job.episode.is_some_and(|e| {
                            a["feature_details"]["episode_number"]
                                .as_i64()
                                .is_some_and(|n| n != e as i64)
                        }) {
                            return None;
                        }
                        if job.season.is_some_and(|s| {
                            a["feature_details"]["season_number"]
                                .as_i64()
                                .is_some_and(|n| n != s as i64)
                        }) {
                            return None;
                        }
                        let exact = flag(a, "moviehash_match");
                        let release = filename != job.title
                            && !filename.is_empty()
                            && release_name(strv(a, "release")) == release_name(filename);
                        if multi_episode && !exact
                            || flag(policy, "exactOnly") && !exact && !release
                        {
                            return None;
                        }
                        // Unknown episode metadata is only safe with evidence for this exact file.
                        if !exact
                            && !release
                            && (job.season.is_some_and(|s| {
                                a["feature_details"]["season_number"].as_i64() != Some(s as i64)
                            }) || job.episode.is_some_and(|e| {
                                a["feature_details"]["episode_number"].as_i64() != Some(e as i64)
                            }) || !job.media_id.starts_with("tt"))
                        {
                            return None;
                        }
                        if flag(a, "foreign_parts_only") {
                            return None;
                        }
                        let id = a["files"].as_array()?.first()?["file_id"].as_u64()?;
                        Some((
                            (
                                exact,
                                release,
                                release_codec_score(strv(a, "release"), &video_codec),
                                a["download_count"].as_u64().unwrap_or(0),
                            ),
                            id,
                        ))
                    })
                    .collect::<Vec<_>>();
                rejected_matches |= matches.is_empty()
                    && results["data"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty());
                matches.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
                selected_api = matches.first().map(|(score, id)| (*id, base, if score.0 {
                    "OpenSubtitles video-hash match; playback timing not reviewed"
                } else if score.1 {
                    "OpenSubtitles release-name match; playback timing needs review"
                } else {
                    "OpenSubtitles title/episode fallback only; video-version timing needs review"
                }));
            }
            if let Some((file_id, base, evidence)) = selected_api {
                let auth = auth
                    .as_ref()
                    .ok_or_else(|| RequestError::from("Subtitle credentials unavailable"))?;
                let mut req = self
                    .client
                    .post(format!("{base}/download"))
                    .header("Api-Key", strv(auth, "key"))
                    .json(&json!({"file_id":file_id,"sub_format":"srt"}));
                if !strv(auth, "token").is_empty() {
                    req = req.bearer_auth(strv(auth, "token"));
                }
                let value = self
                    .requests
                    .json(req, Lane::Provider, 0)
                    .await
                    .map_err(|mut e| {
                        if e.status == Some(406) {
                            e.message =
                            "OpenSubtitles download quota exhausted; retry after the quota resets"
                                .into();
                            e.terminal = false;
                            e.retry_at = now() + 86_400_000;
                            let _ = self.put(
                                "subtitle-quota",
                                "opensubtitles",
                                &json!({"until":e.retry_at}),
                            );
                        }
                        e
                    })?;
                return Ok(Some((strv(&value, "link").to_string(), evidence)));
            }
            Ok(None)
        }
        .await;
        let mut attempts = Vec::new();
        let mut last_error = None;
        match api_result {
            Ok(Some(candidate)) => attempts.push(candidate),
            Err(error) => last_error = Some(error),
            Ok(None) => {}
        }
        rejected_matches |= !candidates.is_empty() && (multi_episode || flag(policy, "exactOnly"));
        if !multi_episode && !flag(policy, "exactOnly") {
            attempts.extend(
                candidates
                    .into_iter()
                    .map(|(_, url)| (url, "Add-on match; playback timing not verified")),
            );
        }
        // Bound fallback downloads so broken add-ons cannot trigger an unbounded request chain.
        for (url, evidence) in attempts.into_iter().take(3) {
            let result = async {
                let url = http_url(&url)
                    .map_err(|_| RequestError::from("Invalid subtitle download URL"))?;
                let bytes = self
                    .requests
                    .bytes(self.client.get(url), Lane::Search, 0, 5 * 1024 * 1024)
                    .await?;
                let path = path.clone();
                let lang = lang.to_string();
                tokio::task::spawn_blocking(move || write_sidecar(&path, &lang, &bytes))
                    .await
                    .map_err(|_| RequestError::from("Subtitle save task failed"))?
                    .map_err(|message| RequestError {
                        message,
                        retry_at: 0,
                        terminal: true,
                        status: None,
                    })
            }
            .await;
            match result {
                Ok(message) => return Ok(format!("{message}. {evidence}")),
                Err(error) => last_error = Some(error),
            }
        }
        if let Some(error) = last_error {
            return Err(error.into());
        }
        if quota_until > now() {
            return Err(SubtitleError {
                reason: "quota",
                error: RequestError {
                    message: "OpenSubtitles quota cooldown; video is already saved".into(),
                    retry_at: quota_until,
                    terminal: false,
                    status: Some(406),
                },
            });
        }
        if addon_failed {
            return Err(SubtitleError::problem(
                "provider_unavailable",
                "A subtitle add-on could not be reached. Check Sources & add-ons or retry later.",
                false,
            ));
        }
        if !provider_available {
            return Err(SubtitleError::problem("not_configured", "No usable subtitle provider is configured. Connect OpenSubtitles or enable a subtitle add-on in Settings.", true));
        }
        if rejected_matches {
            return Err(SubtitleError::problem("no_safe_match", "Results were found, but none passed the language, episode and file-match requirements. Import a matching subtitle or review matching settings.", true));
        }
        let mut error=SubtitleError::problem("no_match", "No matching subtitles returned for this file and language. A later check is scheduled; you can also import a matching subtitle.", false);
        error.error.retry_at = now() + 6 * 3600_000;
        Err(error)
    }
}

// A single durable subtitle consumer cannot hold up cloud preparation (or vice versa).
pub(super) fn start(runtime: Runtime, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = runtime.recover_subtitle_tasks() {
            let _ = runtime.log("error", "subtitles", &error, None);
        }
        for job in app
            .state::<AcquisitionState>()
            .list_jobs()
            .unwrap_or_default()
            .iter()
            .filter(|j| j.status == "done")
        {
            let _ = runtime.schedule_subtitles(job);
        }
        loop {
            match runtime.run_subtitle_jobs(&app).await {
                Ok(true) => {
                    let _ = app.emit("movibox://backend-changed", ());
                    continue;
                }
                Err(error) => {
                    let _ = runtime.log("warning", "subtitles", &error, None);
                }
                Ok(false) => {}
            }
            tokio::select! {
                _ = runtime.subtitle_wake.notified() => {},
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {},
            }
        }
    });
}

impl Runtime {
    fn recover_subtitle_tasks(&self) -> Result<(), String> {
        for mut task in self.list("subtitle-job")? {
            if task["state"] == "running" {
                task["state"] = json!("queued");
                task["message"] = json!("Resuming subtitle search after restart");
                self.put("subtitle-job", strv(&task, "id"), &task)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[tokio::test]
    async fn subtitle_attention_import_and_cooldowns_are_safe() {
        let root = std::env::temp_dir().join(format!("subtitle-actions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let runtime = crate::moviebox::tests::test_runtime(&root.join("db"));
        let video = root.join("Owned.mkv");
        let original = vec![0u8; 200000];
        std::fs::write(&video, &original).unwrap();
        let job:AcquisitionJob=serde_json::from_value(json!({"id":"owned","mediaId":"owned","mediaType":"movie","title":"Owned","subtitle":null,"poster":null,"season":null,"episode":null,"streamLabel":null,"provider":null,"infoHash":null,"fileIndex":null,"sourceContext":{},"url":"","headers":{},"path":video,"status":"done","receivedBytes":200000,"totalBytes":200000,"error":null,"attempt":0,"scheduledAt":null,"createdAt":0,"updatedAt":1,"completedAt":1})).unwrap();
        let error = runtime
            .acquire_subtitle(&job, "fr", &json!({"addons":false}))
            .await
            .unwrap_err();
        assert_eq!(error.reason, "not_configured");
        assert!(error.terminal);
        runtime.put("subtitle-job","owned:fr",&json!({"id":"owned:fr","jobId":"owned","language":"fr","state":"needs_attention","reason":"quota","quotaUntil":now()+600000,"nextCheckAt":now()+600000})).unwrap();
        assert!(runtime.retry_subtitles("owned:fr").is_err());
        let source = root.join("selected.srt");
        std::fs::write(&source, b"1\n00:00:00,000 --> 00:00:01,000\nBonjour\n").unwrap();
        runtime.import_subtitle(&job, "owned:fr", &source).unwrap();
        assert_eq!(
            runtime.get("subtitle-job", "owned:fr").unwrap().unwrap()["state"],
            "done"
        );
        let sidecar = video.with_extension("fr.srt");
        let existing = std::fs::read(&sidecar).unwrap();
        std::fs::write(&source, b"1\n00:00:00,000 --> 00:00:01,000\nReplacement\n").unwrap();
        runtime.import_subtitle(&job, "owned:fr", &source).unwrap();
        assert_eq!(std::fs::read(&sidecar).unwrap(), existing);
        assert_eq!(std::fs::read(&video).unwrap(), original);
        let bad = root.join("invalid.srt");
        std::fs::write(&bad, b"<html>error</html>").unwrap();
        assert!(runtime.import_subtitle(&job, "owned:fr", &bad).is_err());
        assert!(runtime.retry_subtitles("owned:fr").is_err());
        runtime
            .put(
                "settings",
                "preferences",
                &json!({"subtitleExactOnly":false,"subtitleAddons":true}),
            )
            .unwrap();
        runtime.put("subtitle-job","retry:fr",&json!({"id":"retry:fr","jobId":"retry","language":"fr","state":"needs_attention","reason":"no_safe_match","policy":{"exactOnly":true,"ruleId":"rule"}})).unwrap();
        runtime.retry_subtitles("retry:fr").unwrap();
        let retried = runtime.get("subtitle-job", "retry:fr").unwrap().unwrap();
        assert_eq!(retried["policy"]["exactOnly"], false);
        assert_eq!(retried["policy"]["ruleId"], "rule");
        assert_eq!(retried["language"], "fr");
        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn restart_recovers_only_interrupted_tasks_and_keeps_cooldowns() {
        let root = std::env::temp_dir().join(format!("subtitle-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let runtime = crate::moviebox::tests::test_runtime(&root.join("db"));
        for state in ["running", "done", "retrying", "needs_attention"] {
            runtime
                .put(
                    "subtitle-job",
                    state,
                    &json!({"id":state,"state":state,"nextCheckAt":999999,"revision":"frozen"}),
                )
                .unwrap();
        }
        drop(runtime);
        let reopened = crate::moviebox::tests::test_runtime(&root.join("db"));
        reopened.recover_subtitle_tasks().unwrap();
        for state in ["running", "done", "retrying", "needs_attention"] {
            let task = reopened.get("subtitle-job", state).unwrap().unwrap();
            assert_eq!(
                task["state"],
                if state == "running" { "queued" } else { state }
            );
            assert_eq!(task["nextCheckAt"], 999999);
            assert_eq!(task["revision"], "frozen");
        }
        reopened.subtitle_wake.notify_one();
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            reopened.subtitle_wake.notified(),
        )
        .await
        .unwrap();
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
}
