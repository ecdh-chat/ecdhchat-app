import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, MAX_FILE_SIZE, MAX_TEXT_LENGTH } from '../public/js/config.js';
import { FEATURES, MessageType, ProtocolError, decode, encode, encodeChunk, encodeTyping, encodeVerified, randomId } from '../public/js/messages.js';

const id = randomId();
const other = randomId();
const raw = (type, text) => Uint8Array.of(type, ...new TextEncoder().encode(text));
const offer = (overrides) => encode(MessageType.FILE_OFFER, { id, name: 'a', size: 1, mime: '', kind: 'file', caption: '', ...overrides });

describe('chat messages', () => {
    test('round-trip every message type', () => {
        assert.deepEqual(decode(encode(MessageType.TEXT, { id, text: 'hi <b>there</b>' })), { type: MessageType.TEXT, id, text: 'hi <b>there</b>', replyTo: null, expiresIn: 0 });
        assert.deepEqual(decode(encode(MessageType.TEXT, { id, text: 'a reply', replyTo: other, expiresIn: 300 })), { type: MessageType.TEXT, id, text: 'a reply', replyTo: other, expiresIn: 300 });
        assert.deepEqual(decode(encode(MessageType.RECEIPT, { id })), { type: MessageType.RECEIPT, id });
        assert.deepEqual(decode(encodeTyping(true)), { type: MessageType.TYPING, typing: true });
        assert.deepEqual(decode(encodeTyping(false)), { type: MessageType.TYPING, typing: false });
        assert.deepEqual(decode(encodeVerified()), { type: MessageType.VERIFIED });
        assert.deepEqual(decode(encode(MessageType.BYE, { reason: 'mismatch' })), { type: MessageType.BYE, reason: 'mismatch' });
        assert.deepEqual(decode(encode(MessageType.FILE_CANCEL, { id })), { type: MessageType.FILE_CANCEL, id });
        assert.deepEqual(decode(encode(MessageType.REACTION, { id, emoji: '❤️', on: true })), { type: MessageType.REACTION, id, emoji: '❤️', on: true });
        assert.deepEqual(decode(encode(MessageType.DELETE, { id })), { type: MessageType.DELETE, id });
        assert.deepEqual(decode(encode(MessageType.SETTINGS, { disappearAfter: 300, version: 2 })), { type: MessageType.SETTINGS, disappearAfter: 300, version: 2 });
        assert.deepEqual(decode(encode(MessageType.CALL, { action: 'invite', video: true })), { type: MessageType.CALL, action: 'invite', video: true });
        const description = { type: 'offer', sdp: 'v=0\r\n' };
        assert.deepEqual(decode(encode(MessageType.RTC, { description: { ...description, extra: 1 } })), { type: MessageType.RTC, description });

        const file = { id, name: 'notes.txt', size: 1234, mime: '', kind: 'file', caption: '' };
        assert.deepEqual(decode(encode(MessageType.FILE_OFFER, file)), { type: MessageType.FILE_OFFER, ...file, expiresIn: 0 });
        const voice = { ...file, kind: 'audio', mime: 'audio/webm;codecs=opus', expiresIn: 30 };
        assert.deepEqual(decode(encode(MessageType.FILE_OFFER, voice)), { type: MessageType.FILE_OFFER, ...voice });

        const data = Uint8Array.from({ length: 100 }, (_, i) => i);
        const chunk = decode(encodeChunk(id, 7, data));
        assert.equal(chunk.id, id);
        assert.equal(chunk.index, 7);
        assert.deepEqual(chunk.data, data);
    });

    test('reject anything malformed', () => {
        const bad = [
            raw(MessageType.TEXT, '{'),
            Uint8Array.of(MessageType.TEXT, 0xff, 0xfe),
            raw(MessageType.TEXT, '[]'),
            encode(MessageType.TEXT, { id, text: '' }),
            encode(MessageType.TEXT, { id, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }),
            encode(MessageType.TEXT, { id: 'short', text: 'hi' }),
            encode(MessageType.TEXT, { id: id.toUpperCase(), text: 'hi' }),
            encode(MessageType.TEXT, { id, text: 'hi', replyTo: 'nope' }),
            encode(MessageType.TEXT, { id, text: 'hi', expiresIn: 42 }),
            Uint8Array.of(MessageType.TYPING, 2),
            Uint8Array.of(MessageType.TYPING),
            Uint8Array.of(MessageType.VERIFIED, 0),
            encode(MessageType.BYE, { reason: 'other' }),
            offer({ name: '' }),
            offer({ size: -1 }),
            offer({ size: MAX_FILE_SIZE + 1 }),
            offer({ size: 1.5 }),
            offer({ kind: 'video' }),
            offer({ expiresIn: 7 }),
            encode(MessageType.FILE_OFFER, { id, name: 'a', size: 1, mime: '', kind: 'file' }),
            encodeChunk(id, 0, new Uint8Array(0)),
            encodeChunk(id, 0, new Uint8Array(CHUNK_SIZE + 1)),
            encode(MessageType.REACTION, { id, emoji: '🍕', on: true }),
            encode(MessageType.REACTION, { id, emoji: '👍', on: 'yes' }),
            encode(MessageType.DELETE, { id: 'nope' }),
            encode(MessageType.SETTINGS, { disappearAfter: 42, version: 1 }),
            encode(MessageType.SETTINGS, { disappearAfter: 30, version: -1 }),
            encode(MessageType.SETTINGS, { disappearAfter: 30, version: 1.5 }),
            encode(MessageType.CALL, { action: 'ring', video: false }),
            encode(MessageType.CALL, { action: 'invite' }),
            encode(MessageType.RTC, {}),
            encode(MessageType.RTC, { description: { type: 'pranswer', sdp: 'v=0' } }),
            encode(MessageType.RTC, { description: { type: 'offer', sdp: '' } }),
            encode(MessageType.RTC, { description: { type: 'offer', sdp: 'x'.repeat(40000) } }),
            encode(MessageType.SETTINGS, { disappearAfter: 0, version: 0, features: 'edit' }),
            encode(MessageType.SETTINGS, { disappearAfter: 0, version: 0, features: [1] }),
            encode(MessageType.SETTINGS, { disappearAfter: 0, version: 0, features: Array(33).fill('edit') }),
            encode(MessageType.EDIT, { id, text: '' }),
            encode(MessageType.EDIT, { id: 'nope', text: 'hi' }),
            encode(MessageType.EDIT, { id, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }),
            encode(MessageType.PREFS, { readReceipts: 'yes' }),
            encode(MessageType.SEEN, { id: 'nope' }),
            encode(MessageType.CALL, { action: 'screen-share', video: true }),
        ];
        for (const bytes of bad) {
            assert.throws(() => decode(bytes), ProtocolError, `accepted ${Array.from(bytes.slice(0, 12))}`);
        }
    });

    test('decode new message types', () => {
        assert.deepEqual(decode(encode(MessageType.EDIT, { id, text: 'fixed typo' })), { type: MessageType.EDIT, id, text: 'fixed typo' });
        assert.deepEqual(decode(encode(MessageType.PREFS, { readReceipts: true })), { type: MessageType.PREFS, readReceipts: true });
        assert.deepEqual(decode(encode(MessageType.SEEN, { id })), { type: MessageType.SEEN, id });
        for (const action of ['screen-on', 'screen-off']) {
            assert.deepEqual(decode(encode(MessageType.CALL, { action, video: true })), { type: MessageType.CALL, action, video: true });
        }
    });

    test('features are read from SETTINGS, keeping only ones this version knows', () => {
        const settings = decode(encode(MessageType.SETTINGS, { disappearAfter: 0, version: 0, features: ['edit', 'teleport', 'screen'] }));
        assert.deepEqual(settings.features, ['edit', 'screen']);
        assert.equal(decode(encode(MessageType.SETTINGS, { disappearAfter: 30, version: 2 })).features, undefined);
    });

    test('types from a newer version are ignored instead of ending the chat', () => {
        assert.equal(decode(Uint8Array.of(99)), null);
        assert.equal(decode(encode(200, { anything: true })), null);
        assert.equal(decode(Uint8Array.of()), null);
    });

    test('the feature announcement is accepted by 3.1.1, which ignores the extra field', async () => {
        const old = await import('./fixtures/messages-3.1.1.js');
        const announcement = encode(MessageType.SETTINGS, { disappearAfter: 0, version: 0, features: FEATURES });
        assert.deepEqual(old.decode(announcement), { type: old.MessageType.SETTINGS, disappearAfter: 0, version: 0 });
        // Features only go to apps that announced them, so 3.1.1 never receives these; if it did,
        // it would end the chat. That's why they're gated.
        assert.throws(() => old.decode(encode(MessageType.EDIT, { id, text: 'x' })), old.ProtocolError);
        assert.throws(() => old.decode(encode(MessageType.CALL, { action: 'screen-on', video: true })), old.ProtocolError);
    });
});
