use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::super::strv;

static EPISODES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])s(\d{1,3})[ ._-]*e(\d{1,3})((?:[ ._]*e\d{1,3})*)\b").unwrap()
});
static RANGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[-–](?:e)?(\d{1,3})\b").unwrap());
static CROSS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z0-9])(\d{1,3})x(\d{1,3})\b").unwrap());
static SPACED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[^a-z0-9])s(\d{1,3})[ ._]+(\d{1,3})(?:\b|_)").unwrap());
static SEASON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^a-z0-9])(?:s|season[ ._-]*)(\d{1,3})(?:\b|_)").unwrap()
});
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:19|20)\d{2}\b").unwrap());

pub(in crate::moviebox) fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Only explicit numbering establishes file coverage. A pack label is not a file manifest.
pub(crate) fn episode_numbers(name: &str) -> Option<(i32, Vec<i32>)> {
    if let Some(c) = EPISODES.captures(name) {
        let season = c[1].parse().ok()?;
        let start: i32 = c[2].parse().ok()?;
        let mut episodes = vec![start];
        for token in c[3].split(['e', 'E']).skip(1) {
            if let Ok(n) = token.trim_matches([' ', '.', '_', '-']).parse() {
                episodes.push(n);
            }
        }
        let tail = &name[c.get(0)?.end()..];
        if let Some(range) = RANGE.captures(tail) {
            let end: i32 = range[1].parse().ok()?;
            if end < start || end - start > 100 {
                return None;
            }
            episodes.extend(start..=end);
        }
        episodes.sort_unstable();
        episodes.dedup();
        return Some((season, episodes));
    }
    for regex in [&*CROSS, &*SPACED] {
        if let Some(c) = regex.captures(name) {
            return Some((c[1].parse().ok()?, vec![c[2].parse().ok()?]));
        }
    }
    None
}

pub(in crate::moviebox) fn release_season(name: &str) -> Option<i32> {
    episode_numbers(name)
        .map(|v| v.0)
        .or_else(|| SEASON.captures(name)?.get(1)?.as_str().parse().ok())
}

pub(in crate::moviebox) fn video(name: &str) -> bool {
    let name = name.to_lowercase();
    [".mkv", ".mp4", ".avi", ".m4v", ".webm", ".mov", ".ts"]
        .iter()
        .any(|ext| name.ends_with(ext))
        && !normalize(&name)
            .split_whitespace()
            .any(|part| ["sample", "trailer", "featurette"].contains(&part))
}

pub(in crate::moviebox) fn aliases(media: &Value) -> Vec<String> {
    let mut names = vec![strv(media, "title").to_string()];
    names.extend(
        media["aliases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from),
    );
    names.retain(|v| !v.trim().is_empty());
    names.sort();
    names.dedup();
    names
}

pub(in crate::moviebox) fn identity(
    media: &Value,
    title: &str,
    ids: &Value,
) -> Result<String, &'static str> {
    let mut matched_id = false;
    for key in ["imdb", "tmdb", "tvdb"] {
        let requested = media["externalIds"][key].as_str().or_else(|| {
            if key == "imdb" && strv(media, "id").starts_with("tt") {
                media["id"].as_str()
            } else {
                None
            }
        });
        if let (Some(want), Some(actual)) = (requested, ids[key].as_str()) {
            if want.trim_start_matches("tt") != actual.trim_start_matches("tt") {
                return Err("different media ID");
            }
            matched_id = true;
        }
    }
    if matched_id {
        return Ok("Media ID matched".into());
    }
    let normalized = normalize(title);
    let title_matches = aliases(media).iter().any(|a| {
        let a = normalize(a);
        normalized == a
            || normalized.strip_prefix(&a).is_some_and(|tail| {
                let next = tail.trim_start().split_whitespace().next().unwrap_or("");
                tail.starts_with(' ')
                    && (next.parse::<u32>().is_ok()
                        || next.starts_with('s')
                            && next[1..].starts_with(|c: char| c.is_ascii_digit())
                        || [
                            "season", "complete", "1080p", "2160p", "720p", "bluray", "web", "hdtv",
                        ]
                        .contains(&next))
            })
    });
    if !title_matches {
        return Err("title or alternate title did not match");
    }
    let wanted_year = strv(media, "year").get(..4).unwrap_or("");
    let release_year = YEAR.find(title).map(|m| m.as_str());
    if strv(media, "kind") == "movie" && release_year != Some(wanted_year) {
        return Err("movie year missing or different; media ID required");
    }
    if strv(media, "kind") == "series"
        && release_year.is_some_and(|year| !wanted_year.is_empty() && year != wanted_year)
    {
        return Err("series year differs; media ID required");
    }
    Ok("Title / alternate title matched".into())
}

pub(in crate::moviebox) fn language_code(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "en" | "eng" | "english" => "en",
        "fr" | "fre" | "fra" | "french" => "fr",
        "es" | "spa" | "spanish" => "es",
        "de" | "ger" | "deu" | "german" => "de",
        "pt" | "por" | "portuguese" => "pt",
        "ja" | "jpn" | "japanese" => "ja",
        "it" | "ita" | "italian" => "it",
        "ko" | "kor" | "korean" => "ko",
        "zh" | "zho" | "chi" | "chinese" => "zh",
        _ => return value.trim().to_lowercase(),
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn explicit_episode_ranges_and_variants() {
        for name in ["Show.S02E01-E03.mkv", "Show S02E01-03.mkv"] {
            assert_eq!(episode_numbers(name), Some((2, vec![1, 2, 3])));
        }
        assert_eq!(episode_numbers("Show.S02E01E02.mkv"), Some((2, vec![1, 2])));
        assert_eq!(episode_numbers("Show 2x04.mkv"), Some((2, vec![4])));
        assert_eq!(episode_numbers("Show S02 05.mkv"), Some((2, vec![5])));
        assert_eq!(episode_numbers("Show.S02.1080p.Complete.mkv"), None);
        assert_eq!(episode_numbers("Show.S02E08-E01.mkv"), None);
        assert!(!video("Show.S02E01.sample.mkv"));
    }
    #[test]
    fn identity_requires_more_than_a_similar_title() {
        let movie = json!({"id":"tt123","title":"Home","year":"2020","kind":"movie","aliases":["La Maison"]});
        assert!(identity(&movie, "La.Maison.2020.1080p", &json!({})).is_ok());
        assert!(identity(&movie, "Homecoming.2020.1080p", &json!({})).is_err());
        assert!(identity(&movie, "Home.1999.1080p", &json!({})).is_err());
        assert!(identity(&movie, "Home.2020", &json!({"imdb":"tt999"})).is_err());
        assert!(identity(&movie, "Localized title", &json!({"imdb":"123"})).is_ok());
    }
}
