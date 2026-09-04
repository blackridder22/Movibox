mod acquisition;
mod browser;
mod cf_relay;
mod crash_report;
mod download;
mod http_fetch;
mod local_lib;
mod moviebox;
mod proc_mem;
mod settings_store;
mod streams;
mod stremio_auth;
mod torrent_engine;
mod tray;
mod webview_helpers;
mod window_chrome;

pub static CLOSE_FLUSH_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn shutdown_services(app: &tauri::AppHandle) {
    torrent_engine::stop();
    crash_report::mark_clean_exit();
    let _ = app;
}

#[cfg(windows)]
pub(crate) fn force_show_foreground(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE, SW_SHOW,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        } else {
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
        let _ = SetForegroundWindow(hwnd);
    }
}

#[tauri::command]
fn movibox_flush_done() {
    CLOSE_FLUSH_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
fn movibox_startup_ready(window: tauri::WebviewWindow) {
    if window.label() == "main" {
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn close_aux_windows(app: tauri::AppHandle) {
    use tauri::Manager;
    for (label, window) in app.webview_windows() {
        if label != "main" {
            let _ = window.close();
        }
    }
}

#[tauri::command]
async fn deeplink_set_stremio(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    if enabled {
        app.deep_link()
            .register("stremio")
            .map_err(|error| format!("register stremio: {error}"))?;
    } else {
        let _ = app.deep_link().unregister("stremio");
    }
    Ok(())
}

#[tauri::command]
async fn deeplink_is_stremio_registered(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link()
        .is_registered("stremio")
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_text_file(path: String, contents: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| format!("create folder: {error}"))?;
        }
    }
    std::fs::write(target, contents.as_bytes()).map_err(|error| format!("write file: {error}"))
}

fn ensure_window_on_screen(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (position, size) = match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => (position, size),
        _ => return,
    };
    let monitors = match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        _ => return,
    };
    let width = size.width as i32;
    let height = size.height as i32;
    if monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        position.x < origin.x + size.width as i32
            && position.x + width > origin.x
            && position.y < origin.y + size.height as i32
            && position.y + height > origin.y
    }) {
        return;
    }
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next());
    let Some(monitor) = monitor else {
        return;
    };
    let origin = monitor.position();
    let size = monitor.size();
    let x = origin.x + (size.width as i32 - width).max(0) / 2;
    let y = origin.y + (size.height as i32 - height).max(0) / 2;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let app_builder = tauri::Builder::default();
    #[cfg(not(all(target_os = "linux", debug_assertions)))]
    let app_builder = app_builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        use tauri::{Emitter, Manager};
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            #[cfg(windows)]
            force_show_foreground(&window);
        }
        if let Some(url) = args
            .iter()
            .find(|value| value.starts_with("movibox://") || value.starts_with("stremio://"))
        {
            let _ = app.emit("movibox:stremio-deeplink", url.clone());
        }
    }));

    app_builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(std::sync::Arc::new(moviebox::updates::Updates::default()))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(download::DownloadState::new())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let _ = webview.window().show();
            }
        })
        .setup(|app| {
            use tauri::Manager;
            #[cfg(target_os = "macos")]
            window_chrome::hide_app_menus();
            let acquisition_state =
                acquisition::AcquisitionState::new(app.handle()).map_err(std::io::Error::other)?;
            app.manage(acquisition_state.clone());
            let runtime = moviebox::Runtime::new(app.handle(), &acquisition_state)
                .map_err(std::io::Error::other)?;
            app.manage(runtime.clone());
            acquisition::resume_pending(acquisition_state.clone(), app.handle().clone());
            moviebox::start(runtime, app.handle().clone());
            if let Err(error) = crash_report::initialize(app.handle()) {
                eprintln!("[movibox::crash-report] initialization failed: {error}");
            }
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if std::env::var_os("FLATPAK_ID").is_none() {
                    let _ = app.deep_link().register_all();
                }
            }
            webview_helpers::install_process_failure_watchdog(app.handle(), "main");
            ensure_window_on_screen(app.handle());
            torrent_engine::ensure_started_on_setup(app.handle());
            #[cfg(desktop)]
            if tray::STATUS_MENU_ENABLED {
                if let Err(error) = tray::build(app.handle()) {
                    eprintln!("[movibox::tray] build failed: {error:?}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::Manager;
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } if tray::close_to_tray() => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => shutdown_services(window.app_handle()),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            window_chrome::moviebox_set_icon_theme,
            crash_report::take_startup_crash_report,
            movibox_flush_done,
            movibox_startup_ready,
            close_aux_windows,
            save_text_file,
            settings_store::settings_read,
            settings_store::settings_write,
            proc_mem::harbor_process_memory,
            download::download_start,
            download::download_cancel,
            moviebox::commands::moviebox_request,
            acquisition::acquisition_list,
            acquisition::acquisition_enqueue,
            acquisition::acquisition_cancel,
            acquisition::acquisition_pause,
            acquisition::acquisition_resume,
            acquisition::acquisition_pause_all,
            acquisition::acquisition_resume_all,
            acquisition::acquisition_retry,
            acquisition::acquisition_refresh_source,
            acquisition::acquisition_remove,
            acquisition::acquisition_reveal,
            acquisition::acquisition_open,
            acquisition::automation_list,
            acquisition::automation_due,
            acquisition::automation_upsert,
            acquisition::automation_mark_checked,
            acquisition::automation_remove,
            cf_relay::cf_list_accounts,
            cf_relay::cf_deploy_relay,
            cf_relay::cf_delete_relay,
            cf_relay::cf_relay_status,
            browser::browser_open,
            browser::browser_close,
            http_fetch::harbor_fetch,
            http_fetch::harbor_fetch_cancel,
            torrent_engine::torrent_engine_status,
            torrent_engine::torrent_engine_add,
            torrent_engine::torrent_engine_select,
            torrent_engine::torrent_engine_stats,
            torrent_engine::torrent_engine_remove,
            torrent_engine::torrent_engine_selftest,
            torrent_engine::torrent_engine_restart,
            torrent_engine::torrent_engine_hard_reset,
            torrent_engine::torrent_engine_set_options,
            streams::streams_run_pipeline,
            streams::streams_parse,
            streams::streams_core_version,
            local_lib::harbor_scan_folder,
            tray::tray_set_prefs,
            tray::tray_set_custom_themes,
            stremio_auth::stremio_auth_start,
            deeplink_set_stremio,
            deeplink_is_stremio_registered,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MoviBox")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                tray::show_main(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
