use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) fn test_runtime(path: &Path) -> Runtime {
    let runtime = Runtime {
        db: Arc::new(Mutex::new(Connection::open(path).unwrap())),
        client: reqwest::Client::new(),
        running_rules: Arc::default(),
        credential: Arc::default(),
        preparation: Arc::default(),
        subtitle_wake: Arc::default(),
        subtitle_commit: Arc::default(),
        workflow_commit: Arc::default(),
        search_workers: Arc::default(),
        interactive_search: Arc::default(),
        requests: super::requests::Coordinator::default(),
        provider_url: None,
    };
    runtime.initialize_documents().unwrap();
    if runtime.get("settings", "preferences").unwrap().is_none() {
        runtime.put("settings", "preferences", &json!({})).unwrap();
    }
    runtime
}
async fn fixture() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/", listener.local_addr().unwrap());
    let response_base = address.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0; 16384];
            let size = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            let body = if request.contains("/manifest.json") {
                json!({"id":"fixture","name":"Owned fixture","types":["movie","series"],"resources":["catalog","meta","stream"],"catalogs":[{"id":"search","type":"movie","extra":[{"name":"search"}]}]})
            } else if request.contains("/catalog/movie/search/search=Owned") {
                json!({"metas":[{"id":"fixture-film","name":"Owned Film","type":"movie","releaseInfo":"2026","genres":["Documentary"]}]})
            } else if request.contains("/meta/movie/fixture-film.json") {
                json!({"meta":{"id":"fixture-film","name":"Owned Film","type":"movie","releaseInfo":"2026","description":"Public fixture"}})
            } else if request.contains("/stream/movie/fixture-film.json") {
                json!({"streams":[{"name":"1080p","title":"Owned.Film.2026.1080p.English.mkv","url":format!("{response_base}owned-video.mkv"),"behaviorHints":{"videoSize":800000}}]})
            } else {
                json!({"unexpected":true})
            };
            let body = body.to_string();
            let header=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        }
    });
    (address, task)
}
#[tokio::test]
async fn real_http_catalog_metadata_and_source_pipeline_persists_without_exposing_urls() {
    let (root, task) = fixture().await;
    let dir = std::env::temp_dir().join(format!("movibox-backend-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let database = dir.join("test.sqlite");
    let runtime = test_runtime(&database);
    runtime.put("settings","preferences",&json!({"provider":false,"addons":[{"id":"fixture","name":"Fixture","url":format!("{root}manifest.json"),"enabled":true}],"maxSize":"1","sourcePreference":"Cached first"})).unwrap();
    let catalog = runtime.catalog("movie", "Owned", 0).await.unwrap();
    assert_eq!(catalog["items"][0]["id"], "fixture-film");
    let detail = runtime.detail("fixture-film", "movie").await.unwrap();
    assert_eq!(detail["description"], "Public fixture");
    let sources = runtime
        .sources(
            "fixture-film",
            "movie",
            None,
            None,
            "1080p or better",
            "English",
        )
        .await
        .unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["cached"], true);
    assert!(sources[0].get("url").is_none());
    assert!(!sources[0].to_string().contains(&root));
    assert!(runtime
        .sources(
            "fixture-film",
            "movie",
            None,
            None,
            "4K or better",
            "English"
        )
        .await
        .unwrap()
        .is_empty());
    drop(runtime);
    let reopened = test_runtime(&database);
    assert_eq!(
        reopened.get("media", "fixture-film").unwrap().unwrap()["title"],
        "Owned Film"
    );
    task.abort();
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn safe_filenames_cannot_escape_download_root() {
    assert_eq!(safe_name("../../secret"), "_.._secret");
    assert!(!safe_name("movie/../title\\name").contains('/'));
    assert_eq!(safe_name(".."), "Untitled");
}

async fn source_fixture(
    resources: Value,
    status: u16,
    payload: Value,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let root = format!(
        "http://{}/configured%2Fprivate/",
        listener.local_addr().unwrap()
    );
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 16384];
            let size = socket.read(&mut buffer).await.unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            let manifest = request.contains("/manifest.json?");
            // Both the encoded configuration segment and query must survive resource routing.
            assert!(request.contains("/configured%2Fprivate/"));
            assert!(request.contains("?token=fixture-secret"));
            let body = if manifest {
                json!({"id":"fixture", "name":"Fixture", "types":["movie","series"], "resources":resources})
            } else { payload.clone() }.to_string();
            let code = if manifest { 200 } else { status };
            let header = format!("HTTP/1.1 {code} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        }
    });
    (root, task)
}
fn configure_fixture(runtime: &Runtime, root: &str) {
    runtime.put("settings", "preferences", &json!({
        "provider":true, "addons":[{"id":"fixture", "name":"Fixture", "enabled":true,
        "url":format!("{root}manifest.json?token=fixture-secret")}], "maxSize":"1", "sourcePreference":"Cached first"
    })).unwrap();
}
#[tokio::test]
async fn metadata_only_setup_returns_actionable_report_and_persistent_search_logs() {
    let (root, task) = source_fixture(json!(["catalog", "meta"]), 200, json!({})).await;
    let dir = std::env::temp_dir().join(format!("movibox-source-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.sqlite");
    let runtime = test_runtime(&path);
    configure_fixture(&runtime, &root);
    let report = runtime
        .search_sources(
            "tt-fixture",
            "movie",
            None,
            None,
            "Any quality",
            "Any language",
        )
        .await
        .unwrap();
    assert_eq!(report["state"], "missing_provider");
    assert!(report["sources"].as_array().unwrap().is_empty());
    assert_eq!(report["providers"][0]["status"], "skipped");
    assert!(strv(&report, "summary").contains("Cinemeta"));
    assert!(report["warnings"].as_array().unwrap().is_empty()); // No unnecessary credential or TorBox request.
    assert!(!report.to_string().contains("fixture-secret"));
    assert!(!report.to_string().contains(&root));
    let request = strv(&report, "requestId").to_string();
    drop(runtime);
    let reopened = test_runtime(&path);
    let logs = reopened.logs(Some(&request)).unwrap();
    assert!(logs
        .iter()
        .any(|l| strv(l, "message").contains("Source search started")));
    assert!(logs
        .iter()
        .any(|l| strv(l, "message").contains("no download-source request")));
    assert!(logs
        .iter()
        .all(|l| !l.to_string().contains("fixture-secret")));
    assert!(reopened.logs(Some("unrelated-search")).unwrap().is_empty());
    assert!(reopened
        .sources(
            "tt-fixture",
            "series",
            Some(1),
            Some(1),
            "Any quality",
            "Any language"
        )
        .await
        .unwrap_err()
        .contains("Torznab indexer"));
    task.abort();
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}
#[tokio::test]
async fn source_failure_and_filtered_empty_results_have_distinct_diagnostics() {
    let (root, task) =
        source_fixture(json!(["stream"]), 503, json!({"private":"fixture-secret"})).await;
    let runtime = test_runtime(Path::new(":memory:"));
    configure_fixture(&runtime, &root);
    let report = runtime
        .search_sources(
            "tt-fixture",
            "movie",
            None,
            None,
            "Any quality",
            "Any language",
        )
        .await
        .unwrap();
    assert_eq!(report["state"], "error");
    assert_eq!(report["providers"][0]["status"], "failed");
    assert_eq!(
        report["providers"][0]["message"],
        "Service returned HTTP 503"
    );
    assert!(!report.to_string().contains("fixture-secret"));
    task.abort();
    let (root, task) = source_fixture(json!(["stream"]), 200, json!({"streams":[null, 42, "invalid", {"name":"1080p", "title":"Owned.Film.1080p.English.mkv", "url":"https://example.com/owned.mp4"}]})).await;
    let runtime = test_runtime(Path::new(":memory:"));
    configure_fixture(&runtime, &root);
    let report = runtime
        .search_sources(
            "tt-fixture",
            "movie",
            None,
            None,
            "4K or better",
            "Any language",
        )
        .await
        .unwrap();
    assert_eq!(report["state"], "empty");
    assert_eq!(report["providers"][0]["status"], "searched");
    assert_eq!(report["providers"][0]["received"], 4);
    assert_eq!(
        report["providers"][0]["rejected"]["invalid source metadata"],
        3
    );
    assert_eq!(
        report["providers"][0]["rejected"]["quality below preference"],
        1
    );
    let report = runtime
        .search_sources(
            "tt-fixture",
            "movie",
            None,
            None,
            "Any quality",
            "Any language",
        )
        .await
        .unwrap();
    assert_eq!(report["state"], "matches");
    assert_eq!(report["sources"][0]["verification"], "unverified");
    assert!(!report.to_string().contains("https://example.com"));
    task.abort();
}
