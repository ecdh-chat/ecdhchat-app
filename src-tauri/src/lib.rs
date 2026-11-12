mod clipboard;
#[cfg(target_os = "linux")]
mod rtc;
// The desktop app's settings, tray and self-updates. The phone app has none of them.
#[cfg(desktop)]
mod settings;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod updates;

use std::sync::Mutex;

#[cfg(desktop)]
use settings::SettingsState;
#[cfg(desktop)]
use tauri::WebviewWindow;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
#[cfg(desktop)]
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
#[cfg(desktop)]
use tauri_plugin_window_state::StateFlags;

// The signaling server the app talks to. If this changes, connect-src in tauri.conf.json has to
// change with it.
const SERVER: &str = if cfg!(debug_assertions) { "http://localhost:3000" } else { "https://ecdh.chat" };
const WINDOW: &str = "main";
// Windows starts the app with this when "Launch at startup" is on; it then stays in the tray.
#[cfg(desktop)]
const AUTOSTART_ARG: &str = "--autostart";
#[cfg(desktop)]
const STARTUP_ENTRY: &str = "ecdh.chat";

// Invite links waiting for the page. A link can come before the page has loaded or while it
// reloads: the one that starts the app, and on a phone that one arrives as an open-url event,
// usually before the page exists. It's held here and handed over once the page has loaded.
struct InviteState(Mutex<Invites>);

struct Invites {
    page_ready: bool,
    pending: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Must come first: a second launch, such as clicking an invite link while the app is open,
    // hands its link to this one and quits. A phone only ever runs one copy.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)));
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        // Links are opened by on_new_window below, so the page needs no permission to open them.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(phone_plugin());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The startup entry's name; the uninstaller removes it by this name (installer/hooks.nsh).
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(STARTUP_ENTRY)
                .args([AUTOSTART_ARG])
                .build(),
        )
        // Remembers where the window was and how big. Whether it's shown is decided at start.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        );
    builder
        .invoke_handler(tauri::generate_handler![
            #[cfg(desktop)]
            settings::get_settings,
            #[cfg(desktop)]
            settings::set_settings,
            #[cfg(desktop)]
            tray::quit_app,
            #[cfg(desktop)]
            tray::set_unread,
            #[cfg(desktop)]
            updates::get_update,
            #[cfg(desktop)]
            updates::install_update,
            clipboard::copy_text,
            #[cfg(desktop)]
            window_action,
            #[cfg(target_os = "linux")]
            rtc::rtc_create,
            #[cfg(target_os = "linux")]
            rtc::rtc_create_channel,
            #[cfg(target_os = "linux")]
            rtc::rtc_set_local,
            #[cfg(target_os = "linux")]
            rtc::rtc_set_remote,
            #[cfg(target_os = "linux")]
            rtc::rtc_add_candidate,
            #[cfg(target_os = "linux")]
            rtc::rtc_send,
            #[cfg(target_os = "linux")]
            rtc::rtc_recv,
            #[cfg(target_os = "linux")]
            rtc::rtc_close,
        ])
        .on_window_event(window_event)
        .setup(|app| {
            // Installers register ecdhchat:// themselves; a dev build has to do it on start.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            app.deep_link().register_all()?;
            // So must a release Linux build: the bundled .desktop file registers the scheme but
            // can't carry the "%u" that passes the link to a running app, and an AppImage isn't
            // installed at all. register_all writes a per-user handler with "%u". Without the
            // desktop tools this needs, links just don't open the app.
            #[cfg(all(not(debug_assertions), target_os = "linux"))]
            let _ = app.deep_link().register_all();

            let pending = app.deep_link().get_current()?.and_then(|urls| invite(&urls));
            app.manage(InviteState(Mutex::new(Invites { page_ready: false, pending })));

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(fragment) = invite(&event.urls()) {
                    deliver_invite(&handle, fragment);
                }
            });

            #[cfg(target_os = "linux")]
            app.manage(rtc::RtcState::default());

            #[cfg(desktop)]
            {
                let state = SettingsState::load(app.handle());
                let current = state.get();
                app.manage(state);
                let hidden = std::env::args().any(|arg| arg == AUTOSTART_ARG);
                open_window(app.handle(), &current, hidden)?;
                tray::create(app.handle())?;
                settings::apply(app.handle(), &current);
                updates::start(app.handle());
            }
            #[cfg(mobile)]
            window(app.handle()).build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ecdh.chat");
}

// The Android app's own plugin, PhonePlugin.kt beside MainActivity.kt: what the phone's webview
// can't do for the page itself (saving a received file). Its commands are Kotlin's; the page may
// only use the ones capabilities/mobile.json allows by name.
#[cfg(target_os = "android")]
fn phone_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("phone")
        .setup(|_app, api| {
            api.register_android_plugin("chat.ecdh.app", "PhonePlugin")?;
            Ok(())
        })
        .build()
}

fn window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(focused) => eval_in(app, &format!("window.ecdhWindowFocused?.({focused})")),
        #[cfg(desktop)]
        WindowEvent::Resized(_) => {
            let maximized = window.is_maximized().unwrap_or(false);
            eval_in(app, &format!("document.documentElement.classList.toggle('app-maximized', {maximized})"));
            // A window minimized without ever having focus sends no focus event, but it's still
            // in the background.
            if window.is_minimized().unwrap_or(false) {
                eval_in(app, "window.ecdhWindowFocused?.(false)");
            }
        }
        #[cfg(desktop)]
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let state = app.state::<SettingsState>();
            if !state.get().close_to_tray {
                tray::request_quit(app);
                return;
            }
            let _ = window.hide();
            eval_in(app, "window.ecdhWindowFocused?.(false)");
            if !state.get().tray_notice_shown && state.update(|s| s.tray_notice_shown = true).is_ok() {
                let _ = app
                    .notification()
                    .builder()
                    .title("ecdh.chat is still running")
                    .body("It's in the tray, so your chat stays open. Quit from the tray icon's menu.")
                    .show();
            }
        }
        _ => {}
    }
}

// The title bar's own buttons. Closing goes through the same path as Alt+F4.
#[cfg(desktop)]
#[tauri::command]
fn window_action(window: WebviewWindow, action: &str) -> Result<(), String> {
    match action {
        "minimize" => window.minimize(),
        "toggle-maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => return Err(format!("unknown window action {action:?}")),
    }
    .map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn open_window(app: &AppHandle, settings: &settings::Settings, hidden: bool) -> tauri::Result<()> {
    window(app)
        .title("ecdh.chat")
        .inner_size(820.0, 700.0)
        .min_inner_size(520.0, 520.0)
        // The page draws its own title bar. The shadow keeps the resize edges and depth.
        .decorations(false)
        .shadow(true)
        .visible(!hidden)
        .content_protected(settings.block_screenshots)
        // Lets the page take dropped files itself, like it does in a browser.
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

// The window with the app's page, as both the desktop and the phone app open it. On a phone it
// fills the screen, and the app's activity keeps it out of screenshots (MainActivity.kt).
fn window(app: &AppHandle) -> WebviewWindowBuilder<'_, tauri::Wry, AppHandle> {
    let links = app.clone();
    let popups = app.clone();
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .initialization_script(format!(
            "window.__ECDH_SERVER__ = {};window.__ECDH_OS__ = {};window.__ECDH_VERSION__ = {};",
            js_string(SERVER),
            js_string(std::env::consts::OS),
            js_string(&app.package_info().version.to_string())
        ))
        // The window only ever shows the app's own page. Links from messages open in the browser.
        .on_navigation(move |url| {
            if is_app_page(url) {
                return true;
            }
            open_external(&links, url);
            false
        })
        .on_new_window(move |url, _features| {
            open_external(&popups, &url);
            NewWindowResponse::Deny
        })
        .on_page_load(|window, payload| {
            let state = window.state::<InviteState>();
            let pending = {
                let mut invites = state.0.lock().unwrap();
                invites.page_ready = payload.event() == PageLoadEvent::Finished;
                if !invites.page_ready {
                    return;
                }
                invites.pending.take()
            };
            if let Some(fragment) = pending {
                open_invite(window.app_handle(), &fragment);
            }
        })
}

fn is_app_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "blob" | "about" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

fn open_external(app: &AppHandle, url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    // On a phone the opener does its work on the app's main thread and waits for it. This is
    // called from that thread (the webview asking whether it may navigate), so waiting here
    // would wait for itself and freeze the app. It's handed to another thread instead.
    #[cfg(mobile)]
    {
        let app = app.clone();
        let url = url.to_string();
        std::thread::spawn(move || {
            let _ = app.opener().open_url(url, None::<&str>);
        });
    }
    #[cfg(desktop)]
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

// Returns "#room.secret" from an ecdhchat://join#room.secret link, or None for anything else.
fn invite(urls: &[Url]) -> Option<String> {
    urls.iter().find_map(|url| {
        let fragment = url.fragment().filter(|_| url.scheme() == "ecdhchat")?;
        let (room, secret) = fragment.split_once('.')?;
        let room_ok = room.len() == 36 && room.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-');
        let secret_ok = secret.len() == 22 && secret.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        (room_ok && secret_ok).then(|| format!("#{fragment}"))
    })
}

// Hands an invite to the page now, or holds it until the page has loaded (see InviteState).
fn deliver_invite(app: &AppHandle, fragment: String) {
    let state = app.state::<InviteState>();
    {
        let mut invites = state.0.lock().unwrap();
        if !invites.page_ready {
            invites.pending = Some(fragment);
            return;
        }
    }
    open_invite(app, &fragment);
}

fn open_invite(app: &AppHandle, fragment: &str) {
    // On a phone the app is already in front when a link opens it.
    #[cfg(desktop)]
    show(app);
    eval_in(app, &format!("window.ecdhOpenInvite?.({})", js_string(fragment)));
}

pub(crate) fn eval_in(app: &AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.eval(script);
    }
}

#[cfg(desktop)]
pub(crate) fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).expect("a string always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(link: &str) -> Option<String> {
        invite(&[Url::parse(link).unwrap()])
    }

    #[test]
    fn reads_invites_from_ecdhchat_links_only() {
        let fragment = "0b7f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e.AAECAwQFBgcICQoLDA0ODw";
        assert_eq!(parse(&format!("ecdhchat://join#{fragment}")), Some(format!("#{fragment}")));
        assert_eq!(parse(&format!("https://ecdh.chat/#{fragment}")), None);
        assert_eq!(parse("ecdhchat://join"), None);
        assert_eq!(parse("ecdhchat://join#0b7f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e"), None);
        assert_eq!(parse("ecdhchat://join#0b7f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e.AAEC\");alert(1)//"), None);
    }

    #[test]
    fn only_the_apps_own_page_stays_in_the_window() {
        assert!(is_app_page(&Url::parse("http://tauri.localhost/index.html").unwrap()));
        assert!(is_app_page(&Url::parse("tauri://localhost/").unwrap()));
        assert!(!is_app_page(&Url::parse("https://example.com/").unwrap()));
        assert!(!is_app_page(&Url::parse("http://tauri.localhost.evil.com/").unwrap()));
        assert!(!is_app_page(&Url::parse("file:///C:/Windows/").unwrap()));
    }
}
