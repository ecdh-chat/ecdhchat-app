// Sounds and notifications for when the tab is in the background. Notifications never include
// what was said, only that something arrived.

import { inBackground } from './platform.js';

const SOUND = 'alertSound';
const NOTIFY = 'alertNotify';
let audioContext = null;

export function preferences() {
    return { sound: read(SOUND, '1') === '1', notify: read(NOTIFY, '0') === '1' && notificationsAllowed() };
}

export function setSound(enabled) {
    write(SOUND, enabled ? '1' : '0');
}

// Asks for permission when turned on; resolves to whether notifications are actually on.
export async function setNotify(enabled) {
    if (!enabled || !('Notification' in window)) {
        write(NOTIFY, '0');
        return false;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    write(NOTIFY, permission === 'granted' ? '1' : '0');
    return permission === 'granted';
}

export function notificationsBlocked() {
    return 'Notification' in window && Notification.permission === 'denied';
}

export function alertMessage() {
    alert('New message', 1);
}

export function alertCall() {
    alert('Incoming call', 3);
}

function alert(body, chimes) {
    if (!inBackground()) return;
    const { sound, notify } = preferences();
    if (sound) chime(chimes);
    if (!notify) return;
    try {
        const notification = new Notification('ecdh.chat', { body, tag: 'ecdh-chat' });
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch {
        // Some mobile browsers only allow notifications from a service worker.
    }
}

// Two short soft tones, generated on the spot, so no audio file is needed.
function chime(times) {
    try {
        audioContext ??= new AudioContext();
        const start = audioContext.currentTime;
        for (let i = 0; i < times; i++) {
            for (const [offset, frequency] of [[0, 880], [0.12, 1320]]) {
                const at = start + i * 0.6 + offset;
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                oscillator.frequency.value = frequency;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
                oscillator.connect(gain).connect(audioContext.destination);
                oscillator.start(at);
                oscillator.stop(at + 0.3);
            }
        }
    } catch {
        // No audio output available.
    }
}

function notificationsAllowed() {
    return 'Notification' in window && Notification.permission === 'granted';
}

function read(key, fallback) {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function write(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Not saved; the choice still applies until the page closes.
    }
}
