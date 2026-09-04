//! Opt-in real-service checks, excluded from ordinary tests and release binaries.
//! Loaded under subtitles so its private acquisition routine stays private.
use super::*;
use crate::download::{DownloadEnd, DownloadEvent, DownloadPolicy, DownloadSink};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn report(root: &Path, record: &Value) {
    let temporary = root.join("run-report.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(record).unwrap()).unwrap();
    std::fs::rename(temporary, root.join("run-report.json")).unwrap();
}

#[tokio::test]
#[ignore = "Reads live subtitle candidates for the isolated Sintel fixture only"]
async fn live_sintel_subtitle_candidates() {
    assert_eq!(
        std::env::var("MOVIBOX_LIVE_ACCEPTANCE").as_deref(),
        Ok("torbox")
    );
    let root = PathBuf::from(std::env::var("MOVIBOX_LIVE_ROOT").unwrap());
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["fixture"], "sintel-webseed-v1");
    let runtime = crate::moviebox::tests::test_runtime(&root.join("acceptance.sqlite3"));
    let (hash, _) = file_hash(&root.join("Sintel.mp4")).unwrap();
    let auth: Value = serde_json::from_str(
        &auth_entry()
            .unwrap()
            .get_password()
            .expect("Subtitle credential access needed"),
    )
    .unwrap();
    let base = api_base(strv(&auth, "base").trim_end_matches("/api/v1")).unwrap();
    let results = runtime
        .requests
        .json(
            runtime
                .client
                .get(format!("{base}/subtitles"))
                .header("Api-Key", strv(&auth, "key"))
                .bearer_auth(strv(&auth, "token"))
                .query(&[
                    ("languages", "fr"),
                    ("moviehash", hash.as_str()),
                    ("imdb_id", "1727587"),
                ]),
            Lane::Provider,
            0,
        )
        .await
        .expect("Live subtitle search failed");
    let candidates: Vec<Value> = results["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let a = &r["attributes"];
            json!({"hashMatch":a["moviehash_match"],"language":a["language"],"release":a["release"],
            "fps":a["fps"],"downloads":a["download_count"],"fileId":a["files"][0]["file_id"]})
        })
        .collect();
    let result = json!({"totalPages":results["total_pages"],"candidates":candidates,"downloadRequested":false});
    std::fs::write(
        root.join("subtitle-candidates.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}

#[tokio::test]
#[ignore = "Requires explicit live-service opt-in, TorBox and OpenSubtitles credentials"]
async fn live_torbox_uncached_recovery_and_french_subtitles() {
    assert_eq!(
        std::env::var("MOVIBOX_LIVE_ACCEPTANCE").as_deref(),
        Ok("torbox")
    );
    let phase = std::env::var("MOVIBOX_LIVE_PHASE").expect("Set an explicit acceptance phase");
    assert!(["preflight", "cloud-submit", "pause", "finish"].contains(&phase.as_str()));
    let root = PathBuf::from(std::env::var("MOVIBOX_LIVE_ROOT").expect("Set MOVIBOX_LIVE_ROOT"));
    assert!(root.is_absolute());
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["fixture"], "sintel-webseed-v1");
    let bytes = std::fs::read(root.join("source.torrent")).unwrap();
    let metadata: librqbit::TorrentMetaV1Owned = librqbit::torrent_from_bytes(&bytes).unwrap();
    let hash = metadata.info_hash.as_string();
    assert_eq!(hash, strv(&manifest, "hash"));
    let total = metadata
        .info
        .iter_file_details()
        .unwrap()
        .map(|f| f.len)
        .sum::<u64>();
    assert_eq!(Some(total), manifest["cloudBytes"].as_u64());
    assert!(total < 150_000_000);
    let db = root.join("acceptance.sqlite3");
    let runtime = crate::moviebox::tests::test_runtime(&db);
    runtime
        .put(
            "settings",
            "preferences",
            &json!({
                "provider":true,"defaultProvider":"torbox","addons":[],
                "subtitlesAccount":{"connected":true},"maxSize":"1"
            }),
        )
        .unwrap();
    let mut record = runtime
        .get("acceptance", "progress")
        .unwrap()
        .unwrap_or(json!({
            "fixture":"sintel-webseed-v1","phase":"credential_preflight",
            "productionDatabaseTouched":false,"liveDownloadSubmitted":false,
            "uncachedObserved":false,"cloudRecoveredInNewProcess":false
        }));
    report(&root, &record);
    println!("Checking normal OS credential-store access; preflight makes no new submission.");
    let key = runtime
        .key()
        .expect("TorBox credential access was not granted");
    assert!(
        runtime.verify_account("torbox", &key).await.is_ok(),
        "TorBox account verification failed"
    );
    record["torboxAuthenticated"] = json!(true);
    record["phase"] = json!("preflight_ready");
    report(&root, &record);
    if phase == "preflight" {
        record["phase"] = json!("subtitle_credential_preflight");
        report(&root, &record);
        let auth = auth_entry()
            .and_then(|entry| {
                entry
                    .get_password()
                    .map_err(|_| "OpenSubtitles credential access was not granted".to_owned())
            })
            .expect("OpenSubtitles credential preflight failed");
        let auth: Value =
            serde_json::from_str(&auth).expect("Saved OpenSubtitles credential is invalid");
        assert!(
            !strv(&auth, "key").is_empty(),
            "OpenSubtitles API key is missing"
        );
        record["openSubtitlesCredentialReadable"] = json!(true);
        record["openSubtitlesSignInExpired"] = json!(
            !strv(&auth, "token").is_empty() && auth["expiresAt"].as_i64().unwrap_or(0) < now()
        );
        record["phase"] = json!("preflight_ready");
        report(&root, &record);
        println!("Preflight only: provider authenticated and subtitle credential readable. No torrent or subtitle downloaded.");
        return;
    }
    let binding = runtime.binding().unwrap();
    let task_id = binding.task_id(&hash);
    if runtime.get("cloud-task", &task_id).unwrap().is_none() {
        assert_eq!(
            phase, "cloud-submit",
            "Only cloud-submit may create a new provider task"
        );
        let data = runtime
            .torbox(
                runtime
                    .client
                    .get(format!("{}/torrents/checkcached", runtime.torbox_base()))
                    .bearer_auth(&key)
                    .query(&[("hash", hash.as_str()), ("format", "object")]),
            )
            .await
            .expect("Cache check failed; no submission made");
        let object = data
            .as_object()
            .expect("Unexpected cache response; no submission made");
        assert!(
            !object.contains_key(&hash),
            "Test torrent is already cached; no submission made"
        );
        record["uncachedObserved"] = json!(true);
        record["submittedFromProcess"] = json!(std::process::id());
        runtime.put("acceptance", "progress", &record).unwrap();
    } else {
        assert_eq!(
            record["uncachedObserved"], true,
            "Existing run has no cache-miss evidence"
        );
        record["cloudRecoveredInNewProcess"] =
            json!(record["submittedFromProcess"].as_u64() != Some(std::process::id() as u64));
    }
    runtime
        .put("source-torrent", &hash, &json!({"bytes":bytes}))
        .unwrap();
    if std::env::var("MOVIBOX_LIVE_RETRY_REJECTED").as_deref() == Ok("1") {
        assert_eq!(phase, "cloud-submit");
        let previous = runtime.get("cloud-task", &task_id).unwrap().unwrap();
        assert_eq!(previous["phase"], "error");
        assert_eq!(
            previous["submitted"], false,
            "Never replay an uncertain submission"
        );
        runtime.put("cloud-retry", &task_id, &json!({})).unwrap();
    }
    let started = Instant::now();
    let task = loop {
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        record["phase"] = json!(task.phase);
        record["cloudProgress"] = json!(task.progress);
        record["cloudMessage"] = json!(task.message);
        let phases = record
            .as_object_mut()
            .unwrap()
            .entry("cloudPhases")
            .or_insert(json!([]))
            .as_array_mut()
            .unwrap();
        if phases.last().is_none_or(|last| last["phase"] != task.phase) {
            phases.push(json!({"phase":task.phase,"at":now()}));
        }
        record["liveDownloadSubmitted"] = json!(task.submitted);
        runtime.put("acceptance", "progress", &record).unwrap();
        report(&root, &record);
        println!("TorBox: {} ({}%)", task.phase, task.progress);
        assert_ne!(
            task.phase, "error",
            "Cloud preparation needs attention; see the isolated database"
        );
        if phase == "cloud-submit" && task.submitted {
            println!("Submission intent saved. End this process; use phase=pause to recover it.");
            return;
        }
        if task.phase == "ready" {
            break task;
        }
        assert!(
            started.elapsed() < Duration::from_secs(900),
            "Cloud still preparing after 15 minutes; rerun resumes the same intent"
        );
        tokio::time::sleep(Duration::from_secs(30)).await;
    };
    let file = task
        .files
        .iter()
        .find(|f| strv(f, "name").ends_with("Sintel.mp4"))
        .expect("Prepared torrent has no expected video");
    assert_eq!(file["size"].as_u64(), manifest["videoBytes"].as_u64());
    let video = root.join("Sintel.mp4");
    let path = video.to_str().unwrap();
    let policy = DownloadPolicy {
        bytes_per_second: 4 * 1024 * 1024,
        max_bytes: 150_000_000,
        reserve_bytes: 1024 * 1024 * 1024,
        ..DownloadPolicy::default()
    };
    if !video.exists() {
        let link = runtime
            .provider_adapter(&binding)
            .unwrap()
            .download_link(&task, file)
            .await
            .expect("Provider could not resolve the video link");
        let cancel = Arc::new(AtomicBool::new(false));
        let stopped = cancel.clone();
        let sink: DownloadSink = Arc::new(move |event| {
            if matches!(event, DownloadEvent::Progress { received, .. } if received >= 4 * 1024 * 1024)
            {
                stopped.store(true, Ordering::Relaxed);
            }
        });
        if !root.join("Sintel.mp4.part").exists() {
            assert_eq!(
                phase, "pause",
                "The finish phase requires an existing partial transfer"
            );
            let result = crate::download::run_download_with_policy(
                &link,
                path,
                &HashMap::new(),
                &cancel,
                &sink,
                &policy,
            )
            .await;
            assert!(
                matches!(result, Err(DownloadEnd::Canceled(_))),
                "Transfer did not stop at the test boundary"
            );
        }
        let partial = root.join("Sintel.mp4.part").metadata().unwrap().len();
        assert!(partial > 0 && partial < manifest["videoBytes"].as_u64().unwrap());
        record["partialBytesBeforeResume"] = json!(partial);
        if phase == "pause" {
            record["pausedFromProcess"] = json!(std::process::id());
            record["phase"] = json!("transfer_paused");
            runtime.put("acceptance", "progress", &record).unwrap();
            report(&root, &record);
            println!("Partial transfer preserved. End this process; use phase=finish to resume.");
            return;
        }
        assert_eq!(phase, "finish");
        assert_ne!(
            record["pausedFromProcess"].as_u64(),
            Some(std::process::id() as u64)
        );
        record["transferRecoveredInNewProcess"] = json!(true);
        report(&root, &record);
        let resumed = Arc::new(AtomicU64::new(0));
        let observed = resumed.clone();
        let sink: DownloadSink = Arc::new(move |event| {
            if let DownloadEvent::Started { resumed, .. } = event {
                observed.store(resumed, Ordering::Relaxed);
            }
        });
        let link = runtime
            .provider_adapter(&binding)
            .unwrap()
            .download_link(&task, file)
            .await
            .expect("Provider could not refresh the resume link");
        let result = crate::download::run_download_with_policy(
            &link,
            path,
            &HashMap::new(),
            &Arc::new(AtomicBool::new(false)),
            &sink,
            &policy,
        )
        .await;
        assert!(
            result.is_ok(),
            "Video transfer failed; sensitive source URLs are not printed"
        );
        record["resumedBytes"] = json!(resumed.load(Ordering::Relaxed));
        assert_eq!(
            resumed.load(Ordering::Relaxed),
            partial,
            "Provider restarted instead of resuming; report retained"
        );
    }
    assert_eq!(
        video.metadata().unwrap().len(),
        manifest["videoBytes"].as_u64().unwrap()
    );
    record["videoComplete"] = json!(true);
    record["phase"] = json!("french_subtitles");
    report(&root, &record);
    let before = std::fs::read(&video).unwrap();
    let job: AcquisitionJob = serde_json::from_value(json!({
        "id":"live-sintel","mediaId":"tt1727587","mediaType":"movie","title":"Sintel",
        "subtitle":null,"poster":null,"season":null,"episode":null,"streamLabel":null,
        "provider":"torbox","infoHash":hash,"fileIndex":null,"sourceContext":{},
        "url":"","headers":{},"path":video,"status":"done","receivedBytes":before.len(),
        "totalBytes":before.len(),"error":null,"attempt":1,"scheduledAt":null,
        "createdAt":now(),"updatedAt":now(),"completedAt":now()
    }))
    .unwrap();
    let result = runtime
        .acquire_subtitle(
            &job,
            "fr",
            &json!({"enabled":true,"addons":false,"exactOnly":false}),
        )
        .await;
    record["frenchSubtitleAcquisitionSucceeded"] = json!(result.is_ok());
    record["subtitleOutcome"] = json!(match &result {
        Ok(message) => message.clone(),
        Err(error) => error.message.clone(),
    });
    record["frenchSubtitlePresent"] = json!(video.with_extension("fr.srt").is_file());
    record["videoUnchangedBySubtitleWork"] = json!(std::fs::read(&video).unwrap() == before);
    record["phase"] = json!(if result.is_ok() {
        "ready_for_file_verification"
    } else {
        "subtitle_needs_attention"
    });
    runtime.put("acceptance", "progress", &record).unwrap();
    report(&root, &record);
    assert!(
        result.is_ok(),
        "Live French subtitle acquisition needs attention; video preserved"
    );
    println!(
        "Provider transfer complete. Run the reference verifier before claiming subtitle timing."
    );
}
