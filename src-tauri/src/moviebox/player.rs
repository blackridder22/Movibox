use std::path::Path;

pub(super) async fn open_iina(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("The local video file is missing".into());
    }
    #[cfg(target_os = "macos")]
    {
        let output = tokio::process::Command::new("/usr/bin/open")
            .args(["-b", "com.colliderli.iina"])
            .arg(path)
            .output()
            .await
            .map_err(|_| "Could not open IINA")?;
        if !output.status.success() {
            return Err("IINA could not open this file. Install IINA from iina.io or use Open file for your default player.".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("IINA is available on macOS. Use Open file for your default player.".into())
}
