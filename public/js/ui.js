import qrcode from '../vendor/qrcode.mjs';
import * as alerts from './alerts.js';
import { MAX_FILE_SIZE } from './config.js';
import { el, icon } from './dom.js';
import { EMOJI_CATEGORIES } from './emoji.js';
import { emojiOnly, parse } from './format.js';
import { REACTIONS } from './messages.js';
import { appInvoke, inBackground, isApp, onForeground, serverOrigin } from './platform.js';
import { TransferMeter, timeLeft } from './transfer.js';
import { addImage, forgetImages, initViewer, resetViewer } from './viewer.js';
import { formatDuration, voicePlayer } from './voice-player.js';

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
    editBar: $('editBar'),
    editCancel: $('editCancel'),
    emojiButton: $('emojiButton'),
    emojiPicker: $('emojiPicker'),
    emojiTabs: $('emojiTabs'),
    emojiGrid: $('emojiGrid'),
    toneSelect: $('toneSelect'),
    readReceiptsToggle: $('readReceiptsToggle'),
    menuEdit: $('menuEdit'),
    menuEditShortcut: $('menuEditShortcut'),
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
// Only messages younger than this offer Edit (main.js enforces it too).
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const RECENT_EMOJI = 16;
const MAX_INPUT_HEIGHT = 160;
// A scroll this soon after wheel, touch, key or pointer input counts as the person scrolling.
const USER_SCROLL_MS = 600;
const HEX = '0123456789abcdef';
const CIPHER_PAIRS = 3;
const CIPHER_STEP_MS = 85;
// Messages from the same person this close together share one timestamp.
const GROUP_MS = 5 * 60 * 1000;
// Your own messages show one check once sent and two once delivered (colored once seen). They
// only ever move forward, except when Seen is turned off.
const TICK_STATES = ['sent', 'delivered', 'seen'];
const TICK_PATHS = ['M1 5.6L4.1 8.7L10.3 2.2', 'M6.9 7.1L8.5 8.7L14.7 2.2'];
// A transfer's status text changes at most this often (its bar moves with every chunk), and the
// speed and time left show once it has been going this long.
const PROGRESS_TEXT_MS = 250;
const RATE_AFTER_MS = 1000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Every object URL this page made, with the file behind it.
const urls = new Map();
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
// Whether a mouse button or finger is down right now (see the right-click menu in appendRow).
let pointerHeld = false;
let features = { edit: false };
let editingMode = false;
let divider = null;
let dividerSessionOpen = false;
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
        } else if (event.key === 'Escape' && editingMode) {
            event.preventDefault();
            handlers.onCancelEdit();
        } else if (event.key === 'ArrowUp' && !editingMode && !els.messageInput.value && staged.length === 0) {
            event.preventDefault();
            handlers.onEditLast();
        }
    });
    els.editCancel.addEventListener('click', () => handlers.onCancelEdit());
    initEmojiPicker();
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
    // Only the person scrolling can unpin the view. Scrolls caused by layout, such as a file card
    // shrinking just before its image grows, pull it back to the newest message instead.
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
        els.messages.addEventListener(type, () => {
            userScrolledAt = performance.now();
        }, { passive: true });
    }
    window.addEventListener('pointerdown', () => { pointerHeld = true; }, { capture: true, passive: true });
    for (const type of ['pointerup', 'pointercancel']) {
        window.addEventListener(type, () => { pointerHeld = false; }, { capture: true, passive: true });
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
    initViewer();

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
        // The divider stays where it is, but the next time away starts a new one.
        dividerSessionOpen = false;
        handlers.onForeground();
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
    els.emojiButton.disabled = !enabled;
    els.disappearGroup.disabled = !enabled;
}

// Which optional features the other person's app supports.
export function setFeatures(next) {
    features = next;
}

export function startEdit(text) {
    editingMode = true;
    clearReply();
    els.editBar.hidden = false;
    els.attachButton.disabled = true;
    els.micButton.disabled = true;
    els.messageInput.value = text;
    resizeInput();
    els.messageInput.focus();
    els.messageInput.setSelectionRange(text.length, text.length);
}

export function clearEdit() {
    if (!editingMode) return;
    editingMode = false;
    els.editBar.hidden = true;
    els.attachButton.disabled = !composerEnabled;
    els.micButton.disabled = !composerEnabled;
    els.messageInput.value = '';
    resizeInput();
}

// Replaces the text of a message, keeping any quote it replies to, and labels it as edited.
export function editMessage(id, text) {
    const entry = rows.get(id);
    const bubble = entry?.line.querySelector('.bubble');
    if (!bubble || entry.deleted) return;
    const quote = bubble.querySelector('.quote');
    bubble.replaceChildren(...(quote ? [quote] : []), ...formatted(text), el('span', { className: 'edited', textContent: 'edited' }));
    markJumbo(bubble, text, Boolean(quote));
    entry.text = text;
}

// "Seen" covers the given message and every earlier one of yours.
export function markSeen(id) {
    for (const [rowId, entry] of rows) {
        if (entry.mine && !entry.deleted) setTick(rowId, 'seen', 'Seen');
        if (rowId === id) break;
    }
}

export function clearSeen() {
    for (const entry of rows.values()) {
        if (entry.tick?.dataset.state !== 'seen') continue;
        entry.tick.dataset.state = 'delivered';
        entry.tick.setAttribute('aria-label', 'Delivered');
    }
}

// Whether the newest message is actually in front of the person.
export function newestInView() {
    return pinned && !inBackground();
}

export function readReceiptsPreference() {
    try {
        return localStorage.getItem('readReceipts') === '1';
    } catch {
        return false;
    }
}

export function addMessage({ id, from, text, quote }) {
    const bubble = el('div', { className: 'bubble' });
    if (quote) bubble.append(quoteButton(quote));
    bubble.append(...formatted(text));
    markJumbo(bubble, text, Boolean(quote));
    const entry = appendRow({ id, from, content: bubble, text });
    entry.editable = true;
}

// A message of only a few emoji shows them large, without a bubble. Replies keep the bubble so
// the quote stays readable.
function markJumbo(bubble, text, hasQuote) {
    const count = hasQuote ? 0 : emojiOnly(text);
    bubble.classList.toggle('jumbo', count >= 1 && count <= 3);
    bubble.classList.toggle('jumbo-many', count >= 4 && count <= 10);
}

export function addFile({ id, from, name, size, kind, caption, url = null }) {
    const body = el('div', { className: 'file-body' }, [fileBody(kind, url, name, size)]);
    const progress = el('progress', { max: 1, value: 0 });
    const status = el('span', { className: 'file-status', textContent: from === 'me' ? 'Sending…' : 'Receiving…' });
    const cancel = el('button', { type: 'button', className: 'link-button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => handlers.onCancelFile(id));

    const card = el('div', { className: 'file-card' }, [body, el('div', { className: 'file-progress' }, [progress, status, cancel])]);
    card.classList.toggle('is-image', kind === 'image' && Boolean(url));
    if (caption) card.append(el('div', { className: 'attachment-text' }, formatted(caption)));

    const startedAt = performance.now();
    files.set(id, { card, body, progress, status, cancel, mine: from === 'me', size, meter: new TransferMeter(size, startedAt), startedAt, textAt: -Infinity });
    const entry = appendRow({ id, from, content: card, text: caption });
    if (url) entry.urls.push(url);
}

export function markSent(id) {
    setTick(id, 'sent', 'Sent');
}

export function markDelivered(id) {
    setTick(id, 'delivered', 'Delivered');
}

// "Receiving 42% · 3.1 MB/s · 20 s left".
export function setFileProgress(id, fraction) {
    const file = files.get(id);
    // A send already in flight can report progress after the transfer was cancelled.
    if (!file || file.finished) return;
    file.progress.value = fraction;
    const now = performance.now();
    const { rate, secondsLeft } = file.meter.update(fraction * file.size, now);
    if (now - file.textAt < PROGRESS_TEXT_MS) return;
    file.textAt = now;
    const parts = [`${file.mine ? 'Sending' : 'Receiving'} ${Math.floor(fraction * 100)}%`];
    if (now - file.startedAt >= RATE_AFTER_MS && rate > 0) parts.push(`${formatBytes(Math.round(rate))}/s`, timeLeft(secondsLeft));
    file.status.textContent = parts.join(' · ');
}

export function completeFile(id, { url, kind, name, size }) {
    const file = files.get(id);
    if (!file) return;
    finishFile(file);
    file.body.replaceChildren(fileBody(kind, url, name, size));
    file.card.classList.toggle('is-image', kind === 'image' && Boolean(url));
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
    forgetImages(entry.urls);
    releaseUrls(entry);
    files.delete(id);
    entry.line.replaceChildren(el('div', { className: 'bubble deleted', textContent: 'This message was deleted' }));
    entry.reactions.replaceChildren();
    entry.tick?.remove();
}

export function removeMessage(id) {
    const entry = rows.get(id);
    if (!entry) return;
    forgetImages(entry.urls);
    releaseUrls(entry);
    files.delete(id);
    rows.delete(id);
    sizeWatcher.unobserve(entry.row);
    const { previousElementSibling: previous, nextElementSibling: next } = entry.row;
    entry.row.remove();
    if (next?.classList.contains('msg-row')) next.classList.toggle('continues', continuesGroup(previous, next));
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
    els.typingCipher.replaceChildren(...Array.from({ length: CIPHER_PAIRS }, () => el('span', { textContent: hexPair() })));
    if (reducedMotion.matches) return;
    cipherTimer = setInterval(() => {
        const pairs = els.typingCipher.children;
        const pair = pairs[Math.floor(Math.random() * pairs.length)];
        pair.textContent = hexPair();
        pair.classList.remove('fresh');
        void pair.offsetWidth;
        pair.classList.add('fresh');
    }, CIPHER_STEP_MS);
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
    els.recordingTime.textContent = formatDuration(ms / 1000);
}

export function addSystem(content) {
    insertRow(el('div', { className: 'system-message' }, Array.isArray(content) ? content : [content]));
}

export function noteIncoming() {
    if (!inBackground()) return;
    markNewMessages();
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
    urls.set(url, blob);
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

    if (editingMode) {
        handlers.onSend({ text, files: [], original: false });
        return;
    }
    const outgoing = { text, files: staged.map((item) => item.file), original: els.originalToggle.checked };
    clearStaged();
    clearReply();
    removeDivider();
    els.messageInput.value = '';
    resizeInput();
    handlers.onSend(outgoing);
}

// A "New messages" line above the first message that arrived while you were away. It stays until
// you send something, and moves the next time you're away.
function markNewMessages() {
    if (dividerSessionOpen) return;
    dividerSessionOpen = true;
    const newest = els.typing.previousElementSibling;
    if (!newest?.classList.contains('msg-row')) return;
    divider ??= el('div', { className: 'new-divider', role: 'separator' }, [el('span', { textContent: 'New messages' })]);
    els.messages.insertBefore(divider, newest);
}

function removeDivider() {
    divider?.remove();
    dividerSessionOpen = false;
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
    clearEdit();
    removeDivider();
    showTyping(false);
    sizeWatcher.disconnect();
    els.messages.replaceChildren(els.typing, els.jumpButton);
    sizeWatcher.observe(els.messages);
    sizeWatcher.observe(els.typing);
    pinned = true;
    setMissed(0);
    els.messageInput.value = '';
    resetViewer();
    rows.clear();
    files.clear();
    for (const url of urls.keys()) URL.revokeObjectURL(url);
    urls.clear();
}

// One message on screen: the bubble or file card with its ⋯ menu, reactions, and the time (plus
// ticks for your own messages). Hovering it shows its exact time, and right-clicking it opens the
// same menu as the ⋯ button.
function appendRow({ id, from, content, text = '' }) {
    const mine = from === 'me';
    const now = new Date();
    const row = el('div', { className: mine ? 'msg-row me' : 'msg-row peer' });
    row.dataset.at = String(now.getTime());

    const actions = el('button', { type: 'button', className: 'msg-actions', textContent: '⋯' });
    actions.setAttribute('aria-label', 'Message options');
    actions.addEventListener('click', () => openMenu(id, actions));
    const line = el('div', { className: 'msg-line', title: now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }, [content, actions]);
    line.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const at = { x: event.clientX, y: event.clientY };
        if (!pointerHeld) return openMenu(id, at);
        // On Linux, macOS and phones this fires while the button is still down, and letting go
        // would close the menu right away. Open it once the button is released instead.
        const release = () => {
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', release);
            setTimeout(() => openMenu(id, at), 0);
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
    });
    const reactions = el('div', { className: 'reactions' });
    const meta = el('div', { className: 'msg-meta' }, [el('time', { textContent: formatTime(now), dateTime: now.toISOString() })]);
    let tick = null;
    if (mine) {
        tick = el('span', { className: 'ticks' }, [icon('0 0 16 11', ...TICK_PATHS)]);
        tick.setAttribute('aria-label', 'Sending');
        meta.append(tick);
    }
    row.append(line, reactions, meta);

    // Sending something always brings you back to the newest message.
    if (mine) pinned = true;
    else if (!pinned) setMissed(missed + 1);
    row.classList.toggle('continues', continuesGroup(els.typing.previousElementSibling, row));
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
    els.menuEdit.addEventListener('click', () => menuAction(() => handlers.onStartEdit(menuTarget)));
    els.menuCopy.addEventListener('click', () => menuAction(() => {
        const text = rows.get(menuTarget)?.text;
        if (text) navigator.clipboard.writeText(text).catch(() => {});
    }));
}

// Opens beside the ⋯ button, or at the pointer when the message was right-clicked.
function openMenu(id, anchor) {
    const entry = rows.get(id);
    if (!entry || entry.deleted) return;
    menuTarget = id;
    els.menuCopy.hidden = !entry.text;
    els.menuDelete.hidden = !entry.mine;
    els.menuEdit.hidden = !(features.edit && entry.mine && entry.editable && Date.now() - Number(entry.row.dataset.at) < EDIT_WINDOW_MS);
    // ↑ in an empty message box edits your newest message, so its Edit shows the shortcut.
    els.menuEditShortcut.hidden = els.menuEdit.hidden || id !== newestEditable();
    if (els.messageMenu.matches(':popover-open')) els.messageMenu.hidePopover();
    els.messageMenu.showPopover();

    const atPointer = !(anchor instanceof Element);
    const button = atPointer ? { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y } : anchor.getBoundingClientRect();
    const menu = els.messageMenu.getBoundingClientRect();
    const preferred = !atPointer && entry.mine ? button.right - menu.width : button.left;
    const left = Math.min(window.innerWidth - menu.width - 8, Math.max(8, preferred));
    const below = button.bottom + 4;
    const top = below + menu.height > window.innerHeight - 8 ? button.top - menu.height - 4 : below;
    els.messageMenu.style.left = `${left}px`;
    els.messageMenu.style.top = `${Math.max(8, top)}px`;
}

// Your newest text message that's still there: the one ↑ edits (main.js editLast).
function newestEditable() {
    let newest = null;
    for (const [id, entry] of rows) {
        if (entry.mine && entry.editable && !entry.deleted) newest = id;
    }
    return newest;
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
    els.toneSelect.value = alerts.tone();
    els.toneSelect.addEventListener('change', () => {
        alerts.setTone(els.toneSelect.value);
        alerts.preview();
    });
    els.readReceiptsToggle.checked = readReceiptsPreference();
    els.readReceiptsToggle.addEventListener('change', () => {
        try {
            localStorage.setItem('readReceipts', els.readReceiptsToggle.checked ? '1' : '0');
        } catch {
            // Not saved; the choice still applies to this chat.
        }
        handlers.onReadReceipts(els.readReceiptsToggle.checked);
    });
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

// Builds a message's formatting and links (see format.js) as DOM nodes. Links are never fetched
// or previewed.
function formatted(text) {
    return parse(text).map(function build(segment) {
        switch (segment.type) {
            case 'bold': return el('strong', {}, segment.children.map(build));
            case 'italic': return el('em', {}, segment.children.map(build));
            case 'strike': return el('s', {}, segment.children.map(build));
            case 'code': return el('code', { textContent: segment.text });
            case 'pre': return el('pre', {}, [el('code', { textContent: segment.text })]);
            case 'link': return el('a', { href: segment.href, target: '_blank', rel: 'noopener noreferrer', textContent: segment.text });
            default: return segment.text;
        }
    });
}

// The emoji picker: categories, a "Recent" row kept on this device, and insertion at the cursor.
function initEmojiPicker() {
    const categories = [{ name: 'Recent', icon: '🕘', emoji: [] }, ...EMOJI_CATEGORIES];
    let current = recentEmoji().length > 0 ? 0 : 1;

    const show = (index) => {
        current = index;
        categories[0].emoji = recentEmoji();
        for (const [i, tab] of [...els.emojiTabs.children].entries()) tab.setAttribute('aria-selected', String(i === index));
        els.emojiGrid.replaceChildren(...categories[index].emoji.map((emoji) => {
            const button = el('button', { type: 'button', className: 'emoji-choice', textContent: emoji });
            button.setAttribute('aria-label', emoji);
            button.addEventListener('click', () => insertEmoji(emoji));
            return button;
        }));
        if (index === 0 && categories[0].emoji.length === 0) els.emojiGrid.append(el('p', { className: 'emoji-empty', textContent: 'Emoji you use show up here.' }));
    };

    els.emojiTabs.replaceChildren(...categories.map((category, index) => {
        const tab = el('button', { type: 'button', className: 'emoji-tab', textContent: category.icon, title: category.name });
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-label', category.name);
        tab.addEventListener('click', () => show(index));
        return tab;
    }));

    els.emojiButton.addEventListener('click', () => {
        if (els.emojiPicker.matches(':popover-open')) return els.emojiPicker.hidePopover();
        show(current);
        els.emojiPicker.showPopover();
        const button = els.emojiButton.getBoundingClientRect();
        const picker = els.emojiPicker.getBoundingClientRect();
        els.emojiPicker.style.left = `${Math.max(8, Math.min(window.innerWidth - picker.width - 8, button.right - picker.width))}px`;
        els.emojiPicker.style.top = `${Math.max(8, button.top - picker.height - 8)}px`;
        els.emojiGrid.querySelector('button')?.focus();
    });

    function insertEmoji(emoji) {
        const input = els.messageInput;
        input.focus();
        input.setRangeText(emoji, input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input'));
        saveRecentEmoji(emoji);
    }
}

function recentEmoji() {
    try {
        const saved = JSON.parse(localStorage.getItem('recentEmoji') || '[]');
        const known = new Set(EMOJI_CATEGORIES.flatMap((category) => category.emoji));
        return Array.isArray(saved) ? saved.filter((emoji) => known.has(emoji)).slice(0, RECENT_EMOJI) : [];
    } catch {
        return [];
    }
}

function saveRecentEmoji(emoji) {
    try {
        localStorage.setItem('recentEmoji', JSON.stringify([emoji, ...recentEmoji().filter((other) => other !== emoji)].slice(0, RECENT_EMOJI)));
    } catch {
        // Not saved; the picker just won't remember it.
    }
}

function setTick(id, state, label) {
    const tick = rows.get(id)?.tick;
    if (!tick || TICK_STATES.indexOf(tick.dataset.state) >= TICK_STATES.indexOf(state)) return;
    tick.dataset.state = state;
    tick.setAttribute('aria-label', label);
}

function finishFile(file) {
    file.finished = true;
    file.progress.hidden = true;
    file.cancel.hidden = true;
    file.status.hidden = true;
}

function fileBody(kind, url, name, size) {
    if (kind === 'image' && url) return imageButton(url, name, size);
    if (kind === 'audio' && url) return voicePlayer(url, urls.get(url));
    return fileLabel(name, size, url);
}

function imageButton(url, name, size) {
    const button = el('button', { type: 'button', className: 'image-button' }, [el('img', { src: url, alt: name })]);
    button.setAttribute('aria-label', `Open ${name}`);
    addImage(button, { url, name, size: formatBytes(size) });
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

// Whether a message continues the previous one's group: same person, sent soon after.
function continuesGroup(previous, row) {
    if (!previous?.classList.contains('msg-row')) return false;
    const sameSender = previous.classList.contains('me') === row.classList.contains('me');
    return sameSender && Number(row.dataset.at) - Number(previous.dataset.at) < GROUP_MS;
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
