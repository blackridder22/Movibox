fn main() {
    let attributes = tauri_build::Attributes::new();
    #[cfg(all(windows, target_env = "msvc"))]
    let attributes = {
        let manifest = std::path::PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory is available"),
        )
        .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        // Tauri's default resource links only the app binary; tests also need Common Controls v6.
        // https://github.com/tauri-apps/tauri/issues/13419
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    };
    tauri_build::try_build(attributes).expect("Tauri build configuration failed");
}
