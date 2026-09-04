use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::AsyncWriteExt;

pub struct DownloadState {
    tasks: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl DownloadState {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DownloadEvent {
    Started { total: Option<u64>, resumed: u64 },
    Progress { received: u64, total: Option<u64> },
    Done { received: u64 },
    Error { message: String },
    Canceled { received: u64 },
}

#[derive(Debug)]
pub(crate) enum DownloadEnd {
    Deferred,
    Canceled(u64),
    Failed(String),
}

const EMIT_INTERVAL_MS: u128 = 250;
const EMIT_BYTES: u64 = 4 * 1024 * 1024;
const MIN_VIDEO_BYTES: u64 = 512 * 1024;
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

fn total_from_content_range(value: &str) -> Option<u64> {
    value
        .rsplit('/')
        .next()
        .and_then(|s| s.trim().parse::<u64>().ok())
}

pub(crate) type DownloadSink = Arc<dyn Fn(DownloadEvent) + Send + Sync>;

#[tauri::command]
pub async fn download_start(
    state: State<'_, DownloadState>,
    id: String,
    url: String,
    dest: String,
    headers: Option<HashMap<String, String>>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .tasks
        .lock()
        .unwrap()
        .insert(id.clone(), cancel.clone());

    let sink: DownloadSink = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    let outcome = run_download(&url, &dest, &headers.unwrap_or_default(), &cancel, &sink).await;
    state.tasks.lock().unwrap().remove(&id);

    match outcome {
        Ok(()) => Ok(()),
        Err(DownloadEnd::Canceled(received)) => {
            sink(DownloadEvent::Canceled { received });
            Ok(())
        }
        Err(DownloadEnd::Deferred) => Err("Download deferred".into()),
        Err(DownloadEnd::Failed(message)) => {
            sink(DownloadEvent::Error {
                message: message.clone(),
            });
            Err(message)
        }
    }
}

#[tauri::command]
pub fn download_cancel(state: State<'_, DownloadState>, id: String) {
    if let Some(flag) = state.tasks.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

pub(crate) async fn run_download(
    url: &str,
    dest: &str,
    headers: &HashMap<String, String>,
    cancel: &Arc<AtomicBool>,
    on_event: &DownloadSink,
) -> Result<(), DownloadEnd> {
    run_download_with_policy(
        url,
        dest,
        headers,
        cancel,
        on_event,
        &DownloadPolicy::default(),
    )
    .await
}

pub(crate) struct DownloadPolicy {
    pub allowed: Arc<dyn Fn() -> bool + Send + Sync>,
    pub bytes_per_second: u64,
    pub reserve_bytes: u64,
    pub max_bytes: u64,
}
impl Default for DownloadPolicy {
    fn default() -> Self {
        Self {
            allowed: Arc::new(|| true),
            bytes_per_second: 0,
            reserve_bytes: 0,
            max_bytes: u64::MAX,
        }
    }
}
pub(crate) async fn run_download_with_policy(
    url: &str,
    dest: &str,
    headers: &HashMap<String, String>,
    cancel: &Arc<AtomicBool>,
    on_event: &DownloadSink,
    policy: &DownloadPolicy,
) -> Result<(), DownloadEnd> {
    if std::path::Path::new(dest).exists() {
        return Err(DownloadEnd::Failed(
            "A completed file already exists at this destination; it was left untouched".into(),
        ));
    }
    let part = format!("{}.part", dest);
    let validator_path = format!("{part}.http.json");

    if let Some(parent) = std::path::Path::new(dest).parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| DownloadEnd::Failed(format!("create folder: {}", e)))?;
        }
    }

    let start_byte = match tokio::fs::metadata(&part).await {
        Ok(meta) => meta.len(),
        Err(_) => 0,
    };

    let client = reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| DownloadEnd::Failed(format!("client: {}", e)))?;
    let has = |name: &str| headers.keys().any(|k| k.eq_ignore_ascii_case(name));
    let mut req = client.get(url);
    if !has("accept") {
        req = req.header(reqwest::header::ACCEPT, "*/*");
    }
    for (k, v) in headers {
        if !["range", "if-range", "accept-encoding", "host"]
            .contains(&k.to_ascii_lowercase().as_str())
        {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    req = req.header(reqwest::header::ACCEPT_ENCODING, "identity");
    if start_byte > 0 {
        if let Ok(validator) = tokio::fs::read_to_string(&validator_path).await {
            req = req.header(reqwest::header::IF_RANGE, validator);
        }
        req = req.header(reqwest::header::RANGE, format!("bytes={}-", start_byte));
    } else if !has("range") {
        req = req.header(reqwest::header::RANGE, "bytes=0-");
    }
    eprintln!(
        "[harbor::download] GET {} resume-from={}",
        log_host(url),
        start_byte
    );
    let resp = tokio::select! {
        biased;
        _ = wait_cancelled(cancel) => return Err(DownloadEnd::Canceled(start_byte)),
        r = req.send() => r.map_err(|e| DownloadEnd::Failed(format!("request: {}", e.without_url())))?,
    };
    let status = resp.status();
    eprintln!(
        "[harbor::download] status={} content-length={:?}",
        status.as_u16(),
        resp.content_length()
    );

    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && start_byte > 0 {
        let total = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .and_then(total_from_content_range);
        if total != Some(start_byte) || start_byte < MIN_VIDEO_BYTES {
            return Err(DownloadEnd::Failed(
                "Invalid resume response; partial file kept".into(),
            ));
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(DownloadEnd::Canceled(start_byte));
        }
        tokio::fs::rename(&part, dest)
            .await
            .map_err(|e| DownloadEnd::Failed(format!("finalize: {e}")))?;
        let _ = tokio::fs::remove_file(&validator_path).await;
        on_event(DownloadEvent::Done {
            received: start_byte,
        });
        return Ok(());
    }
    if !status.is_success() {
        eprintln!(
            "[harbor::download] upstream rejected: HTTP {}",
            status.as_u16()
        );
        return Err(DownloadEnd::Failed(format!("HTTP {}", status.as_u16())));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    eprintln!(
        "[harbor::download] content-type={} content-length={:?}",
        content_type,
        resp.content_length()
    );
    let non_video = content_type.starts_with("text/")
        || content_type.contains("html")
        || content_type.contains("json")
        || content_type.contains("xml");
    if non_video {
        return Err(DownloadEnd::Failed(
            "Source returned a document instead of a video".into(),
        ));
    }
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let range = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        let actual_start = range
            .strip_prefix("bytes ")
            .and_then(|s| s.split('-').next())
            .and_then(|v| v.parse::<u64>().ok());
        if actual_start != Some(start_byte) {
            return Err(DownloadEnd::Failed(
                "Server returned the wrong resume range; partial file kept".into(),
            ));
        }
    }
    if let Some(validator) = resp
        .headers()
        .get(reqwest::header::ETAG)
        .or_else(|| resp.headers().get(reqwest::header::LAST_MODIFIED))
        .and_then(|h| h.to_str().ok())
    {
        tokio::fs::write(&validator_path, validator)
            .await
            .map_err(|_| DownloadEnd::Failed("Could not save resume metadata".into()))?;
    }

    let resuming = start_byte > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
    let total = if resuming {
        resp.headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .and_then(total_from_content_range)
    } else {
        resp.content_length()
    };

    if total.is_some_and(|n| n > policy.max_bytes) {
        return Err(DownloadEnd::Failed(
            "File exceeds the configured size limit".into(),
        ));
    }
    let mut received = if resuming { start_byte } else { 0 };
    let initial_received = received;
    let started = Instant::now();
    let mut checked_at = Instant::now() - Duration::from_secs(2);
    let file = if resuming {
        tokio::fs::OpenOptions::new().append(true).open(&part).await
    } else {
        tokio::fs::File::create(&part).await
    }
    .map_err(|e| DownloadEnd::Failed(format!("open: {}", e)))?;
    let mut writer = tokio::io::BufWriter::with_capacity(1 << 20, file);

    on_event(DownloadEvent::Started {
        total,
        resumed: received,
    });

    let mut stream = resp.bytes_stream();
    let mut last = Instant::now();
    let mut since: u64 = 0;
    loop {
        if !(policy.allowed)() {
            writer
                .flush()
                .await
                .map_err(|_| DownloadEnd::Failed("Could not flush partial download".into()))?;
            return Err(DownloadEnd::Deferred);
        }
        if checked_at.elapsed() >= Duration::from_secs(1) {
            let parent = std::path::Path::new(dest)
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
            let free = fs2::available_space(parent).map_err(|_| {
                DownloadEnd::Failed("Could not check destination free space".into())
            })?;
            if free < policy.reserve_bytes + 4 * 1024 * 1024 {
                writer
                    .flush()
                    .await
                    .map_err(|_| DownloadEnd::Failed("Could not flush partial download".into()))?;
                return Err(DownloadEnd::Failed(
                    "Free-space reserve reached. Choose another destination or free disk space."
                        .into(),
                ));
            }
            checked_at = Instant::now();
        }
        let next = tokio::select! {
            biased;
            _ = wait_cancelled(cancel) => {
                writer.flush().await.map_err(|e| DownloadEnd::Failed(format!("flush: {e}")))?;
                return Err(DownloadEnd::Canceled(received));
            }
            n = stream.next() => n,
        };
        let Some(chunk) = next else { break };
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                writer
                    .flush()
                    .await
                    .map_err(|e| DownloadEnd::Failed(format!("flush: {e}")))?;
                return Err(DownloadEnd::Failed(format!(
                    "stream: {}",
                    error.without_url()
                )));
            }
        };
        if received + bytes.len() as u64 > policy.max_bytes {
            return Err(DownloadEnd::Failed(
                "File exceeds the configured size limit".into(),
            ));
        }
        writer
            .write_all(&bytes)
            .await
            .map_err(|e| DownloadEnd::Failed(format!("write: {}", e)))?;
        received += bytes.len() as u64;
        since += bytes.len() as u64;
        if policy.bytes_per_second > 0 {
            let due = Duration::from_secs_f64(
                (received - initial_received) as f64 / policy.bytes_per_second as f64,
            );
            if let Some(delay) = due.checked_sub(started.elapsed()) {
                tokio::select! {_ = tokio::time::sleep(delay)=>{},_ = wait_cancelled(cancel)=>{writer.flush().await.map_err(|_|DownloadEnd::Failed("Could not flush partial download".into()))?;return Err(DownloadEnd::Canceled(received));}}
            }
        }
        if last.elapsed().as_millis() >= EMIT_INTERVAL_MS || since >= EMIT_BYTES {
            on_event(DownloadEvent::Progress { received, total });
            last = Instant::now();
            since = 0;
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| DownloadEnd::Failed(format!("flush: {e}")))?;
    writer
        .get_ref()
        .sync_all()
        .await
        .map_err(|e| DownloadEnd::Failed(format!("sync: {e}")))?;
    drop(writer);
    if total.is_some_and(|n| n != received) {
        return Err(DownloadEnd::Failed(
            "Incomplete response; partial file kept for retry".into(),
        ));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(DownloadEnd::Canceled(received));
    }

    if received < MIN_VIDEO_BYTES {
        eprintln!(
            "[harbor::download] refusing {} bytes (not a video file)",
            received
        );
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DownloadEnd::Failed(format!(
            "source returned only {} bytes, not the video (try a different source)",
            received
        )));
    }

    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| DownloadEnd::Failed(format!("rename: {}", e)))?;

    let _ = tokio::fs::remove_file(&validator_path).await;
    eprintln!("[movibox::download] complete {received} bytes");
    on_event(DownloadEvent::Progress { received, total });
    on_event(DownloadEvent::Done { received });
    Ok(())
}

pub(crate) async fn wait_cancelled(cancel: &Arc<AtomicBool>) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

fn log_host(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_else(|| "invalid URL".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn server(
        status: &str,
        headers: &str,
        body: Vec<u8>,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/owned-fixture.mkv",
            listener.local_addr().unwrap()
        );
        let header=format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: video/x-matroska\r\n{headers}\r\n");
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            request
        });
        (url, task)
    }
    fn temp() -> (std::path::PathBuf, String) {
        let root =
            std::env::temp_dir().join(format!("movibox-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.mkv").to_string_lossy().into();
        (root, path)
    }
    fn sink() -> DownloadSink {
        Arc::new(|_| {})
    }
    #[tokio::test]
    async fn range_resume_preserves_bytes_and_finalizes_atomically() {
        let (root, path) = temp();
        let first = vec![7; 600_000];
        let second = vec![9; 200_000];
        std::fs::write(format!("{path}.part"), &first).unwrap();
        let (url, task) = server(
            "206 Partial Content",
            "Content-Length: 200000\r\nContent-Range: bytes 600000-799999/800000\r\n",
            second.clone(),
        )
        .await;
        run_download(
            &url,
            &path,
            &HashMap::new(),
            &Arc::new(AtomicBool::new(false)),
            &sink(),
        )
        .await
        .unwrap();
        assert!(task
            .await
            .unwrap()
            .to_lowercase()
            .contains("range: bytes=600000-"));
        assert_eq!(std::fs::read(&path).unwrap(), [first, second].concat());
        assert!(!std::path::Path::new(&format!("{path}.part")).exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn invalid_416_cannot_mark_partial_download_complete() {
        let (root, path) = temp();
        std::fs::write(format!("{path}.part"), vec![1; 600_000]).unwrap();
        let (url, task) = server(
            "416 Range Not Satisfiable",
            "Content-Length: 0\r\nContent-Range: bytes */900000\r\n",
            vec![],
        )
        .await;
        assert!(matches!(
            run_download(
                &url,
                &path,
                &HashMap::new(),
                &Arc::new(AtomicBool::new(false)),
                &sink()
            )
            .await,
            Err(DownloadEnd::Failed(_))
        ));
        task.await.unwrap();
        assert!(!std::path::Path::new(&path).exists());
        assert_eq!(
            std::fs::metadata(format!("{path}.part")).unwrap().len(),
            600_000
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn wrong_content_range_keeps_original_partial() {
        let (root, path) = temp();
        std::fs::write(format!("{path}.part"), vec![1; 600_000]).unwrap();
        let (url, task) = server(
            "206 Partial Content",
            "Content-Length: 600000\r\nContent-Range: bytes 0-599999/600000\r\n",
            vec![2; 600_000],
        )
        .await;
        assert!(matches!(
            run_download(
                &url,
                &path,
                &HashMap::new(),
                &Arc::new(AtomicBool::new(false)),
                &sink()
            )
            .await,
            Err(DownloadEnd::Failed(_))
        ));
        task.await.unwrap();
        assert_eq!(
            std::fs::read(format!("{path}.part")).unwrap(),
            vec![1; 600_000]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn truncated_response_is_not_a_completed_file() {
        let (root, path) = temp();
        let (url, task) = server("200 OK", "Content-Length: 900000\r\n", vec![1; 600_000]).await;
        assert!(matches!(
            run_download(
                &url,
                &path,
                &HashMap::new(),
                &Arc::new(AtomicBool::new(false)),
                &sink()
            )
            .await,
            Err(DownloadEnd::Failed(_))
        ));
        task.await.unwrap();
        assert!(!std::path::Path::new(&path).exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn closed_window_defers_without_losing_partial() {
        let (root, path) = temp();
        std::fs::write(format!("{path}.part"), vec![1; 600_000]).unwrap();
        let (url, task) = server(
            "206 Partial Content",
            "Content-Length: 200000\r\nContent-Range: bytes 600000-799999/800000\r\n",
            vec![2; 200_000],
        )
        .await;
        let policy = DownloadPolicy {
            allowed: Arc::new(|| false),
            ..Default::default()
        };
        assert!(matches!(
            run_download_with_policy(
                &url,
                &path,
                &HashMap::new(),
                &Arc::new(AtomicBool::new(false)),
                &sink(),
                &policy
            )
            .await,
            Err(DownloadEnd::Deferred)
        ));
        task.await.unwrap();
        assert_eq!(
            std::fs::metadata(format!("{path}.part")).unwrap().len(),
            600_000
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_connection() {
        let (root, path) = temp();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/fixture.mkv", listener.local_addr().unwrap());
        let (connected, connection) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            let _ = connected.send(());
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let transfer = tokio::spawn(async move {
            run_download(&url, &path, &HashMap::new(), &flag, &sink()).await
        });
        // Time cancellation of an established stalled connection, not TLS/client startup
        // competing with every other fixture on a small Linux CI runner.
        tokio::time::timeout(Duration::from_secs(15), connection)
            .await
            .unwrap()
            .unwrap();
        cancel.store(true, Ordering::Relaxed);
        let result = tokio::time::timeout(Duration::from_secs(1), transfer)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(DownloadEnd::Canceled(_))));
        task.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}
