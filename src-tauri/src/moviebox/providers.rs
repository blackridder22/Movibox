//! Provider-specific wire formats stay here; the planner and downloader use normalized tasks.
use super::{
    catalog::http_url,
    now,
    requests::{Lane, RequestError},
    strv, Runtime,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) fn torbox_error(value: &Value, mut error: RequestError) -> RequestError {
    // Only documented codes and our own text reach logs; never echo provider detail/data.
    let code = strv(value, "error");
    let (reason, retryable, rejected) = match code {
        "BOZO_TORRENT" => ("Invalid torrent metadata or magnet", false, true),
        "BOZO_FILE" => ("Unsupported torrent file type", false, true),
        "NO_AUTH" | "BAD_TOKEN" => ("Reconnect your TorBox account", false, true),
        "PLAN_RESTRICTED_FEATURE" => (
            "Your TorBox plan does not include this feature",
            false,
            true,
        ),
        "DOWNLOAD_TOO_LARGE" => ("Torrent exceeds your TorBox plan size limit", false, true),
        "TOO_MUCH_DATA" => ("Request exceeds TorBox's upload size limit", false, true),
        "MISSING_REQUIRED_OPTION" => ("A required TorBox request field is missing", false, true),
        "INVALID_OPTION" | "TOO_MANY_OPTIONS" | "DIFF_ISSUE" => {
            ("TorBox request options are invalid", false, true)
        }
        "ITEM_NOT_FOUND" | "ENDPOINT_NOT_FOUND" => (
            "Requested TorBox item or endpoint was not found",
            false,
            true,
        ),
        "ACTIVE_LIMIT" => (
            "TorBox active download limit reached; waiting for a slot",
            true,
            true,
        ),
        "MONTHLY_LIMIT" => ("TorBox monthly download limit reached", true, true),
        "COOLDOWN_LIMIT" | "TOO_MANY_REQUESTS" => {
            ("TorBox requires a cooldown before retrying", true, true)
        }
        "DUPLICATE_ITEM" => (
            "Torrent already exists; checking your TorBox account",
            true,
            false,
        ),
        "DATABASE_ERROR"
        | "UNKNOWN_ERROR"
        | "UNKNOWN"
        | "AUTH_ERROR"
        | "NO_SERVERS_AVAILABLE_ERROR"
        | "DOWNLOAD_SERVER_ERROR"
        | "REDIRECT_ERROR"
        | "SEARCH_ERROR" => (
            "TorBox is temporarily unavailable; waiting before retry",
            true,
            false,
        ),
        _ => {
            error.message = match error.status {
                Some(status) => {
                    format!("TorBox rejected the request (HTTP {status}; unrecognized error)")
                }
                None => {
                    "TorBox returned an unrecognized error; checking before resubmitting".into()
                }
            };
            return error;
        }
    };
    error.message = format!("{reason} ({code})");
    // HTTP server/timeout failures remain uncertain even if their body names a client error.
    error.terminal = !retryable
        && !error
            .status
            .is_some_and(|s| s >= 500 || s == 408 || s == 429);
    if !error.terminal {
        error.retry_at = error.retry_at.max(now() + 60_000);
    }
    if error.status.is_none() && rejected {
        error.status = Some(if retryable { 429 } else { 400 });
    }
    error
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Binding {
    pub provider: String,
    pub account: String,
}
impl Default for Binding {
    fn default() -> Self {
        Self {
            provider: "torbox".into(),
            account: "legacy".into(),
        }
    }
}
impl Binding {
    pub fn label(&self) -> &str {
        if self.provider == "realdebrid" {
            "Real-Debrid"
        } else {
            "TorBox"
        }
    }
    pub fn task_id(&self, hash: &str) -> String {
        format!("{}:{}:{}", self.provider, self.account, hash.to_lowercase())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudTask {
    pub id: String,
    pub binding: Binding,
    pub hash: String,
    pub remote_id: Option<String>,
    pub phase: String,
    pub message: String,
    pub progress: f64,
    pub files: Vec<Value>,
    pub submitted: bool,
    pub owned: bool,
    pub next_check_at: i64,
    pub last_checked_at: i64,
    pub failures: u32,
}
impl CloudTask {
    fn new(binding: Binding, hash: &str) -> Self {
        Self {
            id: binding.task_id(hash),
            binding,
            hash: hash.to_lowercase(),
            remote_id: None,
            phase: "pending".into(),
            message: "Waiting to submit to the cloud".into(),
            progress: 0.0,
            files: vec![],
            submitted: false,
            owned: false,
            next_check_at: 0,
            last_checked_at: 0,
            failures: 0,
        }
    }
    pub fn public(&self) -> Value {
        json!({"provider":self.binding.label(),"phase":self.phase,"message":self.message,"progress":self.progress,"lastCheckedAt":self.last_checked_at,"nextCheckAt":self.next_check_at})
    }
}

pub(super) struct Adapter<'a> {
    runtime: &'a Runtime,
    pub binding: Binding,
    key: String,
}
impl Runtime {
    pub(super) fn retry_cloud_job(
        &self,
        job: &crate::acquisition::AcquisitionJob,
    ) -> Result<(), String> {
        let Some(hash) = job.info_hash.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        let binding: Binding =
            serde_json::from_value(job.source_context["providerBinding"].clone())
                .unwrap_or_default();
        self.put("cloud-retry", &binding.task_id(hash), &json!(true))
    }
    pub(super) fn binding(&self) -> Result<Binding, String> {
        let p = self.prefs()?;
        let provider = if strv(&p, "defaultProvider") == "realdebrid" {
            "realdebrid"
        } else {
            "torbox"
        };
        let account = p["providerAccounts"][provider]["account"]
            .as_str()
            .unwrap_or("legacy");
        Ok(Binding {
            provider: provider.into(),
            account: account.into(),
        })
    }
    pub(super) fn provider_connected(&self, binding: &Binding) -> bool {
        let p = self.prefs().unwrap_or_default();
        p["providerAccounts"][&binding.provider]["connected"] == true
            || binding.provider == "torbox" && binding.account == "legacy" && p["provider"] == true
    }
    pub(super) fn provider_adapter(&self, binding: &Binding) -> Result<Adapter<'_>, String> {
        if !["torbox", "realdebrid"].contains(&binding.provider.as_str()) {
            return Err("Unknown download provider".into());
        }
        let p = self.prefs()?;
        let current = p["providerAccounts"][&binding.provider]["account"]
            .as_str()
            .unwrap_or("legacy");
        if binding.account != current {
            return Err(format!(
                "Reconnect the original {} account for this download",
                binding.label()
            ));
        }
        let key = if binding.provider == "torbox" {
            self.key()?
        } else {
            #[cfg(test)]
            if self.provider_url.is_some() {
                return Ok(Adapter {
                    runtime: self,
                    binding: binding.clone(),
                    key: self.key()?,
                });
            }
            keyring::Entry::new("app.movibox.backend", "realdebrid")
                .map_err(|_| "Credential store unavailable")?
                .get_password()
                .map_err(|_| "Connect Real-Debrid in Settings")?
        };
        Ok(Adapter {
            runtime: self,
            binding: binding.clone(),
            key,
        })
    }
    pub(super) async fn verify_account(&self, provider: &str, key: &str) -> Result<Value, String> {
        if !["torbox", "realdebrid"].contains(&provider) || !(8..=512).contains(&key.len()) {
            return Err("Enter a valid provider API token".into());
        }
        let adapter = Adapter {
            runtime: self,
            binding: Binding {
                provider: provider.into(),
                account: String::new(),
            },
            key: key.into(),
        };
        let route = if provider == "torbox" {
            "user/me"
        } else {
            "user"
        };
        let account = adapter
            .call(
                self.client
                    .get(format!("{}/{route}", adapter.base()))
                    .bearer_auth(key),
                0,
            )
            .await
            .map_err(|e| e.to_string())?;
        let id = account["id"]
            .as_str()
            .map(String::from)
            .or_else(|| account["id"].as_u64().map(|v| v.to_string()))
            .ok_or("Provider returned no account identity")?;
        Ok(
            json!({"connected":true,"account":id,"plan":account.get("plan").or_else(||account.get("type")),"expiresAt":account["premium_expires_at"].as_str().or_else(||account["expiration"].as_str())}),
        )
    }
    pub(super) async fn cloud_task(
        &self,
        binding: &Binding,
        hash: &str,
    ) -> Result<CloudTask, String> {
        if hash.len() != 40 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid torrent hash".into());
        }
        // Shared by review, scheduler and file workers. A cancelled future drops the lock but not the intent.
        let _guard = self.preparation.lock().await;
        let id = binding.task_id(hash);
        let mut task = self
            .get("cloud-task", &id)?
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| "Invalid cloud task")?
            .unwrap_or_else(|| CloudTask::new(binding.clone(), hash));
        if self.get("cloud-retry", &id)?.is_some() {
            if task.phase == "error" {
                task.phase = "pending".into();
                task.next_check_at = 0;
            }
            self.remove("cloud-retry", &id)?;
        }
        if task.phase == "error" || task.next_check_at > now() {
            return Ok(task);
        }
        let previous = task.phase.clone();
        task.last_checked_at = now();
        task.next_check_at = now() + 30_000;
        let result = self.advance_cloud(&mut task).await;
        if let Err(error) = result {
            task.failures = task.failures.saturating_add(1);
            task.next_check_at = error.retry_at.max(now() + 30_000);
            task.phase = if error.terminal { "error" } else { "retrying" }.into();
            task.message = error.message;
        } else {
            task.failures = 0;
        }
        if task.phase != previous {
            self.log(
                if task.phase == "error" {
                    "error"
                } else {
                    "info"
                },
                "cloud",
                &format!("{}: {}", binding.label(), task.message),
                Some(&id),
            )?;
        }
        self.put(
            "cloud-task",
            &id,
            &serde_json::to_value(&task).map_err(|_| "Could not save cloud task")?,
        )?;
        Ok(task)
    }
    async fn advance_cloud(&self, task: &mut CloudTask) -> Result<(), RequestError> {
        let adapter = self
            .provider_adapter(&task.binding)
            .map_err(|e| RequestError {
                message: e,
                retry_at: now() + 60_000,
                terminal: true,
                status: None,
            })?;
        if task.remote_id.is_none() {
            // Read the legacy intent only for its original account. Never migrate between providers.
            if task.binding == Binding::default() {
                if let Some(old) = self
                    .get("prepared-torrent", &task.hash)
                    .map_err(|_| RequestError::from("Database unavailable"))?
                {
                    task.remote_id = old["id"].as_u64().filter(|n| *n > 0).map(|n| n.to_string());
                    task.submitted = true;
                }
            }
            if task.remote_id.is_none() {
                if let Some(id) = adapter.find(&task.hash).await? {
                    task.remote_id = Some(id);
                } else if task.submitted {
                    task.phase = "cloud_queued".into();
                    task.message="Waiting for the provider to expose the submitted torrent; duplicate submission prevented".into();
                    task.next_check_at = now() + 60_000;
                    return Ok(());
                } else {
                    task.submitted = true;
                    task.owned = true;
                    task.phase = "submitting".into();
                    self.put("cloud-task", &task.id, &json!(task))
                        .map_err(|_| RequestError::from("Could not persist submission intent"))?;
                    match adapter.submit(&task.hash).await {
                        Ok(id) => task.remote_id = id,
                        Err(error) => {
                            // HTTP rejection proves no accepted submission. Unknown/network outcomes must reconcile.
                            if error
                                .status
                                .is_some_and(|s| matches!(s, 400 | 401 | 403 | 429))
                            {
                                task.submitted = false;
                            }
                            return Err(error);
                        }
                    }
                    self.put("cloud-task", &task.id, &json!(task))
                        .map_err(|_| RequestError::from("Could not save provider identity"))?;
                    if task.remote_id.is_none() {
                        task.phase = "cloud_queued".into();
                        task.message = "Queued in the provider cloud".into();
                        task.next_check_at = now() + 60_000;
                        return Ok(());
                    }
                }
            }
        }
        let info = adapter
            .info(
                task.remote_id
                    .as_deref()
                    .ok_or_else(|| RequestError::from("Provider identity pending"))?,
            )
            .await?;
        let hash = strv(&info, "hash");
        if hash.is_empty() {
            let (phase, progress, _) = normalize(&task.binding.provider, &info);
            if !matches!(phase, "ready" | "error") {
                task.phase = "metadata".into();
                task.progress = progress;
                task.files.clear();
                task.message = "Waiting for the provider to confirm torrent metadata".into();
                return Ok(());
            }
        }
        if !hash.eq_ignore_ascii_case(&task.hash) {
            return Err(RequestError {
                message: "Provider returned a different or missing torrent identity".into(),
                retry_at: 0,
                terminal: true,
                status: None,
            });
        }
        let (phase, progress, files) = normalize(&task.binding.provider, &info);
        task.phase = phase.into();
        task.progress = progress;
        task.files = files;
        if task.phase == "selection" {
            if task.owned {
                // Cloud acquisition can fetch the complete release; only reviewed files are saved locally.
                adapter
                    .select(task.remote_id.as_deref().unwrap_or_default())
                    .await?;
                task.phase = "cloud_queued".into();
            } else {
                task.phase = "error".into();
                task.message =
                    "Select files for this existing torrent in Real-Debrid, then retry".into();
                return Ok(());
            }
        }
        task.message = match task.phase.as_str() {
            "metadata" => "Getting torrent metadata",
            "cloud_queued" => "Waiting for a cloud download slot",
            "cloud_downloading" => "Downloading in the provider cloud",
            "cloud_processing" => "TorBox is processing files; waiting until they are downloadable",
            "stalled" => "Cloud download stalled; waiting for peers",
            "ready" => "Cloud files ready",
            "error" => "Provider reports this torrent failed or is unavailable",
            _ => "Waiting for provider preparation",
        }
        .into();
        if task.phase == "stalled" {
            task.next_check_at = now() + 120_000;
        }
        Ok(())
    }
}
impl Adapter<'_> {
    fn base(&self) -> &str {
        #[cfg(test)]
        if let Some(url) = &self.runtime.provider_url {
            return url;
        }
        if self.binding.provider == "realdebrid" {
            "https://api.real-debrid.com/rest/1.0"
        } else {
            super::sources::TORBOX
        }
    }
    async fn call(
        &self,
        request: reqwest::RequestBuilder,
        ttl: i64,
    ) -> Result<Value, RequestError> {
        let value = self
            .runtime
            .requests
            .json(
                request,
                if self.binding.provider == "torbox" {
                    Lane::TorBox
                } else {
                    Lane::Provider
                },
                ttl,
            )
            .await?;
        if self.binding.provider == "torbox" {
            if value["success"] != true {
                return Err(torbox_error(
                    &value,
                    RequestError {
                        message: String::new(),
                        retry_at: now() + 60_000,
                        terminal: false,
                        status: None,
                    },
                ));
            }
            Ok(value["data"].clone())
        } else {
            Ok(value)
        }
    }
    async fn find(&self, hash: &str) -> Result<Option<String>, RequestError> {
        for page in 0..20 {
            let request = if self.binding.provider == "torbox" {
                self.runtime
                    .client
                    .get(format!("{}/torrents/mylist", self.base()))
                    .query(&[
                        ("offset", (page * 1000).to_string()),
                        ("limit", "1000".into()),
                        ("bypass_cache", "true".into()),
                    ])
            } else {
                self.runtime
                    .client
                    .get(format!("{}/torrents", self.base()))
                    .query(&[("page", (page + 1).to_string()), ("limit", "1000".into())])
            };
            let value = self.call(request.bearer_auth(&self.key), 0).await?;
            let items = value
                .as_array()
                .ok_or_else(|| RequestError::from("Provider returned an invalid torrent list"))?;
            if let Some(item) = items
                .iter()
                .find(|v| strv(v, "hash").eq_ignore_ascii_case(hash))
            {
                return Ok(Some(remote_id(&item["id"])?));
            }
            if items.len() < 1000 {
                return Ok(None);
            }
        }
        Err(RequestError::from(
            "Account is too large to reconcile safely; no duplicate torrent was submitted",
        ))
    }
    async fn submit(&self, hash: &str) -> Result<Option<String>, RequestError> {
        let metadata = self
            .runtime
            .get("source-torrent", hash)
            .map_err(|_| RequestError::from("Stored torrent unavailable"))?
            .unwrap_or(Value::Null);
        let bytes = metadata["bytes"]
            .as_array()
            .map(|v| {
                v.iter()
                    .map(|n| {
                        n.as_u64()
                            .and_then(|n| u8::try_from(n).ok())
                            .ok_or_else(|| RequestError::from("Invalid torrent metadata"))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        let magnet = strv(&metadata, "magnet");
        let magnet = if url::Url::parse(magnet).ok().is_some_and(|u| {
            u.scheme() == "magnet"
                && u.query_pairs().any(|(k, v)| {
                    k == "xt"
                        && v.strip_prefix("urn:btih:")
                            .is_some_and(|v| v.eq_ignore_ascii_case(hash))
                })
        }) {
            magnet.to_owned()
        } else {
            format!("magnet:?xt=urn:btih:{hash}")
        };
        let request = if self.binding.provider == "torbox" {
            let mut form = reqwest::multipart::Form::new()
                .text("allow_zip", "false")
                .text("as_queued", "false");
            form = if let Some(bytes) = bytes {
                form.part(
                    "file",
                    reqwest::multipart::Part::bytes(bytes)
                        .file_name("source.torrent")
                        .mime_str("application/x-bittorrent")
                        .map_err(|_| RequestError::terminal("Invalid torrent upload type"))?,
                )
            } else {
                form.text("magnet", magnet)
            };
            self.runtime
                .client
                .post(format!("{}/torrents/createtorrent", self.base()))
                .multipart(form)
        } else if let Some(bytes) = bytes {
            self.runtime
                .client
                .put(format!("{}/torrents/addTorrent", self.base()))
                .body(bytes)
        } else {
            self.runtime
                .client
                .post(format!("{}/torrents/addMagnet", self.base()))
                .form(&[("magnet", magnet)])
        };
        let value = self.call(request.bearer_auth(&self.key), 0).await?;
        if self.binding.provider == "torbox" {
            if value["torrent_id"].is_null() || value["torrent_id"] == 0 {
                return Ok(None);
            }
            remote_id(&value["torrent_id"]).map(Some)
        } else {
            remote_id(&value["id"]).map(Some)
        }
    }
    async fn info(&self, id: &str) -> Result<Value, RequestError> {
        let request = if self.binding.provider == "torbox" {
            self.runtime
                .client
                .get(format!("{}/torrents/mylist", self.base()))
                // Active tasks are already paced at 30 seconds; do not reuse TorBox's older list snapshot.
                .query(&[("id", id), ("bypass_cache", "true")])
        } else {
            self.runtime
                .client
                .get(format!("{}/torrents/info/{id}", self.base()))
        };
        let value = self.call(request.bearer_auth(&self.key), 0).await?;
        Ok(value
            .as_array()
            .and_then(|a| a.first())
            .unwrap_or(&value)
            .clone())
    }
    async fn select(&self, id: &str) -> Result<(), RequestError> {
        self.call(
            self.runtime
                .client
                .post(format!("{}/torrents/selectFiles/{id}", self.base()))
                .bearer_auth(&self.key)
                .form(&[("files", "all")]),
            0,
        )
        .await?;
        Ok(())
    }
    pub async fn download_link(
        &self,
        task: &CloudTask,
        file: &Value,
    ) -> Result<String, RequestError> {
        let id = task
            .remote_id
            .as_deref()
            .ok_or("Provider identity missing")?;
        let value = if self.binding.provider == "torbox" {
            self.call(
                self.runtime
                    .client
                    .get(format!("{}/torrents/requestdl", self.base()))
                    .bearer_auth(&self.key)
                    .query(&[
                        ("token", self.key.as_str()),
                        ("torrent_id", id),
                        ("file_id", &remote_id(&file["id"])?),
                        ("zip_link", "false"),
                    ]),
                0,
            )
            .await?
        } else {
            let link = strv(file, "link");
            if link.is_empty() {
                return Err(RequestError::terminal("Real-Debrid file has no individual download link; archive links are not downloaded as video"));
            }
            let data = self
                .call(
                    self.runtime
                        .client
                        .post(format!("{}/unrestrict/link", self.base()))
                        .bearer_auth(&self.key)
                        .form(&[("link", link)]),
                    0,
                )
                .await?;
            data["download"].clone()
        };
        let url = http_url(value.as_str().ok_or("Provider returned no download link")?)
            .map_err(|e| RequestError::terminal(&e))?;
        Ok(url.to_string())
    }
}
fn remote_id(value: &Value) -> Result<String, RequestError> {
    let id = value
        .as_str()
        .map(String::from)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
        .ok_or_else(|| RequestError::from("Provider returned no identifier"))?;
    if id.is_empty()
        || id.len() > 100
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(RequestError::from("Invalid provider identifier"));
    }
    Ok(id)
}
pub(super) fn normalize(provider: &str, info: &Value) -> (&'static str, f64, Vec<Value>) {
    let rd = provider == "realdebrid";
    let normalized_state = strv(info, if rd { "status" } else { "download_state" }).to_lowercase();
    let state = normalized_state.as_str();
    let ready = if rd {
        state == "downloaded"
    } else {
        // Finished torrents may still be processing, or have expired from the cache.
        info["download_present"] == true
    };
    let phase = if matches!(
        state,
        "error"
            | "failed"
            | "failed (processing)"
            | "dead"
            | "magnet_error"
            | "virus"
            | "incomplete"
            | "missing"
            | "expired"
    ) {
        "error"
    } else if ready {
        "ready"
    } else if !rd && info["download_finished"] == true {
        "cloud_processing"
    } else {
        match state {
            "metadl" | "forcedmetadl" | "magnet_conversion" => "metadata",
            "waiting_files_selection" => "selection",
            "downloading" | "forceddl" => "cloud_downloading",
            "processing" | "moving" | "checkingdl" | "checkingresumedata" | "allocating" => {
                "cloud_processing"
            }
            "stalled" | "stalled (no seeds)" | "stalleddl" | "paused" | "pauseddl" => "stalled",
            _ => "cloud_queued",
        }
    };
    let progress = info["progress"].as_f64().unwrap_or(0.0) * (if rd { 1.0 } else { 100.0 });
    let raw = info["files"].as_array().cloned().unwrap_or_default();
    let selected = raw.iter().filter(|f| f["selected"] == 1).count();
    let links = info["links"].as_array().cloned().unwrap_or_default();
    let mut link_index = 0;
    let files=raw.iter().map(|f|{
        let mut file=json!({"id":f["id"],"name":if rd {strv(f,"path").trim_start_matches('/')}else{f["name"].as_str().or_else(||f["short_name"].as_str()).unwrap_or("")},"size":if rd {&f["bytes"]}else{&f["size"]}});
        if rd && f["selected"]==1 {if links.len()==selected {file["link"]=links[link_index].clone();}link_index+=1;}
        file
    }).collect();
    (phase, progress.clamp(0.0, 100.0), files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::moviebox::tests::test_runtime;
    use axum::{
        extract::Query,
        http::StatusCode,
        routing::{get, post},
        Json,
    };
    use std::{
        collections::HashMap,
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };

    async fn serve(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        (
            url,
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
        )
    }
    fn due(runtime: &Runtime, binding: &Binding, hash: &str) {
        let id = binding.task_id(hash);
        let mut task = runtime.get("cloud-task", &id).unwrap().unwrap();
        task["nextCheckAt"] = json!(0);
        runtime.put("cloud-task", &id, &task).unwrap();
    }
    #[tokio::test]
    async fn torbox_status_poll_requires_a_fresh_snapshot_and_keeps_stalls_visible() {
        let (url, server) = serve(axum::Router::new().route(
            "/torrents/mylist",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                let fresh = q.get("bypass_cache").is_some_and(|v| v == "true");
                Json(json!({"success":true,"data":{
                    "id":17,"hash":"d".repeat(40),
                    "download_state":if fresh {"stalled (no seeds)"} else {"queued"},
                    "progress":if fresh {0.25} else {0.0}
                }}))
            }),
        ))
        .await;
        let mut runtime = test_runtime(Path::new(":memory:"));
        runtime.provider_url = Some(url);
        *runtime.credential.lock().unwrap() = Some("fixture-key".into());
        let info = runtime
            .provider_adapter(&Binding::default())
            .unwrap()
            .info("17")
            .await
            .unwrap();
        let (phase, progress, _) = normalize("torbox", &info);
        assert_eq!(phase, "stalled");
        assert_eq!(progress, 25.0);
        for status in ["stalledDL", "pausedDL"] {
            assert_eq!(
                normalize("torbox", &json!({"download_state":status})).0,
                "stalled"
            );
        }
        server.abort();
    }
    #[tokio::test]
    async fn torbox_torrent_upload_uses_the_required_file_mime_type() {
        let (url, server) = serve(axum::Router::new().route(
            "/torrents/createtorrent",
            post(|headers: axum::http::HeaderMap, body: String| async move {
                assert!(headers["content-type"]
                    .to_str()
                    .unwrap()
                    .starts_with("multipart/form-data; boundary="));
                assert!(body.contains("name=\"file\"; filename=\"source.torrent\""));
                assert!(body
                    .to_lowercase()
                    .contains("content-type: application/x-bittorrent\r\n"));
                assert!(body.contains("\r\n\r\nd4:infodee\r\n"));
                Json(json!({"success":true,"data":{"torrent_id":17}}))
            }),
        ))
        .await;
        let mut runtime = test_runtime(Path::new(":memory:"));
        runtime.provider_url = Some(url);
        *runtime.credential.lock().unwrap() = Some("fixture-key".into());
        let hash = "d".repeat(40);
        runtime
            .put(
                "source-torrent",
                &hash,
                &json!({"bytes": b"d4:infodee".to_vec()}),
            )
            .unwrap();
        assert_eq!(
            runtime
                .provider_adapter(&Binding::default())
                .unwrap()
                .submit(&hash)
                .await
                .unwrap(),
            Some("17".into())
        );
        server.abort();
    }
    #[tokio::test]
    async fn torbox_queued_without_id_then_metadata_download_and_ready() {
        let stage = Arc::new(AtomicUsize::new(0));
        let submissions = Arc::new(AtomicUsize::new(0));
        let state = stage.clone();
        let count = submissions.clone();
        let (url,server)=serve(axum::Router::new()
            .route("/torrents/createtorrent",post(move||{let count=count.clone();async move{count.fetch_add(1,Ordering::SeqCst);Json(json!({"success":true,"data":{"queued_id":12}}))}}))
            .route("/torrents/mylist",get(move|Query(q):Query<HashMap<String,String>>|{let state=state.clone();async move{
                let stage=state.load(Ordering::SeqCst);
                let info=json!({"id":8,"hash":if stage==1&&q.contains_key("id"){String::new()}else{"a".repeat(40)},"download_state":if stage<=1 {"metaDL"}else{"downloading"},"download_finished":stage==3,"download_present":stage==3,"progress":0.5,"files":if stage>=2{json!([{"id":4,"name":"Owned.S01E01.mkv","size":123}])}else{json!([])}});
                Json(json!({"success":true,"data":if stage==0{json!([])}else if q.contains_key("id"){info}else{json!([info])}}))
            }}))).await;
        let mut runtime = test_runtime(Path::new(":memory:"));
        runtime.provider_url = Some(url);
        *runtime.credential.lock().unwrap() = Some("fixture-key".into());
        let binding = Binding::default();
        let hash = "a".repeat(40);
        assert_eq!(
            runtime.cloud_task(&binding, &hash).await.unwrap().phase,
            "cloud_queued"
        );
        stage.store(1, Ordering::SeqCst);
        due(&runtime, &binding, &hash);
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        assert_eq!(task.phase, "metadata");
        assert!(task.files.is_empty());
        stage.store(2, Ordering::SeqCst);
        due(&runtime, &binding, &hash);
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        assert_eq!(task.phase, "cloud_downloading");
        assert_eq!(task.progress, 50.0);
        stage.store(3, Ordering::SeqCst);
        due(&runtime, &binding, &hash);
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        assert_eq!(task.phase, "ready");
        assert_eq!(task.files[0]["id"], 4);
        assert_eq!(submissions.load(Ordering::SeqCst), 1);
        server.abort();
    }
    #[tokio::test]
    async fn uncached_recovery_waits_through_stalls_and_processing_without_resubmission() {
        let stage = Arc::new(AtomicUsize::new(0));
        let submitted = Arc::new(AtomicUsize::new(0));
        let polls = Arc::new(AtomicUsize::new(0));
        let st = stage.clone();
        let count = submitted.clone();
        let polled = polls.clone();
        let (url,server)=serve(axum::Router::new()
            .route("/torrents/createtorrent",post(move || {let count=count.clone();async move {count.fetch_add(1,Ordering::SeqCst);Json(json!({"success":true,"data":{"queued_id":12}}))}}))
            .route("/torrents/mylist",get(move|Query(q):Query<HashMap<String,String>>| {let st=st.clone(); let polled=polled.clone();async move {
                polled.fetch_add(1,Ordering::SeqCst);
                let step=st.load(Ordering::SeqCst);
                let info=json!({"id":8,"hash":"c".repeat(40),"download_state":match step {1=>"metaDL",2=>"stalledDL",3=>"completed",_=>"uploading"},"download_finished":step>=3,"download_present":step>=4,"progress":if step>=3{1.0}else{0.0},"files":[{"id":4,"name":"Owned.S01E01.mkv","size":123}]});
                Json(json!({"success":true,"data":if step==0 {json!([])}else if q.contains_key("id"){info}else{json!([info])}}))
            }}))).await;
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("state.sqlite");
        let binding = Binding::default();
        let hash = "c".repeat(40);
        for (step, expected) in [
            (0, "cloud_queued"),
            (1, "metadata"),
            (2, "stalled"),
            (3, "cloud_processing"),
            (4, "ready"),
        ] {
            // Every stage starts a fresh runtime, as after quitting and reopening the application.
            let mut runtime = test_runtime(&database);
            runtime.provider_url = Some(url.clone());
            *runtime.credential.lock().unwrap() = Some("fixture-key".into());
            stage.store(step, Ordering::SeqCst);
            if step > 0 {
                due(&runtime, &binding, &hash);
            }
            let task = runtime.cloud_task(&binding, &hash).await.unwrap();
            assert_eq!(task.phase, expected);
            if step == 2 {
                assert!(task.next_check_at >= now() + 119_000);
            }
            let before = polls.load(Ordering::SeqCst);
            assert_eq!(
                runtime.cloud_task(&binding, &hash).await.unwrap().phase,
                expected
            );
            assert_eq!(
                polls.load(Ordering::SeqCst),
                before,
                "UI refresh must not bypass cloud polling delay"
            );
        }
        assert_eq!(submitted.load(Ordering::SeqCst), 1);
        assert_eq!(
            normalize(
                "torbox",
                &json!({"download_state":"failed (processing)","download_finished":true})
            )
            .0,
            "error"
        );
        assert_eq!(
            normalize(
                "torbox",
                &json!({"download_state":"completed","progress":1.0})
            )
            .0,
            "cloud_queued"
        );
        server.abort();
    }
    #[tokio::test]
    #[ignore = "Read-only status of the previously authorized owned Sintel TorBox fixture"]
    async fn live_owned_torbox_readiness_status() {
        assert_eq!(
            std::env::var("MOVIBOX_LIVE_ACCEPTANCE").as_deref(),
            Ok("torbox")
        );
        let root = std::path::PathBuf::from(std::env::var("MOVIBOX_LIVE_ROOT").unwrap());
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["fixture"], "sintel-webseed-v1");
        let runtime = test_runtime(&root.join("acceptance.sqlite3"));
        let task: CloudTask = serde_json::from_value(
            runtime
                .list("cloud-task")
                .unwrap()
                .into_iter()
                .find(|v| v["hash"] == manifest["hash"])
                .expect("Previously submitted owned task must exist"),
        )
        .unwrap();
        assert!(task.submitted);
        let remote = task
            .remote_id
            .as_ref()
            .expect("No new task will be submitted");
        // GET only: do not call cloud_task/submit, obtain links, or download video bytes.
        let info = runtime
            .provider_adapter(&task.binding)
            .unwrap()
            .info(remote)
            .await
            .unwrap();
        assert_eq!(strv(&info, "hash"), strv(&manifest, "hash"));
        let (phase, progress, files) = normalize("torbox", &info);
        let result = json!({"checkedAt":now(),"readOnly":true,"newSubmissions":0,"downloadBytes":0,"phase":phase,"progress":progress,"downloadFinished":info["download_finished"],"downloadPresent":info["download_present"],"files":files.len()});
        std::fs::write(
            root.join("readiness-recheck.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        )
        .unwrap();
        assert_eq!(phase, "ready");
        assert_eq!(info["download_present"], true);
        println!("{}", result);
    }
    #[tokio::test]
    async fn known_capacity_rejection_can_retry_without_losing_intent() {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let (url, server) = serve(
            axum::Router::new()
                .route(
                    "/torrents/mylist",
                    get(|| async { Json(json!({"success":true,"data":[]})) }),
                )
                .route(
                    "/torrents/createtorrent",
                    post(move || {
                        let c = c.clone();
                        async move {
                            let first = c.fetch_add(1, Ordering::SeqCst) == 0;
                            Json(if first {
                                json!({"success":false,"error":"ACTIVE_LIMIT"})
                            } else {
                                json!({"success":true,"data":{"queued_id":9}})
                            })
                        }
                    }),
                ),
        )
        .await;
        let mut runtime = test_runtime(Path::new(":memory:"));
        runtime.provider_url = Some(url);
        *runtime.credential.lock().unwrap() = Some("fixture-key".into());
        let binding = Binding::default();
        let hash = "b".repeat(40);
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        assert_eq!(task.phase, "retrying");
        assert!(!task.submitted);
        due(&runtime, &binding, &hash);
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        assert!(task.submitted);
        assert_eq!(task.phase, "cloud_queued");
        assert_eq!(count.load(Ordering::SeqCst), 2);
        server.abort();
    }
    #[tokio::test]
    async fn realdebrid_selects_cloud_files_and_unrestricts_only_mapped_link() {
        let selected = Arc::new(AtomicUsize::new(0));
        let select = selected.clone();
        let info = selected.clone();
        let (url,server)=serve(axum::Router::new()
            .route("/user",get(||async{Json(json!({"id":42,"type":"premium"}))}))
            .route("/torrents",get(||async{Json(json!([]))}))
            .route("/torrents/addMagnet",post(|body:String|async move{assert!(body.contains("magnet="));(StatusCode::CREATED,Json(json!({"id":"RD42"})))}))
            .route("/torrents/selectFiles/RD42",post(move|body:String|{let s=select.clone();async move{assert_eq!(body,"files=all");s.fetch_add(1,Ordering::SeqCst);StatusCode::NO_CONTENT}}))
            .route("/torrents/info/RD42",get(move||{let s=info.clone();async move{Json(json!({"id":"RD42","hash":"c".repeat(40),"status":if s.load(Ordering::SeqCst)>0{"downloaded"}else{"waiting_files_selection"},"progress":100,"files":[{"id":1,"path":"/Owned.S01E01.mkv","bytes":200,"selected":1},{"id":3,"path":"/Owned.S01E02.mkv","bytes":300,"selected":1}],"links":["https://real-debrid.com/d/one","https://real-debrid.com/d/two"]}))}}))
            .route("/unrestrict/link",post(|body:String|async move{assert!(body.contains("two"));Json(json!({"download":"https://download.example/owned.mkv"}))}))).await;
        let mut runtime = test_runtime(Path::new(":memory:"));
        runtime.provider_url = Some(url);
        *runtime.credential.lock().unwrap() = Some("fixture-key".into());
        let account = runtime
            .verify_account("realdebrid", "fixture-key")
            .await
            .unwrap();
        assert_eq!(account["plan"], "premium");
        runtime
            .put(
                "settings",
                "preferences",
                &json!({"defaultProvider":"realdebrid","providerAccounts":{"realdebrid":account}}),
            )
            .unwrap();
        let binding = runtime.binding().unwrap();
        let hash = "c".repeat(40);
        assert_eq!(
            runtime.cloud_task(&binding, &hash).await.unwrap().phase,
            "cloud_queued"
        );
        assert_eq!(selected.load(Ordering::SeqCst), 1);
        due(&runtime, &binding, &hash);
        let task = runtime.cloud_task(&binding, &hash).await.unwrap();
        assert_eq!(task.phase, "ready");
        let adapter = runtime.provider_adapter(&binding).unwrap();
        assert_eq!(
            adapter.download_link(&task, &task.files[1]).await.unwrap(),
            "https://download.example/owned.mkv"
        );
        let (_, _, files) = normalize(
            "realdebrid",
            &json!({"status":"downloaded","files":[{"id":1,"selected":1},{"id":2,"selected":1}],"links":["archive"]}),
        );
        assert!(
            adapter
                .download_link(&task, &files[0])
                .await
                .unwrap_err()
                .terminal
        );
        let wrong = Binding {
            provider: "realdebrid".into(),
            account: "different-account".into(),
        };
        assert!(runtime.provider_adapter(&wrong).is_err());
        server.abort();
    }
}
