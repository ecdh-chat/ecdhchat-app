import qrcode from '../vendor/qrcode.mjs';
import * as alerts from './alerts.js';
import { MAX_FILE_SIZE } from './config.js';
import { REACTIONS } from './messages.js';
import { appInvoke, inBackground, isApp, onForeground, serverOrigin } from './platform.js';

const $ = (id) => document.getElementById(id);

const els = {
    statusChip: $('statusChip'),
    statusText: $('statusText'),
    endButton: $('endButton'),
    voiceCallButton: $('voiceCallButton'),
    videoCallButton: $('videoCallButton'),
    settingsButton: $('settingsButton'),
    infoButton: $('infoButton'),
    messages: $('messages'),
    typing: $('typingIndicator'),
    typingCipher: $('typingCipher'),
    jumpButton: $('jumpButton'),
    jumpText: $('jumpText'),
    attachments: $('attachments'),
    attachmentList: $('attachmentList'),
    originalRow: $('originalRow'),
    originalToggle: $('originalToggle'),
    composer: $('composer'),
    fileInput: $('fileInput'),
    attachButton: $('attachButton'),
    micButton: $('micButton'),
    messageInput: $('messageInput'),
    sendButton: $('sendButton'),
    replyBar: $('replyBar'),
    replyLabel: $('replyLabel'),
    replySnippet: $('replySnippet'),
    replyCancel: $('replyCancel'),
    recordingBar: $('recordingBar'),
    recordingTime: $('recordingTime'),
    recordCancel: $('recordCancel'),
    recordSend: $('recordSend'),
    inviteScreen: $('inviteScreen'),
    inviteLink: $('inviteLink'),
    qrCanvas: $('qrCanvas'),
    newRoomButton: $('newRoomButton'),
    joinScreen: $('joinScreen'),
    ipNotice: $('ipNotice'),
    joinButton: $('joinButton'),
    openInApp: $('openInApp'),
    openInAppLink: $('openInAppLink'),
    pasteInvite: $('pasteInvite'),
    pasteInput: $('pasteInput'),
    pasteButton: $('pasteButton'),
    pasteError: $('pasteError'),
    endedScreen: $('endedScreen'),
    endedTitle: $('endedTitle'),
    endedText: $('endedText'),
    newChatButton: $('newChatButton'),
    dropOverlay: $('dropOverlay'),
    verifyDialog: $('verifyDialog'),
    verifyCode: $('verifyCode'),
    verifyStatus: $('verifyStatus'),
    matchButton: $('matchButton'),
    mismatchButton: $('mismatchButton'),
    settingsDialog: $('settingsDialog'),
    disappearGroup: $('disappearGroup'),
    soundToggle: $('soundToggle'),
    notifyToggle: $('notifyToggle'),
    notifyNote: $('notifyNote'),
    infoDialog: $('infoDialog'),
    confirmEndDialog: $('confirmEndDialog'),
    confirmEndButton: $('confirmEndButton'),
    lightbox: $('lightbox'),
    lightboxImage: $('lightboxImage'),
    lightboxDownload: $('lightboxDownload'),
    messageMenu: $('messageMenu'),
    menuReactions: $('menuReactions'),
    menuReply: $('menuReply'),
    menuCopy: $('menuCopy'),
    menuDelete: $('menuDelete'),
};
const relayRows = document.querySelectorAll('.relay-option');
const relayToggles = document.querySelectorAll('.relay-toggle');
const overlays = [els.inviteScreen, els.joinScreen, els.endedScreen];

const ENDED = {
    'you-ended': ['Chat ended', 'You ended the chat. Its messages are gone from this page.'],
    'peer-ended': ['Chat ended', 'The other person ended the chat. Its messages are gone from this page.'],
    'peer-left': ['They left', 'The other person closed the chat or lost their connection. Its messages are gone from this page.'],
    mismatch: ['Chat closed: the codes didn’t match', 'Someone may have been listening in. Start a new chat and send the link a different way.'],
    'peer-mismatch': ['Chat closed: the codes didn’t match', 'The other person saw a different code, so someone may have been listening in. Start a new chat and send the link a different way.'],
    expired: ['Invite expired', 'Nobody joined in time. Start a new chat to get a fresh link.'],
    unavailable: ['This link can’t be used', 'It was already used, it expired, or the person who made it closed their tab. Ask them for a new link.'],
    'invalid-link': ['This link is incomplete', 'Part of the invite link is missing. Ask for the full link and open it again.'],
    'connect-failed': ['Couldn’t connect', 'A direct connection couldn’t be made. A firewall or a strict network may be blocking it. Try another network, or turn on Hide my IP if it’s offered.'],
    'handshake-failed': ['Couldn’t secure the chat', 'The secure connection couldn’t be set up. The link may be wrong, or something is interfering. Start a new chat.'],
    tampered: ['Chat closed for safety', 'Something unexpected arrived over the secure connection, so the chat was closed. Start a new chat.'],
    'network-lost': ['Connection lost', 'The connection dropped and couldn’t recover.'],
    'server-lost': ['Couldn’t reach the server', 'The connection to the server was lost before the chat started.'],
    'rate-limited': ['Too many new chats', 'Too many chats were started from your network. Wait a minute and try again.'],
    busy: ['The server is busy', 'Too many chats are open right now. Try again in a little while.'],
    unsupported: ['This browser isn’t supported', 'ecdh.chat needs a current browser with WebRTC and Web Crypto, opened over HTTPS.'],
};
const WARNINGS = new Set(['mismatch', 'peer-mismatch', 'handshake-failed', 'tampered']);
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const MAX_INPUT_HEIGHT = 160;
// A scroll this soon after wheel, touch, key or pointer input counts as the person scrolling.
const USER_SCROLL_MS = 600;
const HEX = '0123456789abcdef';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const urls = new Set();
const rows = new Map();
const files = new Map();
let handlers = {};
let staged = [];
let composerEnabled = false;
let inviteLink = '';
let copiedTimer = null;
let relayAvailable = false;
let dragDepth = 0;
let unread = 0;
let menuTarget = null;
// Whether the view follows new content. It stops when you scroll up and resumes at the bottom.
let pinned = true;
let userScrolledAt = -Infinity;
let missed = 0;
let cipherTimer = null;
// Images, file cards and the typing indicator can grow after they're added, so their size is
// watched to keep the newest message in view.
const sizeWatcher = new ResizeObserver(() => {
    if (pinned) scrollToBottom();
});

export function init(callbacks) {
    handlers = callbacks;

    els.sendButton.addEventListener('click', submit);
    els.messageInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submit();
        }
    });
    els.messageInput.addEventListener('input', () => {
        resizeInput();
        handlers.onTyping(els.messageInput.value.trim().length > 0);
    });
    els.attachButton.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
        stage(els.fileInput.files);
        els.fileInput.value = '';
    });
    els.micButton.addEventListener('click', () => handlers.onRecord('start'));
    els.recordCancel.addEventListener('click', () => handlers.onRecord('cancel'));
    els.recordSend.addEventListener('click', () => handlers.onRecord('send'));
    els.replyCancel.addEventListener('click', () => {
        clearReply();
        handlers.onCancelReply();
    });

    window.addEventListener('paste', (event) => {
        const pasted = [...(event.clipboardData?.files || [])];
        if (!composerEnabled || pasted.length === 0) return;
        event.preventDefault();
        stage(pasted);
    });
    // Files dropped anywhere must never make the browser navigate away from the chat.
    window.addEventListener('dragenter', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth++;
        els.dropOverlay.hidden = !composerEnabled;
    });
    window.addEventListener('dragover', (event) => {
        if (hasFiles(event)) event.preventDefault();
    });
    window.addEventListener('dragleave', (event) => {
        if (!hasFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) els.dropOverlay.hidden = true;
    });
    window.addEventListener('drop', (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        els.dropOverlay.hidden = true;
        if (composerEnabled) stage(event.dataTransfer.files);
    });

    for (const button of document.querySelectorAll('[data-close]')) {
        button.addEventListener('click', () => button.closest('dialog').close());
    }
    els.statusChip.addEventListener('click', () => open(els.verifyDialog));
    els.infoButton.addEventListener('click', () => open(els.infoDialog));
    els.settingsButton.addEventListener('click', () => open(els.settingsDialog));
    els.voiceCallButton.addEventListener('click', () => handlers.onCall(false));
    els.videoCallButton.addEventListener('click', () => handlers.onCall(true));
    els.endButton.addEventListener('click', () => open(els.confirmEndDialog));
    els.confirmEndButton.addEventListener('click', () => {
        els.confirmEndDialog.close();
        handlers.onEnd();
    });
    els.matchButton.addEventListener('click', () => handlers.onVerify(true));
    els.mismatchButton.addEventListener('click', () => {
        els.verifyDialog.close();
        handlers.onVerify(false);
    });
    els.joinButton.addEventListener('click', () => handlers.onJoin());
    els.newRoomButton.addEventListener('click', () => handlers.onNewRoom());
    els.newChatButton.addEventListener('click', () => handlers.onNewChat());
    els.inviteLink.addEventListener('click', copyLink);
    els.inviteLink.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        copyLink();
    });
    els.lightbox.addEventListener('click', (event) => {
        if (event.target === els.lightbox) els.lightbox.close();
    });
    // Only the person scrolling can unpin the view. Scrolls caused by layout, such as a file card
    // shrinking just before its image grows, pull it back to the newest message instead.
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
        els.messages.addEventListener(type, () => {
            userScrolledAt = performance.now();
        }, { passive: true });
    }
    els.messages.addEventListener('scroll', () => {
        if (isNearBottom()) pinned = true;
        else if (performance.now() - userScrolledAt < USER_SCROLL_MS) pinned = false;
        else if (pinned) scrollToBottom();
        setMissed(pinned ? 0 : missed);
    }, { passive: true });
    els.jumpButton.addEventListener('click', () => {
        pinned = true;
        setMissed(0);
        scrollToBottom();
    });
    sizeWatcher.observe(els.messages);
    sizeWatcher.observe(els.typing);

    initMessageMenu();
    initSettings();

    const hideIp = savedHideIp();
    for (const toggle of relayToggles) {
        toggle.checked = hideIp;
        toggle.addEventListener('change', () => {
            for (const other of relayToggles) other.checked = toggle.checked;
            try {
                localStorage.setItem('hideIp', toggle.checked ? '1' : '0');
            } catch {
                // Not saved; the choice still applies to this chat.
            }
        });
    }

    onForeground(() => {
        unread = 0;
        document.title = 'ecdh.chat';
        appInvoke('set_unread', { count: 0 });
    });

    // The site pages live on the server. The app opens them in the browser, and doesn't offer
    // itself as a download.
    if (isApp) {
        const about = document.getElementById('aboutLink');
        about.href = `${serverOrigin()}/about#security`;
        document.getElementById('downloadLink').previousSibling.remove();
        document.getElementById('downloadLink').remove();
    }

    // Only the app can open a pasted link: in a browser it goes in the address bar.
    els.pasteInvite.hidden = !isApp;
    const pasteInvite = () => {
        const link = els.pasteInput.value;
        els.pasteError.hidden = !link.trim() || handlers.onPasteInvite(link);
    };
    els.pasteButton.addEventListener('click', pasteInvite);
    els.pasteInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') pasteInvite();
    });
    els.pasteInput.addEventListener('input', () => {
        els.pasteError.hidden = true;
    });
}

export function setStatus(text, tone, clickable) {
    els.statusText.textContent = text;
    els.statusChip.dataset.tone = tone;
    els.statusChip.disabled = !clickable;
}

// Which header controls the chat shows: End chat, and the call buttons.
export function setChatControls({ end, call }) {
    els.endButton.hidden = !end;
    els.voiceCallButton.hidden = !call;
    els.videoCallButton.hidden = !call;
}

export function showInvitePending(available) {
    relayAvailable = available;
    showRelayOption();
    els.inviteLink.textContent = 'Creating a link…';
    show(els.inviteScreen);
}

export function showInvite(link) {
    inviteLink = link;
    els.inviteLink.textContent = link;
    drawQr(els.qrCanvas, link);
    els.qrCanvas.hidden = false;
}

export function showJoin(available, appLink) {
    relayAvailable = available;
    showRelayOption();
    els.openInApp.hidden = isApp;
    els.openInAppLink.href = appLink;
    show(els.joinScreen);
    els.joinButton.focus();
}

export function hideOverlays() {
    for (const overlay of overlays) overlay.hidden = true;
}

export function relayOnly() {
    return relayAvailable && relayToggles[0].checked;
}

export function openChat() {
    hideOverlays();
    setComposerEnabled(true);
    const compare = linkButton('Compare the code', () => open(els.verifyDialog));
    addSystem(['Connected and encrypted end to end. ', compare, ' with the other person to make sure nobody is in the middle.']);
    els.messageInput.focus();
}

export function setComposerEnabled(enabled) {
    composerEnabled = enabled;
    els.messageInput.disabled = !enabled;
    els.sendButton.disabled = !enabled;
    els.attachButton.disabled = !enabled;
    els.micButton.disabled = !enabled;
    els.disappearGroup.disabled = !enabled;
}

export function addMessage({ id, from, text, quote }) {
    const bubble = el('div', { className: 'bubble' });
    if (quote) bubble.append(quoteButton(quote));
    bubble.append(...linkify(text));
    appendRow({ id, from, content: bubble, text });
}

export function addFile({ id, from, name, size, kind, caption, url = null }) {
    const body = el('div', { className: 'file-body' }, [fileBody(kind, url, name, size)]);
    const progress = el('progress', { max: 1, value: 0 });
    const status = el('span', { className: 'file-status', textContent: from === 'me' ? 'Sending…' : 'Receiving…' });
    const cancel = el('button', { type: 'button', className: 'link-button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => handlers.onCancelFile(id));

    const card = el('div', { className: 'file-card' }, [body, el('div', { className: 'file-progress' }, [progress, status, cancel])]);
    if (caption) card.append(el('div', { className: 'attachment-text' }, linkify(caption)));

    files.set(id, { card, body, progress, status, cancel, mine: from === 'me' });
    const entry = appendRow({ id, from, content: card, text: caption });
    if (url) entry.urls.push(url);
}

export function markSent(id) {
    setTick(id, '✓', 'Sent');
}

export function markDelivered(id) {
    setTick(id, '✓✓', 'Delivered');
}

export function setFileProgress(id, fraction) {
    const file = files.get(id);
    // A send already in flight can report progress after the transfer was cancelled.
    if (!file || file.finished) return;
    file.progress.value = fraction;
    file.status.textContent = `${file.mine ? 'Sending' : 'Receiving'} ${Math.floor(fraction * 100)}%`;
}

export function completeFile(id, { url, kind, name, size }) {
    const file = files.get(id);
    if (!file) return;
    finishFile(file);
    file.body.replaceChildren(fileBody(kind, url, name, size));
    rows.get(id)?.urls.push(url);
}

export function setFileState(id, state) {
    const file = files.get(id);
    if (!file) return;
    finishFile(file);
    if (state === 'sent') {
        markSent(id);
        return;
    }
    file.card.classList.add('is-cancelled');
    file.status.hidden = false;
    file.status.textContent = state === 'cancelled' ? 'Cancelled' : 'Cancelled by them';
    rows.get(id)?.tick?.remove();
}

export function markDeleted(id) {
    const entry = rows.get(id);
    if (!entry || entry.deleted) return;
    entry.deleted = true;
    entry.text = '';
    releaseUrls(entry);
    files.delete(id);
    entry.line.replaceChildren(el('div', { className: 'bubble deleted', textContent: 'This message was deleted' }));
    entry.reactions.replaceChildren();
    entry.tick?.remove();
}

export function removeMessage(id) {
    const entry = rows.get(id);
    if (!entry) return;
    releaseUrls(entry);
    files.delete(id);
    rows.delete(id);
    sizeWatcher.unobserve(entry.row);
    entry.row.remove();
}

export function setReactions(id, reactions) {
    const entry = rows.get(id);
    if (!entry || entry.deleted) return;
    entry.reactions.replaceChildren(...reactions.map(({ emoji, count, mine, names }) => {
        const chip = el('button', { type: 'button', className: mine ? 'reaction-chip mine' : 'reaction-chip', title: names, textContent: `${emoji} ${count}` });
        chip.setAttribute('aria-pressed', String(mine));
        chip.setAttribute('aria-label', `${emoji} ${count}: ${names}`);
        chip.addEventListener('click', () => handlers.onReact(id, emoji));
        return chip;
    }));
}

export function startReply({ label, snippet }) {
    els.replyLabel.textContent = label;
    els.replySnippet.textContent = snippet;
    els.replyBar.hidden = false;
    els.messageInput.focus();
}

export function clearReply() {
    els.replyBar.hidden = true;
}

export function showTyping(typing) {
    if (els.typing.hidden === !typing) return;
    els.typing.hidden = !typing;
    clearInterval(cipherTimer);
    cipherTimer = null;
    if (!typing) return;
    // Looks like ciphertext being written. It's decoration only: the glyphs mean nothing.
    els.typingCipher.replaceChildren(...Array.from({ length: 4 }, () => el('span', { textContent: hexPair() })));
    if (reducedMotion.matches) return;
    cipherTimer = setInterval(() => {
        const pairs = els.typingCipher.children;
        const pair = pairs[Math.floor(Math.random() * pairs.length)];
        pair.textContent = hexPair();
        pair.classList.remove('fresh');
        void pair.offsetWidth;
        pair.classList.add('fresh');
    }, 120);
}

export function setVerification({ sas, me, peer }) {
    els.verifyCode.textContent = formatCode(sas);
    els.matchButton.disabled = me;
    els.matchButton.textContent = me ? 'You confirmed' : 'Codes match';
    els.verifyStatus.textContent = verificationText(me, peer);
}

export function setDisappearing(seconds) {
    for (const radio of els.disappearGroup.querySelectorAll('input')) radio.checked = Number(radio.value) === seconds;
}

export function showRecording(recording) {
    els.composer.hidden = recording;
    els.recordingBar.hidden = !recording;
    els.recordingTime.textContent = '0:00';
}

export function setRecordingTime(ms) {
    const seconds = Math.floor(ms / 1000);
    els.recordingTime.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function addSystem(content) {
    insertRow(el('div', { className: 'system-message' }, Array.isArray(content) ? content : [content]));
}

export function noteIncoming() {
    if (!inBackground()) return;
    unread++;
    document.title = `(${unread}) ecdh.chat`;
    appInvoke('set_unread', { count: unread });
}

export function openSettings() {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    open(els.settingsDialog);
}

export function objectUrl(blob) {
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
}

export function showEnded(reason) {
    const [title, text] = ENDED[reason] || ENDED['network-lost'];
    for (const dialog of document.querySelectorAll('dialog')) {
        if (dialog.open) dialog.close();
    }
    if (els.messageMenu.matches(':popover-open')) els.messageMenu.hidePopover();
    clearConversation();
    setComposerEnabled(false);
    showRecording(false);
    clearReply();
    showTyping(false);
    setChatControls({ end: false, call: false });
    setStatus('Ended', 'neutral', false);
    els.endedTitle.textContent = title;
    els.endedText.textContent = text;
    els.endedScreen.dataset.tone = WARNINGS.has(reason) ? 'warning' : 'neutral';
    show(els.endedScreen);
    els.newChatButton.focus();
}

export function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function submit() {
    if (!composerEnabled) return;
    const text = els.messageInput.value.trim();
    if (!text && staged.length === 0) return;

    const outgoing = { text, files: staged.map((item) => item.file), original: els.originalToggle.checked };
    clearStaged();
    clearReply();
    els.messageInput.value = '';
    resizeInput();
    handlers.onSend(outgoing);
}

function stage(fileList) {
    for (const file of fileList) {
        if (file.size > MAX_FILE_SIZE) {
            addSystem(`“${file.name}” is larger than ${formatBytes(MAX_FILE_SIZE)}, so it can’t be sent.`);
            continue;
        }
        staged.push({ file, url: file.type.startsWith('image/') ? objectUrl(file) : null });
    }
    renderStaged();
    els.messageInput.focus();
}

function renderStaged() {
    els.attachmentList.replaceChildren(...staged.map((item) => {
        const remove = el('button', { type: 'button', className: 'chip-remove', textContent: '✕' });
        remove.setAttribute('aria-label', `Remove ${item.file.name}`);
        remove.addEventListener('click', () => {
            staged = staged.filter((other) => other !== item);
            if (item.url) revoke(item.url);
            renderStaged();
        });
        const preview = item.url ? el('img', { src: item.url, alt: '' }) : el('span', { className: 'file-icon' });
        return el('div', { className: 'attachment-chip' }, [
            preview,
            el('span', { className: 'chip-name', textContent: item.file.name || 'file' }),
            el('span', { className: 'chip-size', textContent: formatBytes(item.file.size) }),
            remove,
        ]);
    }));
    els.attachments.hidden = staged.length === 0;
    els.originalRow.hidden = !staged.some((item) => item.url);
}

function clearStaged() {
    for (const item of staged) {
        if (item.url) revoke(item.url);
    }
    staged = [];
    els.originalToggle.checked = false;
    renderStaged();
}

function clearConversation() {
    clearStaged();
    showTyping(false);
    sizeWatcher.disconnect();
    els.messages.replaceChildren(els.typing, els.jumpButton);
    sizeWatcher.observe(els.messages);
    sizeWatcher.observe(els.typing);
    pinned = true;
    setMissed(0);
    els.messageInput.value = '';
    els.lightboxImage.removeAttribute('src');
    els.lightboxDownload.removeAttribute('href');
    rows.clear();
    files.clear();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
}

// One message on screen: the bubble or file card with its ⋯ menu, reactions, and the time (plus
// ticks for your own messages).
function appendRow({ id, from, content, text = '' }) {
    const mine = from === 'me';
    const row = el('div', { className: mine ? 'msg-row me' : 'msg-row peer' });

    const actions = el('button', { type: 'button', className: 'msg-actions', textContent: '⋯' });
    actions.setAttribute('aria-label', 'Message options');
    actions.addEventListener('click', () => openMenu(id, actions));
    const line = el('div', { className: 'msg-line' }, [content, actions]);
    const reactions = el('div', { className: 'reactions' });
    const meta = el('div', { className: 'msg-meta' }, [el('time', { textContent: formatTime(new Date()) })]);
    let tick = null;
    if (mine) {
        tick = el('span', { className: 'ticks' });
        tick.setAttribute('aria-label', 'Sending');
        meta.append(tick);
    }
    row.append(line, reactions, meta);

    // Sending something always brings you back to the newest message.
    if (mine) pinned = true;
    else if (!pinned) setMissed(missed + 1);
    insertRow(row);

    const entry = { row, line, reactions, tick, mine, text, deleted: false, urls: [] };
    rows.set(id, entry);
    return entry;
}

function initMessageMenu() {
    els.menuReactions.replaceChildren(...REACTIONS.map((emoji) => {
        const button = el('button', { type: 'button', className: 'menu-reaction', textContent: emoji });
        button.setAttribute('aria-label', `React with ${emoji}`);
        button.addEventListener('click', () => menuAction(() => handlers.onReact(menuTarget, emoji)));
        return button;
    }));
    els.menuReply.addEventListener('click', () => menuAction(() => handlers.onReply(menuTarget)));
    els.menuDelete.addEventListener('click', () => menuAction(() => handlers.onDelete(menuTarget)));
    els.menuCopy.addEventListener('click', () => menuAction(() => {
        const text = rows.get(menuTarget)?.text;
        if (text) navigator.clipboard.writeText(text).catch(() => {});
    }));
}

function openMenu(id, anchor) {
    const entry = rows.get(id);
    if (!entry || entry.deleted) return;
    menuTarget = id;
    els.menuCopy.hidden = !entry.text;
    els.menuDelete.hidden = !entry.mine;
    els.messageMenu.showPopover();

    const button = anchor.getBoundingClientRect();
    const menu = els.messageMenu.getBoundingClientRect();
    const left = Math.min(window.innerWidth - menu.width - 8, Math.max(8, entry.mine ? button.right - menu.width : button.left));
    const below = button.bottom + 4;
    const top = below + menu.height > window.innerHeight - 8 ? button.top - menu.height - 4 : below;
    els.messageMenu.style.left = `${left}px`;
    els.messageMenu.style.top = `${Math.max(8, top)}px`;
}

function menuAction(action) {
    els.messageMenu.hidePopover();
    if (menuTarget && rows.has(menuTarget)) action();
}

function initSettings() {
    const { sound, notify } = alerts.preferences();
    els.soundToggle.checked = sound;
    els.notifyToggle.checked = notify;
    els.notifyNote.hidden = !alerts.notificationsBlocked();
    els.soundToggle.addEventListener('change', () => alerts.setSound(els.soundToggle.checked));
    els.notifyToggle.addEventListener('change', async () => {
        els.notifyToggle.checked = await alerts.setNotify(els.notifyToggle.checked);
        els.notifyNote.hidden = !alerts.notificationsBlocked();
    });
    for (const radio of els.disappearGroup.querySelectorAll('input')) {
        radio.addEventListener('change', () => handlers.onDisappear(Number(radio.value)));
    }
}

function quoteButton({ id, label, snippet }) {
    const button = el('button', { type: 'button', className: 'quote' }, [el('strong', { textContent: label }), el('span', { textContent: snippet })]);
    button.disabled = !rows.has(id);
    button.addEventListener('click', () => {
        const target = rows.get(id);
        if (!target) return;
        target.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.row.classList.add('highlight');
        setTimeout(() => target.row.classList.remove('highlight'), 1200);
    });
    return button;
}

// Turns http(s) addresses into links. Nothing is fetched or previewed.
function linkify(text) {
    const nodes = [];
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        const address = match[0].replace(/[.,;:!?)\]}'"]+$/, '');
        let href = null;
        try {
            const url = new URL(address);
            if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href;
        } catch {
            // Not a valid address; it stays plain text.
        }
        if (match.index > last) nodes.push(text.slice(last, match.index));
        nodes.push(href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: address }) : address);
        last = match.index + address.length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
}

function setTick(id, text, label) {
    const tick = rows.get(id)?.tick;
    if (!tick) return;
    tick.textContent = text;
    tick.setAttribute('aria-label', label);
}

function finishFile(file) {
    file.finished = true;
    file.progress.hidden = true;
    file.cancel.hidden = true;
    file.status.hidden = true;
}

function fileBody(kind, url, name, size) {
    if (kind === 'image' && url) return imageButton(url, name);
    if (kind === 'audio' && url) return el('audio', { className: 'voice-player', controls: true, preload: 'metadata', src: url });
    return fileLabel(name, size, url);
}

function imageButton(url, name) {
    const button = el('button', { type: 'button', className: 'image-button' }, [el('img', { src: url, alt: name })]);
    button.setAttribute('aria-label', `Open ${name}`);
    button.addEventListener('click', () => {
        els.lightboxImage.src = url;
        els.lightboxImage.alt = name;
        els.lightboxDownload.href = url;
        els.lightboxDownload.download = name;
        open(els.lightbox);
    });
    return button;
}

function fileLabel(name, size, url = null) {
    const label = el('div', { className: 'file-label' }, [
        el('span', { className: 'file-icon' }),
        el('div', { className: 'file-meta' }, [
            el('span', { className: 'file-name', textContent: name }),
            el('span', { className: 'file-size', textContent: formatBytes(size) }),
        ]),
    ]);
    if (url) label.append(el('a', { className: 'secondary-button', href: url, download: name, textContent: 'Download' }));
    return label;
}

function linkButton(text, onClick) {
    const button = el('button', { type: 'button', className: 'link-button', textContent: text });
    button.addEventListener('click', onClick);
    return button;
}

function verificationText(me, peer) {
    if (me && peer) return 'You both confirmed the codes match. Verified.';
    if (me) return 'Waiting for the other person to confirm.';
    if (peer) return 'They say the codes match. Check that you see the same code.';
    return '';
}

function formatCode(sas) {
    return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

function showRelayOption() {
    for (const row of relayRows) row.hidden = !relayAvailable;
    els.ipNotice.textContent = relayAvailable
        ? 'Unless you turn on Hide my IP, the other person will be able to see your IP address.'
        : 'The other person will be able to see your IP address.';
}

function show(overlay) {
    for (const other of overlays) other.hidden = other !== overlay;
}

function open(dialog) {
    if (!dialog.open) dialog.showModal();
}

async function copyLink() {
    if (!inviteLink) return;
    try {
        await navigator.clipboard.writeText(inviteLink);
    } catch {
        // No clipboard access: select the link so it can be copied by hand.
        const range = document.createRange();
        range.selectNodeContents(els.inviteLink);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return;
    }

    clearTimeout(copiedTimer);
    els.inviteLink.textContent = 'Copied to clipboard!';
    els.inviteLink.classList.add('copied');
    copiedTimer = setTimeout(() => {
        els.inviteLink.textContent = inviteLink;
        els.inviteLink.classList.remove('copied');
    }, 1500);
}

function drawQr(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;
    const cell = Math.max(2, Math.floor(240 / (count + margin * 2)));
    canvas.width = canvas.height = (count + margin * 2) * cell;

    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) context.fillRect((col + margin) * cell, (row + margin) * cell, cell, cell);
        }
    }
}

// Grows the box with its text. scrollHeight leaves out the border, so it's added back; the
// scrollbar only appears once the box is at its tallest.
function resizeInput() {
    const input = els.messageInput;
    input.style.height = 'auto';
    const needed = input.scrollHeight + input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(needed, MAX_INPUT_HEIGHT)}px`;
    input.style.overflowY = needed > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
}

// Messages go above the typing indicator and the jump button, which always stay last.
function insertRow(row) {
    els.messages.insertBefore(row, els.typing);
    sizeWatcher.observe(row);
    if (pinned) scrollToBottom();
}

function setMissed(count) {
    missed = count;
    els.jumpButton.hidden = pinned;
    els.jumpText.textContent = count === 0 ? 'Newest messages' : count === 1 ? '1 new message' : `${count} new messages`;
}

function hexPair() {
    return HEX[Math.floor(Math.random() * 16)] + HEX[Math.floor(Math.random() * 16)];
}

function isNearBottom() {
    const { scrollHeight, scrollTop, clientHeight } = els.messages;
    return scrollHeight - scrollTop - clientHeight < 80;
}

function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
}

function revoke(url) {
    URL.revokeObjectURL(url);
    urls.delete(url);
}

function releaseUrls(entry) {
    for (const url of entry.urls) revoke(url);
    entry.urls = [];
}

function hasFiles(event) {
    return Boolean(event.dataTransfer?.types.includes('Files'));
}

function savedHideIp() {
    try {
        return localStorage.getItem('hideIp') === '1';
    } catch {
        return false;
    }
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Builds elements through DOM properties and text nodes only, so nothing is parsed as HTML.
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...children);
    return node;
}
