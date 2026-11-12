fn main() {
    // Lists the app's own commands so capabilities/desktop.json has to allow each one by name, and
    // the same for the Android app's plugin (PhonePlugin.kt) and capabilities/mobile.json.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(
                tauri_build::AppManifest::new().commands(&["get_settings", "set_settings", "quit_app", "set_unread", "window_action", "get_update", "install_update", "copy_text", "rtc_create", "rtc_create_channel", "rtc_set_local", "rtc_set_remote", "rtc_add_candidate", "rtc_send", "rtc_recv", "rtc_close"]),
            )
            .plugin("phone", tauri_build::InlinedPlugin::new().commands(&["save_file", "save_chunk", "save_end"])),
    )
    .expect("failed to run tauri-build");
}
