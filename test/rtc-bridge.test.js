import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeDataChannel } from '../public/js/rtc-bridge.js';

const CHUNK = 60 * 1024;
// LOW_WATER_MARK and HIGH_WATER_MARK in public/js/peer.js.
const LOW_WATER_MARK = 256 * 1024;
const HIGH_WATER_MARK = 1024 * 1024;

const settle = () => new Promise((resolve) => setImmediate(resolve));

// The batch format of rtc.rs: each frame's length (4 bytes, little-endian), then its bytes.
function pack(frames) {
    const parts = frames.map((frame) => {
        const part = new Uint8Array(4 + frame.length);
        new DataView(part.buffer).setUint32(0, frame.length, true);
        part.set(frame, 4);
        return part;
    });
    return Uint8Array.from(parts.flatMap((part) => [...part])).buffer;
}

function unpack(batch) {
    const view = new DataView(batch.buffer, batch.byteOffset, batch.byteLength);
    const frames = [];
    for (let offset = 0; offset < batch.byteLength;) {
        const length = view.getUint32(offset, true);
        frames.push(batch.slice(offset + 4, offset + 4 + length));
        offset += 4 + length;
    }
    return frames;
}

// Stands in for the app's IPC. Each rtc_send and rtc_recv waits until the test answers it, the
// way an answer from Rust can take its time.
function fakeApp() {
    const sends = [];
    const fetches = [];
    globalThis.window = {
        __TAURI_INTERNALS__: {
            invoke: (command, body) => new Promise((resolve, reject) => {
                if (command === 'rtc_send') sends.push({ body, resolve, reject });
                else if (command === 'rtc_recv') fetches.push({ resolve, reject });
                else reject(new Error(`unexpected ${command}`));
            }),
        },
    };
    return {
        sends,
        // Answers the oldest send with Rust's running total, once the bridge has made that call.
        async reply(total) {
            await settle();
            sends.shift().resolve(total);
            await settle();
        },
        async refuse() {
            await settle();
            sends.shift().reject(new Error('gone'));
            await settle();
        },
        // Answers the waiting fetch with these frames (none means the channel closed).
        async arrive(...frames) {
            await settle();
            fetches.shift().resolve(pack(frames));
            await settle();
        },
    };
}

function openChannel() {
    const channel = new BridgeDataChannel({ id: 1 }, 'ecdh.chat');
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.handle({ type: 'open' });
    return channel;
}

function countEvents(channel, type) {
    const seen = { count: 0 };
    channel.addEventListener(type, () => { seen.count += 1; });
    return seen;
}

describe('rtc bridge data channel', () => {
    test('frames sent while a batch is on its way go together in the next', async () => {
        const app = fakeApp();
        const channel = openChannel();
        for (let n = 0; n < 5; n++) channel.send(new Uint8Array(1000).fill(n));
        await settle();
        // The first frame goes at once; the other four wait for its answer, then go as one.
        assert.equal(app.sends.length, 1);
        assert.equal(unpack(app.sends[0].body).length, 1);
        await app.reply(1000);
        assert.equal(app.sends.length, 1);
        assert.equal(unpack(app.sends[0].body).length, 4);
        await app.reply(5000);
        assert.equal(app.sends.length, 0);
        assert.equal(channel.bufferedAmount, 0);
    });

    test('batches keep every frame whole and in order', async () => {
        const app = fakeApp();
        const channel = openChannel();
        const frames = Array.from({ length: 7 }, (_, n) => new Uint8Array(50 + n * 13).fill(n + 1));
        for (const frame of frames.slice(0, 3)) channel.send(frame);
        const bodies = [];
        const take = async () => {
            await settle();
            bodies.push(app.sends[0].body);
            await app.reply(0);
        };
        await take();
        for (const frame of frames.slice(3)) channel.send(frame);
        await take();
        await take();
        assert.equal(bodies.length, 3);
        const unpacked = bodies.flatMap(unpack);
        assert.deepEqual(unpacked, frames);
    });

    test('a stale send reply landing after the drained event can not stall sending', async () => {
        const app = fakeApp();
        const channel = openChannel();
        const low = countEvents(channel, 'bufferedamountlow');
        for (let n = 0; n < 18; n++) channel.send(new Uint8Array(CHUNK));
        // peer.js now waits for bufferedamountlow before sending more.
        assert.ok(channel.bufferedAmount > HIGH_WATER_MARK);
        await app.reply(0);

        // Everything has gone out, and Rust's event saying so overtakes the last batch's reply,
        // which was worked out while about 1 MB was still waiting.
        channel.handle({ type: 'drained', total: 18 * CHUNK });
        await app.reply(18 * CHUNK - 1060 * 1024);

        assert.equal(channel.bufferedAmount, 0);
        assert.equal(low.count, 1);
    });

    test('send replies alone bring the amount down and fire bufferedamountlow once', async () => {
        const app = fakeApp();
        const channel = openChannel();
        const low = countEvents(channel, 'bufferedamountlow');
        for (let n = 0; n < 6; n++) channel.send(new Uint8Array(CHUNK));
        assert.equal(channel.bufferedAmount, 6 * CHUNK);
        await app.reply(CHUNK);
        assert.equal(channel.bufferedAmount, 5 * CHUNK);
        await app.reply(6 * CHUNK);
        assert.equal(channel.bufferedAmount, 0);
        assert.equal(low.count, 1);
    });

    test('a batch Rust refuses closes the channel, so a waiting sender moves on', async () => {
        const app = fakeApp();
        const channel = openChannel();
        const closes = countEvents(channel, 'close');
        channel.send(new Uint8Array(CHUNK));
        await app.refuse();
        assert.equal(channel.readyState, 'closed');
        assert.equal(closes.count, 1);
        assert.throws(() => channel.send(new Uint8Array(1)), { name: 'InvalidStateError' });
    });

    test('frames arrive in order, and a close never overtakes frames that came before it', async () => {
        const app = fakeApp();
        const channel = openChannel();
        const received = [];
        channel.onmessage = ({ data }) => received.push(new Uint8Array(data)[0]);
        const closes = countEvents(channel, 'close');

        await app.arrive(Uint8Array.of(1), Uint8Array.of(2));
        // Rust reports the close while a frame is still waiting to be fetched.
        channel.handle({ type: 'close' });
        assert.equal(channel.readyState, 'open');
        await app.arrive(Uint8Array.of(3));
        await app.arrive();

        assert.deepEqual(received, [1, 2, 3]);
        assert.equal(channel.readyState, 'closed');
        assert.equal(closes.count, 1);
    });
});
