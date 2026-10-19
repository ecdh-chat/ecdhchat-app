import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SecureChannel, decodeBase64Url, encodeBase64Url, randomSecret } from '../public/js/secure-channel.js';

const ROOM = '3f2b8a54-7c1e-4d2a-9b6f-0e5d4c3b2a19';
const FINGERPRINTS = { creator: 'sha-256 AA:BB', joiner: 'sha-256 CC:DD' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function channels({ creatorSecret = randomSecret(), joinerSecret = creatorSecret, creatorPrints = FINGERPRINTS, joinerPrints = FINGERPRINTS } = {}) {
    return {
        creator: new SecureChannel({ role: 'creator', roomId: ROOM, secret: creatorSecret, fingerprints: creatorPrints }),
        joiner: new SecureChannel({ role: 'joiner', roomId: ROOM, secret: joinerSecret, fingerprints: joinerPrints }),
    };
}

// Runs the handshake step by step. `rewrite` lets a test stand in for whoever relays the frames.
async function handshake(creator, joiner, rewrite = (frame) => frame) {
    const { send: [hello] } = await creator.start();
    await joiner.start();
    const { send: [key] } = await joiner.receive(rewrite(hello, 'hello'));
    const { send: [reveal, creatorReady] } = await creator.receive(rewrite(key, 'key'));
    const { send: [joinerReady] } = await joiner.receive(rewrite(reveal, 'reveal'));
    const joinerResult = await joiner.receive(rewrite(creatorReady, 'creator-ready'));
    const creatorResult = await creator.receive(rewrite(joinerReady, 'joiner-ready'));
    return { creatorCode: creatorResult.ready.sas, joinerCode: joinerResult.ready.sas };
}

async function message(from, to, text) {
    const { message: bytes } = await to.receive(await from.seal(encoder.encode(text)));
    return decoder.decode(bytes);
}

async function freshPublicKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
}

describe('secure channel', () => {
    test('agrees on keys and a code, then carries messages both ways in order', async () => {
        const { creator, joiner } = channels();
        const { creatorCode, joinerCode } = await handshake(creator, joiner);

        assert.match(creatorCode, /^\d{6}$/);
        assert.equal(creatorCode, joinerCode);
        assert.equal(await message(creator, joiner, 'hello'), 'hello');
        assert.equal(await message(joiner, creator, 'hi back'), 'hi back');
        for (let i = 0; i < 5; i++) assert.equal(await message(creator, joiner, `#${i}`), `#${i}`);
    });

    test('a relay without the link secret cannot complete the handshake', async () => {
        const { creator, joiner } = channels({ creatorSecret: randomSecret(), joinerSecret: randomSecret() });
        const { send: [hello] } = await creator.start();
        await joiner.start();
        const { send: [key] } = await joiner.receive(hello);
        const { send: [reveal, creatorReady] } = await creator.receive(key);
        const { send: [joinerReady] } = await joiner.receive(reveal);

        await assert.rejects(joiner.receive(creatorReady));
        await assert.rejects(creator.receive(joinerReady));
    });

    test('someone holding the link who swaps in their own keys gets a different code on each side', async () => {
        const secret = randomSecret();
        const alice = new SecureChannel({ role: 'creator', roomId: ROOM, secret, fingerprints: FINGERPRINTS });
        const bob = new SecureChannel({ role: 'joiner', roomId: ROOM, secret, fingerprints: FINGERPRINTS });
        const towardAlice = new SecureChannel({ role: 'joiner', roomId: ROOM, secret, fingerprints: FINGERPRINTS });
        const towardBob = new SecureChannel({ role: 'creator', roomId: ROOM, secret, fingerprints: FINGERPRINTS });

        const left = await handshake(alice, towardAlice);
        const right = await handshake(towardBob, bob);

        assert.notEqual(left.creatorCode, right.joinerCode);
    });

    test('rejects a revealed key that does not match the commitment', async () => {
        const { creator, joiner } = channels();
        const swapped = await freshPublicKey();
        await assert.rejects(handshake(creator, joiner, (frame, step) => {
            if (step !== 'reveal') return frame;
            const forged = frame.slice();
            forged.set(swapped, 2);
            return forged;
        }), /commitment/);
    });

    test('fails when the two sides saw different DTLS fingerprints', async () => {
        const { creator, joiner } = channels({ joinerPrints: { creator: FINGERPRINTS.creator, joiner: 'sha-256 EE:FF' } });
        await assert.rejects(handshake(creator, joiner));
    });

    test('rejects records that are replayed, reordered or tampered with', async () => {
        const replay = channels();
        await handshake(replay.creator, replay.joiner);
        const once = await replay.creator.seal(encoder.encode('once'));
        await replay.joiner.receive(once);
        await assert.rejects(replay.joiner.receive(once));

        const reorder = channels();
        await handshake(reorder.creator, reorder.joiner);
        await reorder.creator.seal(encoder.encode('first'));
        const second = await reorder.creator.seal(encoder.encode('second'));
        await assert.rejects(reorder.joiner.receive(second));

        const tamper = channels();
        await handshake(tamper.creator, tamper.joiner);
        const sealed = await tamper.creator.seal(encoder.encode('original'));
        sealed[sealed.length - 1] ^= 1;
        await assert.rejects(tamper.joiner.receive(sealed));
    });

    test('refuses a second handshake once the chat is open, and stays closed after a failure', async () => {
        const { creator, joiner } = channels();
        await handshake(creator, joiner);

        const intruder = new SecureChannel({ role: 'creator', roomId: ROOM, secret: randomSecret(), fingerprints: FINGERPRINTS });
        const { send: [hello] } = await intruder.start();
        await assert.rejects(joiner.receive(hello));
        await assert.rejects(joiner.receive(await creator.seal(encoder.encode('after failure'))));
    });

    test('will not seal anything before the handshake is done', async () => {
        const { creator } = channels();
        await creator.start();
        await assert.rejects(creator.seal(encoder.encode('too early')));
    });

    test('encodes link secrets as URL-safe base64', () => {
        const secret = randomSecret();
        const text = encodeBase64Url(secret);
        assert.match(text, /^[A-Za-z0-9_-]{22}$/);
        assert.deepEqual(decodeBase64Url(text), secret);
        assert.equal(decodeBase64Url('not base64!'), null);
    });
});
