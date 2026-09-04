//! Shared pacing and single-flight response cache. Request URLs and headers never enter logs.
use super::now;
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

#[derive(Clone, Copy)]
pub(super) enum Lane {
    Search,
    Provider,
    TorBox,
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, routing::get, Json};
    use std::sync::atomic::{AtomicUsize, Ordering};
    async fn serve(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        (
            url,
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
        )
    }
    #[tokio::test]
    async fn torbox_http_errors_keep_safe_reasons_and_capacity_cooldowns() {
        for (code, retryable) in [
            ("BOZO_FILE", false),
            ("ACTIVE_LIMIT", true),
            ("SECRET_TOKEN", false),
        ] {
            let (url, server) = serve(axum::Router::new().route("/", get(move || async move {
                (StatusCode::BAD_REQUEST, [("retry-after", "120")], Json(serde_json::json!({
                    "success":false,"error":code,"detail":"secret-token https://private.example/api?token=secret",
                    "data":{"token":"secret-token"}
                })))
            }))).await;
            let requests = Coordinator::default();
            let client = reqwest::Client::new();
            let error = requests
                .json(client.get(&url), Lane::TorBox, 0)
                .await
                .unwrap_err();
            assert_eq!(error.status, Some(400));
            assert_eq!(error.terminal, !retryable);
            assert!(!error.message.contains("secret"));
            assert!(!error.message.contains("SECRET_TOKEN"));
            assert!(!error.message.contains("private.example"));
            if code != "SECRET_TOKEN" {
                assert!(error.message.contains(code));
            }
            if retryable {
                assert!(error.retry_at >= now() + 119_000);
                let next = requests
                    .json(client.get(&url), Lane::TorBox, 0)
                    .await
                    .unwrap_err();
                assert_eq!(next.retry_at, error.retry_at);
            }
            server.abort();
        }
    }
    #[tokio::test]
    async fn torbox_oversized_error_bodies_never_enter_diagnostics() {
        let (url, server) = serve(axum::Router::new().route(
            "/",
            get(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error":"BOZO_FILE","detail":"secret".repeat(4000)})),
                )
            }),
        ))
        .await;
        let error = Coordinator::default()
            .json(reqwest::Client::new().get(url), Lane::TorBox, 0)
            .await
            .unwrap_err();
        assert_eq!(error.message, "Service returned HTTP 400");
        assert!(error.terminal);
        server.abort();
    }
    #[tokio::test]
    async fn cached_concurrent_requests_share_one_response_and_rate_limits_stop_retries() {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let (url, server) = serve(
            axum::Router::new()
                .route(
                    "/",
                    get(move || {
                        let c = c.clone();
                        async move {
                            c.fetch_add(1, Ordering::SeqCst);
                            Json(serde_json::json!({"ok":true}))
                        }
                    }),
                )
                .route(
                    "/limited",
                    get(|| async { (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "120")]) }),
                ),
        )
        .await;
        let requests = Coordinator::default();
        let client = reqwest::Client::new();
        let results = futures_util::future::join_all(
            (0..8).map(|_| requests.json(client.get(&url), Lane::Search, 60_000)),
        )
        .await;
        assert!(results.iter().all(|r| r.as_ref().unwrap()["ok"] == true));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let error = requests
            .json(client.get(format!("{url}limited")), Lane::Search, 0)
            .await
            .unwrap_err();
        assert!(!error.terminal);
        assert!(error.retry_at >= now() + 119_000);
        let error2 = requests
            .json(client.get(format!("{url}another")), Lane::Search, 0)
            .await
            .unwrap_err();
        assert_eq!(error.retry_at, error2.retry_at);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        server.abort();
    }
    #[tokio::test]
    async fn search_global_cap_is_three_and_each_origin_is_serialized() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut servers = Vec::new();
        let mut urls = Vec::new();
        for _ in 0..6 {
            let active = active.clone();
            let peak = peak.clone();
            let (url, server) = serve(axum::Router::new().route(
                "/",
                get(move || {
                    let active = active.clone();
                    let peak = peak.clone();
                    async move {
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Json(Value::Null)
                    }
                }),
            ))
            .await;
            urls.push(url);
            servers.push(server);
        }
        let requests = Coordinator::default();
        let client = reqwest::Client::new();
        let results = futures_util::future::join_all(
            urls.iter()
                .map(|u| requests.json(client.get(u), Lane::Search, 0)),
        )
        .await;
        assert!(results.iter().all(Result::is_ok));
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        peak.store(0, Ordering::SeqCst);
        let started = std::time::Instant::now();
        let results = futures_util::future::join_all(
            (0..2).map(|_| requests.json(client.get(&urls[0]), Lane::Search, 0)),
        )
        .await;
        assert!(results.iter().all(Result::is_ok));
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() >= Duration::from_millis(1900));
        for server in servers {
            server.abort();
        }
    }
    #[tokio::test]
    async fn subtitle_redirects_are_paced_and_credentials_never_cross_origins() {
        let (target, server2) = serve(axum::Router::new().route(
            "/",
            get(|headers: axum::http::HeaderMap| async move {
                assert!(headers.get("x-private").is_none());
                "1\n00:00:00,000 --> 00:00:01,000\nBonjour\n"
            }),
        ))
        .await;
        let to = target.clone();
        let (root, server) = serve(axum::Router::new().route(
            "/",
            get(move || {
                let to = to.clone();
                async move { (StatusCode::MOVED_PERMANENTLY, [("location", to)]) }
            }),
        ))
        .await;
        let requests = Coordinator::default();
        let client = reqwest::Client::new();
        let bytes = requests
            .bytes(
                client.get(&root).header("x-private", "should-not-leak"),
                Lane::Search,
                0,
                4096,
            )
            .await
            .unwrap();
        assert!(String::from_utf8(bytes).unwrap().contains("Bonjour"));
        let error = requests
            .bytes(
                client.get(&root).header("api-key", "secret"),
                Lane::Provider,
                0,
                4096,
            )
            .await
            .unwrap_err();
        assert!(error.terminal);
        assert!(error.message.contains("credentials"));
        assert!(!error.to_string().contains("secret"));
        server.abort();
        server2.abort();
    }
    #[test]
    fn redirects_reject_downgrades_writes_and_embedded_credentials() {
        let client = reqwest::Client::new();
        for target in [
            "http://example.org/file",
            "https://user:pass@example.org/file",
            "file:///etc/passwd",
        ] {
            assert!(redirect_request(
                client.get("https://example.org/start").build().unwrap(),
                target
            )
            .is_err());
        }
        assert!(redirect_request(
            client.post("https://example.org/start").build().unwrap(),
            "/end"
        )
        .is_err());
        let same = redirect_request(
            client
                .get("https://example.org/start")
                .header("api-key", "kept-here")
                .build()
                .unwrap(),
            "/end",
        )
        .unwrap();
        assert_eq!(same.headers()["api-key"], "kept-here");
    }
    #[test]
    fn retry_after_accepts_seconds_and_http_dates_without_shortening_cooldowns() {
        assert_eq!(retry_after(Some("120"), 1000), Some(121000));
        assert_eq!(
            retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT"), 0),
            Some(1445412480000)
        );
        assert_eq!(retry_after(Some("99999999999999999"), 1000), Some(i64::MAX));
    }
}

#[derive(Clone, Debug)]
pub(super) struct RequestError {
    pub message: String,
    pub retry_at: i64,
    pub terminal: bool,
    pub status: Option<u16>,
}
impl From<&str> for RequestError {
    fn from(message: &str) -> Self {
        Self {
            message: message.into(),
            retry_at: now() + 30_000,
            terminal: false,
            status: None,
        }
    }
}
impl RequestError {
    pub fn terminal(message: &str) -> Self {
        Self {
            message: message.into(),
            terminal: true,
            retry_at: 0,
            status: None,
        }
    }
}
impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
#[derive(Default)]
struct Endpoint {
    next: i64,
    blocked: i64,
    failures: u32,
    cache: HashMap<u64, (i64, Vec<u8>)>,
}
#[derive(Clone)]
pub(super) struct Coordinator {
    endpoints: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Endpoint>>>>>,
    searches: Arc<Semaphore>,
    providers: Arc<Semaphore>,
    client: reqwest::Client,
}
impl Default for Coordinator {
    fn default() -> Self {
        Self {
            endpoints: Arc::default(),
            searches: Arc::new(Semaphore::new(3)),
            providers: Arc::new(Semaphore::new(2)),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .user_agent("MoviBox/0.9.21")
                .build()
                .expect("HTTP client"),
        }
    }
}
fn fingerprint(request: &reqwest::Request) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    request.method().hash(&mut h);
    request.url().as_str().hash(&mut h);
    for (k, v) in request.headers() {
        k.as_str().hash(&mut h);
        v.as_bytes().hash(&mut h);
    }
    request.body().and_then(|b| b.as_bytes()).hash(&mut h);
    h.finish()
}
pub(super) fn retry_after(value: Option<&str>, at: i64) -> Option<i64> {
    let value = value?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(at.saturating_add(seconds.saturating_mul(1000).min(i64::MAX as u64) as i64));
    }
    chrono::DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|d| d.timestamp_millis().max(at))
}
impl Coordinator {
    pub async fn bytes(
        &self,
        request: reqwest::RequestBuilder,
        lane: Lane,
        ttl: i64,
        limit: usize,
    ) -> Result<Vec<u8>, RequestError> {
        let mut request = request
            .build()
            .map_err(|_| RequestError::from("Invalid request"))?;
        for hop in 0..=5 {
            match self.response(request, lane, ttl, limit).await? {
                Response::Body(bytes) => return Ok(bytes),
                Response::Redirect(next) if hop < 5 => request = next,
                Response::Redirect(_) => {
                    return Err(RequestError::terminal("Service redirected too many times"))
                }
            }
        }
        unreachable!()
    }
    async fn response(
        &self,
        request: reqwest::Request,
        lane: Lane,
        ttl: i64,
        limit: usize,
    ) -> Result<Response, RequestError> {
        let key = fingerprint(&request);
        let mut account = std::collections::hash_map::DefaultHasher::new();
        request
            .headers()
            .get("authorization")
            .map(|v| v.as_bytes())
            .hash(&mut account);
        let scope = match lane {
            Lane::Search => request.url().origin().ascii_serialization(),
            Lane::Provider | Lane::TorBox => format!(
                "{}:{}",
                request.url().origin().ascii_serialization(),
                account.finish()
            ),
        };
        let endpoint = {
            let mut endpoints = self
                .endpoints
                .lock()
                .map_err(|_| RequestError::from("Request coordinator unavailable"))?;
            endpoints.entry(scope).or_default().clone()
        };
        let mut state = endpoint.lock().await;
        if ttl > 0 {
            if let Some((expires, body)) = state.cache.get(&key).filter(|(t, _)| *t > now()) {
                let _ = expires;
                if body.len() > limit {
                    return Err(RequestError::terminal(
                        "Service response exceeds size limit",
                    ));
                }
                return Ok(Response::Body(body.clone()));
            }
        }
        if state.blocked > now() {
            return Err(RequestError {
                message: "Service cooling down after a rate limit or temporary failure".into(),
                retry_at: state.blocked,
                terminal: false,
                status: Some(429),
            });
        }
        if state.next > now() {
            tokio::time::sleep(Duration::from_millis((state.next - now()).max(0) as u64)).await;
        }
        let slots = match lane {
            Lane::Search => &self.searches,
            Lane::Provider | Lane::TorBox => &self.providers,
        };
        let _permit = slots
            .acquire()
            .await
            .map_err(|_| RequestError::from("Request coordinator stopped"))?;
        // At most 30 requests/minute per origin/account, regardless of episode count.
        state.next = now() + 2000;
        let redirect_template = request.try_clone();
        let response = match self.client.execute(request).await {
            Ok(response) => response,
            Err(_) => {
                state.failures = state.failures.saturating_add(1);
                state.blocked =
                    now() + ((1_i64 << state.failures.min(7)) * 1000) + (key % 1000) as i64;
                return Err(RequestError {
                    message: "Service could not be reached or timed out".into(),
                    retry_at: state.blocked,
                    terminal: false,
                    status: None,
                });
            }
        };
        let status = response.status();
        if matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            let original = redirect_template
                .ok_or_else(|| RequestError::terminal("Cannot replay redirected request"))?;
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| RequestError::terminal("Service redirect has no destination"))?;
            let next = redirect_request(original, location).map_err(|mut error| {
                error.status = Some(status.as_u16());
                error.message = format!(
                    "Service returned HTTP {}: {}",
                    status.as_u16(),
                    error.message
                );
                error
            })?;
            return Ok(Response::Redirect(next));
        }
        if !status.is_success() {
            let transient =
                status.as_u16() == 429 || status.is_server_error() || status.as_u16() == 408;
            state.failures = state.failures.saturating_add(1);
            let next = retry_after(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok()),
                now(),
            )
            .unwrap_or_else(|| {
                now() + ((1_i64 << state.failures.min(7)) * 1000) + ((key % 1000) as i64)
            });
            let mut error = RequestError {
                message: format!(
                    "Service returned HTTP {}{}",
                    status.as_u16(),
                    if status.as_u16() == 429 {
                        "; waiting before retry"
                    } else {
                        ""
                    }
                ),
                retry_at: next,
                terminal: !transient,
                status: Some(status.as_u16()),
            };
            if matches!(lane, Lane::TorBox) {
                // Read only a bounded error envelope. Provider detail/data can contain secrets.
                let mut body = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(Ok(part)) = stream.next().await {
                    if body.len() + part.len() > 16 * 1024 {
                        body.clear();
                        break;
                    }
                    body.extend_from_slice(&part);
                }
                if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                    error = super::providers::torbox_error(&value, error);
                }
            }
            if !error.terminal {
                state.blocked = error.retry_at;
            }
            return Err(error);
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| RequestError::from("Incomplete service response"))?;
            if bytes.len() + part.len() > limit {
                return Err(RequestError::from("Service response exceeds size limit"));
            }
            bytes.extend_from_slice(&part);
        }
        state.failures = 0;
        if ttl > 0 {
            state.cache.retain(|_, (at, _)| *at > now());
            if state.cache.len() >= 32 {
                state.cache.clear();
            }
            state.cache.insert(key, (now() + ttl, bytes.clone()));
        }
        Ok(Response::Body(bytes))
    }
    pub async fn json(
        &self,
        request: reqwest::RequestBuilder,
        lane: Lane,
        ttl: i64,
    ) -> Result<Value, RequestError> {
        let bytes = self.bytes(request, lane, ttl, 4 * 1024 * 1024).await?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| RequestError::from("Service returned invalid JSON"))
    }
}

// Each redirect re-enters the coordinator, so its destination gets the same pacing and limits.
enum Response {
    Body(Vec<u8>),
    Redirect(reqwest::Request),
}
fn redirect_request(
    mut request: reqwest::Request,
    location: &str,
) -> Result<reqwest::Request, RequestError> {
    if request.method() != reqwest::Method::GET && request.method() != reqwest::Method::HEAD {
        return Err(RequestError::terminal(
            "Service redirected a write request; it was not replayed",
        ));
    }
    let target = request
        .url()
        .join(location)
        .map_err(|_| RequestError::terminal("Invalid redirect destination"))?;
    if !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
        || request.url().scheme() == "https" && target.scheme() != "https"
    {
        return Err(RequestError::terminal("Unsafe service redirect blocked"));
    }
    if target.origin() != request.url().origin() {
        let credentialed = request.headers().keys().any(|k| {
            matches!(
                k.as_str(),
                "authorization" | "api-key" | "x-api-key" | "cookie" | "proxy-authorization"
            )
        }) || request.url().query_pairs().any(|(k, _)| {
            matches!(
                k.to_ascii_lowercase().as_str(),
                "apikey" | "api_key" | "api-key" | "access_token" | "password"
            )
        });
        if credentialed {
            return Err(RequestError::terminal(
                "Service tried to redirect credentials to another host",
            ));
        }
        // Never carry source-specific headers across origins, even for anonymous subtitle links.
        request.headers_mut().clear();
    }
    *request.url_mut() = target;
    Ok(request)
}
