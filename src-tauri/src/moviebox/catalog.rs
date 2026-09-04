use super::{flag, now, strv, Runtime};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};

pub(super) fn http_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "Invalid service URL")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use an HTTP(S) URL without embedded credentials".into());
    }
    Ok(url)
}
pub(super) fn addon_root(raw: &str) -> Result<url::Url, String> {
    let mut url = http_url(raw)?;
    if !url.path().ends_with("/manifest.json") {
        return Err("Invalid add-on manifest path".into());
    }
    url.path_segments_mut()
        .map_err(|_| "Invalid add-on URL")?
        .pop();
    Ok(url)
}
pub(super) async fn json_response(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| -> String {
        if e.is_timeout() {
            "Service timed out".into()
        } else {
            "Service could not be reached".into()
        }
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Service returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > 16 * 1024 * 1024)
    {
        return Err("Service response is too large".into());
    }
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| "Incomplete service response")?;
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("Service response is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Service returned invalid JSON".into())
}
fn media(meta: &Value, kind: &str) -> Option<Value> {
    let id = strv(meta, "id");
    let title = strv(meta, "name");
    if id.is_empty() || title.is_empty() {
        return None;
    }
    let genres = meta["genres"].as_array().cloned().unwrap_or_default();
    let episodes=meta["videos"].as_array().into_iter().flatten().filter(|v|v["season"].as_i64().is_some()&&v["episode"].as_i64().is_some()).map(|v|json!({
        "id":v["id"],"title":v["title"].as_str().or_else(||v["name"].as_str()).unwrap_or("Episode"),"season":v["season"],"episode":v["episode"],"released":v["released"].as_str().unwrap_or("")
    })).collect::<Vec<_>>();
    Some(
        json!({"id":id,"title":title,"year":meta["releaseInfo"].as_str().or_else(||meta["year"].as_str()).unwrap_or(""),"kind":kind,
        "genre":genres.first().and_then(Value::as_str).unwrap_or(""),"genres":genres,"runtime":strv(meta,"runtime"),
        "rating":meta["imdbRating"].as_f64().or_else(||strv(meta,"imdbRating").parse().ok()).unwrap_or(0.0),
        "poster":strv(meta,"poster"),"description":strv(meta,"description"),"episodes":episodes,
        "aliases":meta["aliases"].as_array().cloned().unwrap_or_default(),
        "externalIds":{"imdb":meta["imdb_id"].as_str().or_else(||if id.starts_with("tt"){Some(id)}else{None}),"tmdb":meta["tmdb_id"].as_str().map(String::from).or_else(||meta["tmdb_id"].as_u64().map(|v|v.to_string())),"tvdb":meta["tvdb_id"].as_str().map(String::from).or_else(||meta["tvdb_id"].as_u64().map(|v|v.to_string()))}}),
    )
}
impl Runtime {
    pub(super) async fn manifest(&self, addon: &Value) -> Result<Value, String> {
        let id = strv(addon, "id");
        if let Some(saved) = self.get("manifest", id)? {
            if saved["at"].as_i64().unwrap_or(0) + 86_400_000 > now() {
                return Ok(saved["manifest"].clone());
            }
        }
        let value = json_response(self.client.get(http_url(strv(addon, "url"))?)).await?;
        if strv(&value, "id").is_empty()
            || strv(&value, "name").is_empty()
            || !value["resources"].is_array()
        {
            return Err("This URL does not describe a Stremio add-on".into());
        }
        self.put("manifest", id, &json!({"at":now(),"manifest":value}))?;
        Ok(value)
    }
    pub(super) async fn add_addon(&self, raw: &str) -> Result<(), String> {
        let url = http_url(raw)?;
        if url.scheme() != "https" || !url.path().ends_with("manifest.json") {
            return Err("Enter an HTTPS manifest.json URL".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut addon = json!({"id":id,"url":url.as_str(),"enabled":true});
        let manifest = self.manifest(&addon).await?;
        addon["name"] = manifest["name"].clone();
        let mut p = self.prefs()?;
        let addons = p["addons"]
            .as_array_mut()
            .ok_or("Invalid add-on settings")?;
        if addons.iter().any(|a| strv(a, "url") == url.as_str()) {
            return Err("This add-on is already installed".into());
        }
        addons.push(addon);
        self.put("settings", "preferences", &p)?;
        self.log(
            "info",
            "sources",
            "Source add-on validated and installed",
            None,
        )
    }
    pub(super) async fn catalog(
        &self,
        kind: &str,
        query: &str,
        skip: u64,
    ) -> Result<Value, String> {
        if !["movie", "series"].contains(&kind) || query.len() > 200 || skip > 10_000 {
            return Err("Invalid catalog request".into());
        }
        let p = self.prefs()?;
        let mut fallback = false;
        if p["catalogProvider"] == "tmdb" && p["tmdbConnected"] == true {
            match self.tmdb_catalog(kind, query, skip).await {
                Ok(result) => return Ok(result),
                Err(_) => {
                    fallback = true;
                }
            }
        }

        let addons = p["addons"].as_array().cloned().unwrap_or_default();
        let results = stream::iter(addons.into_iter().filter(|a| flag(a, "enabled")).map(
            |addon| async move {
                let manifest = self.manifest(&addon).await?;
                let mut items = Vec::new();
                for cat in manifest["catalogs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| strv(c, "type") == kind)
                {
                    let search = cat["extra"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|e| strv(e, "name") == "search");
                    if query.is_empty()
                        && cat["extra"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|e| flag(e, "isRequired"))
                    {
                        continue;
                    }
                    if !query.is_empty() && !search {
                        continue;
                    }
                    let mut url = addon_root(strv(&addon, "url"))?;
                    {
                        let mut path =
                            url.path_segments_mut().map_err(|_| "Invalid add-on path")?;
                        path.pop_if_empty()
                            .push("catalog")
                            .push(kind)
                            .push(strv(cat, "id"));
                        let extra = if query.is_empty() {
                            format!("skip={skip}.json")
                        } else {
                            format!("search={query}&skip={skip}.json")
                        };
                        path.push(&extra);
                    }
                    let data = json_response(self.client.get(url)).await?;
                    items.extend(
                        data["metas"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|m| media(m, kind)),
                    );
                    // One matching catalog per add-on avoids duplicate popular/search rows.
                    break;
                }
                Ok::<_, String>(items)
            },
        ))
        .buffered(4)
        .collect::<Vec<_>>()
        .await;
        let mut seen = std::collections::HashSet::new();
        let mut items = Vec::new();
        let mut errors = 0;
        for result in results {
            match result {
                Ok(values) => {
                    for mut m in values {
                        if let Some(cached) = self.get("media", strv(&m, "id"))? {
                            for field in [
                                "episodes",
                                "genres",
                                "genre",
                                "rating",
                                "runtime",
                                "description",
                            ] {
                                if m[field].is_null()
                                    || m[field] == json!([])
                                    || m[field] == json!("")
                                    || m[field] == json!(0)
                                {
                                    if let Some(value) = cached.get(field) {
                                        m[field] = value.clone();
                                    }
                                }
                            }
                        }
                        if seen.insert(strv(&m, "id").to_string()) {
                            self.put("media", strv(&m, "id"), &m)?;
                            items.push(m)
                        }
                    }
                }
                Err(_) => errors += 1,
            }
        }
        if items.is_empty() && errors > 0 {
            return Err(
                "Catalog services could not be reached. Check your connection or add-ons.".into(),
            );
        }
        Ok(
            json!({"items":items,"partial":errors>0 || fallback,"warning":if fallback {"TMDB is unavailable; showing add-on catalogs."}else{""},"hasMore":items.len()>=100,"nextSkip":skip+100}),
        )
    }
    pub(super) async fn detail(&self, id: &str, kind: &str) -> Result<Value, String> {
        if !["movie", "series"].contains(&kind) {
            return Err("Invalid media type".into());
        }
        let p = self.prefs()?;
        let cached = self.get("media", id)?;
        let tmdb_id = super::tmdb::parse_id(id)
            .filter(|(k, _)| *k == kind)
            .map(|(_, n)| n)
            .or_else(|| cached.as_ref().and_then(|m| m["tmdbId"].as_u64()));
        if let Some(tmdb_id) = tmdb_id.filter(|_| p["tmdbConnected"] == true) {
            match self.tmdb_detail(id, kind, tmdb_id).await {
                Ok(media) => return Ok(media),
                Err(error) if id.starts_with("tmdb:") => return Err(error),
                Err(_) => {}
            }
        }

        for addon in p["addons"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| flag(a, "enabled"))
        {
            let Ok(manifest) = self.manifest(addon).await else {
                continue;
            };
            if !supports(&manifest, "meta", kind, id) {
                continue;
            }
            let mut url = addon_root(strv(addon, "url"))?;
            url.path_segments_mut()
                .map_err(|_| "Invalid add-on path")?
                .pop_if_empty()
                .push("meta")
                .push(kind)
                .push(&format!("{id}.json"));
            if let Ok(response) = json_response(self.client.get(url)).await {
                if let Some(value) = media(&response["meta"], kind) {
                    self.put("media", id, &value)?;
                    return Ok(value);
                }
            }
        }
        Err("Title details could not be loaded from the enabled add-ons".into())
    }
}
pub(super) fn supports(manifest: &Value, resource: &str, kind: &str, id: &str) -> bool {
    manifest["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|r| {
            let named = r.as_str() == Some(resource) || strv(r, "name") == resource;
            let types = r.get("types").or_else(|| manifest.get("types"));
            let prefixes = r.get("idPrefixes").or_else(|| manifest.get("idPrefixes"));
            named
                && types
                    .and_then(Value::as_array)
                    .is_none_or(|ts| ts.iter().any(|t| t.as_str() == Some(kind)))
                && prefixes
                    .and_then(Value::as_array)
                    .is_none_or(|ps| ps.iter().any(|p| id.starts_with(p.as_str().unwrap_or(""))))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn episode_titles_accept_cinemeta_names_and_standard_titles() {
        let result = media(
            &json!({"id":"series-fixture", "name":"Owned series", "videos":[
                {"id":"series-fixture:1:1", "name":"First episode", "season":1, "episode":1},
                {"id":"series-fixture:1:2", "title":"Second episode", "season":1, "episode":2}
            ]}),
            "series",
        )
        .unwrap();
        assert_eq!(result["episodes"][0]["title"], "First episode");
        assert_eq!(result["episodes"][1]["title"], "Second episode");
    }
}
