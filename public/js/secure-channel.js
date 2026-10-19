const { subtle } = globalThis.crypto;

const VERSION = 2;
const FRAME_HANDSHAKE = 1;
const FRAME_RECORD = 2;
const HELLO = 1;
const KEY = 2;
const REVEAL = 3;
const READY = 0;
const PUBLIC_KEY_LENGTH = 65;
const MAX_FRAME_SIZE = 64 * 1024;
const RECORD_AAD = Uint8Array.of(FRAME_RECORD, VERSION);
const encoder = new TextEncoder();

class HandshakeError extends Error {}

export function randomSecret() {
    return globalThis.crypto.getRandomValues(new Uint8Array(16));
}

export function encodeBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(text) {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
    try {
        return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
    } catch {
        return null;
    }
}

/*
 * One end of the chat's encrypted channel. The handshake runs over the data channel
 * (C = creator, J = joiner):
 *
 *   C -> J  hello   version, SHA-256(pkC)   C commits to its key before seeing J's
 *   J -> C  key     pkJ
 *   C -> J  reveal  pkC                     J checks it against the commitment
 *
 * Both sides then derive one AES-GCM key per direction and the verification code with HKDF.
 * The salt is the secret from the invite link, which the server never sees. The info covers
 * a transcript of the room, both public keys and both DTLS fingerprints. Each side's first
 * record carries its transcript hash, which proves both ends derived the same keys.
 * Records use a per-direction counter as the nonce, so a replayed, dropped or reordered
 * record fails to decrypt.
 */
export class SecureChannel {
    constructor({ role, roomId, secret, fingerprints }) {
        this.role = role;
        this.roomId = roomId;
        this.secret = secret;
        this.fingerprints = fingerprints;
        this.state = 'new';
        this.queue = Promise.resolve();
        this.sendCounter = 0;
        this.receiveCounter = 0;
    }

    start() {
        return this.enqueue(() => this.begin());
    }

    receive(frame) {
        return this.enqueue(() => this.process(new Uint8Array(frame)));
    }

    async seal(plaintext) {
        if (this.state !== 'ready') throw new HandshakeError('Channel is not ready');
        return this.sealRecord(plaintext);
    }

    // Frames are handled strictly one at a time. After a failure every later call fails too.
    enqueue(task) {
        this.queue = this.queue.then(task);
        return this.queue;
    }

    async begin() {
        this.keyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        this.publicKey = new Uint8Array(await subtle.exportKey('raw', this.keyPair.publicKey));

        if (this.role === 'joiner') {
            this.state = 'awaiting-hello';
            return { send: [] };
        }
        this.state = 'awaiting-key';
        return { send: [handshakeFrame(HELLO, concat(Uint8Array.of(VERSION), await sha256(this.publicKey)))] };
    }

    async process(frame) {
        if (frame.length < 2 || frame.length > MAX_FRAME_SIZE) throw new HandshakeError('Bad frame size');
        if (frame[0] === FRAME_HANDSHAKE) return this.processHandshake(frame[1], frame.subarray(2));
        if (frame[0] === FRAME_RECORD) return this.processRecord(frame.subarray(1));
        throw new HandshakeError('Unknown frame');
    }

    async processHandshake(type, body) {
        if (this.state === 'awaiting-hello' && type === HELLO) {
            if (body.length !== 33 || body[0] !== VERSION) throw new HandshakeError('Unsupported version');
            this.commitment = body.slice(1);
            this.state = 'awaiting-reveal';
            return { send: [handshakeFrame(KEY, this.publicKey)] };
        }

        if (this.state === 'awaiting-key' && type === KEY) {
            await this.deriveKeys(body);
            this.state = 'awaiting-ready';
            return { send: [handshakeFrame(REVEAL, this.publicKey), await this.sealRecord(this.readyRecord())] };
        }

        if (this.state === 'awaiting-reveal' && type === REVEAL) {
            if (!equal(await sha256(body), this.commitment)) throw new HandshakeError('Key does not match its commitment');
            await this.deriveKeys(body);
            this.state = 'awaiting-ready';
            return { send: [await this.sealRecord(this.readyRecord())] };
        }

        throw new HandshakeError('Unexpected handshake message');
    }

    async processRecord(ciphertext) {
        if (!this.receiveKey) throw new HandshakeError('Record before handshake');
        const plaintext = new Uint8Array(await subtle.decrypt(
            { name: 'AES-GCM', iv: nonce(this.receiveCounter++), additionalData: RECORD_AAD },
            this.receiveKey,
            ciphertext,
        ));

        if (this.state === 'awaiting-ready') {
            if (plaintext[0] !== READY || !equal(plaintext.subarray(1), this.transcript)) throw new HandshakeError('Transcripts differ');
            this.state = 'ready';
            return { ready: { sas: this.sas } };
        }
        if (this.state !== 'ready' || plaintext.length === 0 || plaintext[0] === READY) throw new HandshakeError('Unexpected record');
        return { message: plaintext };
    }

    async deriveKeys(peerPublicKey) {
        if (peerPublicKey.length !== PUBLIC_KEY_LENGTH) throw new HandshakeError('Bad public key');
        const peerKey = await subtle.importKey('raw', peerPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const shared = await subtle.deriveBits({ name: 'ECDH', public: peerKey }, this.keyPair.privateKey, 256);
        this.keyPair = null;

        const isCreator = this.role === 'creator';
        this.transcript = await sha256(encodeFields([
            encoder.encode('ecdh.chat/v2'),
            encoder.encode(this.roomId),
            isCreator ? this.publicKey : peerPublicKey,
            isCreator ? peerPublicKey : this.publicKey,
            encoder.encode(this.fingerprints.creator),
            encoder.encode(this.fingerprints.joiner),
        ]));

        const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey', 'deriveBits']);
        const hkdf = (label) => ({ name: 'HKDF', hash: 'SHA-256', salt: this.secret, info: concat(encoder.encode(label), this.transcript) });
        const aes = { name: 'AES-GCM', length: 256 };
        this.sendKey = await subtle.deriveKey(hkdf(isCreator ? 'creator to joiner' : 'joiner to creator'), ikm, aes, false, ['encrypt']);
        this.receiveKey = await subtle.deriveKey(hkdf(isCreator ? 'joiner to creator' : 'creator to joiner'), ikm, aes, false, ['decrypt']);

        const code = new DataView(await subtle.deriveBits(hkdf('verification code'), ikm, 32)).getUint32(0) % 1000000;
        this.sas = String(code).padStart(6, '0');
    }

    readyRecord() {
        return concat(Uint8Array.of(READY), this.transcript);
    }

    async sealRecord(plaintext) {
        const ciphertext = await subtle.encrypt(
            { name: 'AES-GCM', iv: nonce(this.sendCounter++), additionalData: RECORD_AAD },
            this.sendKey,
            plaintext,
        );
        return concat(Uint8Array.of(FRAME_RECORD), new Uint8Array(ciphertext));
    }
}

function handshakeFrame(type, body) {
    return concat(Uint8Array.of(FRAME_HANDSHAKE, type), body);
}

function nonce(counter) {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(4, Math.floor(counter / 2 ** 32));
    view.setUint32(8, counter >>> 0);
    return iv;
}

function encodeFields(fields) {
    const parts = [];
    for (const field of fields) {
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, field.length);
        parts.push(length, field);
    }
    return concat(...parts);
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

function equal(a, b) {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
}
