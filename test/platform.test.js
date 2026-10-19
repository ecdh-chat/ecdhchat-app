import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteFragment, resolveServerOrigin, socketUrl } from '../public/js/platform.js';

const ROOM = '0b7f3c2e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const SECRET = 'AAECAwQFBgcICQoLDA0ODw';

describe('platform', () => {
    test('the website uses its own origin; the app uses the server it was given', () => {
        assert.equal(resolveServerOrigin(undefined, 'https://ecdh.chat'), 'https://ecdh.chat');
        assert.equal(resolveServerOrigin('http://localhost:3000/', 'http://tauri.localhost'), 'http://localhost:3000');
        assert.equal(resolveServerOrigin('https://chat.example.com/some/path', 'http://tauri.localhost'), 'https://chat.example.com');
        for (const bad of ['', 'not a url', 'javascript:alert(1)', 'ftp://example.com', 42]) {
            assert.equal(resolveServerOrigin(bad, 'http://tauri.localhost'), 'http://tauri.localhost');
        }
    });

    test('turns the server origin into its WebSocket address', () => {
        assert.equal(socketUrl('https://ecdh.chat'), 'wss://ecdh.chat/ws');
        assert.equal(socketUrl('http://localhost:3000'), 'ws://localhost:3000/ws');
    });

    test('accepts pasted invite links for this server only', () => {
        const fragment = `#${ROOM}.${SECRET}`;
        assert.equal(inviteFragment(`https://ecdh.chat/${fragment}`, 'https://ecdh.chat'), fragment);
        assert.equal(inviteFragment(`  https://ecdh.chat/${fragment}\n`, 'https://ecdh.chat'), fragment);
        assert.equal(inviteFragment(`${ROOM}.${SECRET}`, 'https://ecdh.chat'), fragment);
        assert.equal(inviteFragment(fragment, 'https://ecdh.chat'), fragment);

        assert.equal(inviteFragment(`https://other.example/${fragment}`, 'https://ecdh.chat'), null);
        assert.equal(inviteFragment(`https://ecdh.chat/#${ROOM}`, 'https://ecdh.chat'), null);
        assert.equal(inviteFragment(`https://ecdh.chat/#${ROOM}.${SECRET}x`, 'https://ecdh.chat'), null);
        assert.equal(inviteFragment(`ecdhchat://join${fragment}`, 'https://ecdh.chat'), null);
        assert.equal(inviteFragment('hello', 'https://ecdh.chat'), null);
    });
});
