// /about: one chat, start to finish, played as an animation that fills the page. The page holds a
// 1280 × 720 world of chat screens (about.html); this works out every element's state at story time
// t, 0 to 56 seconds, and moves a camera over the world so each scene fills the window. Only styles
// and classes change here; the markup is never rewritten.

// The steps, by story time. A step plays for at least MIN_STEP seconds, slowed down if need be, so
// its caption stays up long enough to read.
const SEGMENTS = [[0, 14], [14, 18.3], [18.3, 19.6], [19.6, 21.4], [21.4, 31.5], [31.5, 42], [42, 50], [50, 55.9]];
const MIN_STEP = 5;
const PLAY = SEGMENTS.map(([from, to]) => Math.max(to - from, MIN_STEP));
const STARTS = PLAY.map((_, i) => PLAY.slice(0, i).reduce((a, b) => a + b, 0));
const TOTAL = STARTS.at(-1) + PLAY.at(-1);

// The camera: at each time, the part of the world (x, y, width, height) to fit in the window.
// Tall, narrow windows such as phones get their own path that stays close to one screen at a time.
const WIDE = [
    [0, 200, 0, 880, 650], [2.4, 200, 0, 880, 650], [3.4, 440, 160, 840, 420], [8.1, 440, 160, 840, 420],
    [9.0, 220, 0, 840, 650], [13.8, 220, 0, 840, 650], [14.8, 420, 20, 440, 610], [19.6, 420, 20, 440, 610],
    [20.8, 0, 10, 1280, 640], [22.2, 0, 10, 1280, 640], [23.0, 170, 50, 1110, 520], [28.4, 170, 50, 1110, 520],
    [29.4, 0, 10, 1280, 640], [49.6, 0, 10, 1280, 640], [50.6, 0, 0, 1280, 720],
];
const NARROW = [
    [0, 240, 20, 800, 610], [2.4, 240, 20, 800, 610], [3.2, 455, 185, 370, 370], [4.3, 455, 185, 370, 370],
    [5.0, 1000, 330, 300, 170], [6.2, 1000, 330, 300, 170], [6.8, 455, 185, 370, 370], [8.3, 455, 185, 370, 370],
    [9.0, 500, 120, 540, 520], [13.8, 500, 120, 540, 520], [14.6, 480, 30, 320, 590], [19.8, 480, 30, 320, 590],
    [20.8, 950, 30, 320, 590], [22.4, 950, 30, 320, 590], [23.2, 740, 40, 260, 320], [25.6, 740, 40, 260, 320],
    [26.4, 950, 30, 320, 590], [33.8, 950, 30, 320, 590], [34.6, 750, 280, 240, 220], [37.4, 750, 280, 240, 220],
    [38.2, 950, 30, 320, 590], [41.4, 950, 30, 320, 590], [42.2, 170, 170, 420, 280], [44.4, 170, 170, 420, 280],
    [45.2, 950, 30, 320, 590], [45.8, 950, 30, 320, 590], [46.6, 750, 170, 240, 240], [48.8, 750, 170, 240, 240],
    [49.6, 950, 30, 320, 590], [50.6, 300, 240, 680, 240],
];

const MESSAGES = [
    { from: 'a', at: 32.0 },
    { from: 'b', at: 33.2, file: { send: 33.7, done: 36.5 } },
    { from: 'a', at: 37.6 },
    { from: 'a', at: 39.8 },
];

const NOTES = [
    { a: 33.8, b: 38.2, x: 772, y: 300, w: 176, lines: [[329, 288, 772, 340], [1010, 242, 948, 340]] },
    { a: 3.6, b: 8.3, x: 1060, y: 360, w: 200, lines: [[794, 462, 1060, 412]] },
    { a: 22.6, b: 27.8, x: 772, y: 190, w: 176, lines: [[448, 308, 772, 262], [1052, 313, 948, 262]] },
    { a: 45.4, b: 49.4, x: 772, y: 190, w: 176, lines: [[548, 301, 772, 282], [981, 296, 948, 282]] },
];

// The pointer's path: [time, x, y].
const POINTER = [[5.4, 1000, 600], [6.6, 640, 462], [8.2, 640, 462],
    [20.8, 420, 520], [21.4, 197, 121], [26.2, 197, 121], [26.9, 319, 377], [28.0, 319, 377],
    [41.6, 500, 300], [42.3, 571, 121], [43.2, 571, 121], [43.8, 319, 346], [44.6, 319, 346]];

// Taps on the phone, in the phone page's own coordinates.
const RIPPLES = [[15.2, 168, 160], [17.9, 195, 432], [21.75, 70, 26], [28.15, 116, 462]];

const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
const round = (x) => Math.round(x * 1000) / 1000;

export function initStory(section) {
    const els = {};
    for (const el of section.querySelectorAll('[data-f]')) (els[el.dataset.f] ??= []).push(el);
    const one = (name) => els[name][0];
    const steps = [...section.querySelectorAll('.story-steps li')];
    const jumps = [...section.querySelectorAll('.story-progress button')];
    const stage = section.querySelector('.story-stage');
    const head = section.querySelector('.story-head');
    const captions = section.querySelector('.story-captions');
    const controls = section.querySelector('.story-controls');
    const world = one('world');
    one('qrPath').setAttribute('d', qrPath());

    for (const [i, line] of els.line.entries()) {
        const [x1, y1, x2, y2] = NOTES.flatMap((note) => note.lines)[i];
        Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => line.setAttribute(k, v));
    }
    for (const [i, note] of els.note.entries()) {
        note.style.left = `${NOTES[i].x}px`;
        note.style.top = `${NOTES[i].y}px`;
        note.style.width = `${NOTES[i].w}px`;
    }

    section.classList.add('live');

    // Playback runs on its own clock, in seconds of playing time (not story time).
    let clock = 0;
    let playing = false;
    let frame = 0;
    let last = 0;
    let view = { width: 0, top: 0, bottom: 0, narrow: false };

    const measure = () => {
        const width = stage.clientWidth;
        const height = stage.clientHeight;
        // Room is left for an ordinary caption. The last one, with its buttons, comes over the end
        // card, which has room to spare.
        const caption = Math.max(...steps.slice(0, -1).map((step) => step.offsetHeight));
        view = { width, top: head.offsetTop + head.offsetHeight + 8, bottom: captions.offsetTop + controls.offsetTop - caption, narrow: width / height < 1.1 };
    };

    const tick = (now) => {
        // A long gap (a hidden tab) doesn't skip ahead.
        clock = Math.min(TOTAL, clock + Math.min(0.1, (now - last) / 1000));
        last = now;
        render();
        if (clock >= TOTAL) setPlaying(false);
        else frame = requestAnimationFrame(tick);
    };

    function setPlaying(next) {
        playing = next;
        cancelAnimationFrame(frame);
        if (playing) {
            if (clock >= TOTAL) clock = 0;
            last = performance.now();
            frame = requestAnimationFrame(tick);
        }
        render();
    }

    one('replay').addEventListener('click', () => {
        clock = 0;
        setPlaying(true);
    });
    jumps.forEach((button, i) => button.addEventListener('click', () => {
        clock = STARTS[i];
        setPlaying(true);
    }));

    // Story time for the playing clock.
    function storyTime() {
        const i = Math.max(0, STARTS.findLastIndex((start) => clock >= start));
        const [from, to] = SEGMENTS[i];
        return from + (to - from) * clamp((clock - STARTS[i]) / PLAY[i]);
    }

    function render() {
        const t = storyTime();
        camera(t);
        scene(t);
        caption();
    }

    function camera(t) {
        const path = view.narrow ? NARROW : WIDE;
        let [, x, y, w, h] = path[0];
        for (let k = 0; k < path.length - 1; k++) {
            const [t0, ...a] = path[k];
            const [t1, ...b] = path[k + 1];
            if (t >= t0 && t <= t1) {
                const q = ease(clamp((t - t0) / (t1 - t0)));
                [x, y, w, h] = a.map((v, i) => v + (b[i] - v) * q);
            } else if (t > t1) {
                [x, y, w, h] = b;
            }
        }
        const margin = view.narrow ? 12 : 40;
        const room = { w: view.width - margin * 2, h: Math.max(160, view.bottom - view.top) };
        const scale = Math.min(room.w / w, room.h / h, view.narrow ? 2 : 1.6);
        const left = margin + (room.w - w * scale) / 2 - x * scale;
        const up = view.top + (room.h - h * scale) / 2 - y * scale;
        world.style.transform = `translate(${round(left)}px, ${round(up)}px) scale(${round(scale)})`;
    }

    function caption() {
        const index = Math.max(0, STARTS.findLastIndex((start) => clock >= start));
        steps.forEach((step, i) => {
            const local = (clock - STARTS[i]) / PLAY[i];
            const fadeIn = i === 0 ? 1 : clamp(local / 0.1);
            const fadeOut = i === SEGMENTS.length - 1 ? 1 : clamp((1 - local) / 0.06);
            const o = i === index ? Math.min(fadeIn, fadeOut) : 0;
            step.style.opacity = round(o);
            step.style.visibility = o > 0.002 ? 'visible' : 'hidden';
            step.style.transform = `translateY(${round((1 - o) * 10)}px)`;
        });
        jumps.forEach((button, i) => {
            button.style.setProperty('--p', `${round(clamp((clock - STARTS[i]) / PLAY[i]) * 100)}%`);
            if (i === index) button.setAttribute('aria-current', 'step');
            else button.removeAttribute('aria-current');
        });
    }

    function scene(t) {
        const win = (a, b, fi = 0.35, fo = 0.35) => (t < a || t > b ? 0 : ease(Math.min(clamp((t - a) / fi), clamp((b - t) / fo))));
        const up = (a, d) => ease(clamp((t - a) / d));
        const press = (a) => `scale(${round(1 - win(a, a + 0.35, 0.08, 0.2) * 0.05)})`;
        const show = (el, o, transform, filter) => {
            el.style.opacity = round(o);
            el.style.visibility = o <= 0.002 ? 'hidden' : 'visible';
            if (transform !== undefined) el.style.transform = transform;
            if (filter !== undefined) el.style.filter = filter;
        };
        const all = (name, o, transform) => els[name].forEach((el) => show(el, o, transform));
        const on = (name, visible) => all(name, visible ? 1 : 0);
        const chip = (name, text, tone) => {
            const el = one(name);
            el.classList.toggle('warn', tone === 'warn');
            el.classList.toggle('ok', tone === 'ok');
            one(`${name}Text`).textContent = text;
            one(`${name}Dot`).style.opacity = tone === 'ok' ? round(0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 3.9))) : 1;
        };
        const highlight = (el, p, alpha, ring) => {
            el.style.background = `color-mix(in srgb, var(--accent) ${round(p * alpha)}%, transparent)`;
            el.style.boxShadow = `0 0 0 ${round(p * ring)}px color-mix(in srgb, var(--accent) ${round(p * 75)}%, transparent)`;
        };

        // A: Sam's browser. Centred while Sam makes the link, then to the left beside the phone.
        let ax;
        let ay;
        let ak;
        let ao;
        if (t < 10) {
            ax = 240; ay = 20 + (1 - up(0, 0.8)) * 10; ak = 0.8; ao = win(0, 8.6, 0.6, 0.25);
        } else {
            ax = 30 - (1 - up(20.2, 0.9)) * 30; ay = 30; ak = 0.72; ao = win(20.2, 49.8, 0.6, 0.8);
        }
        show(one('Awin'), ao, `translate(${round(ax)}px, ${round(ay)}px) scale(${ak})`);
        one('url').textContent = 'ecdh.chat'.slice(0, t < 10 ? Math.max(0, Math.min(9, Math.floor((t - 0.5) / 0.1))) : 9);
        one('caret').style.opacity = t < 1.6 && Math.floor(t * 2.5) % 2 === 0 ? 1 : 0;
        show(one('Acard'), t < 10 ? up(1.5, 0.4) : 1);

        const aOpen = t >= 10;
        const aEnded = t >= 44.6;
        on('Aopen', aOpen && !aEnded);
        show(one('AendBtn'), aOpen && !aEnded ? 1 : 0, press(42.4));
        if (t < 2.9) chip('Achip', 'Starting…');
        else if (t < 10) chip('Achip', 'Waiting for them to join');
        else if (aEnded) chip('Achip', 'Ended');
        else if (t < 27.0) chip('Achip', 'Not verified', 'warn');
        else if (t < 28.2) chip('Achip', 'Waiting for them to confirm', 'warn');
        else chip('Achip', 'Verified', 'ok');
        const blur = up(44.0, 0.8);
        show(one('Asys'), aOpen ? 1 - blur : 0, undefined, `blur(${round(blur * 8)}px)`);
        one('Acompose').classList.toggle('on', aOpen && !aEnded);
        show(one('AinviteO'), t < 10 ? up(2.2, 0.4) : 0);
        one('qr').style.opacity = round(up(2.9, 0.3));
        const copied = t >= 6.8 && t < 8.3;
        on('urlCreating', t < 2.9);
        on('urlLink', t >= 2.9 && !copied);
        on('urlCopied', copied);
        one('urlBox').classList.toggle('copied', copied);
        show(one('AendedO'), up(44.6, 0.4));
        show(one('AverifyO'), win(21.5, 30.0, 0.25, 0.3));
        show(one('AchoiceO'), win(42.6, 44.1, 0.2, 0.2));
        one('confirmBtn').style.transform = press(43.9);
        const aMatch = one('AmatchBtn');
        if (t < 27.0) {
            one('AvStatus').textContent = '';
            aMatch.textContent = 'Codes match';
            aMatch.style.transform = press(26.95);
        } else {
            one('AvStatus').textContent = t < 28.2 ? 'Waiting for the other person to confirm.' : 'You both confirmed the codes match. Verified.';
            aMatch.textContent = 'You confirmed';
            aMatch.style.transform = '';
        }
        aMatch.classList.toggle('disabled', t >= 27.0);
        highlight(one('secretHi'), win(3.6, 8.3, 0.4, 0.4), 28, 2);
        const codeHi = win(22.6, 27.8, 0.4, 0.4);
        highlight(one('codeHiA'), codeHi, 16, 1.5);
        highlight(one('codeHiB'), codeHi, 16, 1.5);

        // The other messenger.
        show(one('win2'), win(8.6, 14.1, 0.15, 0.25));
        on('ph', t < 9.4 || t >= 10.6);
        on('paste', t >= 9.4 && t < 10.6);
        one('sendBtn').style.transform = press(10.45);
        const sent = up(10.65, 0.3);
        show(one('sent'), sent, `translateY(${round((1 - sent) * 8)}px)`);
        show(one('deliv'), up(11.3, 0.3));

        // B: Mira's phone. It slides right when the browser comes back beside it.
        show(one('phone'), win(14.0, 49.8, 0.25, 0.8), `translateX(${round(470 * up(20.2, 0.9))}px)`);
        const bOpen = t >= 19.6;
        const bEnded = t >= 44.8;
        show(one('msgr'), win(14.0, 16.05, 0.2, 0.15));
        show(one('Bcard'), up(15.9, 0.2));
        if (t < 18.0) chip('Bchip', 'Invitation');
        else if (t < 19.1) chip('Bchip', 'Joining…');
        else if (t < 19.6) chip('Bchip', 'Connecting…');
        else if (bEnded) chip('Bchip', 'Ended');
        else if (t < 27.0) chip('Bchip', 'Not verified', 'warn');
        else if (t < 28.2) chip('Bchip', 'They confirmed: check the code', 'warn');
        else chip('Bchip', 'Verified', 'ok');
        on('Bopen', bOpen && !bEnded);
        on('BendBtn', bOpen && !bEnded);
        show(one('Bsys'), bOpen ? up(19.6, 0.3) * (1 - blur) : 0, undefined, `blur(${round(blur * 8)}px)`);
        one('Bcompose').classList.toggle('on', bOpen && !bEnded);
        show(one('BjoinO'), win(15.9, 18.3, 0.15, 0.25));
        one('joinBtn').style.transform = press(17.85);
        show(one('BendedO'), up(44.8, 0.4));
        show(one('BverifyO'), win(21.8, 30.0, 0.25, 0.3));
        const bMatch = one('BmatchBtn');
        one('BvStatus').textContent = t < 27.0 ? '' : t < 28.2 ? 'They say the codes match. Check that you see the same code.' : 'You both confirmed the codes match. Verified.';
        bMatch.textContent = t < 28.2 ? 'Codes match' : 'You confirmed';
        bMatch.classList.toggle('disabled', t >= 28.2);
        bMatch.style.transform = t >= 27.0 && t < 28.2 ? press(28.1) : '';
        els.ripple.forEach((el, i) => {
            const [at, x, y] = RIPPLES[i];
            const p = clamp((t - at) / 0.6);
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            show(el, t >= at && t < at + 0.6 ? (1 - p) * 0.45 : 0, `scale(${round(0.3 + p * 1.4)})`);
        });

        // The messages, the same on both screens; at the end they blur away.
        for (const side of ['A', 'B']) {
            els[`${side}msg`].forEach((el, i) => {
                const m = MESSAGES[i];
                const appear = up(m.at, 0.35);
                const gone = up(44.0 + i * 0.12, 0.8);
                show(el, appear * (1 - gone), `translateY(${round((1 - appear) * 8 - gone * 14)}px)`, `blur(${round(gone * 10)}px)`);
                if (!m.file) return;
                const mine = m.from === side.toLowerCase();
                const done = t >= m.file.done;
                const p = clamp((t - m.file.send) / (m.file.done - m.file.send));
                on(`${side}prog`, !done);
                on(`${side}dl`, done && !mine);
                one(`${side}bar`).style.width = `${Math.round(p * 100)}%`;
                one(`${side}status`).textContent = `${mine ? 'Sending' : 'Receiving'} ${Math.floor(p * 100)}%`;
            });
        }

        // Notes, with lines drawn out to what they explain.
        let line = 0;
        NOTES.forEach((note, i) => {
            const o = win(note.a, note.b, 0.4, 0.4);
            const rise = up(note.a + 0.15, 0.5);
            show(els.note[i], rise * win(note.a, note.b, 0.01, 0.4), `translateY(${round((1 - rise) * 6)}px)`);
            for (const [x1, y1, x2, y2] of note.lines) {
                const length = Math.round(Math.hypot(x2 - x1, y2 - y1));
                const lineEl = els.line[line];
                lineEl.setAttribute('stroke-dasharray', length);
                lineEl.setAttribute('stroke-dashoffset', round(length * (1 - up(note.a, 0.6))));
                show(els.lineGroup[line], o);
                line++;
            }
        });
        all('call1', win(22.6, 27.6, 0.3, 0.3));
        show(one('call2'), win(24.0, 27.6, 0.3, 0.3));

        let px = POINTER[0][1];
        let py = POINTER[0][2];
        for (let k = 0; k < POINTER.length - 1; k++) {
            const [t0, x0, y0] = POINTER[k];
            const [t1, x1, y1] = POINTER[k + 1];
            if (t >= t0 && t <= t1) {
                const q = ease(clamp((t - t0) / (t1 - t0)));
                px = x0 + (x1 - x0) * q;
                py = y0 + (y1 - y0) * q;
            } else if (t > t1) {
                px = x1;
                py = y1;
            }
        }
        show(one('cursor'), Math.max(win(5.4, 8.2, 0.2, 0.2), win(20.8, 28.0, 0.2, 0.2), win(41.6, 44.6, 0.2, 0.2)), `translate(${round(px)}px, ${round(py)}px)`);

        // The end card.
        const title = up(50.6, 1.3);
        show(one('endcard'), t >= 50.0 ? 1 : 0);
        show(one('endTitle'), title, undefined, `blur(${round((1 - title) * 12)}px)`);
        show(one('endTag'), up(52.2, 1.1));
    }

    window.addEventListener('resize', () => {
        measure();
        render();
    });
    measure();
    setPlaying(true);
}

// A made-up QR code: it looks the part, but doesn't scan.
function qrPath() {
    const n = 37;
    let seed = 20261108;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const grid = Array.from({ length: n }, () => Array.from({ length: n }, () => (random() < 0.5 ? 1 : 0)));
    const finder = (ox, oy) => {
        for (let y = -1; y <= 7; y++) {
            for (let x = -1; x <= 7; x++) {
                const X = ox + x;
                const Y = oy + y;
                if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
                const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
                grid[Y][X] = x < 0 || y < 0 || x > 6 || y > 6 ? 0 : ring === 2 ? 0 : 1;
            }
        }
    };
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);
    for (let i = 8; i < n - 8; i++) {
        grid[6][i] = i % 2 === 0 ? 1 : 0;
        grid[i][6] = i % 2 === 0 ? 1 : 0;
    }
    for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) grid[30 + y][30 + x] = Math.max(Math.abs(x), Math.abs(y)) === 1 ? 0 : 1;
    }
    let d = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) if (grid[y][x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
    return d;
}
