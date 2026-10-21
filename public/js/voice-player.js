import { audioLength } from './audio-length.js';
import { el, icon } from './dom.js';

// Voice messages: a play button, a bar to seek with, and the time (the message's length, or how
// far in it is while playing). It's drawn in the bubble's own colors, so it looks the same in
// every browser and in the apps. Only one voice message plays at a time.

const PLAY = 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.78-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z';
const PAUSE = 'M7 5h3.5v14H7zm6.5 0H17v14h-3.5z';
// Shown while the length isn't known yet.
const NO_LENGTH = '–:––';
// The longest the search for a length may take (see loadedmetadata below).
const PROBE_MS = 8000;
// Recordings up to this size are read for their length; five minutes of voice is about 2 MB.
const MAX_READ = 8 * 1024 * 1024;

let playing = null;

// `file` is the recording itself, read for its length (audio-length.js) where it's small enough.
export function voicePlayer(url, file) {
    // It's a small file already on this device, so all of it loads: some players only know the
    // real length once they've read to the end.
    const audio = el('audio', { preload: 'auto', src: url });
    const button = el('button', { type: 'button', className: 'voice-play' }, [icon('0 0 24 24', PLAY), icon('0 0 24 24', PAUSE)]);
    const seek = el('input', { type: 'range', className: 'voice-seek', min: '0', max: '1', step: 'any', value: '0', disabled: true });
    seek.setAttribute('aria-label', 'Position');
    const time = el('span', { className: 'voice-time', textContent: NO_LENGTH });
    const player = el('div', { className: 'voice-player' }, [audio, button, seek, time]);
    let probing = false;
    let probeTimer = null;
    let fileLength = 0;

    // The player's own length, once it has a real one. Seeking works only then.
    const playerLength = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    // The file's length is the surest: some players only guess until they've played it all.
    const length = () => fileLength || playerLength();
    const render = () => {
        const fraction = length() ? Math.min(1, audio.currentTime / length()) : 0;
        seek.value = String(fraction);
        seek.style.setProperty('--progress', String(fraction));
        seek.disabled = !(playerLength() && audio.seekable.length);
        const idle = audio.paused && audio.currentTime === 0;
        time.textContent = idle && !length() ? NO_LENGTH : formatDuration(idle ? length() : audio.currentTime);
    };
    if (file && file.size <= MAX_READ) {
        file.arrayBuffer().then((buffer) => {
            fileLength = audioLength(new Uint8Array(buffer)) ?? 0;
            render();
        }, () => {});
    }
    const follow = () => {
        render();
        if (!audio.paused) requestAnimationFrame(follow);
    };
    const showPlaying = (on) => {
        player.classList.toggle('playing', on);
        button.setAttribute('aria-label', on ? 'Pause' : 'Play');
    };
    // Ends the search for the length, found or not, and goes back to the start.
    const stopProbing = () => {
        if (!probing) return;
        probing = false;
        clearTimeout(probeTimer);
        if (audio.currentTime) audio.currentTime = 0;
        render();
    };
    showPlaying(false);

    button.addEventListener('click', () => {
        stopProbing();
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    });
    seek.addEventListener('input', () => {
        if (!length()) return;
        audio.currentTime = Number(seek.value) * length();
        render();
    });
    audio.addEventListener('play', () => {
        if (playing && playing !== audio) playing.pause();
        playing = audio;
        showPlaying(true);
        follow();
    });
    audio.addEventListener('pause', () => {
        if (playing === audio) playing = null;
        showPlaying(false);
        render();
    });
    audio.addEventListener('ended', () => {
        audio.currentTime = 0;
        render();
    });
    // Seeking needs the player to know the length itself. Recordings often don't tell it (it
    // reads as Infinity) until the whole file has been played; Chrome and Edge work it out when
    // asked to seek far past the end, which can take a moment. Firefox doesn't start that seek at
    // all, so there seeking waits until the message has played once. Some players start with a
    // guess and correct it as they read on, so everything is redrawn whenever it changes.
    audio.addEventListener('loadedmetadata', () => {
        if (audio.duration !== Infinity) return render();
        probing = true;
        audio.currentTime = Number.MAX_SAFE_INTEGER;
        if (!audio.seeking) return stopProbing();
        probeTimer = setTimeout(stopProbing, PROBE_MS);
    });
    audio.addEventListener('durationchange', () => {
        if (probing && !Number.isFinite(audio.duration)) return;
        if (probing) stopProbing();
        else render();
    });
    // The seek reached the end without the length turning up.
    audio.addEventListener('seeked', () => {
        if (probing && !Number.isFinite(audio.duration)) stopProbing();
    });
    return player;
}

// "0:07", "1:23": minutes and seconds.
export function formatDuration(seconds) {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
