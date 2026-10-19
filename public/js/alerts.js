// Sounds and notifications for when the tab is in the background. Notifications never include
// what was said, only that something arrived.

import { inBackground } from './platform.js';

const SOUND = 'alertSound';
const NOTIFY = 'alertNotify';
const TONE = 'alertTone';
// Each tone is a few notes: [start in seconds, frequency in Hz, length in seconds, waveform].
const TONES = {
    chime: [[0, 880, 0.25, 'sine'], [0.12, 1320, 0.25, 'sine']],
    soft: [[0, 523, 0.35, 'sine'], [0.18, 659, 0.4, 'sine']],
    pop: [[0, 1200, 0.08, 'triangle'], [0.07, 1600, 0.08, 'triangle']],
    bell: [[0, 988, 0.6, 'sine'], [0, 1976, 0.35, 'sine']],
};
let audioContext = null;

export function preferences() {
    return { sound: read(SOUND, '1') === '1', notify: read(NOTIFY, '0') === '1' && notificationsAllowed() };
}

export function setSound(enabled) {
    write(SOUND, enabled ? '1' : '0');
}

export function tone() {
    const saved = read(TONE, 'chime');
    return Object.hasOwn(TONES, saved) ? saved : 'chime';
}

export function setTone(name) {
    if (Object.hasOwn(TONES, name)) write(TONE, name);
}

// Plays the chosen tone once, so it can be heard while choosing.
export function preview() {
    chime(1);
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

// The chosen tone, generated on the spot so no audio file is needed. Calls repeat it.
function chime(times) {
    try {
        audioContext ??= new AudioContext();
        const start = audioContext.currentTime;
        for (let i = 0; i < times; i++) {
            for (const [offset, frequency, length, type] of TONES[tone()]) {
                const at = start + i * 0.6 + offset;
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                oscillator.type = type;
                oscillator.frequency.value = frequency;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
                oscillator.connect(gain).connect(audioContext.destination);
                oscillator.start(at);
                oscillator.stop(at + length + 0.05);
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
