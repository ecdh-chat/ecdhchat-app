// What only the desktop app does: the title bar's window buttons, app settings, the first-run
// welcome, the privacy blur, quitting from the tray, and keyboard shortcuts.

import * as alerts from './alerts.js';
import { appInvoke, onAppBackground } from './platform.js';

const $ = (id) => document.getElementById(id);

let settings = {};
let shielded = false;
let answer = null;

// busy: whether a chat is starting or open. leave: ends it politely. newChat: starts over.
export async function initDesktop({ busy, leave, newChat, openSettings }) {
    $('windowControls').hidden = false;
    for (const button of document.querySelectorAll('[data-window-action]')) {
        button.addEventListener('click', () => appInvoke('window_action', { action: button.dataset.windowAction }));
    }

    $('appSettings').hidden = false;
    $('backgroundLegend').textContent = 'When the window is in the background';
    settings = await appInvoke('get_settings');
    const toggles = document.querySelectorAll('[data-app-setting]');
    const render = () => {
        for (const toggle of toggles) toggle.checked = Boolean(settings[toggle.dataset.appSetting]);
    };
    render();
    for (const toggle of toggles) {
        toggle.addEventListener('change', async () => {
            await save({ [toggle.dataset.appSetting]: toggle.checked });
            render();
        });
    }

    const welcome = $('welcomeDialog');
    $('welcomeDone').addEventListener('click', async () => {
        $('notifyToggle').checked = await alerts.setNotify($('welcomeNotify').checked);
        welcome.close();
    });
    welcome.addEventListener('close', () => save({ welcomed: true }));
    if (!settings.welcomed) {
        $('welcomeNotify').checked = alerts.preferences().notify;
        welcome.showModal();
    }

    initPrivacyShield();
    initUpdates(busy, leave);

    $('appConfirmButton').addEventListener('click', () => settle(true));
    $('appConfirmDialog').addEventListener('close', () => settle(false));

    // Called by the Rust side for the tray's Quit, and for closing the window when it doesn't
    // keep running in the tray.
    window.ecdhRequestQuit = async () => {
        if (busy()) {
            if (!(await ask('End this chat and quit?', 'The chat ends for both of you and its messages are cleared.', 'End chat and quit'))) return;
            await leave();
        }
        appInvoke('quit_app');
    };
    window.ecdhOpenSettings = openSettings;

    document.addEventListener('keydown', async (event) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key === ',') {
            event.preventDefault();
            openSettings();
        } else if (event.key.toLowerCase() === 'n') {
            event.preventDefault();
            if (busy()) {
                if (!(await ask('Start a new chat?', 'This chat ends for both of you and its messages are cleared.', 'End chat and start new'))) return;
                await leave();
            }
            newChat();
        }
    });
}

// Asks before something that ends the chat. Resolves to true only if the person confirms.
export function ask(title, text, button) {
    settle(false);
    $('appConfirmTitle').textContent = title;
    $('appConfirmText').textContent = text;
    $('appConfirmButton').textContent = button;
    $('appConfirmDialog').showModal();
    return new Promise((resolve) => {
        answer = resolve;
    });
}

function settle(confirmedByPerson) {
    const resolve = answer;
    answer = null;
    if ($('appConfirmDialog').open) $('appConfirmDialog').close();
    resolve?.(confirmedByPerson);
}

// The Rust side found a newer, signed version. The person decides when to install it, because
// installing restarts the app and so ends a chat that's open.
function initUpdates(busy, leave) {
    const bar = $('updateBar');
    const show = ({ version }) => {
        $('updateText').textContent = `Version ${version} of ecdh.chat is ready.`;
        $('updateInstall').hidden = false;
        $('updateLater').hidden = false;
        bar.hidden = false;
    };
    window.ecdhUpdateAvailable = show;
    appInvoke('get_update').then((update) => update && show(update), () => {});

    $('updateLater').addEventListener('click', () => {
        bar.hidden = true;
    });
    $('updateInstall').addEventListener('click', async () => {
        if (busy()) {
            if (!(await ask('Update now?', 'The app restarts to update, which ends this chat for both of you.', 'End chat and update'))) return;
            await leave();
        }
        $('updateText').textContent = 'Downloading the update…';
        $('updateInstall').hidden = true;
        $('updateLater').hidden = true;
        try {
            await appInvoke('install_update');
        } catch {
            $('updateText').textContent = 'The update couldn’t be installed. It will be offered again later.';
            $('updateLater').hidden = false;
        }
    });
}

async function save(change) {
    try {
        settings = await appInvoke('set_settings', { settings: { ...settings, ...change } });
    } catch {
        // The setting stays as it was; the toggles show the saved value again.
    }
}

// Blurs everything while the window is in the background. The first click or key press after
// coming back only reveals the chat, so it can't press anything by accident.
function initPrivacyShield() {
    const shield = $('privacyShield');
    const setShielded = (on) => {
        shielded = on;
        shield.hidden = !on;
        document.documentElement.classList.toggle('shielded', on);
    };
    onAppBackground(() => {
        if (settings.privacyBlur) setShielded(true);
    });
    const reveal = (event) => {
        if (!shielded) return;
        event.preventDefault();
        event.stopPropagation();
        setShielded(false);
    };
    document.addEventListener('click', reveal, true);
    document.addEventListener('keydown', reveal, true);
}
