// The same page runs as the website and inside the desktop app. The website is served by the
// signaling server itself; the app loads the page from its own files, and its Rust side tells
// it which server to use (window.__ECDH_SERVER__) before any script on the page runs.

const INVITE_FRAGMENT = /^#?([0-9a-f-]{36}\.[A-Za-z0-9_-]{22})$/;

export const isApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// The app's webview doesn't notice when its window is minimized or loses focus, so the Rust
// side reports it.
let windowFocused = true;
const foregroundListeners = [];
const backgroundListeners = [];
if (isApp) {
    window.ecdhWindowFocused = (focused) => {
        windowFocused = focused;
        for (const listener of focused ? foregroundListeners : backgroundListeners) listener();
    };
}

// Calls one of the app's Rust commands. Only the commands allowed in
// src-tauri/capabilities/default.json go through. On the website it does nothing.
export function appInvoke(command, args = {}) {
    return isApp ? window.__TAURI_INTERNALS__.invoke(command, args) : Promise.resolve();
}

export function serverOrigin() {
    return resolveServerOrigin(window.__ECDH_SERVER__, location.origin);
}

export function resolveServerOrigin(appServer, pageOrigin) {
    if (typeof appServer !== 'string') return pageOrigin;
    try {
        const url = new URL(appServer);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
        // Falls through to the page's own origin.
    }
    return pageOrigin;
}

export function socketUrl(origin) {
    return `${origin.replace(/^http/, 'ws')}/ws`;
}

// Takes an invite link someone pasted and returns its "#room.secret" part, or null when it isn't
// an invite for this server. A bare "room.secret" is accepted too.
export function inviteFragment(link, origin) {
    const text = String(link).trim();
    const bare = INVITE_FRAGMENT.exec(text);
    if (bare) return `#${bare[1]}`;
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    const match = INVITE_FRAGMENT.exec(url.hash);
    return match ? `#${match[1]}` : null;
}

// In the app, a window that's open but not focused counts as in the background, like any
// desktop chat app. In a browser only a hidden tab does.
export function inBackground() {
    return document.hidden || (isApp && !windowFocused);
}

// The app's window lost focus, was minimized or went to the tray.
export function onAppBackground(listener) {
    backgroundListeners.push(listener);
}

export function onForeground(listener) {
    foregroundListeners.push(listener);
    document.addEventListener('visibilitychange', () => {
        if (!inBackground()) listener();
    });
}
