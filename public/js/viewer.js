// The full-screen image viewer. An image from the chat opens as large as the window allows, on a
// dark backdrop, with its name and size above and who sent it below. Clicking the picture zooms
// in on that spot and clicking again fits it back; while zoomed, dragging moves it, and the wheel
// zooms too. The arrow keys and the side buttons go through the chat's other images. It only
// ever shows the chat's own blob URLs.

const $ = (id) => document.getElementById(id);

const MAX_SCALE = 4;
// A press that moves less than this is a click, not a drag.
const DRAG_PX = 4;
const WHEEL_STEP = 0.002;

const els = {
    viewer: $('viewer'),
    stage: $('viewerStage'),
    image: $('viewerImage'),
    name: $('viewerName'),
    size: $('viewerSize'),
    download: $('viewerDownload'),
    info: $('viewerInfo'),
    prev: $('viewerPrev'),
    next: $('viewerNext'),
};
// What each thumbnail in the chat opens: { url, name, size }.
const images = new WeakMap();
// The thumbnail being shown, and the one it was opened from (focus goes back there).
let current = null;
let opener = null;
// Zoom on top of the fitted picture: scale 1 fits the window, x and y move it from the center.
let view = { scale: 1, x: 0, y: 0 };
let press = null;

export function initViewer() {
    els.prev.addEventListener('click', () => step(-1));
    els.next.addEventListener('click', () => step(1));
    els.viewer.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') step(-1);
        else if (event.key === 'ArrowRight') step(1);
        else return;
        event.preventDefault();
    });
    // A click on the dark area around the picture closes it.
    els.viewer.addEventListener('click', (event) => {
        if (event.target === els.viewer || event.target === els.stage) els.viewer.close();
    });
    els.viewer.addEventListener('close', () => {
        current = null;
        press = null;
        fit();
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        opener = null;
    });
    els.image.addEventListener('pointerdown', startPress);
    els.image.addEventListener('pointermove', movePress);
    els.image.addEventListener('pointerup', endPress);
    els.image.addEventListener('pointercancel', () => {
        press = null;
        els.image.classList.remove('dragging');
    });
    els.stage.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', () => {
        if (current) setView(view);
    });
}

// Makes a thumbnail in the chat open the viewer.
export function addImage(button, info) {
    images.set(button, info);
    button.addEventListener('click', () => {
        opener = button;
        show(button);
        if (!els.viewer.open) els.viewer.showModal();
    });
}

// Closes the viewer if it's showing one of these images (its message was deleted or vanished).
export function forgetImages(urls) {
    if (current && urls.includes(images.get(current).url)) els.viewer.close();
}

// Closes the viewer and lets go of the image it showed.
export function resetViewer() {
    if (els.viewer.open) els.viewer.close();
    els.image.removeAttribute('src');
    els.download.removeAttribute('href');
}

function show(button) {
    current = button;
    const { url, name, size } = images.get(button);
    els.image.src = url;
    els.image.alt = name;
    els.download.href = url;
    els.download.download = name;
    els.name.textContent = name;
    els.size.textContent = size;
    fit();

    const all = chatImages();
    const index = all.indexOf(button);
    const row = button.closest('.msg-row');
    const parts = [row?.classList.contains('me') ? 'You' : 'Them'];
    const time = row?.querySelector('.msg-meta time')?.textContent;
    if (time) parts.push(time);
    if (all.length > 1) parts.push(`${index + 1} of ${all.length}`);
    els.info.textContent = parts.join(' · ');
    els.prev.hidden = all.length < 2;
    els.next.hidden = all.length < 2;
    els.prev.disabled = index <= 0;
    els.next.disabled = index >= all.length - 1;
}

// The chat's images, oldest first. Deleted and vanished ones are already gone from the page.
function chatImages() {
    return [...document.querySelectorAll('#messages .image-button')].filter((button) => images.has(button));
}

function step(direction) {
    if (!current) return;
    const all = chatImages();
    const next = all[all.indexOf(current) + direction];
    if (next) show(next);
}

function fit() {
    setView({ scale: 1, x: 0, y: 0 });
}

// Moving is held to the picture's edges, so it never slides off the screen.
function setView({ scale, x, y }) {
    const stage = els.stage.getBoundingClientRect();
    const maxX = Math.max(0, (els.image.offsetWidth * scale - stage.width) / 2);
    const maxY = Math.max(0, (els.image.offsetHeight * scale - stage.height) / 2);
    view = { scale, x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
    els.image.style.transform = scale === 1 ? '' : `translate(${view.x}px, ${view.y}px) scale(${scale})`;
    els.image.classList.toggle('zoomed', scale > 1);
}

// Zooms to the scale while the point under the pointer stays where it is. The picture sits in
// the middle of the stage, so offsets are measured from there.
function zoomAt(scale, clientX, clientY) {
    const stage = els.stage.getBoundingClientRect();
    const dx = clientX - (stage.left + stage.width / 2);
    const dy = clientY - (stage.top + stage.height / 2);
    const ratio = scale / view.scale;
    setView({ scale, x: dx - (dx - view.x) * ratio, y: dy - (dy - view.y) * ratio });
}

// A click zooms to the picture's own pixels, or to twice the size if it already fits at that.
function zoomedScale() {
    return clamp(els.image.naturalWidth / els.image.offsetWidth, 2, MAX_SCALE);
}

function startPress(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    els.image.setPointerCapture(event.pointerId);
    press = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: view.x, y: view.y, moved: false };
}

function movePress(event) {
    if (event.pointerId !== press?.id) return;
    const dx = event.clientX - press.startX;
    const dy = event.clientY - press.startY;
    if (!press.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    press.moved = true;
    if (view.scale === 1) return;
    els.image.classList.add('dragging');
    setView({ scale: view.scale, x: press.x + dx, y: press.y + dy });
}

function endPress(event) {
    if (event.pointerId !== press?.id) return;
    const { moved } = press;
    press = null;
    els.image.classList.remove('dragging');
    if (moved || !els.image.naturalWidth) return;
    if (view.scale > 1) fit();
    else zoomAt(zoomedScale(), event.clientX, event.clientY);
}

function wheel(event) {
    event.preventDefault();
    if (!els.image.naturalWidth) return;
    // Some browsers count the wheel in lines rather than pixels.
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    const scale = clamp(view.scale * Math.exp(-delta * WHEEL_STEP), 1, MAX_SCALE);
    if (scale === 1) fit();
    else if (scale !== view.scale) zoomAt(scale, event.clientX, event.clientY);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
