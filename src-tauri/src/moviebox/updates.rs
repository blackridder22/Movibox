//! Only the release build chooses the update server and trusted public key.
use super::{now, Runtime};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub(crate) struct Updates {
    installing: AtomicBool,
    operation: tokio::sync::Mutex<()>,
    pending: Mutex<Option<Update>>,
    status: Mutex<Value>,
}

fn configuration(endpoint: &str, key: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(endpoint).map_err(|_| "This build has no update feed configured")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || key.trim().is_empty()
    {
        return Err("Updates require an HTTPS feed and a trusted signing public key".into());
    }
    Ok(url)
}

fn release_config() -> Result<(url::Url, &'static str), String> {
    let key = option_env!("MOVIBOX_UPDATE_PUBLIC_KEY").unwrap_or("");
    Ok((
        configuration(option_env!("MOVIBOX_UPDATE_ENDPOINT").unwrap_or(""), key)?,
        key,
    ))
}

fn ensure_idle(runtime: &Runtime, app: &AppHandle) -> Result<(), String> {
    runtime.ensure_update_idle()?;
    let acquisition = app.state::<crate::acquisition::AcquisitionState>();
    for job in acquisition.list_jobs()? {
        if acquisition.task_running(&job.id) {
            return Err("Wait for transfers to stop before installing".into());
        }
    }
    Ok(())
}

struct InstallationGuard<'a>(&'a AtomicBool);
impl Drop for InstallationGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Updates {
    pub(super) fn installing(&self) -> bool {
        self.installing.load(Ordering::SeqCst)
    }
    pub(super) fn snapshot(&self) -> Value {
        #[cfg(target_os = "linux")]
        if std::env::var_os("APPIMAGE").is_none() {
            return json!({"state":"unsupported", "message":"This Linux package updates through its installer or package manager. In-app updates require AppImage."});
        }
        let value = self.status.lock().map(|v| v.clone()).unwrap_or_default();
        if !value.is_null() {
            return value;
        }
        json!({"state":if release_config().is_ok(){"idle"}else{"unconfigured"},"currentVersion":env!("CARGO_PKG_VERSION"),"message":if release_config().is_ok(){"Ready to check for updates"}else{"This local build has no signed update feed configured."}})
    }
    fn publish(&self, app: &AppHandle, value: Value) {
        if let Ok(mut status) = self.status.lock() {
            *status = value.clone();
        }
        let _ = app.emit("movibox://update", value);
    }
    pub(super) async fn check(&self, app: &AppHandle) -> Result<Value, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "An update operation is already running")?;
        let (endpoint, key) = release_config()?;
        self.publish(
            app,
            json!({"state":"checking","message":"Checking for updates…"}),
        );
        let result = async {
            let updater = app.updater_builder().endpoints(vec![endpoint]).map_err(|_| "Invalid update endpoint")?.pubkey(key).timeout(Duration::from_secs(30)).configure_client(|client| client.https_only(true)).build().map_err(|_| "Could not initialize the updater")?;
            let mut update = updater.check().await.map_err(|_| "Could not check the update feed. Check your connection and try again.")?;
            if let Some(update) = &mut update {
                configuration(update.download_url.as_str(), key)?;
                update.timeout = Some(Duration::from_secs(600));
            }
            let status = if let Some(update) = &update {
                json!({"state":"available","version":update.version,"currentVersion":env!("CARGO_PKG_VERSION"),"notes":update.body,"checkedAt":now(),"message":"An update is available. Installation requires your confirmation."})
            } else { json!({"state":"current","currentVersion":env!("CARGO_PKG_VERSION"),"checkedAt":now(),"message":"Movie Box is up to date."}) };
            *self.pending.lock().map_err(|_| "Updater unavailable")? = update;
            Ok::<_, String>(status)
        }.await;
        match &result {
            Ok(status) => self.publish(app, status.clone()),
            Err(error) => self.publish(app, json!({"state":"error","message":error})),
        }
        result
    }
    pub(super) async fn install(
        &self,
        app: &AppHandle,
        runtime: &Runtime,
        version: &str,
    ) -> Result<Value, String> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "An update operation is already running")?;
        ensure_idle(runtime, app)?;
        let update = self
            .pending
            .lock()
            .map_err(|_| "Updater unavailable")?
            .clone()
            .ok_or("Check for updates before installing")?;
        if update.version != version {
            return Err("The available version changed. Review the update again.".into());
        }
        self.installing.store(true, Ordering::SeqCst);
        let _installing = InstallationGuard(&self.installing);
        let result = async {
            let mut received = 0u64;
            let mut last = std::time::Instant::now();
            self.publish(app, json!({"state":"downloading","version":version,"received":0,"message":"Downloading and verifying the signed update…"}));
            let bytes = update.download(|length, total| {
                received = received.saturating_add(length as u64);
                if last.elapsed() >= Duration::from_millis(250) {
                    self.publish(app, json!({"state":"downloading","version":version,"received":received,"total":total,"message":"Downloading and verifying the signed update…"}));
                    last = std::time::Instant::now();
                }
            }, || {}).await.map_err(|_| "Update download or signature verification failed. Nothing was installed.")?;
            ensure_idle(runtime, app)?;
            let recovery = app.path().app_data_dir().map_err(|_| "Recovery folder unavailable")?.join("recovery");
            std::fs::create_dir_all(&recovery).map_err(|_| "Could not create pre-update recovery folder")?;
            runtime.export_backup(&recovery.join(format!("before-update-{}.movibox-backup",uuid::Uuid::new_v4())))?;
            self.publish(app, json!({"state":"installing","version":version,"message":"Installing verified update; Movie Box will restart…"}));
            update.install(bytes).map_err(|_| "Could not install the update. Your recovery backup is retained.")?;
            app.restart();
            #[allow(unreachable_code)]
            Ok::<Value,String>(Value::Null)
        }.await;
        if let Err(error) = &result {
            self.publish(
                app,
                json!({"state":"error","version":version,"message":error}),
            );
        }
        result
    }
}

pub(super) fn start(app: AppHandle) {
    if release_config().is_err() {
        return;
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if app
                .state::<Runtime>()
                .prefs()
                .ok()
                .is_some_and(|p| p["autoCheckUpdates"] != false)
            {
                let _ = app.state::<Arc<Updates>>().check(&app).await;
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_feed_cannot_downgrade_transport_or_omit_trust() {
        assert!(configuration("http://updates.example/latest.json", "public").is_err());
        assert!(
            configuration("https://user:secret@updates.example/latest.json", "public").is_err()
        );
        assert!(configuration("https://updates.example/latest.json", "").is_err());
        assert!(configuration("https://updates.example/latest.json", "public").is_ok());
    }
    #[tokio::test]
    async fn updater_accepts_signed_bytes_and_rejects_tampering_before_install() {
        use axum::{routing::get, Json};
        use std::sync::atomic::{AtomicBool, Ordering};
        let tamper = Arc::new(AtomicBool::new(false));
        let changed = tamper.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let download = format!("{root}/artifact");
        let bytes = include_bytes!("../../../tests/fixtures/updater/sample.bin");
        let router=axum::Router::new().route("/latest.json",get(move || { let download=download.clone(); async move {
            Json(json!({"version":"99.0.0", "url":download,"signature":include_str!("../../../tests/fixtures/updater/sample.bin.sig").trim()}))
        }})).route("/artifact",get(move || {let changed=changed.clone();async move {if changed.load(Ordering::SeqCst){b"tampered artifact".to_vec()}else{bytes.to_vec()}}}));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        // The HTTP exception is confined to this loopback fixture, never a release configuration.
        context.config_mut().plugins.0.insert(
            "updater".into(),
            json!({"pubkey":"", "dangerousInsecureTransportProtocol":true}),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let updater = app
            .updater_builder()
            .pubkey(include_str!("../../../tests/fixtures/updater/public-key.txt").trim())
            .endpoints(vec![
                url::Url::parse(&format!("{root}/latest.json")).unwrap()
            ])
            .unwrap()
            .build()
            .unwrap();
        let update = updater.check().await.unwrap().unwrap();
        assert_eq!(update.download(|_, _| {}, || {}).await.unwrap(), bytes);
        tamper.store(true, Ordering::SeqCst);
        assert!(update.download(|_, _| {}, || {}).await.is_err());
        server.abort();
    }
}
