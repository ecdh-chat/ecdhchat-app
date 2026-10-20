fn main() {
    // Lists the app's own commands so capabilities/default.json has to allow each one by name.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["get_settings", "set_settings", "quit_app", "set_unread", "window_action", "get_update", "install_update", "rtc_create", "rtc_create_channel", "rtc_set_local", "rtc_set_remote", "rtc_add_candidate", "rtc_send", "rtc_recv", "rtc_close"]),
    ))
    .expect("failed to run tauri-build");
}
