fn main() {
    // Listing the app's commands here turns each one into a permission
    // (`allow-start-scan`, ...) that must be granted in `capabilities/`.
    // Without this list every command would be callable from every page,
    // including instagram.com.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            // Called by the app's own window.
            "start_scan",
            "cancel_scan",
            "get_status",
            "latest_report",
            "save_csv",
            // Called by the script injected into instagram.com.
            "scan_next",
            "scan_progress",
            "scan_report",
            "scan_error",
        ]),
    ))
    .expect("failed to run tauri-build");
}
