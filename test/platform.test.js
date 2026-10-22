import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteFragment, isMobileBrowser, resolveServerOrigin, socketUrl } from '../public/js/platform.js';

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

    test('offers the relay to phones and tablets only', () => {
        const phones = [
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        ];
        for (const userAgent of phones) assert.equal(isMobileBrowser({ userAgent, maxTouchPoints: 5 }), true, userAgent);
        assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 }), true);
        assert.equal(isMobileBrowser({ userAgent: 'x', userAgentData: { mobile: true } }), true);

        const computers = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
            'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
        ];
        for (const userAgent of computers) assert.equal(isMobileBrowser({ userAgent, maxTouchPoints: 0 }), false, userAgent);
        assert.equal(isMobileBrowser(null), false);
    });
});