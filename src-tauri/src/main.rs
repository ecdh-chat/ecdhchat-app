// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    scrub_webview_environment();
    ecdh_chat_lib::run();
}

// WebView2 reads WEBVIEW2_* environment variables at startup, and they override the app's own
// choices: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS can turn on remote debugging, and
// WEBVIEW2_BROWSER_EXECUTABLE_FOLDER can swap in another browser. Any program running as this user
// can set them without admin rights, so the app clears them before the webview starts.
#[cfg(windows)]
fn scrub_webview_environment() {
    let names: Vec<_> = std::env::vars_os()
        .map(|(name, _)| name)
        .filter(|name| name.to_string_lossy().to_ascii_uppercase().starts_with("WEBVIEW2_"))
        .collect();
    for name in names {
        // Safe here: nothing else is running yet, so no other thread reads the environment.
        unsafe { std::env::remove_var(name) };
    }
}

#[cfg(not(windows))]
fn scrub_webview_environment() {}
