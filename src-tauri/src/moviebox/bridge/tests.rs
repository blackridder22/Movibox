use super::super::{strv, tests::test_runtime};
use super::{
    matching,
    planner::{choices, select_picks},
    BundleRequest,
};
use crate::acquisition::{self, AcquisitionState, EnqueueAcquisition};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn pack(hash: &str, names: &[&str]) -> Value {
    json!({"mediaId":"owned","kind":"series","season":1,"raw":{"infoHash":hash,"title":"Owned S01 1080p English"},"display":{"id":hash,"name":"Owned pack","height":1080,"pack":true,"cached":true},"files":names.iter().map(|n|json!({"name":n,"size":100})).collect::<Vec<_>>()})
}
#[test]
fn partial_pack_fills_gaps_and_deduplicates_multi_episode_files() {
    let partial = pack(
        "a",
        &[
            "Owned.S01E01E02.mkv",
            "Owned.S01E04.mkv",
            "Owned.S02E03.mkv",
            "sample.mkv",
        ],
    );
    let other = pack("b", &["Owned.S01E03.mkv"]);
    let mut candidates = choices(&partial, 1, &[1, 2, 3, 4], 1000);
    candidates.extend(choices(&other, 1, &[1, 2, 3, 4], 1000));
    candidates.extend(choices(&partial, 1, &[1, 2, 3, 4], 1000));
    let picks = select_picks(candidates, &[1, 2, 3, 4], "Season pack");
    assert_eq!(picks.len(), 3);
    let mut coverage = picks
        .iter()
        .flat_map(|p| p.episodes.clone())
        .collect::<Vec<_>>();
    coverage.sort();
    assert_eq!(coverage, vec![1, 2, 3, 4]);
    assert_eq!(choices(&partial, 1, &[4], 1000).len(), 1);
}
#[test]
fn pack_label_ambiguity_and_size_are_not_coverage() {
    let mut p = pack(
        "a",
        &[
            "Owned.S01E01.1080p.mkv",
            "Owned.S01E01.2160p.mkv",
            "Owned.S01E02.mkv",
        ],
    );
    assert_eq!(
        choices(&p, 1, &[1, 2], 1000)
            .iter()
            .flat_map(|p| p.episodes.clone())
            .collect::<Vec<_>>(),
        vec![2]
    );
    assert!(choices(&p, 1, &[1, 2], 50).is_empty());
    p["files"] = Value::Null;
    assert!(choices(&p, 1, &[1, 2], 1000).iter().all(|p| !p.verified));
    assert!(select_picks(
        choices(&p, 1, &[1, 2], 1000),
        &[1, 2],
        "Individual episodes"
    )
    .is_empty());
}
#[test]
fn direct_links_keep_episode_scope_without_claiming_a_manifest() {
    let mut source = json!({"episode":1,"raw":{"url":"https://example.invalid/private/one"},"display":{"pack":false}});
    let one = choices(&source, 1, &[1, 2], 1000);
    source["episode"] = json!(2);
    let mut both = one;
    both.extend(choices(&source, 1, &[1, 2], 1000));
    let result = select_picks(both, &[1, 2], "Season pack");
    assert_eq!(
        result.len(),
        1,
        "one opaque link must not download twice for different episodes"
    );
    assert!(result[0].filename.is_none());
}
#[test]
fn exact_identity_and_audio_aliases() {
    let movie = json!({"id":"tt123","title":"Home","year":"2020","kind":"movie"});
    assert!(matching::identity(&movie, "Home Again 2020 1080p", &json!({})).is_err());
    assert_eq!(
        matching::language_code("French"),
        matching::language_code("fra")
    );
    assert_ne!(
        matching::language_code("multi"),
        matching::language_code("French")
    );
}
fn input(episode: i32, bundle: &str) -> EnqueueAcquisition {
    serde_json::from_value(json!({"mediaId":"owned","mediaType":"series","title":"Owned","season":1,"episode":episode,"sourceContext":{"moviebox":true,"bundleId":bundle,"episodes":[episode]},"url":"","path":format!("/tmp/owned-{}-{episode}.mkv",uuid::Uuid::new_v4())})).unwrap()
}
#[test]
fn bundle_commit_is_atomic_idempotent_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!("bundle-{}.sqlite", uuid::Uuid::new_v4()));
    let runtime = test_runtime(&path);
    let state =
        AcquisitionState::from_connection(rusqlite::Connection::open(&path).unwrap()).unwrap();
    let (_, jobs) = acquisition::persist_bundle(
        &state,
        "one",
        json!({"id":"one"}),
        vec![input(1, "one"), input(2, "one")],
    )
    .unwrap();
    assert_eq!(jobs.len(), 2);
    assert_eq!(
        acquisition::persist_bundle(&state, "one", json!({}), vec![input(1, "one")])
            .unwrap()
            .1
            .len(),
        0
    );
    assert!(acquisition::persist_bundle(
        &state,
        "two",
        json!({}),
        vec![input(3, "two"), input(2, "two")]
    )
    .is_err());
    assert_eq!(state.list_jobs().unwrap().len(), 2);
    assert!(runtime.get("bundle", "two").unwrap().is_none());
    drop(state);
    drop(runtime);
    let state =
        AcquisitionState::from_connection(rusqlite::Connection::open(&path).unwrap()).unwrap();
    assert_eq!(state.list_jobs().unwrap().len(), 2);
    drop(state);
    std::fs::remove_file(path).unwrap();
}
async fn provider(lost: bool) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    use axum::{
        routing::{get, post},
        Json,
    };
    let count = Arc::new(AtomicUsize::new(0));
    let c = count.clone();
    let app = axum::Router::new()
        .route(
            "/torrents/mylist",
            get(|axum::extract::Query(q):axum::extract::Query<std::collections::HashMap<String,String>>| async move {
                Json(json!({"success":true,"data":if q.contains_key("id") {json!({"id":41,"hash":"a".repeat(40),"download_state":"metaDL","files":[]})}else{json!([])}}))
            }),
        )
        .route(
            "/torrents/createtorrent",
            post(move || {
                let c = c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    if lost {
                        Json(json!({"success":false,"error":"UNKNOWN"}))
                    } else {
                        Json(json!({"success":true,"data":{"torrent_id":41}}))
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base, count, task)
}
#[tokio::test]
async fn concurrent_preparation_and_restart_only_submit_once() {
    let (base, count, server) = provider(false).await;
    let path = std::env::temp_dir().join(format!("prepare-{}.sqlite", uuid::Uuid::new_v4()));
    let mut runtime = test_runtime(&path);
    runtime.provider_url = Some(base.clone());
    *runtime.credential.lock().unwrap() = Some("fixture-key".into());
    let hash = "a".repeat(40);
    let binding = crate::moviebox::providers::Binding::default();
    let (a, b) = tokio::join!(
        runtime.cloud_task(&binding, &hash),
        runtime.cloud_task(&binding, &hash)
    );
    assert_eq!(a.unwrap().remote_id.as_deref(), Some("41"));
    assert_eq!(b.unwrap().remote_id.as_deref(), Some("41"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(runtime);
    let mut runtime = test_runtime(&path);
    runtime.provider_url = Some(base);
    *runtime.credential.lock().unwrap() = Some("fixture-key".into());
    assert_eq!(
        runtime
            .cloud_task(&crate::moviebox::providers::Binding::default(), &hash)
            .await
            .unwrap()
            .remote_id
            .as_deref(),
        Some("41")
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(runtime);
    server.abort();
    std::fs::remove_file(path).unwrap();
}
#[tokio::test]
async fn uncertain_submission_is_not_repeated() {
    let (base, count, server) = provider(true).await;
    let mut runtime = test_runtime(std::path::Path::new(":memory:"));
    runtime.provider_url = Some(base);
    *runtime.credential.lock().unwrap() = Some("fixture-key".into());
    let hash = "b".repeat(40);
    let binding = crate::moviebox::providers::Binding::default();
    let first = runtime.cloud_task(&binding, &hash).await.unwrap();
    assert_eq!(first.phase, "retrying");
    let mut persisted = runtime
        .get("cloud-task", &binding.task_id(&hash))
        .unwrap()
        .unwrap();
    persisted["nextCheckAt"] = json!(0);
    runtime
        .put("cloud-task", &binding.task_id(&hash), &persisted)
        .unwrap();
    let second = runtime.cloud_task(&binding, &hash).await.unwrap();
    assert_eq!(second.phase, "cloud_queued");
    assert!(second.message.contains("duplicate submission prevented"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
}
#[tokio::test]
async fn native_torznab_search_builds_one_pack_plan_over_http() {
    use axum::{extract::Query, routing::get};
    let query_log = Arc::new(std::sync::Mutex::new(Vec::<
        std::collections::HashMap<String, String>,
    >::new()));
    let log = query_log.clone();
    let hash = "c".repeat(40);
    let rss=format!("<rss xmlns:torznab='http://torznab.com/schemas/2015/feed'><channel><item><title>Localized Name S01 1080p French</title><torznab:attr name='infohash' value='{hash}'/><torznab:attr name='imdb' value='123'/><torznab:attr name='language' value='fra'/></item></channel></rss>");
    let app=axum::Router::new().route("/api",get(move |Query(q):Query<std::collections::HashMap<String,String>>|{let log=log.clone();let rss=rss.clone();async move{log.lock().unwrap().push(q);rss}}))
      .route("/torrents/checkcached",get(move ||{let hash=hash.clone();async move{axum::Json(json!({"success":true,"data":{hash:{"files":[{"name":"Localized.Name.S01E01.mkv","size":100},{"name":"Localized.Name.S01E02.mkv","size":100}]}}}))}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut runtime = test_runtime(std::path::Path::new(":memory:"));
    runtime.provider_url = Some(base.clone());
    *runtime.credential.lock().unwrap() = Some("fixture-key".into());
    runtime
        .put(
            "settings",
            "preferences",
            &json!({"provider":true,"addons":[],"maxSize":"1"}),
        )
        .unwrap();
    runtime.put("media","tt123",&json!({"id":"tt123","title":"Owned","kind":"series","year":"2020","episodes":[{"season":1,"episode":1,"title":"One"},{"season":1,"episode":2,"title":"Two"}]})).unwrap();
    runtime.put("indexer","fixture",&json!({"id":"fixture","name":"Fixture","url":format!("{base}/api"),"enabled":true,"capabilities":{"modes":{"tvsearch":["imdbid","season","ep"]},"limit":100}})).unwrap();
    let acquisition =
        AcquisitionState::from_connection(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
    let plan = runtime
        .plan_bundle(
            BundleRequest {
                id: "tt123".into(),
                season: 1,
                episodes: vec![1, 2],
                quality: "1080p or better".into(),
                language: "French".into(),
                method: "Season pack".into(),
            },
            &acquisition,
        )
        .await
        .unwrap();
    assert_eq!(plan.source_count, 1);
    assert_eq!(plan.rows.iter().filter(|r| r.status == "ready").count(), 2);
    let queries = query_log.lock().unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0]["imdbid"], "123");
    assert_eq!(queries[0]["season"], "1");
    assert!(!queries[0].contains_key("ep"));
    let public = serde_json::to_string(&plan).unwrap();
    assert!(!public.contains("fixture-key"));
    assert!(!public.contains(&base));
    assert_eq!(strv(&runtime.bundle_plan(&plan.id).unwrap(), "id"), plan.id);
    server.abort();
}
