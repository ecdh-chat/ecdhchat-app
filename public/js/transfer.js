import { CHUNK_SIZE, INLINE_AUDIO_TYPES, INLINE_IMAGE_TYPES, MAX_FILE_SIZE, MAX_INCOMING_TRANSFERS } from './config.js';
import { ProtocolError } from './messages.js';

export async function* readChunks(blob) {
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
        yield new Uint8Array(await blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    }
}

// Names come from the peer and become download names, so strip anything that could hide the
// real extension (bidi overrides, zero-width characters) or act as a path.
export function safeFileName(name) {
    const cleaned = String(name)
        .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*​-‏‪-‮⁦-⁩]/g, '_')
        .replace(/^[\s.]+|[\s.]+$/g, '')
        .slice(0, 120);
    return cleaned || 'file';
}

export class IncomingTransfers {
    constructor({ maxConcurrent = MAX_INCOMING_TRANSFERS, maxFileSize = MAX_FILE_SIZE } = {}) {
        this.maxConcurrent = maxConcurrent;
        this.maxFileSize = maxFileSize;
        this.transfers = new Map();
    }

    offer({ id, name, size, mime, kind, caption, expiresIn = 0 }) {
        if (this.transfers.has(id)) throw new ProtocolError('Duplicate transfer');
        if (this.transfers.size >= this.maxConcurrent) throw new ProtocolError('Too many transfers at once');
        if (size > this.maxFileSize) throw new ProtocolError('File too large');

        // Only allowlisted image and audio types are ever shown inline; everything else is a
        // download that the browser can't render inside this page.
        const type = mime.split(';')[0].trim().toLowerCase();
        const shown = (kind === 'image' && INLINE_IMAGE_TYPES.includes(type)) || (kind === 'audio' && INLINE_AUDIO_TYPES.includes(type)) ? kind : 'file';
        const transfer = {
            id,
            name: safeFileName(name),
            size,
            caption,
            expiresIn,
            kind: shown,
            type: shown === 'file' ? 'application/octet-stream' : type,
            parts: [],
            received: 0,
            total: Math.ceil(size / CHUNK_SIZE),
        };
        this.transfers.set(id, transfer);
        return this.progress(transfer);
    }

    chunk(id, index, data) {
        const transfer = this.transfers.get(id);
        // Chunks can still be in flight after a cancel; those are dropped.
        if (!transfer) return null;
        if (index !== transfer.parts.length) throw new ProtocolError('Chunk out of order');
        if (data.length !== Math.min(CHUNK_SIZE, transfer.size - transfer.received)) throw new ProtocolError('Wrong chunk size');

        transfer.parts.push(data);
        transfer.received += data.length;
        return this.progress(transfer);
    }

    progress(transfer) {
        if (transfer.parts.length < transfer.total) return { transfer, done: false };

        this.transfers.delete(transfer.id);
        const blob = new Blob(transfer.parts, { type: transfer.type });
        transfer.parts = [];
        return { transfer, done: true, blob };
    }

    cancel(id) {
        return this.transfers.delete(id);
    }

    clear() {
        this.transfers.clear();
    }
}
