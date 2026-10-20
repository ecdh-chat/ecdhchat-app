import * as alerts from './alerts.js';
import { Call } from './call.js';
import { INLINE_AUDIO_TYPES, INLINE_IMAGE_TYPES, MAX_FILE_SIZE, MAX_RECORDING_MS, TYPING_DISPLAY_MS, TYPING_SEND_INTERVAL_MS } from './config.js';
import { Connection } from './connection.js';
import { ask, initDesktop } from './desktop.js';
import { plainText } from './format.js';
import { cleanImage } from './images.js';
import { startRecording, voiceMessageName } from './media.js';
import { FEATURES, MessageType, NO_CALLS, encode, encodeChunk, encodeTyping, encodeVerified, randomId } from './messages.js';
import { callsAvailable, inviteFragment, isApp, rtcAvailable, serverOrigin } from './platform.js';
import { decodeBase64Url, encodeBase64Url, randomSecret } from './secure-channel.js';
import { connectSignaling } from './signaling.js';
import { initTheme } from './theme.js';
import { readChunks } from './transfer.js';
import * as ui from './ui.js';

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVITE = /^#([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})$/;
const SERVER_ERRORS = { unavailable: 'unavailable', expired: 'expired', 'rate-limited': 'rate-limited', busy: 'busy' };
const PHASE_STATUS = {
    invited: 'Invitation',
    inviting: 'Waiting for them to join',
    joining: 'Joining…',
    connecting: 'Connecting…',
};
const DURATIONS = { 30: '30 seconds', 300: '5 minutes', 3600: '1 hour' };
// Your own messages can be edited for 15 minutes; theirs are accepted with a minute's slack.
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const EDIT_ACCEPT_MS = 16 * 60 * 1000;
const SEEN_DELAY_MS = 400;

// phase: starting → (creator) inviting | (joiner) invited → joining → connecting → open → ended
let phase = 'starting';
let roomId = null;
let secret = null;
let iceServers = [];
let relayAvailable = false;
let signaling = null;
let connection = null;
let call = null;
let callBusy = false;
let settings = { disappearAfter: 0, version: 0 };
let replyTo = null;
let recording = null;
let recordingStarting = false;
let recordingTimer = null;
let typingTimer = null;
let typingSent = false;
let typingSentAt = 0;
let fileQueue = Promise.resolve();
// What the other person's app announced it can do (see FEATURES in messages.js).
let peerFeatures = [];
let editing = null;
let readReceipts = ui.readReceiptsPreference();
let peerReadReceipts = false;
let seenTimer = null;
let lastSeenSent = null;
const messages = new Map();

initTheme(document.getElementById('themeToggle'));
ui.init({
    onSend: send,
    onTyping: typingChanged,
    onJoin: join,
    onEnd: endChat,
    onVerify: verify,
    onCancelFile: cancelFile,
    onNewRoom: () => location.reload(),
    onNewChat: () => location.assign('/'),
    onReply: startReply,
    onCancelReply: () => { replyTo = null; },
    onReact: toggleReaction,
    onDelete: deleteMessage,
    onDisappear: setDisappearing,
    onRecord: record,
    onCall: (video) => call?.start(video),
    onStartEdit: startEdit,
    onEditLast: editLast,
    onCancelEdit: cancelEdit,
    onReadReceipts: setReadReceipts,
    onForeground: sendSeen,
    onPasteInvite: pasteInvite,
});
window.addEventListener('pagehide', () => {
    connection?.peer.close();
    signaling?.close();
});
if (isApp) {
    // The Rust side calls this when someone opens an ecdhchat:// invite link with the app.
    window.ecdhOpenInvite = (link) => pasteInvite(link);
    initDesktop({ busy: chatBusy, leave: leaveChat, newChat: () => location.assign('/'), openSettings: ui.openSettings });
}
start();

async function start() {
    // The invite secret is read once and never left in the address bar or history.
    const { hash } = location;
    if (hash) history.replaceState(null, '', location.pathname);

    if (!window.isSecureContext || !window.crypto?.subtle || !rtcAvailable()) return end('unsupported');
    relayAvailable = await fetchRelayAvailable();

    if (!hash) return create();

    const match = INVITE.exec(hash);
    const decoded = match && ROOM_ID.test(match[1]) ? decodeBase64Url(match[2]) : null;
    if (!decoded || decoded.length !== 16) return end('invalid-link');

    roomId = match[1];
    secret = decoded;
    setPhase('invited');
    ui.showJoin(relayAvailable, `ecdhchat://join${hash}`);
}

// Returns false when the link isn't an invite for this server. Only the app opens pasted links.
function pasteInvite(link) {
    const fragment = inviteFragment(link, serverOrigin());
    if (!fragment) return false;
    openInvite(fragment);
    return true;
}

async function openInvite(fragment) {
    if (chatBusy()) {
        if (!(await ask('Leave this chat?', 'Opening the new invite ends this chat for both of you.', 'Leave and open invite'))) return;
        await leaveChat();
    }
    history.replaceState(null, '', fragment);
    location.reload();
}

function chatBusy() {
    return phase === 'connecting' || phase === 'open';
}

// Says goodbye so the other person sees the chat end right away, not after a timeout.
async function leaveChat() {
    if (phase === 'open') await connection.sayGoodbye('ended');
}

function create() {
    secret = randomSecret();
    setPhase('inviting');
    ui.showInvitePending(relayAvailable);
    openSignaling().send({ type: 'create' });
}

function join() {
    if (phase !== 'invited') return;
    setPhase('joining');
    ui.hideOverlays();
    openSignaling().send({ type: 'join', roomId });
}

function openSignaling() {
    signaling = connectSignaling({ onMessage: handleSignaling, onClose: handleSignalingClosed });
    return signaling;
}

function handleSignaling(message) {
    if (phase === 'ended') return;

    switch (message.type) {
        case 'created':
            if (phase !== 'inviting' || typeof message.roomId !== 'string' || !ROOM_ID.test(message.roomId)) return;
            roomId = message.roomId;
            iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
            ui.showInvite(`${serverOrigin()}/#${roomId}.${encodeBase64Url(secret)}`);
            break;

        case 'joined':
            if (phase !== 'joining') return;
            iceServers = Array.isArray(message.iceServers) ? message.iceServers : [];
            connect('joiner');
            break;

        case 'peer-joined':
            if (phase !== 'inviting' || !roomId) return;
            ui.hideOverlays();
            connect('creator');
            break;

        case 'signal':
            if (message.signal && typeof message.signal === 'object') connection?.handleSignal(message.signal);
            break;

        // Once the chat is open it no longer depends on the server, so these can't end it.
        case 'peer-left':
            if (phase !== 'open') end('peer-left');
            break;

        case 'error':
            if (phase !== 'open') end(SERVER_ERRORS[message.code] || 'server-lost');
            break;
    }
}

function handleSignalingClosed() {
    signaling = null;
    if (phase !== 'open') end('server-lost');
}

function connect(role) {
    setPhase('connecting');
    try {
        connection = new Connection({
            role,
            roomId,
            secret,
            iceServers,
            relayOnly: ui.relayOnly(),
            sendSignal: (signal) => signaling?.send({ type: 'signal', signal }),
            onOpen: connectionOpened,
            onMessage: receive,
            onClose: end,
            onStateChange: connectionStateChanged,
            onTrack: (event) => call?.handleTrack(event),
        });
    } catch {
        end('connect-failed');
    }
}

function connectionOpened() {
    setPhase('open');
    ui.openChat();
    call = callsAvailable
        ? new Call({
            connection,
            onSystem: ui.addSystem,
            onBusyChange: (busy) => {
                callBusy = busy;
                updateControls();
            },
        })
        : null;
    // Older apps read only the fields they know from SETTINGS, so this is how both sides learn
    // what the other can do without upsetting a version that can't.
    const features = callsAvailable ? FEATURES : [...FEATURES.filter((name) => name !== 'screen'), NO_CALLS];
    sendMessage(encode(MessageType.SETTINGS, { ...settings, features }));
    if (!callsAvailable) ui.addSystem('Calls aren’t in the Linux app yet. For calls, open ecdh.chat in a browser.');
    updateStatus();
    updateControls();
}

function connectionStateChanged(state) {
    if (phase !== 'open') return;
    if (state === 'disconnected') ui.setStatus('Reconnecting…', 'warning', false);
    if (state === 'connected') updateStatus();
}

function setPhase(next) {
    phase = next;
    if (PHASE_STATUS[next]) ui.setStatus(PHASE_STATUS[next], 'neutral', false);
    updateControls();
}

function updateControls() {
    if (phase === 'ended') return;
    ui.setChatControls({
        end: phase === 'connecting' || phase === 'open',
        call: phase === 'open' && Boolean(call) && !callBusy && !hasFeature(NO_CALLS),
    });
}

function updateStatus() {
    if (phase !== 'open') return;
    const { sas, verifiedByMe, verifiedByPeer } = connection;
    ui.setVerification({ sas, me: verifiedByMe, peer: verifiedByPeer });
    if (verifiedByMe && verifiedByPeer) ui.setStatus('Verified', 'success', true);
    else if (verifiedByMe) ui.setStatus('Waiting for them to confirm', 'warning', true);
    else if (verifiedByPeer) ui.setStatus('They confirmed: check the code', 'warning', true);
    else ui.setStatus('Not verified', 'warning', true);
}

function verify(match) {
    if (phase !== 'open') return;
    if (!match) {
        connection.sayGoodbye('mismatch');
        return;
    }
    if (connection.verifiedByMe) return;
    connection.verifiedByMe = true;
    sendMessage(encodeVerified());
    updateStatus();
}

async function endChat() {
    await leaveChat();
    end('you-ended');
}

function end(reason) {
    if (phase === 'ended') return;
    phase = 'ended';
    cancelRecording();
    call?.dispose();
    call = null;
    connection?.close('you-ended');
    connection = null;
    for (const message of messages.values()) clearTimeout(message.timer);
    messages.clear();
    clearTimeout(typingTimer);
    signaling?.close();
    signaling = null;
    secret = null;
    ui.showEnded(reason);
}

function receive(message) {
    switch (message.type) {
        case MessageType.TEXT:
            if (messages.has(message.id)) return;
            peerTyping(false);
            remember(message.id, { from: 'them', kind: 'text', text: message.text });
            ui.addMessage({ id: message.id, from: 'them', text: message.text, quote: quoteFor(message.replyTo) });
            expireLater(message.id, message.expiresIn);
            incoming();
            sendMessage(encode(MessageType.RECEIPT, { id: message.id }));
            break;
        case MessageType.RECEIPT:
            if (messages.get(message.id)?.from === 'me') ui.markDelivered(message.id);
            break;
        case MessageType.TYPING:
            peerTyping(message.typing);
            break;
        case MessageType.VERIFIED:
            connection.verifiedByPeer = true;
            updateStatus();
            break;
        case MessageType.FILE_OFFER:
            receiveOffer(message);
            break;
        case MessageType.FILE_CHUNK:
            receiveChunk(message);
            break;
        case MessageType.FILE_CANCEL:
            if (stopTransfer(message.id)) ui.setFileState(message.id, 'cancelled-by-peer');
            break;
        case MessageType.REACTION:
            react(message.id, 'them', message.emoji, message.on);
            break;
        case MessageType.DELETE:
            deleted(message.id);
            break;
        case MessageType.SETTINGS:
            applySettings(message);
            break;
        case MessageType.CALL:
            if (call) call.handleMessage(message);
            else if (message.action === 'invite') declineCall(message.video);
            break;
        case MessageType.EDIT:
            edited(message);
            break;
        case MessageType.PREFS:
            peerReadReceipts = message.readReceipts;
            seenSettingChanged();
            break;
        case MessageType.SEEN:
            if (bothSeeReceipts() && messages.get(message.id)?.from === 'me') ui.markSeen(message.id);
            break;
    }
}

// Sends one message to the other person. Nothing is sent once the chat has ended.
function sendMessage(bytes) {
    return connection ? connection.send(bytes) : Promise.resolve();
}

function send({ text, files, original }) {
    if (phase !== 'open') return;
    if (editing) {
        finishEdit(text);
        return;
    }
    stopTyping();
    const reply = replyTo;
    replyTo = null;
    if (files.length === 1 && text && !reply) {
        queueFile(files[0], text, original);
        return;
    }
    if (text) sendText(text, reply);
    for (const file of files) queueFile(file, '', original);
}

function sendText(text, reply) {
    const id = randomId();
    const expiresIn = settings.disappearAfter;
    remember(id, { from: 'me', kind: 'text', text });
    ui.addMessage({ id, from: 'me', text, quote: quoteFor(reply) });
    expireLater(id, expiresIn);
    sendMessage(encode(MessageType.TEXT, { id, text, replyTo: reply ?? undefined, expiresIn: expiresIn || undefined })).then(() => ui.markSent(id));
}

function remember(id, message) {
    messages.set(id, { id, reactions: new Map(), timer: null, deleted: false, at: Date.now(), ...message });
}

function incoming() {
    ui.noteIncoming();
    alerts.alertMessage();
    sendSeen();
}

function hasFeature(name) {
    return peerFeatures.includes(name);
}

// An older app can still try to call this one where calls aren't available.
function declineCall(video) {
    sendMessage(encode(MessageType.CALL, { action: 'decline', video }));
    ui.addSystem('They tried to call. Calls aren’t in the Linux app yet; use ecdh.chat in a browser for calls.');
}

function setPeerFeatures(features) {
    peerFeatures = features;
    if (callsAvailable && hasFeature(NO_CALLS)) {
        ui.addSystem('They’re using the Linux app, which can’t take calls yet.');
        updateControls();
    }
    ui.setFeatures({ edit: hasFeature('edit') });
    call?.setScreenSharing(hasFeature('screen'));
    if (hasFeature('seen')) sendMessage(encode(MessageType.PREFS, { readReceipts }));
}

// Editing: only your own text messages, only for 15 minutes, only with an app that understands it.
function canEdit(message) {
    return hasFeature('edit') && message?.from === 'me' && message.kind === 'text' && !message.deleted && Date.now() - message.at < EDIT_WINDOW_MS;
}

function startEdit(id) {
    const message = messages.get(id);
    if (phase !== 'open' || !canEdit(message)) return;
    editing = id;
    replyTo = null;
    ui.startEdit(message.text);
}

function editLast() {
    const mine = [...messages.values()].reverse().find((message) => message.from === 'me' && message.kind === 'text' && !message.deleted);
    if (mine && canEdit(mine)) startEdit(mine.id);
}

function cancelEdit() {
    editing = null;
    ui.clearEdit();
}

function finishEdit(text) {
    const message = messages.get(editing);
    cancelEdit();
    if (!text || !canEdit(message) || text === message.text) return;
    message.text = text;
    ui.editMessage(message.id, text);
    sendMessage(encode(MessageType.EDIT, { id: message.id, text }));
}

// Their edit is only taken for their own, still-visible text message, sent less than 16 minutes ago.
function edited({ id, text }) {
    const message = messages.get(id);
    if (!message || message.from !== 'them' || message.kind !== 'text' || message.deleted || Date.now() - message.at > EDIT_ACCEPT_MS) return;
    message.text = text;
    ui.editMessage(id, text);
}

// "Seen" works only when both people have it on, and only reports messages you've actually had
// in front of you: the window in the foreground and the newest message in view.
function bothSeeReceipts() {
    return readReceipts && peerReadReceipts && hasFeature('seen');
}

function setReadReceipts(on) {
    readReceipts = on;
    if (phase === 'open' && hasFeature('seen')) sendMessage(encode(MessageType.PREFS, { readReceipts }));
    seenSettingChanged();
}

function seenSettingChanged() {
    if (!bothSeeReceipts()) {
        ui.clearSeen();
        lastSeenSent = null;
        return;
    }
    sendSeen();
}

function sendSeen() {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
        if (phase !== 'open' || !bothSeeReceipts() || !ui.newestInView()) return;
        const newest = [...messages.values()].reverse().find((message) => message.from === 'them' && !message.deleted);
        if (!newest || newest.id === lastSeenSent) return;
        lastSeenSent = newest.id;
        sendMessage(encode(MessageType.SEEN, { id: newest.id }));
    }, SEEN_DELAY_MS);
}

function label(from) {
    return from === 'me' ? 'You' : 'Them';
}

function typingChanged(hasText) {
    if (phase !== 'open') return;
    if (hasText && (!typingSent || Date.now() - typingSentAt > TYPING_SEND_INTERVAL_MS)) {
        typingSent = true;
        typingSentAt = Date.now();
        sendMessage(encodeTyping(true));
    } else if (!hasText) {
        stopTyping();
    }
}

function stopTyping() {
    if (!typingSent) return;
    typingSent = false;
    sendMessage(encodeTyping(false));
}

function peerTyping(isTyping) {
    clearTimeout(typingTimer);
    ui.showTyping(isTyping);
    if (isTyping) typingTimer = setTimeout(() => ui.showTyping(false), TYPING_DISPLAY_MS);
}

function startReply(id) {
    const quote = quoteFor(id);
    if (!quote || phase !== 'open') return;
    replyTo = id;
    ui.startReply(quote);
}

function quoteFor(id) {
    if (!id) return null;
    const message = messages.get(id);
    if (!message || message.deleted) return { id, label: '', snippet: 'Original message isn’t available' };
    const snippet = message.kind === 'text' ? plainText(message.text)
        : message.kind === 'audio' ? 'Voice message'
        : message.kind === 'image' ? (message.text ? `Photo: ${message.text}` : 'Photo')
        : `File: ${message.name}`;
    return { id, label: label(message.from), snippet: snippet.slice(0, 120) };
}

function toggleReaction(id, emoji) {
    const message = messages.get(id);
    if (!message || message.deleted || phase !== 'open') return;
    const on = !message.reactions.get(emoji)?.has('me');
    react(id, 'me', emoji, on);
    sendMessage(encode(MessageType.REACTION, { id, emoji, on }));
}

function react(id, who, emoji, on) {
    const message = messages.get(id);
    if (!message || message.deleted) return;
    const people = message.reactions.get(emoji) ?? new Set();
    if (on) people.add(who);
    else people.delete(who);
    message.reactions.set(emoji, people);
    ui.setReactions(id, [...message.reactions]
        .filter(([, reacted]) => reacted.size > 0)
        .map(([symbol, reacted]) => ({ emoji: symbol, count: reacted.size, mine: reacted.has('me'), names: reacted.size > 1 ? 'You and them' : label([...reacted][0]) })));
}

function deleteMessage(id) {
    const message = messages.get(id);
    if (!message || message.from !== 'me' || message.deleted || phase !== 'open') return;
    if (message.transfer) message.transfer.cancelled = true;
    forget(id, true);
    sendMessage(encode(MessageType.DELETE, { id }));
}

// Only the person who sent a message can delete it.
function deleted(id) {
    const message = messages.get(id);
    if (!message || message.from !== 'them' || message.deleted) return;
    connection.incoming.cancel(id);
    forget(id, true);
}

// "Delete for everyone" leaves a placeholder; a disappearing message is removed entirely.
function forget(id, placeholder) {
    const message = messages.get(id);
    if (!message) return;
    clearTimeout(message.timer);
    if (placeholder) {
        message.deleted = true;
        message.text = '';
        message.reactions.clear();
        ui.markDeleted(id);
    } else {
        messages.delete(id);
        ui.removeMessage(id);
    }
}

function expireLater(id, seconds) {
    const message = messages.get(id);
    if (!message || !seconds) return;
    message.timer = setTimeout(() => {
        if (message.transfer) message.transfer.cancelled = true;
        if (message.from === 'them') connection?.incoming.cancel(id);
        forget(id, false);
    }, seconds * 1000);
}

function setDisappearing(seconds) {
    if (phase !== 'open' || seconds === settings.disappearAfter) return;
    settings = { disappearAfter: seconds, version: settings.version + 1 };
    sendMessage(encode(MessageType.SETTINGS, settings));
    ui.setDisappearing(seconds);
    ui.addSystem(disappearNote('You', seconds));
}

// The newest change wins on both sides. If both of you change it at the same moment, the
// change from whoever made the room wins.
function applySettings({ disappearAfter, version, features }) {
    if (features) setPeerFeatures(features);
    if (version < settings.version || (version === settings.version && connection.role === 'creator')) return;
    const changed = disappearAfter !== settings.disappearAfter;
    settings = { disappearAfter, version };
    ui.setDisappearing(disappearAfter);
    if (changed) ui.addSystem(disappearNote('They', disappearAfter));
}

function disappearNote(who, seconds) {
    return seconds
        ? `${who} turned on disappearing messages. New messages vanish after ${DURATIONS[seconds]}.`
        : `${who} turned off disappearing messages.`;
}

function queueFile(file, caption, original, kind) {
    fileQueue = fileQueue.then(() => sendFile(file, caption, original, kind)).catch(() => {});
}

async function sendFile(file, caption, original, forcedKind) {
    if (phase !== 'open') return;

    let blob = file;
    let name = shortName(file.name || 'file');
    let mime = file.type.split(';')[0];
    let kind = INLINE_IMAGE_TYPES.includes(mime) ? 'image' : INLINE_AUDIO_TYPES.includes(mime) ? 'audio' : 'file';
    if (forcedKind === 'audio') {
        kind = 'audio';
        mime = file.type;
    } else if (!original && file.type.startsWith('image/')) {
        try {
            const cleaned = await cleanImage(file);
            blob = cleaned.blob;
            name = shortName(cleaned.name);
            mime = cleaned.type;
            kind = 'image';
        } catch {
            // This browser can't read the image, so it goes as a plain file.
            kind = 'file';
        }
    }
    if (kind === 'file') mime = '';
    if (phase !== 'open') return;
    if (blob.size > MAX_FILE_SIZE) {
        ui.addSystem(`“${name}” is larger than ${ui.formatBytes(MAX_FILE_SIZE)}, so it can’t be sent.`);
        return;
    }

    const id = randomId();
    const expiresIn = settings.disappearAfter;
    const transfer = { cancelled: false };
    remember(id, { from: 'me', kind, name, text: caption, transfer });
    ui.addFile({ id, from: 'me', name, size: blob.size, kind, caption, url: kind === 'file' ? null : ui.objectUrl(blob) });
    expireLater(id, expiresIn);
    await sendMessage(encode(MessageType.FILE_OFFER, { id, name, size: blob.size, mime, kind, caption, expiresIn: expiresIn || undefined }));

    let index = 0;
    let sent = 0;
    for await (const data of readChunks(blob)) {
        if (transfer.cancelled || phase !== 'open') return;
        await sendMessage(encodeChunk(id, index++, data));
        sent += data.length;
        ui.setFileProgress(id, sent / blob.size);
    }

    const message = messages.get(id);
    if (!message || transfer.cancelled || phase !== 'open') return;
    message.transfer = null;
    ui.setFileState(id, 'sent');
}

function cancelFile(id) {
    if (!stopTransfer(id)) return;
    ui.setFileState(id, 'cancelled');
    sendMessage(encode(MessageType.FILE_CANCEL, { id }));
}

// Stops a file that's still on its way, in either direction.
function stopTransfer(id) {
    const transfer = messages.get(id)?.transfer;
    if (transfer) {
        if (transfer.cancelled) return false;
        transfer.cancelled = true;
        return true;
    }
    return connection?.incoming.cancel(id) ?? false;
}

function receiveOffer(offer) {
    if (messages.has(offer.id)) return;
    const result = connection.incoming.offer(offer);
    const { transfer } = result;
    remember(transfer.id, { from: 'them', kind: transfer.kind, name: transfer.name, text: transfer.caption });
    ui.addFile({ id: transfer.id, from: 'them', name: transfer.name, size: transfer.size, kind: transfer.kind, caption: transfer.caption });
    expireLater(transfer.id, offer.expiresIn);
    incoming();
    if (result.done) received(transfer, result.blob);
}

function receiveChunk({ id, index, data }) {
    const result = connection.incoming.chunk(id, index, data);
    if (!result) return;
    if (result.done) received(result.transfer, result.blob);
    else ui.setFileProgress(id, result.transfer.received / result.transfer.size);
}

function received(transfer, blob) {
    ui.completeFile(transfer.id, { url: ui.objectUrl(blob), kind: transfer.kind, name: transfer.name, size: transfer.size });
    sendMessage(encode(MessageType.RECEIPT, { id: transfer.id }));
}

async function record(action) {
    if (action === 'start') {
        if (recording || recordingStarting || phase !== 'open') return;
        recordingStarting = true;
        try {
            recording = await startRecording();
        } catch {
            ui.addSystem('Couldn’t use your microphone. Check this site’s permissions in your browser.');
            return;
        } finally {
            recordingStarting = false;
        }
        const startedAt = Date.now();
        ui.showRecording(true);
        recordingTimer = setInterval(() => {
            const elapsed = Date.now() - startedAt;
            ui.setRecordingTime(elapsed);
            if (elapsed >= MAX_RECORDING_MS) record('send');
        }, 250);
        return;
    }

    const current = recording;
    if (!current) return;
    recording = null;
    clearInterval(recordingTimer);
    ui.showRecording(false);
    if (action === 'cancel') {
        await current.cancel();
        return;
    }
    const blob = await current.stop();
    if (blob && blob.size > 0 && phase === 'open') {
        queueFile(new File([blob], voiceMessageName(blob.type), { type: blob.type }), '', true, 'audio');
    }
}

function cancelRecording() {
    clearInterval(recordingTimer);
    recording?.cancel();
    recording = null;
}

function shortName(name) {
    if (name.length <= 255) return name;
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    return name.slice(0, 255 - extension.length) + extension;
}

async function fetchRelayAvailable() {
    try {
        const res = await fetch(`${serverOrigin()}/api/config`, { cache: 'no-store' });
        return res.ok && (await res.json()).relay === true;
    } catch {
        return false;
    }
}
