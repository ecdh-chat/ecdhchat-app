import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE } from '../public/js/config.js';
import { ProtocolError, randomId } from '../public/js/messages.js';
import { IncomingTransfers, TransferMeter, readChunks, safeFileName, timeLeft } from '../public/js/transfer.js';

function offer(overrides = {}) {
    return { id: randomId(), name: 'report.pdf', size: 40000, mime: '', kind: 'file', caption: '', ...overrides };
}

async function bytesOf(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

describe('file transfers', () => {
    test('reassemble a file from its chunks', async () => {
        const size = 2 * CHUNK_SIZE + 1000;
        const source = Uint8Array.from({ length: size }, (_, i) => i % 251);
        const chunks = [];
        for await (const chunk of readChunks(new Blob([source]))) chunks.push(chunk);
        assert.deepEqual(chunks.map((chunk) => chunk.length), [CHUNK_SIZE, CHUNK_SIZE, 1000]);

        const transfers = new IncomingTransfers();
        const { transfer } = transfers.offer(offer({ size: source.length }));
        assert.equal(transfers.chunk(transfer.id, 0, chunks[0]).done, false);
        assert.equal(transfers.chunk(transfer.id, 1, chunks[1]).done, false);
        const result = transfers.chunk(transfer.id, 2, chunks[2]);
        assert.equal(result.done, true);
        assert.equal(result.blob.type, 'application/octet-stream');
        assert.deepEqual(await bytesOf(result.blob), source);
    });

    test('show only allowlisted image types inline', () => {
        const transfers = new IncomingTransfers({ maxConcurrent: 10 });
        assert.equal(transfers.offer(offer({ kind: 'image', mime: 'image/png' })).transfer.kind, 'image');
        assert.equal(transfers.offer(offer({ kind: 'image', mime: 'image/png' })).transfer.type, 'image/png');
        for (const mime of ['image/svg+xml', 'text/html', '']) {
            const { transfer } = transfers.offer(offer({ kind: 'image', mime }));
            assert.equal(transfer.kind, 'file', mime);
            assert.equal(transfer.type, 'application/octet-stream', mime);
        }
    });

    test('play only allowlisted audio types inline, ignoring codec parameters', () => {
        const transfers = new IncomingTransfers({ maxConcurrent: 10 });
        const voice = transfers.offer(offer({ kind: 'audio', mime: 'audio/webm;codecs=opus' })).transfer;
        assert.equal(voice.kind, 'audio');
        assert.equal(voice.type, 'audio/webm');
        for (const mime of ['audio/x-wav', 'text/html', 'image/png']) {
            const { transfer } = transfers.offer(offer({ kind: 'audio', mime }));
            assert.equal(transfer.kind, 'file', mime);
            assert.equal(transfer.type, 'application/octet-stream', mime);
        }
    });

    test('complete empty files right away', () => {
        const result = new IncomingTransfers().offer(offer({ size: 0 }));
        assert.equal(result.done, true);
        assert.equal(result.blob.size, 0);
    });

    test('reject chunks that are out of order or the wrong size', () => {
        const transfers = new IncomingTransfers({ maxConcurrent: 10 });
        const first = transfers.offer(offer()).transfer;
        assert.throws(() => transfers.chunk(first.id, 1, new Uint8Array(CHUNK_SIZE)), ProtocolError);

        const second = transfers.offer(offer()).transfer;
        assert.throws(() => transfers.chunk(second.id, 0, new Uint8Array(100)), ProtocolError);

        const third = transfers.offer(offer({ size: 10 })).transfer;
        assert.throws(() => transfers.chunk(third.id, 0, new Uint8Array(11)), ProtocolError);
    });

    test('reject duplicate, oversized and too many simultaneous transfers', () => {
        const transfers = new IncomingTransfers({ maxConcurrent: 2, maxFileSize: 1000 });
        const duplicate = offer({ size: 10 });
        transfers.offer(duplicate);
        assert.throws(() => transfers.offer(duplicate), ProtocolError);
        assert.throws(() => transfers.offer(offer({ size: 1001 })), ProtocolError);
        transfers.offer(offer({ size: 10 }));
        assert.throws(() => transfers.offer(offer({ size: 10 })), ProtocolError);
    });

    test('drop chunks that arrive after a cancel', () => {
        const transfers = new IncomingTransfers();
        const { transfer } = transfers.offer(offer());
        assert.equal(transfers.cancel(transfer.id), true);
        assert.equal(transfers.chunk(transfer.id, 0, new Uint8Array(CHUNK_SIZE)), null);
        assert.equal(transfers.cancel(transfer.id), false);
    });

    test('clean up file names from the peer', () => {
        assert.equal(safeFileName('holiday.jpg'), 'holiday.jpg');
        assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd');
        assert.equal(safeFileName('invoice‮fdp.exe'), 'invoice_fdp.exe');
        assert.equal(safeFileName('a​b\u0000c'), 'a_b_c');
        assert.equal(safeFileName('  ...  '), 'file');
        assert.equal(safeFileName('x'.repeat(500)).length, 120);
    });
});

describe('transfer speed', () => {
    test('measures the rate over the last few seconds and works out the time left', () => {
        const meter = new TransferMeter(10_000_000, 0);
        assert.deepEqual(meter.update(1_000_000, 1000), { rate: 1_000_000, secondsLeft: 9 });
        assert.deepEqual(meter.update(2_000_000, 2000), { rate: 1_000_000, secondsLeft: 8 });

        // It speeds up: once the slow start is out of the window, the rate is the new speed.
        meter.update(4_000_000, 3000);
        meter.update(6_000_000, 4000);
        meter.update(8_000_000, 5000);
        assert.deepEqual(meter.update(9_000_000, 5500), { rate: 2_000_000, secondsLeft: 0.5 });
    });

    test('has no rate or time left before any time has passed or while nothing moves', () => {
        assert.deepEqual(new TransferMeter(100, 0).update(0, 0), { rate: 0, secondsLeft: Infinity });
        const stalled = new TransferMeter(100, 0);
        stalled.update(50, 1000);
        assert.deepEqual(stalled.update(50, 5000), { rate: 0, secondsLeft: Infinity });
    });

    test('says the time left in seconds, minutes or hours', () => {
        assert.equal(timeLeft(0.2), '1 s left');
        assert.equal(timeLeft(20), '20 s left');
        assert.equal(timeLeft(59.5), '1 min left');
        assert.equal(timeLeft(150), '3 min left');
        assert.equal(timeLeft(89 * 60), '89 min left');
        assert.equal(timeLeft(2 * 3600), '2 h left');
    });
});
