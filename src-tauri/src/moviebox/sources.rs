use super::{
    catalog::{http_url, supports},
    flag, now, number, safe_name, strv, Runtime,
};
use crate::acquisition::{AcquisitionJob, AcquisitionState, EnqueueAcquisition};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};
pub(super) const TORBOX: &str = "https://api.torbox.app/v1/api";

impl Runtime {
    pub(super) fn torbox_base(&self) -> &str {
        #[cfg(test)]
        if let Some(url) = &self.provider_url {
            return url;
        }
        TORBOX
    }

    pub(super) async fn torbox(&self, request: reqwest::RequestBuilder) -> Result<Value, String> {
        let ttl = request
            .try_clone()
            .and_then(|r| r.build().ok())
            .filter(|r| r.url().path().ends_with("checkcached"))
            .map(|_| 30_000)
            .unwrap_or(0);
        let result = self
            .requests
            .json(request, super::requests::Lane::TorBox, ttl)
            .await
            .map_err(|e| e.to_string())?;
        if result["success"] != true {
            return Err(super::providers::torbox_error(
                &result,
                super::requests::RequestError::from("TorBox request failed"),
            )
            .to_string());
        }
        Ok(result["data"].clone())
    }
    pub(super) async fn sources(
        &self,
        id: &str,
        kind: &str,
        season: Option<i32>,
        episode: Option<i32>,
        quality: &str,
        language: &str,
    ) -> Result<Vec<Value>, String> {
        let report = self
            .search_sources(id, kind, season, episode, quality, language)
            .await?;
        if matches!(strv(&report, "state"), "missing_provider" | "error") {
            return Err(strv(&report, "summary").into());
        }
        Ok(report["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| !flag(s, "blocked"))
            .cloned()
            .collect())
    }
    pub(super) async fn search_sources(
        &self,
        id: &str,
        kind: &str,
        season: Option<i32>,
        episode: Option<i32>,
        quality: &str,
        language: &str,
    ) -> Result<Value, String> {
        if !["movie", "series"].contains(&kind) || id.is_empty() {
            return Err("Choose a movie or series before searching sources".into());
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let started = now();
        let target = match (season, episode) {
            (Some(s), Some(e)) => format!("series S{s:02}E{e:02}"),
            _ => kind.into(),
        };
        self.log(
            "info",
            "sources",
            &format!("Source search started for {target}"),
            Some(&request_id),
        )?;
        self.db.lock().map_err(|_| "Database unavailable")?.execute(
            "DELETE FROM moviebox_documents WHERE kind='source' AND json_extract(payload,'$.at') < ?1", [now() - 86_400_000],
        ).map_err(|e| e.to_string())?;
        let p = self.prefs()?;
        let timeout = std::time::Duration::from_secs(
            strv(&p, "sourceTimeout")
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok())
                .unwrap_or(20)
                .clamp(1, 60),
        );
        let resource_id = match (season, episode) {
            (Some(s), Some(e)) => format!("{id}:{s}:{e}"),
            _ => id.into(),
        };
        let addons = p["addons"].as_array().cloned().unwrap_or_default();
        let addon_requests = stream::iter(addons.into_iter().filter(|a| flag(a, "enabled")).map(|addon| {
            let resource_id = resource_id.clone(); let p = p.clone();
            async move {
                let name = public_addon_name(strv(&addon,"name"));
                let mut diagnostic = json!({"name":name,"status":"skipped","received":0,"accepted":0,"rejected":{},"message":""});
                let result = async {
                    if kind == "series" && season.is_some() && episode.is_none() {
                        diagnostic["message"] = json!("Stremio streams are episode-scoped; used when season indexers leave gaps.");
                        return Ok(Vec::new());
                    }
                    let manifest = tokio::time::timeout(timeout, self.manifest(&addon)).await.map_err(|_|"Manifest request timed out".to_string())??;
                    if !supports(&manifest,"stream",kind,&resource_id) {
                        diagnostic["message"] = json!("Metadata/catalog only for this title; no download-source request was sent.");
                        return Ok(Vec::new());
                    }
                    diagnostic["status"] = json!("searched");
                    let mut url = super::catalog::addon_root(strv(&addon,"url"))?;
                    url.path_segments_mut().map_err(|_|"Invalid add-on URL")?.pop_if_empty().push("stream").push(kind).push(&format!("{resource_id}.json"));
                    let response = self.requests.json(self.client.get(url).timeout(timeout),super::requests::Lane::Search,60_000).await.map_err(|e|e.to_string())?;
                    let streams = response["streams"].as_array().ok_or("Add-on returned no valid streams array")?;
                    diagnostic["received"] = json!(streams.len());
                    let mut found = Vec::new();
                    let mut rejected = std::collections::BTreeMap::<String, usize>::new();
                    for raw in streams.iter().take(200) {
                        if !raw.is_object() {
                            *rejected.entry("invalid source metadata".into()).or_default() += 1;
                            continue;
                        }
                        let mut raw=raw.clone(); raw["addonId"]=addon["id"].clone(); raw["addonName"]=addon["name"].clone();
                        let parsed = serde_json::from_value::<harbor_core::Stream>(raw.clone()).map(harbor_core::parser::parse_stream);
                        let (parsed, reason) = match parsed {
                            Ok(parsed) => {
                                let parsed_json=serde_json::to_value(&parsed).map_err(|e|e.to_string())?;
                                let height=resolution_height(strv(&parsed_json,"resolution"));
                                let direct=parsed.stream.url.as_ref().is_some_and(|u| http_url(u).is_ok_and(|v| !["m3u8","mpd"].iter().any(|ext|v.path().to_lowercase().ends_with(ext))));
                                let hash=parsed.stream.info_hash.as_deref().unwrap_or("");
                                let reason = if parsed.scam_score > 50 { Some("suspicious source") }
                                    else if height < resolution_height(quality) { Some("quality below preference") }
                                    else if !language.is_empty() && language != "Any language" && !parsed.audio_languages.iter().any(|v|super::bridge::matching::language_code(v)==super::bridge::matching::language_code(language)) { Some("audio language not identified") }
                                    else if !parsed.season_pack && parsed.size.is_some_and(|n| n as f64 > number(&p,"maxSize",40.0)*1e9) { Some("size exceeds limit") }
                                    else if season.is_some() && parsed.season.is_some_and(|s|Some(s)!=season) { Some("different season") }
                                    else if episode.is_some() && super::bridge::matching::episode_numbers(strv(&raw,"title")).map(|(_,es)|!es.contains(&episode.unwrap_or_default())).unwrap_or_else(||parsed.episode.is_some_and(|e|Some(e)!=episode)) { Some("different episode") }
                                    else if !direct && !(hash.len()==40 && hash.chars().all(|c|c.is_ascii_hexdigit())) { Some("unsupported download format") }
                                    else { None };
                                (Some((parsed,height,direct)), reason)
                            }
                            Err(_) => (None,Some("invalid source metadata")),
                        };
                        if let Some(reason) = reason { *rejected.entry(reason.into()).or_default() += 1; continue; }
                        let (parsed,height,direct)=parsed.ok_or("Source parsing failed")?;
                        let sid=uuid::Uuid::new_v4().to_string();
                        let quality=if height==2160{"4K".to_string()}else if height>0{format!("{height}p")}else{"Unknown quality".to_string()};
                        let label=format!("{} · {}",quality,if parsed.audio_languages.is_empty(){"Unknown audio".into()}else{parsed.audio_languages.join(", ")});
                        let display=json!({"id":sid,"name":format!("{} · {}",quality,name),"quality":label,
                            "size":parsed.size.map(|n|n as f64/1e9),"cached":direct,"availability":if direct{"Direct link found · file not verified"}else{"Cache not checked"},
                            "verification":"unverified","height":height,"pack":parsed.season_pack,"mediaId":id,"season":season,"episode":episode});
                        self.put("source",&sid,&json!({"raw":raw,"display":display,"at":now(),"mediaId":id,"kind":kind,"season":season,"episode":episode}))?;
                        found.push(display);
                    }
                    if streams.len()>200 { rejected.insert("above search limit".into(), streams.len()-200); }
                    diagnostic["accepted"]=json!(found.len()); diagnostic["rejected"]=json!(rejected);
                    diagnostic["message"]=json!(format!("{} returned · {} passed source filters",streams.len(),found.len()));
                    Ok::<Vec<Value>,String>(found)
                }.await;
                match result {
                    Ok(items) => (items, diagnostic),
                    Err(error) => {diagnostic["status"]=json!("failed");diagnostic["message"]=json!(error);(Vec::new(),diagnostic)}
                }
            }
        })).buffered(3).collect::<Vec<_>>();
        let (responses, native) = tokio::join!(
            addon_requests,
            self.indexer_sources(id, kind, season, episode, quality, language)
        );
        let (mut found, indexer_diagnostics) = native?;
        let mut providers = Vec::new();
        for (items, diagnostic) in responses {
            self.log(
                if strv(&diagnostic, "status") == "failed" {
                    "error"
                } else {
                    "info"
                },
                "sources",
                &format!(
                    "{}: {}",
                    strv(&diagnostic, "name"),
                    strv(&diagnostic, "message")
                ),
                Some(&request_id),
            )?;
            if let Some(rejected) = diagnostic["rejected"].as_object() {
                for (reason, count) in rejected {
                    self.log(
                        "info",
                        "sources",
                        &format!("Rejected {count}: {reason}"),
                        Some(&request_id),
                    )?;
                }
            }
            found.extend(items);
            providers.push(diagnostic);
        }
        for diagnostic in indexer_diagnostics {
            self.log(
                if strv(&diagnostic, "status") == "failed" {
                    "error"
                } else {
                    "info"
                },
                "sources",
                &format!(
                    "{}: {}",
                    strv(&diagnostic, "name"),
                    strv(&diagnostic, "message")
                ),
                Some(&request_id),
            )?;
            for (reason, count) in diagnostic["rejected"].as_object().into_iter().flatten() {
                self.log(
                    "info",
                    "sources",
                    &format!("Rejected {count}: {reason}"),
                    Some(&request_id),
                )?;
            }
            providers.push(diagnostic);
        }
        let mut warnings = Vec::<String>::new();
        let mut hashes = Vec::new();
        for item in &found {
            if let Some(source) = self.get("source", strv(item, "id"))? {
                let hash = strv(&source["raw"], "infoHash");
                if !hash.is_empty() {
                    hashes.push(hash.to_ascii_lowercase());
                }
            }
        }
        hashes.sort();
        hashes.dedup();
        let binding = self.binding()?;
        let connected = self.provider_connected(&binding);
        let mut checked = std::collections::HashSet::new();
        let mut cached = HashMap::<String, Value>::new();
        if !hashes.is_empty() && binding.provider == "torbox" {
            let key = if connected {
                self.key()
            } else {
                Err("Connect TorBox in Settings to prepare torrent sources".into())
            };
            match key {
                Ok(key) => {
                    for batch in hashes.chunks(50) {
                        let mut query: Vec<(&str, String)> =
                            batch.iter().map(|h| ("hash", h.clone())).collect();
                        query.push(("format", "object".into()));
                        query.push(("list_files", "true".into()));
                        match self
                            .torbox(
                                self.client
                                    .get(format!("{}/torrents/checkcached", self.torbox_base()))
                                    .bearer_auth(&key)
                                    .query(&query)
                                    .timeout(timeout),
                            )
                            .await
                        {
                            Ok(data) => {
                                for hash in batch {
                                    checked.insert(hash.clone());
                                    if let Some(value) = cached_record(&data, hash) {
                                        cached.insert(hash.clone(), value.clone());
                                    }
                                }
                            }
                            Err(error) => {
                                warnings.push(format!("TorBox cache check failed: {error}"))
                            }
                        }
                    }
                }
                Err(error) => warnings.push(error),
            }
        }
        for item in &mut found {
            let mut source = self
                .get("source", strv(item, "id"))?
                .ok_or("Source disappeared")?;
            let hash = strv(&source["raw"], "infoHash").to_ascii_lowercase();
            if !hash.is_empty() {
                if source["files"].as_array().is_none_or(|f| f.is_empty()) {
                    if let Some(saved) = self.get("torrent-files", &hash)? {
                        source["files"] = saved["files"].clone();
                    }
                }
                item["cached"] = json!(cached.contains_key(&hash));
                item["availability"] = json!(if !connected {
                    format!("Connect {} to prepare this source", binding.label())
                } else if cached.contains_key(&hash) {
                    "Cached on TorBox · files not verified".to_string()
                } else if checked.contains(&hash) {
                    "Uncached · preparation required".to_string()
                } else if binding.provider == "realdebrid" {
                    "Real-Debrid availability is checked after submission".to_string()
                } else {
                    "Cache check failed · availability unknown".to_string()
                });
                if !connected {
                    item["blocked"] = json!(true);
                }
                if let Some(record) = cached.get(&hash) {
                    if record["files"].as_array().is_some_and(|f| !f.is_empty()) {
                        source["files"] = record["files"].clone();
                    }
                    self.put(
                        "torrent-files",
                        &hash,
                        &json!({"at":now(),"files":record["files"]}),
                    )?;
                    if !(kind == "series" && episode.is_none()) {
                        apply_cached_files(
                            item,
                            record,
                            season,
                            episode,
                            number(&p, "maxSize", 40.0),
                        );
                    }
                }
            }
            source["display"] = item.clone();
            self.put("source", strv(item, "id"), &source)?;
        }
        if strv(&p, "sourcePreference") == "Cached only" {
            let before = found.len();
            found.retain(|v| flag(v, "cached"));
            if before > found.len() {
                warnings.push(format!(
                    "{} sources excluded by Cached only preference",
                    before - found.len()
                ));
            }
        }
        found.sort_by_key(|v| {
            (
                flag(v, "blocked"),
                if strv(&p, "sourcePreference") == "Best quality" {
                    0
                } else {
                    !flag(v, "cached") as i64
                },
                -v["height"].as_i64().unwrap_or(0),
            )
        });
        for warning in &warnings {
            self.log("warning", "sources", warning, Some(&request_id))?;
        }
        let capable = providers
            .iter()
            .filter(|v| strv(v, "status") == "searched")
            .count();
        let failed = providers
            .iter()
            .filter(|v| strv(v, "status") == "failed")
            .count();
        let usable = found.iter().filter(|v| !flag(v, "blocked")).count();
        let (state, summary) = if capable == 0 && failed == 0 {
            ("missing_provider","No download-source indexer or add-on is configured for this title. Cinemeta supplies titles and episodes; connect a native Torznab indexer or a Stremio source add-on.".into())
        } else if usable == 0 && failed > 0 {
            (
                "error",
                "Source lookup failed. Open search details for the provider error, then retry."
                    .into(),
            )
        } else if usable == 0 {
            (
                "empty",
                "No usable download source found. Review filters and provider results below."
                    .into(),
            )
        } else {
            ("matches",format!("{usable} candidate sources found. File matching and download completion are separate checks."))
        };
        self.log(
            if usable == 0 { "warning" } else { "info" },
            "sources",
            &summary,
            Some(&request_id),
        )?;
        Ok(
            json!({"requestId":request_id,"startedAt":started,"finishedAt":now(),"state":state,"summary":summary,"sources":found,"providers":providers,"warnings":warnings}),
        )
    }
    pub(super) fn enqueue_source(
        &self,
        app: &AppHandle,
        acquisition: &AcquisitionState,
        source_id: &str,
        destination: &str,
        window: &str,
        zone: &str,
        subtitle_policy: Option<Value>,
        rule_id: Option<&str>,
    ) -> Result<AcquisitionJob, String> {
        let source = self
            .get("source", source_id)?
            .ok_or("Source expired. Search again.")?;
        if flag(&source["display"], "blocked") {
            return Err(strv(&source["display"], "availability").into());
        }
        let id = strv(&source, "mediaId");
        let media = self.get("media", id)?.ok_or("Title metadata is missing")?;
        let season = source["season"].as_i64().map(|v| v as i32);
        let episode = source["episode"].as_i64().map(|v| v as i32);
        let mut filename = if let (Some(s), Some(e)) = (season, episode) {
            format!("{} S{s:02}E{e:02}.mkv", safe_name(strv(&media, "title")))
        } else {
            format!(
                "{} ({}).mkv",
                safe_name(strv(&media, "title")),
                safe_name(strv(&media, "year"))
            )
        };
        let preferences = self.prefs()?;
        let original = source["raw"]["behaviorHints"]["filename"]
            .as_str()
            .unwrap_or("");
        let direct = url::Url::parse(strv(&source["raw"], "url")).ok();
        let hint = if original.is_empty() {
            direct.as_ref().map(|u| u.path()).unwrap_or("")
        } else {
            original
        };
        if let Some(ext) = video_extension(hint) {
            filename = std::path::Path::new(&filename)
                .with_extension(ext)
                .to_string_lossy()
                .into();
        }
        if strv(&preferences, "naming") == "Original file names" && !original.is_empty() {
            filename = safe_name(original);
        }
        let path = self.destination(&media, destination, season, &filename)?;
        let binding = self.binding()?;
        let policy = subtitle_policy.unwrap_or(self.subtitle_policy(None)?);
        let context = json!({"moviebox":true,"subtitlePolicy":policy,"ruleId":rule_id,"providerBinding":binding,"sourceId":source_id,"source":source,"media":media,"window":window,"timezone":zone,"destination":destination,"skipDuplicates":flag(&preferences,"duplicates")});
        crate::acquisition::enqueue_native(
            app.clone(),
            acquisition,
            EnqueueAcquisition {
                media_id: id.into(),
                media_type: strv(&source, "kind").into(),
                title: filename.trim_end_matches(".mkv").into(),
                subtitle: None,
                poster: media["poster"].as_str().map(String::from),
                season,
                episode,
                stream_label: Some(strv(&source["display"], "quality").into()),
                provider: Some(
                    if strv(&source["raw"], "infoHash").is_empty() {
                        "Direct"
                    } else {
                        binding.label()
                    }
                    .into(),
                ),
                info_hash: source["raw"]["infoHash"].as_str().map(String::from),
                file_index: source["raw"]["fileIdx"].as_i64().map(|v| v as i32),
                source_context: context,
                url: String::new(),
                headers: HashMap::new(),
                path,
                scheduled_at: None,
            },
        )
    }
}
fn public_addon_name(name: &str) -> String {
    if name.contains("://") {
        return "Source add-on".into();
    }
    name.chars().filter(|c| !c.is_control()).take(80).collect()
}
fn cached_record<'a>(data: &'a Value, hash: &str) -> Option<&'a Value> {
    data.as_object()
        .and_then(|m| {
            m.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(hash))
                .map(|(_, v)| v)
        })
        .or_else(|| {
            data.as_array()?
                .iter()
                .find(|v| strv(v, "hash").eq_ignore_ascii_case(hash))
        })
        .filter(|v| !v.is_null() && **v != json!(false))
}
fn apply_cached_files(
    item: &mut Value,
    record: &Value,
    season: Option<i32>,
    episode: Option<i32>,
    max_gb: f64,
) {
    let Some(files) = record["files"].as_array().filter(|f| !f.is_empty()) else {
        return;
    };
    // Cached-file order is not guaranteed to match a Stremio fileIdx. Match names instead.
    let normalized:Vec<Value>=files.iter().map(|f|json!({"name":f["name"].as_str().or_else(||f["short_name"].as_str()).unwrap_or(""),"size":f["size"]})).collect();
    match pick_file(&normalized, season, episode, None) {
        Ok(file)
            if !file["size"]
                .as_u64()
                .is_some_and(|n| n as f64 > max_gb * 1e9) =>
        {
            item["verification"] = json!("file_matched");
            item["file"] = file.clone();
            item["size"] = file["size"]
                .as_u64()
                .map(|n| json!(n as f64 / 1e9))
                .unwrap_or(Value::Null);
            item["availability"] = json!(if episode.is_some() {
                "Cached · episode filename matched"
            } else {
                "Cached video file identified · not downloaded"
            });
        }
        Ok(_) => {
            item["blocked"] = json!(true);
            item["verification"] = json!("mismatch");
            item["availability"] = json!("Selected file exceeds the size limit");
        }
        Err(error) => {
            item["blocked"] = json!(true);
            item["verification"] = json!("mismatch");
            item["availability"] = json!(error);
        }
    }
}

pub(super) fn resolution_height(value: &str) -> i64 {
    let v = value.to_lowercase();
    if v.contains("2160") || v.contains("4k") {
        2160
    } else if v.contains("1080") {
        1080
    } else if v.contains("720") {
        720
    } else if v.contains("480") {
        480
    } else {
        0
    }
}

pub(crate) async fn resolve_job(
    app: &AppHandle,
    acquisition: &AcquisitionState,
    job: &AcquisitionJob,
    cancel: &Arc<AtomicBool>,
) -> Result<Option<(String, HashMap<String, String>)>, String> {
    let runtime = app.state::<Runtime>().inner().clone();
    let mut source = job.source_context["source"].clone();
    if strv(&source["raw"], "infoHash").is_empty() && job.attempt > 0 {
        let candidates = runtime
            .sources(
                &job.media_id,
                &job.media_type,
                job.season,
                job.episode,
                "Any quality",
                "Any language",
            )
            .await?;
        let mut matches = Vec::new();
        for candidate in candidates {
            let Some(candidate) = runtime.get("source", strv(&candidate, "id"))? else {
                continue;
            };
            let old = &source["raw"];
            let new = &candidate["raw"];
            if old["addonId"] == new["addonId"]
                && old["name"] == new["name"]
                && old["title"] == new["title"]
                && old["behaviorHints"]["filename"] == new["behaviorHints"]["filename"]
                && strv(new, "infoHash").is_empty()
            {
                matches.push(candidate);
            }
        }
        if matches.len() != 1 {
            return Err(
                "Could not safely refresh this source. Choose a new source from Discover.".into(),
            );
        }
        source = matches.remove(0);
        acquisition.update_job(&job.id, |j| j.source_context["source"] = source.clone())?;
    }
    let raw = &source["raw"];
    if !flag(&job.source_context, "moviebox") {
        return Ok(Some((job.url.clone(), job.headers.clone())));
    }
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    if strv(raw, "infoHash").is_empty() {
        let mut headers = HashMap::new();
        if let Some(map) = raw["behaviorHints"]["proxyHeaders"]["request"].as_object() {
            for (k, v) in map {
                if let Some(v) = v.as_str() {
                    headers.insert(k.clone(), v.into());
                }
            }
        }
        let url = http_url(strv(raw, "url"))?;
        return Ok(Some((url.to_string(), headers)));
    }
    let binding = job
        .source_context
        .get("providerBinding")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "Invalid provider binding")?
        .unwrap_or_default();
    let task = runtime.cloud_task(&binding, strv(raw, "infoHash")).await?;
    if job.source_context["cloud"] != task.public() {
        acquisition.update_job(&job.id, |j| j.source_context["cloud"] = task.public())?;
        let _ = app.emit("movibox://backend-changed", ());
    }
    if task.phase == "error" {
        return Err(task.message);
    }
    if task.phase != "ready" {
        return Ok(None);
    }
    let files = &task.files;
    let file = if let Some(planned) = job.source_context["plannedFilename"].as_str() {
        let root = strv(raw, "torrentRoot");
        let matches = files
            .iter()
            .filter(|f| {
                let name = strv(f, "name");
                name == planned
                    || !root.is_empty() && name.strip_prefix(&format!("{root}/")) == Some(planned)
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(
                "The reviewed file is missing or ambiguous in the provider. Find sources again."
                    .into(),
            );
        }
        let file = matches[0];
        let (season, episodes) = super::bridge::matching::episode_numbers(strv(file, "name"))
            .ok_or("Reviewed file has no explicit episode identity")?;
        if Some(season) != job.season
            || !super::bridge::job_episodes(job)
                .iter()
                .all(|e| episodes.contains(e))
        {
            return Err("Reviewed file does not cover the selected episodes".into());
        }
        file
    } else {
        pick_file(files, job.season, job.episode, job.file_index)?
    };
    if file["id"].as_u64().is_none() {
        return Err("Provider returned no valid file ID".into());
    }
    if let Some(extension) = video_extension(strv(file, "name")) {
        if !std::path::Path::new(&format!("{}.part", job.path)).exists() {
            let path = std::path::Path::new(&job.path).with_extension(extension);
            if path != std::path::Path::new(&job.path) && !path.exists() {
                acquisition.update_job(&job.id, |j| j.path = path.to_string_lossy().into())?;
            }
        }
    }
    let p = runtime.prefs()?;
    if file["size"]
        .as_u64()
        .is_some_and(|n| n as f64 > number(&p, "maxSize", 40.0) * 1e9)
    {
        return Err("Selected file exceeds the maximum size in Downloads settings".into());
    }
    let url = match runtime
        .provider_adapter(&binding)?
        .download_link(&task, file)
        .await
    {
        Ok(url) => url,
        Err(error) if !error.terminal => {
            let _guard = runtime.preparation.lock().await;
            if let Some(mut current) = runtime.get("cloud-task", &task.id)? {
                current["phase"] = json!("retrying");
                current["message"] = json!(error.message);
                current["nextCheckAt"] = json!(error.retry_at.max(super::now() + 30_000));
                runtime.put("cloud-task", &task.id, &current)?;
            }
            return Ok(None);
        }
        Err(error) => return Err(error.message),
    };
    Ok(Some((url.to_string(), HashMap::new())))
}
pub(super) fn pick_file(
    files: &[Value],
    season: Option<i32>,
    episode: Option<i32>,
    index: Option<i32>,
) -> Result<&Value, String> {
    let video = |f: &&Value| {
        let n = strv(f, "name").to_lowercase();
        [".mkv", ".mp4", ".avi", ".mov", ".webm", ".m4v", ".ts"]
            .iter()
            .any(|ext| n.ends_with(ext))
            && !n.contains("sample")
    };
    let candidates: Vec<_> = files.iter().filter(video).collect();
    if let (Some(s), Some(e)) = (season, episode) {
        let matches: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|f| {
                if let Some((season, episodes)) =
                    super::bridge::matching::episode_numbers(strv(f, "name"))
                {
                    return season == s && episodes.contains(&e);
                }
                let raw = json!({"addonId":"torbox","addonName":"TorBox","title":strv(f,"name")});
                let Ok(stream) = serde_json::from_value::<harbor_core::Stream>(raw) else {
                    return false;
                };
                let p = harbor_core::parser::parse_stream(stream);
                p.season == Some(s) && p.episode == Some(e)
            })
            .collect();
        if matches.len() == 1 {
            return Ok(matches[0]);
        }
        if matches.len() > 1 {
            return Err("Several files match this episode; choose a more specific source".into());
        }
        // Trust a file index only when the filename has no conflicting episode identity.
        if let Some(f) = index
            .and_then(|i| usize::try_from(i).ok())
            .and_then(|i| files.get(i))
            .filter(|f| video(f))
        {
            let raw = json!({"addonId":"torbox","addonName":"TorBox","title":strv(f,"name")});
            if let Ok(stream) = serde_json::from_value::<harbor_core::Stream>(raw) {
                let p = harbor_core::parser::parse_stream(stream);
                if p.season.is_none_or(|n| n == s) && p.episode.is_none_or(|n| n == e) {
                    return Ok(f);
                }
            }
        }
        return Err("This pack has no unambiguous match for the selected episode".into());
    }
    if let Some(f) = index
        .and_then(|i| usize::try_from(i).ok())
        .and_then(|i| files.get(i))
        .filter(|f| video(f))
    {
        return Ok(f);
    }
    candidates
        .into_iter()
        .max_by_key(|f| f["size"].as_u64().unwrap_or(0))
        .ok_or("No video file found in this torrent".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_file_evidence_distinguishes_matched_missing_ambiguous_and_unknown() {
        let record = json!({"files":[
            {"name":"Show.S01E02.1080p.mkv", "size":9000000000u64},
            {"name":"Show.S01E01.1080p.mkv", "size":1000000000u64}
        ]});
        let mut item = json!({"verification":"unverified"});
        apply_cached_files(&mut item, &record, Some(1), Some(1), 4.0);
        assert_eq!(item["verification"], "file_matched");
        assert_eq!(item["file"]["name"], "Show.S01E01.1080p.mkv");
        assert_eq!(item["size"], 1.0);
        assert!(!flag(&item, "blocked"));
        for episode in [2, 3] {
            let mut item = json!({"verification":"unverified"});
            apply_cached_files(&mut item, &record, Some(1), Some(episode), 4.0);
            assert!(flag(&item, "blocked"));
            assert_eq!(item["verification"], "mismatch");
        }
        let mut item = json!({"verification":"unverified"});
        apply_cached_files(&mut item, &json!({"cached":true}), Some(1), Some(1), 4.0);
        assert_eq!(item["verification"], "unverified");
        apply_cached_files(
            &mut item,
            &json!({"files":[
                {"name":"Show.S01E01.1080p.mkv"}, {"name":"Show.S01E01.720p.mkv"}
            ]}),
            Some(1),
            Some(1),
            4.0,
        );
        assert!(flag(&item, "blocked"));
        assert!(strv(&item, "availability").contains("Several files"));
    }
    #[test]
    fn cache_presence_does_not_claim_file_evidence() {
        assert!(cached_record(&json!({"abc":false}), "ABC").is_none());
        assert!(cached_record(&json!({"abc":null}), "ABC").is_none());
        assert!(cached_record(&json!({"abc":{"files":[]}}), "ABC").is_some());
        assert!(cached_record(&json!([{"hash":"ABC"}]), "abc").is_some());
    }
    #[test]
    fn season_pack_matches_episode_instead_of_largest_file() {
        let files = vec![
            json!({"id":42,"name":"Show.S01E02.1080p.mkv","size":9000000000u64}),
            json!({"id":73,"name":"Show.S01E01.1080p.mkv","size":1000000000u64}),
        ];
        assert_eq!(pick_file(&files, Some(1), Some(1), None).unwrap()["id"], 73);
        assert!(pick_file(&files, Some(1), Some(3), Some(0)).is_err());
    }
    #[test]
    fn file_index_is_not_provider_file_id() {
        let files = vec![
            json!({"id":80,"name":"Movie.mkv","size":9000000000u64}),
            json!({"id":99,"name":"Movie.mp4","size":1000000000u64}),
        ];
        assert_eq!(pick_file(&files, None, None, Some(1)).unwrap()["id"], 99);
    }
}

fn video_extension(name: &str) -> Option<&str> {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| {
            ["mkv", "mp4", "avi", "mov", "webm", "m4v", "ts"]
                .iter()
                .any(|v| e.eq_ignore_ascii_case(v))
        })
}
