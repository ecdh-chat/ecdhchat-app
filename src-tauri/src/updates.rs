// Checks ecdh.chat for a newer version of the app. An update is only installed when the person
// agrees, and only if it's signed with the release key; the public half is in tauri.conf.json, so
// someone who took over the server still couldn't push their own build.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::eval_in;

const FIRST_CHECK_AFTER: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: String,
}

impl From<&Update> for UpdateInfo {
    fn from(update: &Update) -> Self {
        Self { version: update.version.clone(), notes: update.body.clone().unwrap_or_default() }
    }
}

pub fn start(app: &AppHandle) {
    app.manage(PendingUpdate::default());
    // Development builds would only ever be offered the public release, so they don't check.
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK_AFTER);
        loop {
            tauri::async_runtime::block_on(check(&app));
            thread::sleep(CHECK_EVERY);
        }
    });
}

// A failed check (offline, server down) is simply tried again at the next interval.
async fn check(app: &AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return };
    let info = UpdateInfo::from(&update);
    *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
    let json = serde_json::to_string(&info).expect("update info always serializes");
    eval_in(app, &format!("window.ecdhUpdateAvailable?.({json})"));
}

// Lets a freshly loaded page show an update found earlier.
#[tauri::command]
pub fn get_update(pending: State<'_, PendingUpdate>) -> Option<UpdateInfo> {
    pending.0.lock().unwrap().as_ref().map(UpdateInfo::from)
}

// Downloads the update, checks its signature and runs the installer, which replaces and restarts
// the app.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().clone().ok_or("There's no update to install")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
