use super::{now, requests::Lane, strv, Runtime};
use serde_json::{json, Value};

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.movibox.backend", "tmdb")
        .map_err(|_| "Credential store unavailable".into())
}
fn api_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "movie" => Ok("movie"),
        "series" => Ok("tv"),
        _ => Err("Unknown catalog type".into()),
    }
}
pub(super) fn parse_id(id: &str) -> Option<(&str, u64)> {
    let rest = id.strip_prefix("tmdb:")?;
    let (kind, id) = rest.split_once(':')?;
    if !matches!(kind, "movie" | "series") {
        return None;
    }
    let id = id.parse::<u64>().ok()?;
    (id > 0).then_some((kind, id))
}
fn poster(item: &Value) -> String {
    let path = strv(item, "poster_path");
    if path.starts_with('/') {
        format!("https://image.tmdb.org/t/p/w500{path}")
    } else {
        String::new()
    }
}
fn normalized(item: &Value, kind: &str, genres: &Value) -> Option<Value> {
    let id = item["id"].as_u64()?;
    let title = item[if kind == "series" { "name" } else { "title" }].as_str()?;
    let original = item[if kind == "series" {
        "original_name"
    } else {
        "original_title"
    }]
    .as_str()
    .unwrap_or(title);
    let genre_names = if let Some(names) = item["genres"].as_array() {
        names
            .iter()
            .filter_map(|g| g["name"].as_str())
            .collect::<Vec<_>>()
    } else {
        genres["genres"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|g| {
                item["genre_ids"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&g["id"]))
            })
            .filter_map(|g| g["name"].as_str())
            .collect::<Vec<_>>()
    };
    let date = strv(
        item,
        if kind == "series" {
            "first_air_date"
        } else {
            "release_date"
        },
    );
    Some(
        json!({"id":format!("tmdb:{kind}:{id}"),"tmdbId":id,"title":title,"aliases":[original],"kind":kind,"year":date.get(..4).unwrap_or(""),"description":item["overview"].as_str().unwrap_or(""),"poster":poster(item),"genres":genre_names,"genre":genre_names.first().copied().unwrap_or(""),"rating":item["vote_average"].as_f64().unwrap_or(0.0),"runtime":item["runtime"].as_u64().map(|n|format!("{n} min")).unwrap_or_default(),"episodes":[],"catalog":"TMDB"}),
    )
}
impl Runtime {
    async fn tmdb_request(
        &self,
        path: &str,
        params: &[(&str, String)],
        ttl: i64,
    ) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(root) = &self.provider_url {
            return self
                .requests
                .json(
                    self.client.get(format!("{root}{path}")).query(params),
                    Lane::Provider,
                    ttl,
                )
                .await
                .map_err(|e| e.to_string());
        }
        let key = credential()?
            .get_password()
            .map_err(|_| "Connect TMDB in Settings → Catalog first")?;
        self.requests
            .json(
                self.client
                    .get(format!("https://api.themoviedb.org/3/{path}"))
                    .bearer_auth(key)
                    .query(params),
                Lane::Provider,
                ttl,
            )
            .await
            .map_err(|e| e.to_string())
    }
    pub(super) async fn connect_tmdb(&self, token: &str) -> Result<(), String> {
        let token = token.trim();
        if token.len() < 16 || token.len() > 4096 || token.chars().any(char::is_whitespace) {
            return Err("Enter your TMDB API Read Access Token".into());
        }
        self.requests
            .json(
                self.client
                    .get("https://api.themoviedb.org/3/configuration")
                    .bearer_auth(token),
                Lane::Provider,
                0,
            )
            .await
            .map_err(|e| e.to_string())?;
        credential()?
            .set_password(token)
            .map_err(|_| "Could not save TMDB token")?;
        let mut prefs = self.prefs()?;
        prefs["tmdbConnected"] = json!(true);
        self.put("settings", "preferences", &prefs)
    }
    pub(super) fn disconnect_tmdb(&self) -> Result<(), String> {
        match credential()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err("Could not remove TMDB token".into()),
        }
        let mut prefs = self.prefs()?;
        prefs["tmdbConnected"] = json!(false);
        prefs["catalogProvider"] = json!("addons");
        self.put("settings", "preferences", &prefs)
    }
    pub(super) async fn tmdb_catalog(
        &self,
        kind: &str,
        query: &str,
        skip: u64,
    ) -> Result<Value, String> {
        let api = api_kind(kind)?;
        let prefs = self.prefs()?;
        let language = prefs["catalogLanguage"]
            .as_str()
            .unwrap_or("en-US")
            .to_string();
        let page = skip / 20 + 1;
        let mut params = vec![
            ("language", language.clone()),
            ("page", page.to_string()),
            ("include_adult", "false".into()),
        ];
        let path = if query.is_empty() {
            format!("discover/{api}")
        } else {
            params.push(("query", query.into()));
            format!("search/{api}")
        };
        let results = self.tmdb_request(&path, &params, 5 * 60_000).await?;
        let genres = self
            .tmdb_request(
                &format!("genre/{api}/list"),
                &[("language", language)],
                24 * 3600_000,
            )
            .await?;
        let mut items = Vec::new();
        for item in results["results"].as_array().into_iter().flatten() {
            if let Some(mut media) = normalized(item, kind, &genres) {
                let synthetic = strv(&media, "id").to_owned();
                if let Some(alias) = self.get("tmdb-alias", &synthetic)? {
                    media["id"] = alias["id"].clone();
                }
                if let Some(old) = self.get("media", strv(&media, "id"))? {
                    media["episodes"] = old["episodes"].clone();
                }
                self.put("media", strv(&media, "id"), &media)?;
                items.push(media);
            }
        }
        Ok(
            json!({"items":items,"partial":false,"hasMore":page<results["total_pages"].as_u64().unwrap_or(page).min(500),"nextSkip":page*20,"provider":"TMDB"}),
        )
    }
    pub(super) async fn tmdb_detail(
        &self,
        id: &str,
        kind: &str,
        tmdb_id: u64,
    ) -> Result<Value, String> {
        let api = api_kind(kind)?;
        let prefs = self.prefs()?;
        let language = prefs["catalogLanguage"]
            .as_str()
            .unwrap_or("en-US")
            .to_owned();
        let base = format!("{api}/{tmdb_id}");
        let data = self
            .tmdb_request(
                &base,
                &[
                    ("language", language.clone()),
                    ("append_to_response", "external_ids".into()),
                ],
                15 * 60_000,
            )
            .await?;
        let mut media = normalized(&data, kind, &Value::Null)
            .ok_or("TMDB returned incomplete title metadata")?;
        let imdb = data["external_ids"]["imdb_id"]
            .as_str()
            .or_else(|| data["imdb_id"].as_str())
            .unwrap_or("");
        if imdb.starts_with("tt") && imdb[2..].chars().all(|c| c.is_ascii_digit()) && imdb.len() > 2
        {
            media["id"] = json!(imdb);
        } else if id.starts_with("tt") {
            media["id"] = json!(id);
        }
        if kind == "series" {
            let seasons = data["seasons"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s["season_number"].as_u64())
                .collect::<Vec<_>>();
            let mut episodes = Vec::new();
            for batch in seasons.chunks(20) {
                let append = batch
                    .iter()
                    .map(|s| format!("season/{s}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let response = self
                    .tmdb_request(
                        &base,
                        &[
                            ("language", language.clone()),
                            ("append_to_response", append),
                        ],
                        15 * 60_000,
                    )
                    .await?;
                for season in batch {
                    for episode in response[format!("season/{season}")]["episodes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        let date = strv(episode, "air_date");
                        episodes.push(json!({"title":episode["name"],"season":season,"episode":episode["episode_number"],"released":if date.len()==10 {format!("{date}T00:00:00Z")}else{String::new()}}));
                    }
                }
            }
            media["episodes"] = json!(episodes);
        }
        media["metadataUpdatedAt"] = json!(now());
        let synthetic = format!("tmdb:{kind}:{tmdb_id}");
        self.put("tmdb-alias", &synthetic, &json!({"id":media["id"]}))?;
        self.put("media", strv(&media, "id"), &media)?;
        Ok(media)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn catalog_maps_to_imdb_and_loads_episode_identity_from_tmdb() {
        use axum::{routing::get, Json, Router};
        let app=Router::new()
            .route("/discover/tv",get(||async {Json(json!({"page":1,"total_pages":2,"results":[{"id":1396,"name":"Titre traduit","original_name":"Original title","first_air_date":"2008-01-20","genre_ids":[18]}]}))}))
            .route("/genre/tv/list",get(||async {Json(json!({"genres":[{"id":18,"name":"Drame"}]}))}))
            .route("/tv/1396",get(||async {Json(json!({"id":1396,"name":"Titre traduit","external_ids":{"imdb_id":"tt0903747"},"seasons":[{"season_number":1}],"season/1":{"episodes":[{"episode_number":1,"name":"Pilote","air_date":"2008-01-20"}]}}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let path = std::env::temp_dir().join(format!("tmdb-{}.sqlite", uuid::Uuid::new_v4()));
        let mut runtime = crate::moviebox::tests::test_runtime(&path);
        runtime.provider_url = Some(root);
        let first = runtime.tmdb_catalog("series", "", 0).await.unwrap();
        assert_eq!(first["items"][0]["id"], "tmdb:series:1396");
        assert_eq!(first["hasMore"], true);
        let full = runtime
            .tmdb_detail("tmdb:series:1396", "series", 1396)
            .await
            .unwrap();
        assert_eq!(full["id"], "tt0903747");
        assert_eq!(full["episodes"][0]["title"], "Pilote");
        assert_eq!(full["episodes"][0]["season"], 1);
        assert_eq!(full["episodes"][0]["episode"], 1);
        let again = runtime.tmdb_catalog("series", "", 0).await.unwrap();
        assert_eq!(again["items"][0]["id"], "tt0903747");
        assert_eq!(again["items"][0]["episodes"][0]["title"], "Pilote");
        drop(runtime);
        server.abort();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn tmdb_ids_and_translated_catalog_metadata_do_not_invent_episode_mapping() {
        assert_eq!(parse_id("tmdb:series:1396"), Some(("series", 1396)));
        assert!(parse_id("tmdb:series:0").is_none());
        assert!(parse_id("tmdb:person:4").is_none());
        let m=normalized(&json!({"id":1396,"name":"Titre traduit","original_name":"Original title","first_air_date":"2008-01-20","genre_ids":[18],"vote_average":8.9}),"series",&json!({"genres":[{"id":18,"name":"Drame"}]})).unwrap();
        assert_eq!(m["genre"], "Drame");
        assert!(super::super::bridge::matching::aliases(&m).contains(&"Original title".to_string()));
        assert_eq!(m["year"], "2008");
        assert_eq!(m["episodes"], json!([]));
    }
}
