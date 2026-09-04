use super::{now, strv, Runtime};
use serde_json::{json, Value};

const RECENT_LIMIT: usize = 20;

fn compact(value: &str, limit: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

impl Runtime {
    pub(super) fn record_recent_search(&self, input: &Value) -> Result<Value, String> {
        let query = compact(strv(input, "query"), 120);
        let media_id = compact(strv(input, "mediaId"), 180);
        if query.is_empty() && media_id.is_empty() {
            return Err("Enter a search or choose a title".into());
        }
        let kind = match strv(input, "kind") {
            "movie" => "movie",
            "series" => "series",
            _ => "",
        };
        let id = if media_id.is_empty() {
            format!("query:{}", query.to_lowercase())
        } else {
            format!("title:{media_id}")
        };
        let latest = self
            .db
            .lock()
            .map_err(|_| "Database unavailable")?
            .query_row(
                "SELECT MAX(CAST(json_extract(payload,'$.searchedAt') AS INTEGER)) FROM moviebox_documents WHERE kind='recent-search'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|error| error.to_string())?
            .unwrap_or(0);
        let searched_at = now().max(latest.saturating_add(1));
        let item = json!({
            "id": id,
            "query": query,
            "mediaId": if media_id.is_empty() { Value::Null } else { json!(media_id) },
            "title": compact(strv(input, "title"), 160),
            "kind": kind,
            "searchedAt": searched_at,
        });
        self.put("recent-search", strv(&item, "id"), &item)?;
        for old in self.recent_searches()?.into_iter().skip(RECENT_LIMIT) {
            self.remove("recent-search", strv(&old, "id"))?;
        }
        Ok(item)
    }

    pub(super) fn recent_searches(&self) -> Result<Vec<Value>, String> {
        let mut items = self.list("recent-search")?;
        items.sort_by_key(|item| -item["searchedAt"].as_i64().unwrap_or(0));
        items.truncate(RECENT_LIMIT);
        Ok(items)
    }

    pub(super) fn remove_recent_search(&self, id: &str) -> Result<(), String> {
        if !id.starts_with("query:") && !id.starts_with("title:") {
            return Err("Invalid recent-search identifier".into());
        }
        self.remove("recent-search", id)
    }

    pub(super) fn clear_recent_searches(&self) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "Database unavailable")?
            .execute(
                "DELETE FROM moviebox_documents WHERE kind='recent-search'",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(super) fn set_watched(&self, input: &Value) -> Result<Value, String> {
        let media_id = compact(strv(input, "mediaId"), 180);
        if media_id.is_empty() {
            return Err("Choose a title first".into());
        }
        let watched = input["watched"].as_bool().unwrap_or(true);
        let season = input["season"].as_i64().map(|value| value as i32);
        let media = self.get("media", &media_id)?;
        let kind = media
            .as_ref()
            .and_then(|item| item["kind"].as_str())
            .unwrap_or(if season.is_some() || input["episodes"].is_array() {
                "series"
            } else {
                "movie"
            });
        let mut state = self
            .get("watch-state", &media_id)?
            .unwrap_or_else(|| json!({"mediaId":media_id,"episodes":[],"updatedAt":now()}));
        if kind == "movie" {
            state["movieWatchedAt"] = if watched { json!(now()) } else { Value::Null };
        } else {
            let mut episodes = input["episodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_i64)
                .filter(|episode| (1..=10_000).contains(episode))
                .map(|episode| episode as i32)
                .collect::<Vec<_>>();
            if episodes.is_empty() {
                episodes = media
                    .as_ref()
                    .and_then(|item| item["episodes"].as_array())
                    .into_iter()
                    .flatten()
                    .filter(|episode| {
                        season.is_none_or(|value| episode["season"].as_i64() == Some(value.into()))
                    })
                    .filter_map(|episode| episode["episode"].as_i64())
                    .map(|episode| episode as i32)
                    .collect();
            }
            episodes.sort_unstable();
            episodes.dedup();
            let seasons = season
                .into_iter()
                .chain(
                    media
                        .as_ref()
                        .and_then(|item| item["episodes"].as_array())
                        .into_iter()
                        .flatten()
                        .filter(|item| {
                            episodes.contains(&(item["episode"].as_i64().unwrap_or(0) as i32))
                        })
                        .filter_map(|item| item["season"].as_i64().map(|value| value as i32)),
                )
                .collect::<Vec<_>>();
            let default_season = seasons.first().copied().unwrap_or(1);
            let targets = episodes
                .into_iter()
                .map(|episode| (default_season, episode))
                .collect::<Vec<_>>();
            let mut current = state["episodes"].as_array().cloned().unwrap_or_default();
            current.retain(|item| {
                !targets.iter().any(|(target_season, target_episode)| {
                    item["season"].as_i64() == Some(i64::from(*target_season))
                        && item["episode"].as_i64() == Some(i64::from(*target_episode))
                })
            });
            if watched {
                current.extend(targets.into_iter().map(|(season, episode)| {
                    json!({"season":season,"episode":episode,"watchedAt":now()})
                }));
            }
            current.sort_by_key(|item| {
                (
                    item["season"].as_i64().unwrap_or(0),
                    item["episode"].as_i64().unwrap_or(0),
                )
            });
            state["episodes"] = json!(current);
        }
        state["updatedAt"] = json!(now());
        let empty = state["movieWatchedAt"].is_null()
            && state["episodes"].as_array().is_none_or(Vec::is_empty);
        if empty {
            self.remove("watch-state", &media_id)?;
        } else {
            self.put("watch-state", &media_id, &state)?;
        }
        self.log(
            "info",
            "library",
            if watched {
                "Marked watched"
            } else {
                "Marked unwatched"
            },
            Some(&media_id),
        )?;
        Ok(state)
    }

    pub(super) fn is_watched(
        &self,
        media_id: &str,
        season: Option<i32>,
        episode: Option<i32>,
    ) -> Result<bool, String> {
        let Some(state) = self.get("watch-state", media_id)? else {
            return Ok(false);
        };
        let Some(episode) = episode else {
            return Ok(state["movieWatchedAt"].as_i64().is_some());
        };
        Ok(state["episodes"].as_array().is_some_and(|episodes| {
            episodes.iter().any(|item| {
                item["season"].as_i64() == season.map(i64::from)
                    && item["episode"].as_i64() == Some(i64::from(episode))
            })
        }))
    }

    pub(super) fn mark_library_entry_watched(&self, file: &Value) -> Result<(), String> {
        let input = json!({
            "mediaId": file["mediaId"],
            "season": file["season"],
            "episodes": file["episodes"],
            "watched": true,
        });
        self.set_watched(&input).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::moviebox::tests::test_runtime;
    use std::path::Path;

    #[test]
    fn recent_searches_are_deduplicated_and_bounded() {
        let runtime = test_runtime(Path::new(":memory:"));
        for index in 0..25 {
            runtime
                .record_recent_search(&json!({"query":format!("Title {index}")}))
                .unwrap();
        }
        runtime
            .record_recent_search(&json!({"query":"  Title   24  "}))
            .unwrap();
        let items = runtime.recent_searches().unwrap();
        assert_eq!(items.len(), RECENT_LIMIT);
        assert_eq!(items[0]["query"], "Title 24");
    }

    #[test]
    fn watched_episodes_can_be_set_and_cleared() {
        let runtime = test_runtime(Path::new(":memory:"));
        runtime
            .put(
                "media",
                "series",
                &json!({"id":"series","kind":"series","episodes":[]}),
            )
            .unwrap();
        runtime
            .set_watched(&json!({"mediaId":"series","season":2,"episodes":[1,2],"watched":true}))
            .unwrap();
        assert!(runtime.is_watched("series", Some(2), Some(1)).unwrap());
        assert!(!runtime.is_watched("series", Some(2), Some(3)).unwrap());
        runtime
            .set_watched(&json!({"mediaId":"series","season":2,"episodes":[1],"watched":false}))
            .unwrap();
        assert!(!runtime.is_watched("series", Some(2), Some(1)).unwrap());
        assert!(runtime.is_watched("series", Some(2), Some(2)).unwrap());
    }
}
