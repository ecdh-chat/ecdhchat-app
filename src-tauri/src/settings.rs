// App-wide settings, kept by the Rust side in settings.json in the app's config folder. The page
// reads and changes them only through the get_settings and set_settings commands.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::WINDOW;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    /// Closing the window keeps the app running in the tray.
    pub close_to_tray: bool,
    /// Hides the window from screenshots, screen recording and screen sharing.
    pub block_screenshots: bool,
    /// Blurs the chat while the window isn't focused.
    pub privacy_blur: bool,
    /// Starts with Windows, hidden in the tray.
    pub launch_at_startup: bool,
    /// The first-run welcome screen has been seen.
    pub welcomed: bool,
    /// The "still running in the tray" notice has been shown once.
    pub tray_notice_shown: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            block_screenshots: true,
            privacy_blur: false,
            launch_at_startup: false,
            welcomed: false,
            tray_notice_shown: false,
        }
    }
}

pub struct SettingsState {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsState {
    pub fn load(app: &AppHandle) -> Self {
        let path = app
            .path()
            .app_config_dir()
            .map(|dir| dir.join("settings.json"))
            .unwrap_or_else(|_| PathBuf::from("settings.json"));
        let current = Mutex::new(read(&path));
        Self { path, current }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
        let mut current = self.current.lock().unwrap();
        let mut next = current.clone();
        change(&mut next);
        write(&self.path, &next)?;
        *current = next.clone();
        Ok(next)
    }
}

// A missing or damaged file means defaults, never a crash.
fn read(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

// Written to a temporary file first, so a crash mid-write can't leave a half-written file.
fn write(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&temporary, text).map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

// Makes the system match the settings: screenshot blocking on the window, and the startup entry.
pub fn apply(app: &AppHandle, settings: &Settings) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.set_content_protected(settings.block_screenshots);
    }
    let autostart = app.autolaunch();
    if autostart.is_enabled().unwrap_or(false) != settings.launch_at_startup {
        let _ = if settings.launch_at_startup { autostart.enable() } else { autostart.disable() };
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Settings {
    state.get()
}

// The page can change what the person controls; the app's own bookkeeping stays as it is.
#[tauri::command]
pub fn set_settings(app: AppHandle, state: State<'_, SettingsState>, settings: Settings) -> Result<Settings, String> {
    let saved = state.update(|current| {
        *current = Settings { tray_notice_shown: current.tray_notice_shown, ..settings };
    })?;
    apply(&app, &saved);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ecdh-settings-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("settings.json")
    }

    #[test]
    fn missing_or_damaged_files_give_defaults() {
        let path = scratch("damaged");
        assert_eq!(read(&path), Settings::default());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(read(&path), Settings::default());
        fs::write(&path, r#"{"closeToTray": "yes"}"#).unwrap();
        assert_eq!(read(&path), Settings::default());
    }

    #[test]
    fn saves_and_loads_back() {
        let path = scratch("roundtrip");
        let settings = Settings { privacy_blur: true, close_to_tray: false, ..Settings::default() };
        write(&path, &settings).unwrap();
        assert_eq!(read(&path), settings);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn older_files_keep_defaults_for_new_fields() {
        let path = scratch("partial");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"privacyBlur": true}"#).unwrap();
        assert_eq!(read(&path), Settings { privacy_blur: true, ..Settings::default() });
    }

    #[test]
    fn unknown_fields_from_the_page_are_refused() {
        let result: Result<Settings, _> = serde_json::from_str(r#"{"closeToTray": true, "server": "https://evil.example"}"#);
        assert!(result.is_err());
    }
}
