//! Native Torznab adapter. Credentials never enter snapshots, logs, or release records.
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use futures_util::StreamExt;
use roxmltree::Document;
use serde_json::{json, Value};

use super::{bridge::matching, catalog::http_url, flag, now, number, strv, Runtime};

fn endpoint(raw: &str) -> Result<url::Url, String> {
    let url = http_url(raw)?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(
            "Use the indexer's API URL without query parameters; enter the API key separately"
                .into(),
        );
    }
    if url.scheme() != "https"
        && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("Use HTTPS for remote indexers. HTTP is supported on localhost only.".into());
    }
    Ok(url)
}

async fn xml_get(
    requests: &super::requests::Coordinator,
    mut url: url::Url,
    key: &str,
    params: &[(String, String)],
    timeout: u64,
) -> Result<String, String> {
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    if !key.is_empty() {
        url.query_pairs_mut().append_pair("apikey", key);
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(timeout))
        .user_agent("MoviBox/0.9.21")
        .build()
        .map_err(|_| "Could not initialize indexer client")?;
    let bytes = requests
        .bytes(
            client.get(url),
            super::requests::Lane::Search,
            60_000,
            4 * 1024 * 1024,
        )
        .await
        .map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "Indexer returned invalid text".into())
}

fn document(xml: &str) -> Result<Document<'_>, String> {
    let doc = Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 100_000,
            ..Default::default()
        },
    )
    .map_err(|_| "Indexer returned invalid or unsafe XML")?;
    if doc.descendants().any(|n| n.has_tag_name("error")) {
        return Err("Indexer rejected the request. Check its API key and capabilities.".into());
    }
    Ok(doc)
}

fn capabilities(xml: &str) -> Result<Value, String> {
    let doc = document(xml)?;
    if !doc.root_element().has_tag_name("caps") {
        return Err("This endpoint did not return Torznab capabilities".into());
    }
    let mut modes = serde_json::Map::new();
    for (tag, mode) in [
        ("search", "search"),
        ("tv-search", "tvsearch"),
        ("movie-search", "movie"),
    ] {
        if let Some(node) = doc
            .descendants()
            .find(|n| n.has_tag_name(tag) && n.attribute("available") == Some("yes"))
        {
            modes.insert(
                mode.into(),
                json!(node
                    .attribute("supportedParams")
                    .unwrap_or("q")
                    .split(',')
                    .map(str::trim)
                    .collect::<Vec<_>>()),
            );
        }
    }
    if modes.is_empty() {
        return Err("Indexer has no supported movie, series, or text search".into());
    }
    let max = doc
        .descendants()
        .find(|n| n.has_tag_name("limits"))
        .and_then(|n| n.attribute("max"))
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(100)
        .clamp(1, 100);
    Ok(json!({"modes":modes,"limit":max}))
}

fn releases(xml: &str) -> Result<Vec<Value>, String> {
    let doc = document(xml)?;
    if !doc.root_element().has_tag_name("rss") {
        return Err("Indexer returned no RSS result feed".into());
    }
    Ok(doc.descendants().filter(|n| n.has_tag_name("item")).take(100).map(|item| {
        let mut attrs: HashMap<String, Vec<String>> = HashMap::new();
        for n in item.children().filter(|n| n.tag_name().name() == "attr") {
            if let (Some(key), Some(value)) = (n.attribute("name"), n.attribute("value")) { attrs.entry(key.into()).or_default().push(value.into()); }
        }
        let text = |tag| item.children().find(|n| n.has_tag_name(tag)).and_then(|n| n.text()).unwrap_or("").to_string();
        let first = |key: &str| attrs.get(key).and_then(|v| v.first()).cloned().unwrap_or_default();
        let magnet = attrs.get("magneturl").and_then(|v|v.first()).cloned().or_else(|| item.children().find(|n| n.has_tag_name("enclosure")).and_then(|n|n.attribute("url")).filter(|u|u.starts_with("magnet:")).map(String::from)).unwrap_or_else(||text("link"));
        let hash = first("infohash");
        let hash = if hash.is_empty() { url::Url::parse(&magnet).ok().and_then(|u|u.query_pairs().find(|(k,v)| k=="xt" && v.starts_with("urn:btih:")).map(|(_,v)|v.trim_start_matches("urn:btih:").to_string())).unwrap_or_default() } else { hash };
        json!({"title":text("title"),"hash":hash.to_lowercase(),"torrentUrl":if magnet.starts_with("http"){magnet.clone()}else{String::new()},"magnet":if magnet.starts_with("magnet:"){magnet}else{String::new()},
            "size":first("size").parse::<u64>().ok(),"languages":attrs.get("language").cloned().unwrap_or_default(),
            "subtitles":attrs.get("subs").cloned().unwrap_or_default(),"ids":{"imdb":attrs.get("imdb").or_else(||attrs.get("imdbid")).and_then(|v|v.first()),"tvdb":attrs.get("tvdbid").and_then(|v|v.first()),"tmdb":attrs.get("tmdbid").and_then(|v|v.first())}})
    }).collect())
}

// Metadata is fetched without forwarding an indexer's API key or following redirects.
async fn torrent_metadata(
    requests: &super::requests::Coordinator,
    raw: &str,
) -> Result<(String, String, Value, Vec<u8>), String> {
    let url = http_url(raw)?;
    if url.scheme() != "https"
        && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err("torrent metadata requires HTTPS".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|_| "metadata client unavailable")?;
    let bytes = requests
        .bytes(
            client.get(url).timeout(Duration::from_secs(8)),
            super::requests::Lane::Search,
            300_000,
            524288,
        )
        .await
        .map_err(|e| e.to_string())?;
    let meta: librqbit::TorrentMetaV1Owned =
        librqbit::torrent_from_bytes(&bytes).map_err(|_| "invalid v1 torrent metadata")?;
    let root = meta
        .info
        .name
        .as_ref()
        .map(|v| String::from_utf8_lossy(v.as_ref()).into_owned())
        .unwrap_or_default();
    let mut files = Vec::new();
    for file in meta
        .info
        .iter_file_details()
        .map_err(|_| "torrent file list invalid")?
        .take(2001)
    {
        if files.len() == 2000 {
            return Err("torrent file list exceeds 2000 entries".into());
        }
        if file.attrs().symlink || file.attrs().padding {
            continue;
        }
        let name = file
            .filename
            .to_string()
            .map_err(|_| "torrent filename invalid")?;
        if std::path::Path::new(&name).is_absolute() || name.split(['/', '\\']).any(|s| s == "..") {
            return Err("torrent filename is unsafe".into());
        }
        files.push(json!({"name":name,"size":file.len}));
    }
    Ok((meta.info_hash.as_string(), root, json!(files), bytes))
}

impl Runtime {
    pub(super) async fn save_indexer(&self, input: &Value) -> Result<Value, String> {
        let url = endpoint(strv(input, "url"))?;
        let name: String = strv(input, "name")
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(80)
            .collect();
        if name.is_empty() || name.contains("://") {
            return Err("Give this indexer a short display name".into());
        }
        let key = strv(input, "key").trim();
        if key.len() > 512 {
            return Err("API key is too long".into());
        }
        if self
            .list("indexer")?
            .iter()
            .any(|v| strv(v, "url") == url.as_str())
        {
            return Err("This indexer is already connected".into());
        }
        let caps = capabilities(
            &xml_get(
                &self.requests,
                url.clone(),
                key,
                &[("t".into(), "caps".into())],
                20,
            )
            .await?,
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        if !key.is_empty() {
            keyring::Entry::new("app.movibox.indexers", &id)
                .map_err(|_| "OS credential store unavailable")?
                .set_password(key)
                .map_err(|_| "Could not save indexer key in OS credential store")?;
        }
        self.put("indexer",&id,&json!({"id":id,"name":name,"url":url.as_str(),"enabled":true,"hasKey":!key.is_empty(),"capabilities":caps}))?;
        self.log(
            "info",
            "indexers",
            "Torznab capabilities verified; indexer connected",
            Some(&id),
        )?;
        Ok(json!({"id":id}))
    }

    fn indexer_key(&self, indexer: &Value) -> Result<String, String> {
        if !flag(indexer, "hasKey") {
            return Ok(String::new());
        }
        keyring::Entry::new("app.movibox.indexers", strv(indexer, "id"))
            .map_err(|_| "OS credential store unavailable")?
            .get_password()
            .map_err(|_| "Indexer key is unavailable; reconnect this indexer".into())
    }

    pub(super) async fn test_indexer(&self, id: &str) -> Result<Value, String> {
        let mut indexer = self.get("indexer", id)?.ok_or("Indexer not found")?;
        if strv(&indexer, "kind") == "knaben" {
            self.requests.json(self.client.post("https://api.knaben.org/v1").json(&json!({"query":"Debian Linux ISO","search_field":"title","size":1,"hide_unsafe":true,"hide_xxx":true})),super::requests::Lane::Search,60_000).await.map_err(|e|e.to_string())?;
            return Ok(json!({"public":true}));
        }
        let caps = capabilities(
            &xml_get(
                &self.requests,
                endpoint(strv(&indexer, "url"))?,
                &self.indexer_key(&indexer)?,
                &[("t".into(), "caps".into())],
                20,
            )
            .await?,
        )?;
        indexer["capabilities"] = caps.clone();
        self.put("indexer", id, &indexer)?;
        Ok(caps)
    }

    pub(super) fn configure_indexer(&self, id: &str, enabled: Option<bool>) -> Result<(), String> {
        let mut indexer = self.get("indexer", id)?.ok_or("Indexer not found")?;
        if let Some(enabled) = enabled {
            indexer["enabled"] = json!(enabled);
            self.put("indexer", id, &indexer)
        } else {
            if flag(&indexer, "hasKey") {
                match keyring::Entry::new("app.movibox.indexers", id)
                    .map_err(|_| "OS credential store unavailable")?
                    .delete_credential()
                {
                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                    Err(_) => return Err("Could not remove indexer credential".into()),
                }
            }
            self.remove("indexer", id)
        }
    }

    pub(super) fn public_indexers(&self) -> Result<Vec<Value>, String> {
        Ok(self.list("indexer")?.iter().map(|i|json!({"id":i["id"],"name":i["name"],"enabled":i["enabled"],"hasKey":i["hasKey"],"origin":url::Url::parse(strv(i,"url")).ok().map(|u|u.origin().ascii_serialization()),"capabilities":i["capabilities"]})).collect())
    }

    pub(super) async fn indexer_sources(
        &self,
        id: &str,
        kind: &str,
        season: Option<i32>,
        episode: Option<i32>,
        quality: &str,
        language: &str,
    ) -> Result<(Vec<Value>, Vec<Value>), String> {
        let Some(media) = self.get("media", id)? else {
            return Ok((vec![], vec![]));
        };
        let prefs = self.prefs()?;
        let mut found = Vec::new();
        let mut diagnostics = Vec::new();
        let mut metadata_budget = 8usize;
        let indexers = self
            .list("indexer")?
            .into_iter()
            .filter(|i| flag(i, "enabled"))
            .collect::<Vec<_>>();
        let responses = futures_util::stream::iter(indexers.into_iter().map(|indexer| {
            let media = &media;
            async move {
                let result = tokio::time::timeout(
                    Duration::from_secs(45),
                    self.search_indexer(&indexer, media, season, episode),
                )
                .await
                .unwrap_or_else(|_| Err("Indexer search deadline exceeded".into()));
                (indexer, result)
            }
        }))
        .buffered(3)
        .collect::<Vec<_>>()
        .await;
        for (indexer, response) in responses {
            let mut rejected = BTreeMap::<String, usize>::new();
            let items = match response {
                Ok(items) => items,
                Err(error) => {
                    diagnostics.push(json!({"name":indexer["name"],"status":"failed","received":0,"accepted":0,"rejected":{},"message":error}));
                    continue;
                }
            };
            let received = items.len();
            let before = found.len();
            for mut release in items {
                if matching::identity(&media, strv(&release, "title"), &release["ids"]).is_ok()
                    && strv(&release, "hash").is_empty()
                    && !strv(&release, "torrentUrl").is_empty()
                {
                    if metadata_budget == 0 {
                        *rejected
                            .entry("torrent metadata lookup limit reached".into())
                            .or_default() += 1;
                        continue;
                    }
                    metadata_budget -= 1;
                    match torrent_metadata(&self.requests, strv(&release, "torrentUrl")).await {
                        Ok((hash, root, files, bytes)) => {
                            self.put("source-torrent", &hash, &json!({"bytes":bytes,"at":now()}))?;
                            release["hash"] = json!(hash);
                            release["files"] = files;
                            release["torrentRoot"] = json!(root);
                        }
                        Err(error) => {
                            *rejected.entry(error).or_default() += 1;
                            continue;
                        }
                    }
                }
                let hash = strv(&release, "hash");
                let title = strv(&release, "title");
                let identity = matching::identity(&media, title, &release["ids"]);
                let mut raw = json!({"name":title,"title":title,"infoHash":hash,"magnet":release["magnet"],"torrentRoot":release["torrentRoot"],"indexerId":indexer["id"],"addonId":indexer["id"],"addonName":indexer["name"],"behaviorHints":{"videoSize":release["size"]}});
                let parsed = serde_json::from_value::<harbor_core::Stream>(raw.clone())
                    .map(harbor_core::parser::parse_stream)
                    .map_err(|_| "Invalid indexer release")?;
                let parsed_json = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
                let height = super::sources::resolution_height(strv(&parsed_json, "resolution"));
                let mut languages = parsed.audio_languages.clone();
                languages.extend(
                    release["languages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .flat_map(|s| s.split([',', '/', ';']))
                        .map(str::to_owned),
                );
                let pack = matching::release_season(title).is_some()
                    && matching::episode_numbers(title).is_none();
                let reason = if identity.is_err() {
                    identity.as_ref().err().copied()
                } else if hash.len() != 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                    Some("missing supported torrent hash")
                } else if height < super::sources::resolution_height(quality) {
                    Some("quality below preference")
                } else if !language.is_empty()
                    && language != "Any language"
                    && !languages
                        .iter()
                        .any(|l| matching::language_code(l) == matching::language_code(language))
                {
                    Some("requested audio language not advertised")
                } else if season.is_some()
                    && matching::release_season(title).is_some_and(|s| Some(s) != season)
                {
                    Some("different season")
                } else if episode.is_some()
                    && matching::episode_numbers(title)
                        .is_some_and(|(_, es)| !es.contains(&episode.unwrap_or_default()))
                {
                    Some("different episode")
                } else if !pack
                    && number(&release, "size", 0.0) > number(&prefs, "maxSize", 40.0) * 1e9
                {
                    Some("size exceeds limit")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    *rejected.entry(reason.into()).or_default() += 1;
                    continue;
                }
                raw["identityEvidence"] = json!(identity.unwrap_or_default());
                if !strv(&release, "magnet").is_empty()
                    && self.get("source-torrent", hash)?.is_none()
                {
                    self.put(
                        "source-torrent",
                        hash,
                        &json!({"magnet":release["magnet"],"at":now()}),
                    )?;
                }
                let sid = uuid::Uuid::new_v4().to_string();
                let display = json!({"id":sid,"name":format!("{} · {}",strv(&indexer,"name"),title),"releaseTitle":title,"quality":format!("{}p · {}",height,if languages.is_empty(){"Unknown audio".into()}else{languages.join(", ")}),"height":height,"size":release["size"].as_u64().map(|s|s as f64/1e9),"pack":pack,"cached":false,"availability":"Cache not checked","verification":"unverified","languageEvidence":"Advertised by release; audio tracks not inspected","mediaId":id,"season":season,"episode":episode});
                self.put("source",&sid,&json!({"raw":raw,"display":display,"files":release["files"],"at":now(),"mediaId":id,"kind":kind,"season":season,"episode":episode}))?;
                found.push(display);
            }
            diagnostics.push(json!({"name":indexer["name"],"status":"searched","received":received,"accepted":found.len()-before,"rejected":rejected,"message":format!("{received} native Torznab results; search limited to 3 pages per title") }));
        }
        Ok((found, diagnostics))
    }

    async fn search_indexer(
        &self,
        indexer: &Value,
        media: &Value,
        season: Option<i32>,
        episode: Option<i32>,
    ) -> Result<Vec<Value>, String> {
        if strv(indexer, "kind") == "knaben" {
            let suffix = match (season, episode) {
                (Some(s), Some(e)) => format!(" S{s:02}E{e:02}"),
                (Some(s), None) => format!(" S{s:02}"),
                _ => format!(" {}", strv(media, "year").get(..4).unwrap_or("")),
            };
            let query = format!("{}{suffix}", strv(media, "title"));
            let value=self.requests.json(self.client.post("https://api.knaben.org/v1").json(&json!({"query":query,"search_field":"title","search_type":"100%","order_by":"seeders","order_direction":"desc","size":100,"hide_unsafe":true,"hide_xxx":true})),super::requests::Lane::Search,300_000).await.map_err(|e|e.to_string())?;
            let hits = value["hits"]
                .as_array()
                .ok_or("Public source returned no valid results array")?;
            return Ok(hits.iter().filter(|h|h["hash"].as_str().is_some()).map(|h|json!({"title":h["title"],"hash":strv(h,"hash").to_lowercase(),"magnet":h["magnetUrl"],"size":h["bytes"],"ids":{},"languages":[]})).collect());
        }
        let caps = &indexer["capabilities"];
        let preferred = if strv(media, "kind") == "movie" {
            "movie"
        } else {
            "tvsearch"
        };
        let mode = if caps["modes"][preferred].is_array() {
            preferred
        } else {
            "search"
        };
        let supported = caps["modes"][mode]
            .as_array()
            .ok_or("Indexer does not support this search type")?;
        let supports = |k: &str| supported.iter().any(|v| v == k);
        let mut base = vec![("t".into(), mode.into()), ("extended".into(), "1".into())];
        let mut use_id = false;
        for (param, key) in [("imdbid", "imdb"), ("tvdbid", "tvdb"), ("tmdbid", "tmdb")] {
            let value = media["externalIds"][key].as_str().or_else(|| {
                if key == "imdb" && strv(media, "id").starts_with("tt") {
                    media["id"].as_str()
                } else {
                    None
                }
            });
            if let Some(value) = value.filter(|_| supports(param)) {
                base.push((param.into(), value.trim_start_matches("tt").into()));
                use_id = true;
                break;
            }
        }
        let titles = if use_id {
            vec![String::new()]
        } else {
            matching::aliases(media).into_iter().take(3).collect()
        };
        if !use_id && !supports("q") {
            return Err("Indexer cannot search this title without a supported media ID".into());
        }
        let limit = number(caps, "limit", 100.0) as usize;
        let key = self.indexer_key(indexer)?;
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for title in titles {
            let mut params = base.clone();
            if !use_id {
                let suffix = match (season, episode) {
                    (Some(s), Some(e)) => format!(" S{s:02}E{e:02}"),
                    (Some(s), _) => format!(" S{s:02}"),
                    _ => format!(" {}", strv(media, "year").get(..4).unwrap_or("")),
                };
                params.push((
                    "q".into(),
                    if mode == "search" {
                        format!("{title}{suffix}")
                    } else {
                        title
                    },
                ));
            }
            if let Some(s) = season.filter(|_| supports("season")) {
                params.push(("season".into(), s.to_string()));
            }
            if let Some(e) = episode.filter(|_| supports("ep")) {
                params.push(("ep".into(), e.to_string()));
            }
            for page in 0..3 {
                let mut paged = params.clone();
                paged.extend([
                    ("limit".into(), limit.to_string()),
                    ("offset".into(), (page * limit).to_string()),
                ]);
                let xml = xml_get(
                    &self.requests,
                    endpoint(strv(indexer, "url"))?,
                    &key,
                    &paged,
                    20,
                )
                .await?;
                let items = releases(&xml)?;
                let count = items.len();
                let prior = result.len();
                for item in items {
                    if seen.insert((
                        strv(&item, "hash").to_string(),
                        strv(&item, "title").to_string(),
                    )) {
                        result.push(item);
                    }
                }
                if count < limit || result.len() == prior {
                    break;
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_namespaces_repeated_languages_and_caps() {
        let xml = r#"<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>Owned &amp; Original S01</title><torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/><torznab:attr name="language" value="French"/><torznab:attr name="language" value="English"/><torznab:attr name="subs" value="Spanish"/></item></channel></rss>"#;
        let rows = releases(xml).unwrap();
        assert_eq!(rows[0]["languages"], json!(["French", "English"]));
        assert_eq!(strv(&rows[0], "hash"), "a".repeat(40));
        assert!(document(
            "<!DOCTYPE root [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><root>&x;</root>"
        )
        .is_err());
        assert!(releases("<error code='100' description='SECRET'/>")
            .unwrap_err()
            .contains("rejected"));
        assert!(capabilities("<caps><searching><tv-search available='yes' supportedParams='q,season,ep'/></searching></caps>").unwrap()["modes"]["tvsearch"].is_array());
        assert!(endpoint("https://indexer.example/api?apikey=secret").is_err());
    }
    #[tokio::test]
    async fn torrent_metadata_uses_real_hash_and_file_manifest() {
        let name = b"Owned.S01E01.mp4";
        let mut info = format!("d6:lengthi123e4:name{}:", name.len()).into_bytes();
        info.extend_from_slice(name);
        info.extend_from_slice(b"12:piece lengthi16384e6:pieces20:");
        info.extend_from_slice(&[0; 20]);
        info.extend_from_slice(b"e");
        let mut bytes = b"d4:info".to_vec();
        bytes.extend_from_slice(&info);
        bytes.push(b'e');
        let expected: librqbit::TorrentMetaV1Owned = librqbit::torrent_from_bytes(&bytes).unwrap();
        let served = bytes.clone();
        let app = axum::Router::new().route(
            "/owned.torrent",
            axum::routing::get(move || {
                let bytes = served.clone();
                async move { bytes }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/owned.torrent", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let (hash, _, files, original) =
            torrent_metadata(&crate::moviebox::requests::Coordinator::default(), &url)
                .await
                .unwrap();
        assert_eq!(hash, expected.info_hash.as_string());
        assert_eq!(files[0]["name"], "Owned.S01E01.mp4");
        assert_eq!(files[0]["size"], 123);
        assert_eq!(original, bytes);
        server.abort();
    }
    #[tokio::test]
    async fn indexer_does_not_forward_key_across_redirects_or_echo_errors() {
        use axum::{response::Redirect, routing::get};
        let app = axum::Router::new().route(
            "/api",
            get(|| async { Redirect::temporary("http://127.0.0.1:1/secret") }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = endpoint(&format!("http://{}/api", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let error = xml_get(
            &crate::moviebox::requests::Coordinator::default(),
            url,
            "PRIVATE-FIXTURE-KEY",
            &[("t".into(), "caps".into())],
            2,
        )
        .await
        .unwrap_err();
        assert!(error.contains("307"));
        assert!(!error.contains("PRIVATE"));
        assert!(!error.contains("secret"));
        server.abort();
    }
}
