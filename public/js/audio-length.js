// How long a recorded voice message is, read from the file itself. Players can't always tell:
// Firefox's WebM recordings give their length as 0, older Chrome's give none, and some players
// only find out by playing to the end. This reads WebM (the length in its header, or else the
// time of its last block) and Ogg Opus (the position of its last page). Any other file, or one it
// can't make sense of, gives null. It only reads; the file comes from the other person, so every
// step stays inside the bytes it was given.

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const CLUSTER = 0x1f43b675;
const BLOCK_GROUP = 0xa0;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;
// Elements whose contents are read rather than skipped. Recorders often leave a segment's or a
// cluster's size open (unknown), which only works for these.
const CONTAINERS = new Set([SEGMENT, INFO, CLUSTER, BLOCK_GROUP]);
// A recording's last block holds one 20 ms Opus frame, which ends after the block's time.
const LAST_FRAME = 0.02;
const OPUS_RATE = 48000;

export function audioLength(bytes) {
    if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return webmLength(bytes);
    if (matches(bytes, 0, [0x4f, 0x67, 0x67, 0x53])) return oggLength(bytes);
    return null;
}

function webmLength(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let scale = 1000000; // nanoseconds per tick, unless the file says otherwise
    let duration = 0;
    let cluster = 0;
    let last = -1;
    for (let pos = 0; pos < bytes.length;) {
        const id = readId(bytes, pos);
        const size = id && readSize(bytes, pos + id.length);
        if (!size) break;
        const start = pos + id.length + size.length;
        if (CONTAINERS.has(id.value)) {
            pos = start;
            continue;
        }
        // Anything else needs a known size that fits in the file; a cut-off file stops here.
        if (size.value === null || start + size.value > bytes.length) break;
        if (id.value === TIMECODE_SCALE) scale = readUint(bytes, start, size.value);
        else if (id.value === DURATION && size.value === 4) duration = view.getFloat32(start);
        else if (id.value === DURATION && size.value === 8) duration = view.getFloat64(start);
        else if (id.value === TIMECODE) cluster = readUint(bytes, start, size.value);
        else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
            // A block starts with its track number, then its time relative to the cluster.
            const track = readSize(bytes, start);
            if (track && track.length + 2 <= size.value) last = Math.max(last, cluster + view.getInt16(start + track.length));
        }
        pos = start + size.value;
    }
    const seconds = duration > 0 ? (duration * scale) / 1e9 : last >= 0 ? (last * scale) / 1e9 + LAST_FRAME : 0;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// Ogg Opus: the last page's granule position counts the samples up to its end, at 48 kHz, after
// the pre-skip the Opus header gives.
function oggLength(bytes) {
    const payload = 27 + (bytes[26] ?? 0);
    if (!matches(bytes, payload, [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])) return null; // OpusHead
    const preSkip = bytes[payload + 10] | (bytes[payload + 11] << 8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let pos = bytes.length - 27; pos > 0; pos--) {
        if (!matches(bytes, pos, [0x4f, 0x67, 0x67, 0x53, 0x00])) continue; // OggS, version 0
        const low = view.getUint32(pos + 6, true);
        const high = view.getUint32(pos + 10, true);
        // All ones means no packet ends on this page; the one before it says more.
        if (low === 0xffffffff && high === 0xffffffff) continue;
        const seconds = (high * 2 ** 32 + low - preSkip) / OPUS_RATE;
        return seconds > 0 ? seconds : null;
    }
    return null;
}

// An element ID: its first byte's leading zeros say how many bytes it has (1 to 4).
function readId(bytes, pos) {
    const length = vintLength(bytes[pos]);
    if (length > 4 || pos + length > bytes.length) return null;
    return { value: readUint(bytes, pos, length), length };
}

// A size or track number: like an ID, but without its length marker, and all ones means unknown.
function readSize(bytes, pos) {
    const length = vintLength(bytes[pos]);
    if (length > 8 || pos + length > bytes.length) return null;
    const mask = 0xff >> length;
    let value = bytes[pos] & mask;
    let unknown = value === mask;
    for (let i = 1; i < length; i++) {
        value = value * 256 + bytes[pos + i];
        if (bytes[pos + i] !== 0xff) unknown = false;
    }
    return { value: unknown ? null : value, length };
}

function vintLength(byte) {
    return byte ? Math.clz32(byte) - 23 : 9;
}

function readUint(bytes, pos, length) {
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + bytes[pos + i];
    return value;
}

function matches(bytes, pos, expected) {
    return pos >= 0 && pos + expected.length <= bytes.length && expected.every((byte, i) => bytes[pos + i] === byte);
}
