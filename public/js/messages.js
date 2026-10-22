import { CHUNK_SIZE, MAX_FILE_SIZE, MAX_TEXT_LENGTH } from './config.js';

// Chat messages travel inside encrypted records as [type byte][body].
export const MessageType = Object.freeze({
    TEXT: 1,
    RECEIPT: 2,
    TYPING: 3,
    VERIFIED: 4,
    BYE: 5,
    FILE_OFFER: 6,
    FILE_CHUNK: 7,
    FILE_CANCEL: 8,
    REACTION: 9,
    DELETE: 10,
    SETTINGS: 11,
    CALL: 12,
    RTC: 13,
    EDIT: 14,
    PREFS: 15,
    SEEN: 16,
    PADDED: 17,
});

// What each side can do beyond 3.1. They're announced inside SETTINGS, whose extra fields older
// apps ignore, and a feature is only used when both sides announce it.
export const FEATURES = ['edit', 'seen', 'screen', 'pad'];
// Announced only by an app that can't take calls (the Linux app, for now), so the other side
// hides its call buttons. It's an opt-out because older apps announce nothing at all.
export const NO_CALLS = 'no-calls';
const KNOWN_FEATURES = [...FEATURES, NO_CALLS];

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
export const DISAPPEAR_OPTIONS = [0, 30, 300, 3600];
const CALL_ACTIONS = ['invite', 'accept', 'decline', 'end', 'busy', 'screen-on', 'screen-off'];
const MAX_SDP = 32 * 1024;
const MAX_VERSION = 1e9;

export class ProtocolError extends Error {}

const ID = /^[0-9a-f]{32}$/;
const CHUNK_HEADER = 21;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function randomId() {
    return toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export function encode(type, body) {
    const json = encoder.encode(JSON.stringify(body));
    const bytes = new Uint8Array(1 + json.length);
    bytes[0] = type;
    bytes.set(json, 1);
    return bytes;
}

// Short messages are padded to a few fixed sizes, so their length doesn't show what they are (a
// typing signal, a receipt, a short or long text) to anyone watching the encrypted traffic.
// Longer ones (descriptions, file chunks) are left as they are: frames have a size limit, and a
// file's size is no secret from the network anyway. Only sent once the other side announces 'pad'.
const PAD_BUCKETS = [256, 1024, 4096];
const PAD_HEADER = 5;

export function pad(bytes) {
    const size = PAD_BUCKETS.find((bucket) => bucket >= PAD_HEADER + bytes.length);
    if (!size || bytes[0] === MessageType.PADDED) return bytes;
    const padded = new Uint8Array(size);
    padded[0] = MessageType.PADDED;
    new DataView(padded.buffer).setUint32(1, bytes.length);
    padded.set(bytes, PAD_HEADER);
    return padded;
}

export function encodeTyping(typing) {
    return Uint8Array.of(MessageType.TYPING, typing ? 1 : 0);
}

export function encodeVerified() {
    return Uint8Array.of(MessageType.VERIFIED);
}

export function encodeChunk(id, index, data) {
    const bytes = new Uint8Array(CHUNK_HEADER + data.length);
    bytes[0] = MessageType.FILE_CHUNK;
    bytes.set(fromHex(id), 1);
    new DataView(bytes.buffer).setUint32(17, index);
    bytes.set(data, CHUNK_HEADER);
    return bytes;
}

// Everything decoded here came from a peer, so every field is checked. A type this version doesn't
// know returns null and is ignored: the record was already authenticated, and a newer app may
// have sent it.
export function decode(bytes) {
    switch (bytes[0]) {
        case MessageType.PADDED: {
            check(bytes.length >= PAD_HEADER);
            const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(1);
            check(length >= 1 && length <= bytes.length - PAD_HEADER);
            const inner = bytes.subarray(PAD_HEADER, PAD_HEADER + length);
            check(inner[0] !== MessageType.PADDED);
            return decode(inner);
        }
        case MessageType.TEXT: {
            const { id, text, replyTo, expiresIn } = json(bytes);
            check(isId(id) && isText(text, 1, MAX_TEXT_LENGTH) && isOptionalId(replyTo) && isOptionalExpiry(expiresIn));
            return { type: MessageType.TEXT, id, text, replyTo: replyTo ?? null, expiresIn: expiresIn ?? 0 };
        }
        case MessageType.RECEIPT: {
            const { id } = json(bytes);
            check(isId(id));
            return { type: MessageType.RECEIPT, id };
        }
        case MessageType.TYPING:
            check(bytes.length === 2 && bytes[1] <= 1);
            return { type: MessageType.TYPING, typing: bytes[1] === 1 };
        case MessageType.VERIFIED:
            check(bytes.length === 1);
            return { type: MessageType.VERIFIED };
        case MessageType.BYE: {
            const { reason } = json(bytes);
            check(reason === 'ended' || reason === 'mismatch');
            return { type: MessageType.BYE, reason };
        }
        case MessageType.FILE_OFFER: {
            const { id, name, size, mime, kind, caption, expiresIn } = json(bytes);
            check(isId(id) && isText(name, 1, 255) && isText(mime, 0, 100) && isText(caption, 0, MAX_TEXT_LENGTH));
            check(Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_SIZE);
            check((kind === 'image' || kind === 'file' || kind === 'audio') && isOptionalExpiry(expiresIn));
            return { type: MessageType.FILE_OFFER, id, name, size, mime, kind, caption, expiresIn: expiresIn ?? 0 };
        }
        case MessageType.FILE_CHUNK:
            check(bytes.length > CHUNK_HEADER && bytes.length <= CHUNK_HEADER + CHUNK_SIZE);
            return {
                type: MessageType.FILE_CHUNK,
                id: toHex(bytes.subarray(1, 17)),
                index: new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(17),
                data: bytes.subarray(CHUNK_HEADER),
            };
        case MessageType.FILE_CANCEL: {
            const { id } = json(bytes);
            check(isId(id));
            return { type: MessageType.FILE_CANCEL, id };
        }
        case MessageType.REACTION: {
            const { id, emoji, on } = json(bytes);
            check(isId(id) && REACTIONS.includes(emoji) && typeof on === 'boolean');
            return { type: MessageType.REACTION, id, emoji, on };
        }
        case MessageType.DELETE: {
            const { id } = json(bytes);
            check(isId(id));
            return { type: MessageType.DELETE, id };
        }
        case MessageType.SETTINGS: {
            const { disappearAfter, version, features } = json(bytes);
            check(DISAPPEAR_OPTIONS.includes(disappearAfter) && Number.isSafeInteger(version) && version >= 0 && version <= MAX_VERSION);
            check(features === undefined || (Array.isArray(features) && features.length <= 32 && features.every((name) => isText(name, 1, 32))));
            const decoded = { type: MessageType.SETTINGS, disappearAfter, version };
            if (features) decoded.features = KNOWN_FEATURES.filter((name) => features.includes(name));
            return decoded;
        }
        case MessageType.CALL: {
            const { action, video } = json(bytes);
            check(CALL_ACTIONS.includes(action) && typeof video === 'boolean');
            return { type: MessageType.CALL, action, video };
        }
        case MessageType.RTC: {
            const { description } = json(bytes);
            check(typeof description === 'object' && description !== null);
            check((description.type === 'offer' || description.type === 'answer') && isText(description.sdp, 1, MAX_SDP));
            return { type: MessageType.RTC, description: { type: description.type, sdp: description.sdp } };
        }
        case MessageType.EDIT: {
            const { id, text } = json(bytes);
            check(isId(id) && isText(text, 1, MAX_TEXT_LENGTH));
            return { type: MessageType.EDIT, id, text };
        }
        case MessageType.PREFS: {
            const { readReceipts } = json(bytes);
            check(typeof readReceipts === 'boolean');
            return { type: MessageType.PREFS, readReceipts };
        }
        case MessageType.SEEN: {
            const { id } = json(bytes);
            check(isId(id));
            return { type: MessageType.SEEN, id };
        }
        default:
            return null;
    }
}

function json(bytes) {
    let value;
    try {
        value = JSON.parse(decoder.decode(bytes.subarray(1)));
    } catch {
        throw new ProtocolError('Malformed message');
    }
    check(typeof value === 'object' && value !== null && !Array.isArray(value));
    return value;
}

function check(condition) {
    if (!condition) throw new ProtocolError('Invalid message');
}

function isId(value) {
    return typeof value === 'string' && ID.test(value);
}

function isOptionalId(value) {
    return value === undefined || isId(value);
}

function isOptionalExpiry(value) {
    return value === undefined || DISAPPEAR_OPTIONS.includes(value);
}

function isText(value, minLength, maxLength) {
    return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
    return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
}
