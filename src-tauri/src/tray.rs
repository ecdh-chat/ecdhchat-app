// The tray icon and its menu, plus unread alerts on the tray and taskbar icons.

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, UserAttentionType};

use crate::{WINDOW, eval_in, show};

const TRAY: &str = "main";
const DOT: [u8; 4] = [239, 68, 68, 255];

pub struct Unread {
    count: Mutex<u32>,
    plain: Image<'static>,
    marked: Image<'static>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let plain = app.default_window_icon().cloned().expect("the bundle has an icon").to_owned();
    let marked = with_dot(&plain);
    app.manage(Unread { count: Mutex::new(0), plain: plain.clone(), marked });

    let show_item = MenuItem::with_id(app, "show", "Show ecdh.chat", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &settings_item, &PredefinedMenuItem::separator(app)?, &quit_item])?;

    TrayIconBuilder::with_id(TRAY)
        .icon(plain)
        .tooltip("ecdh.chat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "settings" => {
                show(app);
                eval_in(app, "window.ecdhOpenSettings?.()");
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray: &TrayIcon, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// Asks the page first, so it can check with the person before ending a chat that's open. If the
// page can't answer, the app quits anyway.
pub fn request_quit(app: &AppHandle) {
    show(app);
    eval_in(app, "window.ecdhRequestQuit ? window.ecdhRequestQuit() : window.__TAURI_INTERNALS__.invoke('quit_app')");
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// The page reports how many messages arrived while the window was in the background.
#[tauri::command]
pub fn set_unread(app: AppHandle, unread: State<'_, Unread>, count: u32) {
    let mut current = unread.count.lock().unwrap();
    let grew = count > *current;
    *current = count;
    let Some(window) = app.get_webview_window(WINDOW) else { return };

    if let Some(tray) = app.tray_by_id(TRAY) {
        let _ = tray.set_icon(Some(if count > 0 { unread.marked.clone() } else { unread.plain.clone() }));
        let _ = tray.set_tooltip(Some(match count {
            0 => "ecdh.chat".to_string(),
            1 => "ecdh.chat: 1 new message".to_string(),
            n => format!("ecdh.chat: {n} new messages"),
        }));
    }
    // Only Windows badges the taskbar button; elsewhere the tray dot and the attention request do.
    #[cfg(windows)]
    let _ = window.set_overlay_icon(if count > 0 { Some(dot_badge()) } else { None });
    if grew && !window.is_focused().unwrap_or(false) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

// The tray icon with a red dot in its top-right corner.
fn with_dot(icon: &Image<'_>) -> Image<'static> {
    let (width, height) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    let radius = width.min(height) as f32 * 0.22;
    let (cx, cy) = (width as f32 - radius - 0.5, radius + 0.5);
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if distance <= radius + 0.5 {
                let i = ((y * width + x) * 4) as usize;
                let cover = (radius + 0.5 - distance).clamp(0.0, 1.0);
                for c in 0..4 {
                    rgba[i + c] = (DOT[c] as f32 * cover + rgba[i + c] as f32 * (1.0 - cover)) as u8;
                }
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

// A small red dot for the taskbar button.
#[cfg(windows)]
fn dot_badge() -> Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = vec![0; (SIZE * SIZE * 4) as usize];
    let center = SIZE as f32 / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let distance = ((x as f32 + 0.5 - center).powi(2) + (y as f32 + 0.5 - center).powi(2)).sqrt();
            let cover = (center - 0.5 - distance).clamp(0.0, 1.0);
            let i = ((y * SIZE + x) * 4) as usize;
            rgba[i..i + 3].copy_from_slice(&DOT[..3]);
            rgba[i + 3] = (255.0 * cover) as u8;
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dot_goes_in_the_top_right_corner_only() {
        let icon = Image::new_owned(vec![0; 32 * 32 * 4], 32, 32);
        let marked = with_dot(&icon);
        let pixel = |x: u32, y: u32| marked.rgba()[((y * 32 + x) * 4) as usize..][..4].to_vec();
        assert_eq!(pixel(25, 6), DOT.to_vec());
        assert_eq!(pixel(2, 30), vec![0, 0, 0, 0]);
        assert_eq!(marked.width(), 32);
    }

    #[cfg(windows)]
    #[test]
    fn the_badge_is_a_round_dot() {
        let badge = dot_badge();
        let alpha = |x: u32, y: u32| badge.rgba()[((y * 16 + x) * 4 + 3) as usize];
        assert_eq!(alpha(8, 8), 255);
        assert_eq!(alpha(0, 0), 0);
    }
}
