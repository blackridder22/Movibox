use super::{flag, number, strv, Runtime};
use crate::acquisition::{self, AcquisitionState};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn moviebox_request(
    app: AppHandle,
    runtime: State<'_, Runtime>,
    acquisition: State<'_, AcquisitionState>,
    action: String,
    input: Value,
) -> Result<Value, String> {
    if app
        .state::<std::sync::Arc<super::updates::Updates>>()
        .installing()
        && !matches!(
            action.as_str(),
            "snapshot" | "updates.status" | "logs" | "diagnostics" | "storage" | "search.get"
        )
    {
        return Err("An update is being installed. Wait for Movie Box to restart.".into());
    }
    let runtime = runtime.inner().clone();
    let result = dispatch(&app, &runtime, acquisition, &action, input).await;
    if result.is_ok()
        && !matches!(
            action.as_str(),
            "snapshot"
                | "updates.status"
                | "backup.preview"
                | "backup.latest"
                | "catalog"
                | "detail"
                | "sources"
                | "search.get"
                | "logs"
                | "diagnostics"
                | "storage"
        )
    {
        let _ = app.emit("movibox://backend-changed", ());
    }
    if let Err(error) = &result {
        if error != "Search canceled" {
            let _ = runtime.log("error", "backend", error, None);
        }
    }
    result
}
async fn dispatch(
    app: &AppHandle,
    runtime: &Runtime,
    acquisition: State<'_, AcquisitionState>,
    action: &str,
    input: Value,
) -> Result<Value, String> {
    let id = strv(&input, "id");
    match action {
        "updates.status" => {
            use tauri::Manager;
            Ok(app.state::<std::sync::Arc<super::updates::Updates>>().snapshot())
        }
        "updates.check" => {
            use tauri::Manager;
            app.state::<std::sync::Arc<super::updates::Updates>>().check(app).await
        }
        "updates.install" => {
            use tauri::Manager;
            app.state::<std::sync::Arc<super::updates::Updates>>().install(app, runtime, strv(&input,"version")).await
        }
        "backup.create" => {
            let recovery = app.path().app_data_dir().map_err(|_| "Recovery folder unavailable")?.join("recovery");
            std::fs::create_dir_all(&recovery).map_err(|_| "Could not create recovery folder")?;
            let path = recovery.join(format!("MovieBox-{}-{}.movibox-backup",chrono::Local::now().format("%Y-%m-%d-%H%M%S"),uuid::Uuid::new_v4()));
            runtime.export_backup(&path)?;
            let mut result = runtime.preview_backup(&path)?; result["path"] = json!(path); Ok(result)
        }
        "backup.latest" => {
            let recovery = app.path().app_data_dir().map_err(|_| "Recovery folder unavailable")?.join("recovery");
            Ok(super::backup::latest_recovery(&recovery).unwrap_or(Value::Null))
        }
        "backup.export" => runtime.export_backup(Path::new(strv(&input, "path"))),
        "backup.preview" => runtime.preview_backup(Path::new(strv(&input, "path"))),
        "backup.restore" => {
            use tauri::Manager;
            let _preparation = runtime.preparation.lock().await;
            for job in acquisition.list_jobs()? {
                if acquisition.task_running(&job.id) { return Err("Wait for transfers to stop before restoring".into()); }
            }
            let recovery = app.path().app_data_dir().map_err(|_| "Recovery folder unavailable")?.join("recovery");
            runtime.restore_backup(Path::new(strv(&input, "path")), strv(&input, "checksum"), &recovery)
        }
        "backup.folder" => {
            use tauri::{Manager};
            use tauri_plugin_opener::OpenerExt;
            let recovery = app.path().app_data_dir().map_err(|_| "Recovery folder unavailable")?.join("recovery");
            std::fs::create_dir_all(&recovery).map_err(|_| "Could not create recovery folder")?;
            app.opener().open_path(recovery.to_string_lossy(), None::<&str>).map_err(|_| "Could not open recovery folder")?;
            Ok(Value::Null)
        }
        "snapshot" => runtime.snapshot(&acquisition),
        "catalog" => {
            runtime
                .catalog(
                    strv(&input, "kind"),
                    strv(&input, "query"),
                    input["skip"].as_u64().unwrap_or(0),
                )
                .await
        }
        "detail" => runtime.detail(id, strv(&input, "kind")).await,
        "activity.search.record" => runtime.record_recent_search(&input),
        "activity.search.remove" => { runtime.remove_recent_search(id)?; Ok(Value::Null) },
        "activity.search.clear" => { runtime.clear_recent_searches()?; Ok(Value::Null) },
        "watch.set" => runtime.set_watched(&input),
        "tmdb.connect" => {runtime.connect_tmdb(strv(&input,"token")).await?;Ok(Value::Null)},
        "tmdb.disconnect" => {runtime.disconnect_tmdb()?;Ok(Value::Null)},
        "search.start" => runtime.create_search(&input),
        "search.get" => runtime.search_result(id),
        "search.cancel" => { if !id.is_empty() {runtime.cancel_background_search(id)?;} else {runtime.cancel_search(strv(&input,"requestId"))?;} Ok(Value::Null)},
        "sources" => runtime.interactive(strv(&input,"requestId"),runtime.search_sources(id,strv(&input,"kind"),input["season"].as_i64().map(|n|n as i32),input["episode"].as_i64().map(|n|n as i32),strv(&input,"quality"),strv(&input,"language"))).await,
        "indexer.public" => {
            runtime.put("indexer","knaben",&json!({"id":"knaben","kind":"knaben","name":"Knaben public search","url":"https://api.knaben.org/v1","enabled":true,"hasKey":false,"capabilities":{"public":true}}))?;
            Ok(Value::Null)
        }
        "indexer.save" => runtime.save_indexer(&input).await,
        "indexer.test" => runtime.test_indexer(id).await,
        "indexer.toggle" => {runtime.configure_indexer(id,Some(flag(&input,"enabled")))?;Ok(Value::Null)},
        "indexer.remove" => {runtime.configure_indexer(id,None)?;Ok(Value::Null)},
        "bundle.plan" => {
            let request_id=strv(&input,"requestId").to_owned();
            let request=serde_json::from_value(input).map_err(|_|"Invalid bundle request")?;
            runtime.interactive(&request_id,async {
                let plan=tokio::time::timeout(std::time::Duration::from_secs(180),runtime.plan_bundle(request,&acquisition)).await.map_err(|_|"Source search timed out. Try fewer episodes or check source connections.")??;
                serde_json::to_value(plan).map_err(|e|e.to_string())
            }).await
        },
        "bundle.get" => runtime.bundle_plan(id),
        "bundle.prepare" => tokio::time::timeout(std::time::Duration::from_secs(180),runtime.prepare_bundle(id)).await.map_err(|_|"Preparation check timed out. Check the bundle again; existing cloud submissions are reused.")?,
        "bundle.enqueue" => {let _guard=runtime.workflow_commit.lock().map_err(|_|"Workflow unavailable")?;let p=runtime.prefs()?;runtime.enqueue_bundle(app,&acquisition,id,strv(&input,"destination"),strv(&p,"transferWindow"),strv(&p,"timezone"))},
        "bundle.control" => runtime.control_bundle(app,acquisition,id,strv(&input,"action")),
        "enqueue" => {
            let p = runtime.prefs()?;
            let job = runtime.enqueue_source(
                app,
                &acquisition,
                id,
                strv(&input, "destination"),
                strv(&p, "transferWindow"),
                strv(&p, "timezone"),
                None,
                None,
            )?;
            Ok(json!({"id":job.id}))
        }
        "provider.connect" => {
            let provider=input["provider"].as_str().unwrap_or("torbox");
            let key=strv(&input,"key").trim();
            let account=runtime.verify_account(provider,key).await?;
            let _guard=runtime.preparation.lock().await;
            let mut p=runtime.prefs()?;
            let old=p["providerAccounts"][provider]["account"].as_str().unwrap_or("legacy");
            if old!=strv(&account,"account") && acquisition.list_jobs()?.iter().any(|j| {
                let b=j.source_context["providerBinding"]["provider"].as_str().unwrap_or("torbox");
                b==provider && !matches!(j.status.as_str(),"done"|"canceled")
            }) {return Err("Finish or cancel this provider's existing downloads before switching accounts".into());}
            if runtime.list("bundle-wait")?.iter().any(|v|!matches!(strv(v,"state"),"queued"|"canceled") && runtime.get("bundle-plan",strv(v,"id")).ok().flatten().is_some_and(|plan|plan["binding"]["provider"].as_str().unwrap_or("torbox")==provider)) && old!=strv(&account,"account") {return Err("Finish or cancel pending bundle preparation before switching accounts".into());}
            if p["providerAccounts"].is_null() {p["providerAccounts"]=json!({"torbox":{"account":"legacy","connected":flag(&p,"provider")}});}
            keyring::Entry::new("app.movibox.backend",provider).map_err(|_|"Credential store unavailable")?.set_password(key).map_err(|_|"Could not save provider token")?;
            if provider=="torbox" {*runtime.credential.lock().map_err(|_|"Credential store unavailable")?=Some(key.into());}
            p["providerAccounts"][provider]=account.clone();
            if p["defaultProvider"].is_null() {p["defaultProvider"]=json!(provider);}
            p["provider"]=p["providerAccounts"][strv(&p,"defaultProvider")]["connected"].clone();
            runtime.put("settings","preferences",&p)?;
            runtime.log("info","provider","Provider account verified; token saved in OS credential store",None)?;
            Ok(json!({"connected":true,"plan":account["plan"],"expiresAt":account["expiresAt"]}))
        }
        "provider.test" => {
            let binding=runtime.binding()?;
            let provider=input["provider"].as_str().unwrap_or(&binding.provider);
            let key=if provider=="torbox" {runtime.key()?}else{keyring::Entry::new("app.movibox.backend",provider).map_err(|_|"Credential store unavailable")?.get_password().map_err(|_|"Connect this provider first")?};
            runtime.verify_account(provider,&key).await.map(|_|json!({"connected":true}))
        }
        "provider.disconnect" => {
            let binding=runtime.binding()?;
            let provider=input["provider"].as_str().unwrap_or(&binding.provider);
            if !["torbox","realdebrid"].contains(&provider) {return Err("Unknown provider".into());}
            let _guard=runtime.preparation.lock().await;
            let entry=keyring::Entry::new("app.movibox.backend",provider).map_err(|_|"Credential store unavailable")?;
            match entry.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>{},Err(_)=>return Err("Could not remove provider token".into())}
            if provider=="torbox" {*runtime.credential.lock().map_err(|_|"Credential store unavailable")?=None;}
            let mut p=runtime.prefs()?;
            if p["providerAccounts"].is_null(){p["providerAccounts"]=json!({});}
            if p["providerAccounts"][provider].is_null(){p["providerAccounts"][provider]=json!({"account":"legacy"});}
            p["providerAccounts"][provider]["connected"]=json!(false);
            if binding.provider==provider {p["provider"]=json!(false);}
            runtime.put("settings","preferences",&p)?;
            Ok(Value::Null)
        }
        "bundle.wait" => {let p=runtime.prefs()?;runtime.queue_wait(id,strv(&input,"destination"),strv(&p,"transferWindow"),strv(&p,"timezone"),None)},
        "bundle.wait.control" => runtime.control_wait(id,strv(&input,"action")),
        "subtitles.find" => {
            let runtime=runtime.clone();
            let acquisition=acquisition.inner().clone();
            tokio::task::spawn_blocking(move ||runtime.find_subtitles(&acquisition,&input)).await.map_err(|_|"Subtitle queue request interrupted")?
        },
        "subtitles.import" => {
            let task = runtime.get("subtitle-job",id)?.ok_or("Subtitle task not found")?;
            let job = acquisition.load_job(strv(&task,"jobId"))?.ok_or("Video download not found")?;
            let runtime = runtime.clone();
            let id = id.to_owned();
            let path = std::path::PathBuf::from(strv(&input,"path"));
            tokio::task::spawn_blocking(move || runtime.import_subtitle(&job,&id,&path)).await.map_err(|_|"Subtitle import interrupted")??;
            Ok(Value::Null)
        },
        "subtitles.connect" => runtime.connect_subtitles(&input).await,
        "subtitles.disconnect" => {
            match keyring::Entry::new("app.movibox.backend","opensubtitles").map_err(|_|"Credential store unavailable")?.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>{},Err(_)=>return Err("Could not remove subtitle credentials".into())}
            let mut p=runtime.prefs()?;p["subtitlesAccount"]=json!({"connected":false});runtime.put("settings","preferences",&p)?;Ok(Value::Null)
        }
        "subtitles.retry" => {runtime.retry_subtitles(id)?;Ok(Value::Null)},
        "addon.add" => {
            runtime.add_addon(strv(&input, "url")).await?;
            Ok(Value::Null)
        }
        "addon.configure" => {
            let p = runtime.prefs()?;
            let addon = p["addons"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|a| strv(a, "id") == id)
                .ok_or("Add-on not found")?;
            let mut url = super::catalog::http_url(strv(addon, "url"))?;
            let path = url.path().trim_end_matches("manifest.json").to_string() + "configure";
            url.set_path(&path);
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .open_url(url.as_str(), None::<&str>)
                .map_err(|_| "Could not open add-on configuration")?;
            Ok(Value::Null)
        }
        "preferences" => {
            let mut p = runtime.prefs()?;
            let was_subtitles_enabled=flag(&p,"subtitlesEnabled");
            let patch = input.as_object().ok_or("Invalid settings update")?;
            for (k, v) in patch {
                if ["provider", "providerAccounts", "subtitlesAccount", "tmdbConnected"].contains(&k.as_str()) {
                    continue;
                }
                if k == "addons" {
                    let old = p["addons"].as_array().cloned().unwrap_or_default();
                    let mut next = Vec::new();
                    for a in v.as_array().ok_or("Invalid add-ons")? {
                        let mut saved = old
                            .iter()
                            .find(|x| x["id"] == a["id"])
                            .cloned()
                            .ok_or("Validate new add-ons before installing")?;
                        saved["enabled"] = a["enabled"].clone();
                        next.push(saved);
                    }
                    p[k] = json!(next);
                    continue;
                }
                p[k] = v.clone();
            }
            if p["catalogProvider"]=="tmdb" && p["tmdbConnected"]!=true {return Err("Connect TMDB before selecting its catalog".into());}
            if !p["catalogProvider"].is_null() && !["addons","tmdb"].contains(&strv(&p,"catalogProvider")) {return Err("Unknown catalog provider".into());}
            if !p["catalogLanguage"].is_null() && !["en-US","fr-FR","es-ES","pt-BR","de-DE","it-IT","ja-JP","ko-KR"].contains(&strv(&p,"catalogLanguage")) {return Err("Unsupported catalog language".into());}
            if !p["defaultProvider"].is_null() && !["torbox","realdebrid"].contains(&strv(&p,"defaultProvider")) {return Err("Unknown default provider".into());}
            if patch.contains_key("defaultProvider") {
                let selected=strv(&p,"defaultProvider");
                p["provider"]=json!(p["providerAccounts"][selected]["connected"]==true || selected=="torbox" && p["providerAccounts"].is_null() && flag(&p,"provider"));
            }
            for (key, min, max) in [
                ("concurrency", 1.0, 16.0),
                ("retries", 0.0, 10.0),
                ("reserve", 0.0, 1000.0),
                ("maxSize", 0.1, 10000.0),
            ] {
                let value = number(&p, key, f64::NAN);
                if !value.is_finite() || value < min || value > max {
                    return Err(format!("Invalid {key} setting"));
                }
            }
            if !Path::new(strv(&p, "folder")).is_absolute() {
                return Err("Choose a destination using the folder picker".into());
            }
            super::scheduler::window_open(
                strv(&p, "transferWindow"),
                strv(&p, "timezone"),
                super::now(),
            )?;
            if patch.contains_key("autoStart") {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                if flag(&p, "autoStart") {
                    manager.enable()
                } else {
                    manager.disable()
                }
                .map_err(|_| "Could not change launch-at-login registration")?;
            }
            if !was_subtitles_enabled && flag(&p,"subtitlesEnabled") {p["subtitlesEnabledAt"]=json!(super::now());}
            runtime.put("settings", "preferences", &p)?;
            crate::tray::tray_set_prefs(
                app.clone(),
                crate::tray::TrayPrefs {
                    close_to_tray: flag(&p, "background"),
                    always_on_top: false,
                    pause_minimized: false,
                    pause_unfocused: false,
                },
            );
            Ok(Value::Null)
        }
        "rule.save" => {
            let runtime=runtime.clone();
            let acquisition=acquisition.inner().clone();
            tokio::task::spawn_blocking(move || {
                let _guard=runtime.workflow_commit.lock().map_err(|_|"Workflow unavailable")?;
                let mut input=input;
                let repair_now=flag(&input,"repairExistingNow");
                if let Some(object)=input.as_object_mut() {object.remove("repairExistingNow");}
                let mut rule=runtime.save_rule(input)?;
                let report=if repair_now {
                    runtime.queue_rule_subtitles(&rule,&acquisition.list_jobs()?,true)
                        .map_err(|e|format!("Rule saved, but existing subtitles could not be queued: {e}"))?
                } else {json!({"queued":0,"videos":0,"missing":0})};
                rule["subtitleRepair"]=report;
                runtime.put("rule",strv(&rule,"id"),&rule)?;
                Ok(rule)
            }).await.map_err(|_|"Rule save interrupted")?
        },
        "rule.run" => {
            runtime.run_rule(app.clone(), id.into(), false)?;
            Ok(Value::Null)
        }
        "rule.remove" => {
            let _guard=runtime.workflow_commit.lock().map_err(|_|"Workflow unavailable")?;
            runtime.remove("rule", id)?;
            Ok(Value::Null)
        }
        "job.pause" => {
            acquisition::acquisition_pause(app.clone(), acquisition, id.into())?;
            Ok(Value::Null)
        }
        "job.resume" => {
            acquisition::acquisition_resume(app.clone(), acquisition, id.into())?;
            Ok(Value::Null)
        }
        "job.prioritize" => {
            acquisition.update_job(id, |j| {
                j.source_context["queuePriority"] = json!(super::now())
            })?;
            Ok(Value::Null)
        }
        "job.retry" => {
            runtime.retry_cloud_job(&acquisition.load_job(id)?.ok_or("Download not found")?)?;
            // Resolve again from durable source identity, never depend on an expired signed URL.
            acquisition.update_job(id, |j| {
                if flag(&j.source_context, "moviebox") {
                    j.url.clear();
                }
                j.attempt = 0;
            })?;
            acquisition::acquisition_retry(app.clone(), acquisition, id.into())?;
            Ok(Value::Null)
        }
        "job.cancel" => {
            acquisition::acquisition_cancel(app.clone(), acquisition, id.into())?;
            Ok(Value::Null)
        }
        "job.remove" => {
            let job = acquisition.load_job(id)?.ok_or("Download not found")?;
            if !matches!(job.status.as_str(), "done" | "error" | "canceled") {
                acquisition::acquisition_cancel(app.clone(), acquisition.clone(), id.into())?;
                wait_stopped(&acquisition, id).await?;
                if flag(&input, "deleteFile") {
                    for suffix in [".part", ".part.http.json"] {
                        let path = format!("{}{suffix}", job.path);
                        if Path::new(&path).exists() {
                            tokio::fs::remove_file(path)
                                .await
                                .map_err(|_| "Could not remove partial file")?;
                        }
                    }
                }
            }
            runtime.put("hidden-job", id, &json!(true))?;
            Ok(Value::Null)
        }
        "history.remove" => {
            let ids = input["ids"]
                .as_array()
                .ok_or("Choose at least one history record")?
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            if ids.is_empty() {
                return Err("Choose at least one history record".into());
            }
            Ok(json!({ "removed": acquisition.remove_history(&ids)? }))
        }
        "history.clear" => Ok(json!({ "removed": acquisition.clear_history()? })),
        "history.open" | "history.reveal" => {
            let entry = acquisition
                .load_history(id)?
                .ok_or("History record not found")?;
            let path = Path::new(&entry.destination);
            if !path.is_file() {
                return Err("The downloaded file is no longer available at this location".into());
            }
            if action == "history.open" {
                acquisition::open_path(path)?;
            } else {
                acquisition::reveal_path(path)?;
            }
            Ok(Value::Null)
        }
        "job.destination" => {
            let job = acquisition.load_job(id)?.ok_or("Download not found")?;
            if job.status == "done" {
                return Err("Completed files are managed from Library".into());
            }
            acquisition::acquisition_pause(app.clone(), acquisition.clone(), id.into())?;
            wait_stopped(&acquisition, id).await?;
            let media = runtime
                .get("media", &job.media_id)?
                .ok_or("Title metadata missing")?;
            let filename = Path::new(&job.path)
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid filename")?;
            let destination =
                runtime.destination(&media, strv(&input, "destination"), job.season, filename)?;
            if destination != job.path {
                if Path::new(&destination).exists()
                    || Path::new(&format!("{destination}.part")).exists()
                {
                    return Err("A file already exists at this destination".into());
                }
                let parent = Path::new(&destination)
                    .parent()
                    .ok_or("Invalid destination")?;
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| "Could not create destination")?;
                for suffix in [".part", ".part.http.json"] {
                    let old = format!("{}{suffix}", job.path);
                    let new = format!("{destination}{suffix}");
                    if Path::new(&old).exists() {
                        if tokio::fs::rename(&old, &new).await.is_err() {
                            tokio::fs::copy(&old, &new).await.map_err(|_| {
                                "Could not copy partial file to the new destination"
                            })?;
                            tokio::fs::remove_file(&old).await.map_err(|_| {
                                "Copied file but could not remove its old partial file"
                            })?;
                        }
                    }
                }
                acquisition.update_job(id, |j| {
                    j.path = destination;
                    j.source_context["destination"] = input["destination"].clone();
                })?;
            }
            Ok(Value::Null)
        }
        "player.iina" => {
            let path=if strv(&input,"target")=="library" {runtime.get("library",id)?.ok_or("Library entry not found")?["path"].as_str().ok_or("Library path missing")?.to_owned()}else{
                let job=acquisition.load_job(id)?.ok_or("Download not found")?;
                if job.status!="done" {return Err("Finish downloading this video before opening it".into());}
                job.path
            };
            super::player::open_iina(Path::new(&path)).await?; Ok(Value::Null)
        }
        "library.removeMany" => {
            let ids = input["ids"]
                .as_array()
                .ok_or("Choose library entries to remove")?;
            if ids.is_empty() || ids.len() > 500 {
                return Err("Choose between 1 and 500 library entries".into());
            }
            for id in ids.iter().filter_map(Value::as_str) {
                remove_library_entry(runtime, id, &input)?;
            }
            Ok(json!({"removed":ids.len()}))
        }
        "job.open" => {
            acquisition::acquisition_open(acquisition, id.into())?;
            Ok(Value::Null)
        }
        "job.reveal" => {
            acquisition::acquisition_reveal(acquisition, id.into())?;
            Ok(Value::Null)
        }
        "library.open" | "library.reveal" | "library.remove" => {
            let file = runtime
                .get("library", id)?
                .ok_or("Library entry not found")?;
            let path = Path::new(strv(&file, "path"));
            if action == "library.remove" {
                remove_library_entry(runtime, id, &input)?;
            } else if action == "library.open" {
                acquisition::open_path(path)?;
            } else {
                acquisition::reveal_path(path)?;
            }
            Ok(Value::Null)
        }
        "library.folder" => {
            let p = runtime.prefs()?;
            let path = Path::new(strv(&p, "folder"));
            std::fs::create_dir_all(path).map_err(|_| "Could not create library folder")?;
            acquisition::open_path(path)?;
            Ok(Value::Null)
        }
        "library.relink" => {
            let mut file = runtime
                .get("library", id)?
                .ok_or("Library entry not found")?;
            let path = Path::new(strv(&input, "path"));
            if !path.is_absolute() || !path.is_file() {
                return Err("Choose an existing local file".into());
            }
            file["path"] = input["path"].clone();
            runtime.put("library", id, &file)?;
            Ok(Value::Null)
        }
        "storage" => {
            let p = runtime.prefs()?;
            let path = Path::new(strv(&p, "folder"));
            std::fs::create_dir_all(path).map_err(|_| "Could not create library folder")?;
            let probe = path.join(format!(".movibox-write-check-{}", uuid::Uuid::new_v4()));
            std::fs::write(&probe, []).map_err(|_| "Library folder is not writable")?;
            std::fs::remove_file(probe).map_err(|_| "Could not remove write-check file")?;
            Ok(
                json!({"free":fs2::available_space(path).map_err(|_|"Could not read free space")?,"total":fs2::total_space(path).map_err(|_|"Could not read disk size")?,"writable":true}),
            )
        }
        "notification.test" => {
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("Movie Box")
                .body("Notifications are ready.")
                .show()
                .map_err(|_| "System notification could not be shown")?;
            Ok(Value::Null)
        }
        "logs" => Ok(json!(runtime.logs(input["subject"].as_str())?)),
        "diagnostics" => Ok(
            json!({"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"backend":"native","providerConfigured":flag(&runtime.prefs()?,"provider"),"jobs":acquisition.list_jobs()?.len(),"rules":runtime.list("rule")?.len(),"logs":runtime.logs(None)?}),
        ),
        "quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        _ => Err("Unknown backend operation".into()),
    }
}

fn remove_library_entry(runtime: &Runtime, id: &str, input: &Value) -> Result<(), String> {
    let file = runtime
        .get("library", id)?
        .ok_or("Library entry not found")?;
    let path = Path::new(strv(&file, "path"));
    let move_to_trash = flag(input, "trashFile") || flag(input, "deleteFile");
    if move_to_trash && path.exists() {
        if !path.is_file() {
            return Err("Library path is not a local file".into());
        }
        trash::delete(path).map_err(|_| "Could not move file to the system Trash")?;
    }
    if flag(input, "markWatched") {
        runtime.mark_library_entry_watched(&file)?;
    }
    runtime.remove("library", id)?;
    runtime.put("hidden-library", id, &json!(true))?;
    runtime.log(
        "info",
        "library",
        if move_to_trash {
            "Library file moved to the system Trash"
        } else {
            "Library entry removed; local file kept"
        },
        Some(id),
    )?;
    Ok(())
}

async fn wait_stopped(state: &AcquisitionState, id: &str) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while state.task_running(id) {
        if tokio::time::Instant::now() > deadline {
            return Err("Transfer is still stopping. Try again shortly.".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}

impl Runtime {
    fn cancel_search(&self, id: &str) -> Result<(), String> {
        let active = self
            .interactive_search
            .lock()
            .map_err(|_| "Search unavailable")?;
        if let Some((current, handle)) = active.as_ref().filter(|(current, _)| current == id) {
            let _ = current;
            handle.abort();
        }
        Ok(())
    }
    async fn interactive<T>(
        &self,
        id: &str,
        work: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        if id.is_empty() {
            return work.await;
        }
        if id.len() > 80 {
            return Err("Invalid search identifier".into());
        }
        let (handle, registration) = futures_util::future::AbortHandle::new_pair();
        {
            let mut active = self
                .interactive_search
                .lock()
                .map_err(|_| "Search unavailable")?;
            if let Some((_, old)) = active.replace((id.into(), handle)) {
                old.abort();
            }
        }
        let result = futures_util::future::Abortable::new(work, registration)
            .await
            .map_err(|_| "Search canceled".to_string())
            .and_then(|v| v);
        let mut active = self
            .interactive_search
            .lock()
            .map_err(|_| "Search unavailable")?;
        if active.as_ref().is_some_and(|(current, _)| current == id) {
            active.take();
        }
        result
    }
}
