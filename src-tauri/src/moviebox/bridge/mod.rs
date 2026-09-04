pub(super) mod matching;
mod planner;
pub(crate) use planner::job_episodes;
mod execution;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BundleRequest {
    pub id: String,
    pub season: i32,
    pub episodes: Vec<i32>,
    #[serde(default)]
    pub quality: String,
    #[serde(default)]
    pub language: String,
    #[serde(default = "default_method")]
    pub method: String,
}
fn default_method() -> String {
    "Season pack".into()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BundleRow {
    pub episode: i32,
    pub title: String,
    pub status: String,
    pub reason: String,
    pub source_id: Option<String>,
    pub source_name: Option<String>,
    pub filename: Option<String>,
    pub size: Option<u64>,
    pub quality: Option<String>,
    pub language_evidence: String,
    pub pack: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BundlePlan {
    pub id: String,
    pub media_id: String,
    pub title: String,
    pub season: i32,
    pub created_at: i64,
    pub state: String,
    pub method: String,
    pub rows: Vec<BundleRow>,
    pub reports: Vec<Value>,
    pub warnings: Vec<String>,
    pub source_count: usize,
    pub total_bytes: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredPlan {
    #[serde(default)]
    pub subtitle_policy: Option<Value>,
    #[serde(default)]
    pub rule_id: Option<String>,
    #[serde(default)]
    pub binding: super::providers::Binding,
    pub request: BundleRequest,
    pub plan: BundlePlan,
    pub picks: Vec<Pick>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Pick {
    pub key: String,
    pub source: Value,
    pub filename: Option<String>,
    pub episodes: Vec<i32>,
    pub size: Option<u64>,
    pub verified: bool,
}

#[cfg(test)]
mod tests;
