import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioLength } from '../public/js/audio-length.js';

// Voice messages recorded the way the chat records them (MediaRecorder, about 2.5 s on a fake
// microphone), with the lengths their browsers reported after playing them to the end.
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const chromiumWebm = fixture('voice-chromium.webm'); // 2.4 s; Chrome writes the length into the header
const firefoxWebm = fixture('voice-firefox.webm'); // 2.22 s; Firefox writes a length of 0
const firefoxOgg = fixture('voice-firefox.ogg'); // 1.969 s

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.05, `${actual} is not about ${expected}`);

describe('voice message length from the file', () => {
    test('WebM with its length in the header (Chrome)', () => {
        near(audioLength(chromiumWebm), 2.4);
    });

    test('WebM whose header gives 0 is timed by its last block (Firefox)', () => {
        near(audioLength(firefoxWebm), 2.22);
    });

    test('WebM with no length in the header at all is timed by its last block (older Chrome)', () => {
        const bytes = chromiumWebm.slice();
        // Turn the Duration element (ID 44 89) into a Void element of the same size, so the file
        // stays valid but says nothing about its length.
        const at = bytes.findIndex((byte, i) => byte === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x84);
        assert.ok(at > 0);
        bytes.set([0xec, 0x85], at);
        near(audioLength(bytes), 2.4);
    });

    test('Ogg Opus, from its last page', () => {
        near(audioLength(firefoxOgg), 1.969);
    });

    test('a cut-off recording gives the length of what is there, or nothing', () => {
        for (const bytes of [chromiumWebm, firefoxWebm, firefoxOgg]) {
            for (const cut of [4, 40, 400, Math.floor(bytes.length / 2), bytes.length - 1]) {
                const length = audioLength(bytes.subarray(0, cut));
                assert.ok(length === null || (length > 0 && length <= audioLength(bytes) + 0.05), `${cut}: ${length}`);
            }
        }
    });

    test('anything else gives nothing, whatever its bytes', () => {
        assert.equal(audioLength(new Uint8Array()), null);
        assert.equal(audioLength(new TextEncoder().encode('not a recording')), null);
        assert.equal(audioLength(Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3)), null);
        assert.equal(audioLength(Uint8Array.of(0x4f, 0x67, 0x67, 0x53)), null);
        for (let seed = 1; seed <= 200; seed++) {
            // Random bytes behind a WebM or Ogg signature must never throw or loop.
            let state = seed;
            const random = () => (state = (state * 1103515245 + 12345) % 2 ** 31) % 256;
            const bytes = Uint8Array.from({ length: 2000 }, random);
            bytes.set(seed % 2 ? [0x1a, 0x45, 0xdf, 0xa3] : [0x4f, 0x67, 0x67, 0x53]);
            const length = audioLength(bytes);
            assert.ok(length === null || (Number.isFinite(length) && length > 0));
        }
    });
});
