// Keep native keyboard equivalents even though MoviBox supplies its own window UI.
#[cfg(target_os = "macos")]
pub fn hide_app_menus() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSMenu};

    fn preserve_shortcuts(menu: &NSMenu) {
        for item in menu.itemArray() {
            item.setAllowsKeyEquivalentWhenHidden(true);
            if let Some(submenu) = item.submenu() {
                preserve_shortcuts(&submenu);
            }
        }
    }

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let Some(menu) = NSApplication::sharedApplication(main_thread).mainMenu() else {
        return;
    };
    preserve_shortcuts(&menu);
    // macOS owns the Apple/application menu; hide the remaining default headings.
    for item in menu.itemArray().iter().skip(1) {
        item.setHidden(true);
    }
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IconTheme {
    Light,
    Dark,
}

#[cfg(target_os = "macos")]
async fn on_main_thread<T: Send + 'static>(
    app: &tauri::AppHandle,
    task: impl FnOnce(objc2::MainThreadMarker) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = objc2::MainThreadMarker::new()
            .ok_or_else(|| "Native action requires the main thread".to_string())
            .and_then(task);
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn moviebox_set_icon_theme(
    window: tauri::WebviewWindow,
    theme: IconTheme,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can change branding".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::AllocAnyThread;
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;
        use tauri::Manager;

        on_main_thread(window.app_handle(), move |main_thread| {
            let png = match theme {
                IconTheme::Light => include_bytes!("../icons/dock-light.png").as_slice(),
                IconTheme::Dark => include_bytes!("../icons/dock-dark.png").as_slice(),
            };
            let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))
                .ok_or_else(|| "Could not load the Dock icon".to_string())?;
            // A decoded, retained NSImage is passed on AppKit's main thread.
            unsafe {
                NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&image));
            }
            Ok(())
        })
        .await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = theme;
        Ok(())
    }
}
