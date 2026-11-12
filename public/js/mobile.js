// What only the phone app does: the Back button, the notice that a newer version is out, and
// saving received files, which the phone's webview can't download itself.

import { appInvoke, appVersion, serverOrigin } from './platform.js';

const $ = (id) => document.getElementById(id);

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
// A file goes to the app in pieces of this many bytes, each as base64 text.
const SAVE_CHUNK = 192 * 1024;

// back: closes whatever is open on top of the chat and returns whether there was anything.
export function initMobile({ back }) {
    // The app calls this for the Back button (MainActivity.kt). When it returns false the app
    // goes to the background, where the chat stays open.
    window.ecdhBack = () => back() === true;
    checkForUpdate();
}

// The phone app doesn't update itself. It only says that a newer version is out and opens the
// download page in the browser; Android then installs the new app only if it's signed with the
// same key as this one, so the notice can't be used to pass off someone else's build.
async function checkForUpdate() {
    let release;
    try {
        const response = await fetch(`${serverOrigin()}/downloads/latest.json`, { cache: 'no-store', credentials: 'omit' });
        if (!response.ok) return;
        release = await response.json();
    } catch {
        return;
    }
    const latest = release?.android?.version;
    if (!isNewer(latest, appVersion)) return;

    $('updateText').textContent = `Version ${latest} of ecdh.chat is out.`;
    $('updateInstall').textContent = 'Get the update';
    $('updateInstall').addEventListener('click', () => window.open(`${serverOrigin()}/download`, '_blank', 'noopener'));
    $('updateLater').addEventListener('click', () => {
        $('updateBar').hidden = true;
    });
    $('updateBar').hidden = false;
}

// Whether version a ("4.4.0") is newer than version b. Anything that isn't a version is not.
export function isNewer(a, b) {
    const newer = VERSION.exec(a);
    const current = VERSION.exec(b);
    if (!newer || !current) return false;
    for (let i = 1; i <= 3; i++) {
        if (Number(newer[i]) !== Number(current[i])) return Number(newer[i]) > Number(current[i]);
    }
    return false;
}

// Saves a received file where the person chooses, on the system's "save as" screen. Resolves to
// false when they back out of it.
export async function saveFile(blob, name) {
    const { saving } = await appInvoke('plugin:phone|save_file', { name, mime: blob.type });
    if (!saving) return false;
    try {
        for (let offset = 0; offset < blob.size; offset += SAVE_CHUNK) {
            await appInvoke('plugin:phone|save_chunk', { data: await base64(blob.slice(offset, offset + SAVE_CHUNK)) });
        }
    } catch (error) {
        await appInvoke('plugin:phone|save_end', { discard: true }).catch(() => {});
        throw error;
    }
    await appInvoke('plugin:phone|save_end', { discard: false });
    return true;
}

function base64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
