// Stands in for RTCPeerConnection in the app where the webview has none (WebKitGTK on Linux).
// The connection itself runs in Rust (src-tauri/src/rtc.rs); this only covers the part of the
// browser API that peer.js and connection.js use: one data channel, descriptions, candidates
// and connection state. There's no media, so calls aren't available where it's used.
// Frames cross to Rust and back in batches, one IPC round trip per batch rather than per frame.

function internals() {
    return window.__TAURI_INTERNALS__;
}

// A batch carries frames in order, each as its length (4 bytes, little-endian) and then its
// bytes, the same as pack() and unpack() in rtc.rs.
function pack(frames) {
    const batch = new Uint8Array(frames.reduce((size, frame) => size + 4 + frame.byteLength, 0));
    const view = new DataView(batch.buffer);
    let offset = 0;
    for (const frame of frames) {
        view.setUint32(offset, frame.byteLength, true);
        batch.set(frame, offset + 4);
        offset += 4 + frame.byteLength;
    }
    return batch;
}

function unpack(batch) {
    const view = new DataView(batch);
    const frames = [];
    for (let offset = 0; offset + 4 <= batch.byteLength;) {
        const length = view.getUint32(offset, true);
        frames.push(batch.slice(offset + 4, offset + 4 + length));
        offset += 4 + length;
    }
    return frames;
}

// A Tauri channel for events from Rust, put back in the order they were sent (it fetches large
// messages separately, and those can arrive late).
function openChannel(onMessage) {
    let next = 0;
    const waiting = new Map();
    const id = internals().transformCallback((raw) => {
        if ('end' in raw) return;
        waiting.set(raw.index, raw.message);
        while (waiting.has(next)) {
            const message = waiting.get(next);
            waiting.delete(next);
            next += 1;
            onMessage(message);
        }
    });
    return { id, ipc: `__CHANNEL__:${id}` };
}

function description(value) {
    if (!value) return null;
    const { type, sdp } = value;
    return { type, sdp, toJSON: () => ({ type, sdp }) };
}

export class BridgeDataChannel extends EventTarget {
    constructor(connection, label) {
        super();
        this.connection = connection;
        this.label = label;
        this.binaryType = 'arraybuffer';
        this.bufferedAmountLowThreshold = 0;
        this.readyState = 'connecting';
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        // Bytes handed to send() and bytes Rust has sent on, both counted from the start. Rust's
        // reports come back by two routes (each send's reply and "drained" events) and can
        // overtake each other; a running total only ever grows, so a late one changes nothing.
        this.handed = 0;
        this.drained = 0;
        this.outbox = [];
        this.flushing = false;
    }

    get bufferedAmount() {
        return this.handed - this.drained;
    }

    send(data) {
        if (this.readyState !== 'open') throw new DOMException('The data channel is not open', 'InvalidStateError');
        const bytes = new Uint8Array(data);
        this.handed += bytes.byteLength;
        this.outbox.push(bytes);
        if (!this.flushing) this.flush();
    }

    // Everything sent while a batch is on its way goes in the next one. Batches go one at a time,
    // so frames leave in the order they were sent; the chat's encryption counts on that.
    async flush() {
        this.flushing = true;
        try {
            while (this.outbox.length) {
                const batch = pack(this.outbox.splice(0));
                this.setDrained(await internals().invoke('rtc_send', batch, { headers: { 'x-rtc-peer': String(this.connection.id) } }));
            }
        } catch {
            this.closed();
        } finally {
            this.flushing = false;
        }
    }

    // Keeps one fetch waiting in Rust, which answers with everything that arrived since the last.
    // An empty batch means the channel closed, after every frame that came before it.
    async receiveAll() {
        try {
            for (;;) {
                const batch = await internals().invoke('rtc_recv', { id: this.connection.id });
                if (!batch.byteLength) break;
                for (const frame of unpack(batch)) this.receive(frame);
            }
        } catch {
            // The connection is gone.
        }
        this.closed();
    }

    setDrained(total) {
        if (!(total > this.drained)) return;
        const wasHigh = this.bufferedAmount > this.bufferedAmountLowThreshold;
        this.drained = Math.min(total, this.handed);
        if (wasHigh && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event('bufferedamountlow'));
    }

    handle(event) {
        if (event.type === 'open') {
            this.readyState = 'open';
            this.onopen?.(new Event('open'));
            this.receiveAll();
        } else if (event.type === 'close') {
            // Once open, receiveAll() closes the channel after the frames that came before this.
            if (this.readyState !== 'open') this.closed();
        } else if (event.type === 'drained') {
            this.setDrained(event.total);
        }
    }

    receive(data) {
        if (this.readyState === 'open') this.onmessage?.({ data });
    }

    closed() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.onclose?.(new Event('close'));
        this.dispatchEvent(new Event('close'));
    }

    // The channel only ends with its connection.
    close() {
        this.connection.close();
    }
}

export class BridgePeerConnection {
    constructor({ iceServers = [], iceTransportPolicy = 'all' } = {}) {
        this.id = null;
        this.channel = null;
        this.localDescription = null;
        this.remoteDescription = null;
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.isClosed = false;
        this.onicecandidate = null;
        this.onconnectionstatechange = null;
        this.ondatachannel = null;
        this.onnegotiationneeded = null;
        this.ontrack = null;
        // Rust starts gathering while it sets the local description, but a browser only reports
        // candidates after setLocalDescription() has resolved, and peer.js signals the
        // description first. Candidates wait here until then.
        this.heldCandidates = [];
        this.events = openChannel((message) => this.handle(message));
        this.ready = internals()
            .invoke('rtc_create', { config: { iceServers, relayOnly: iceTransportPolicy === 'relay' }, events: this.events.ipc })
            .then((id) => {
                this.id = id;
                // Closed before Rust had made it.
                if (this.isClosed) this.call('rtc_close');
            });
    }

    async call(command, args = {}) {
        await this.ready;
        if (this.id === null) throw new DOMException('The connection could not be made', 'InvalidStateError');
        return internals().invoke(command, { id: this.id, ...args });
    }

    createDataChannel(label) {
        this.channel = new BridgeDataChannel(this, label);
        this.call('rtc_create_channel', { label }).catch(() => this.channel.closed());
        return this.channel;
    }

    async setLocalDescription() {
        const local = await this.call('rtc_set_local');
        this.localDescription = description(local);
        this.signalingState = local.type === 'offer' ? 'have-local-offer' : 'stable';
        // After the caller's own code following the await has run.
        setTimeout(() => {
            const held = this.heldCandidates;
            this.heldCandidates = null;
            for (const candidate of held) this.reportCandidate(candidate);
        }, 0);
    }

    reportCandidate(init) {
        if (this.heldCandidates) this.heldCandidates.push(init);
        else this.onicecandidate?.({ candidate: { ...init, toJSON: () => init } });
    }

    async setRemoteDescription(value) {
        await this.call('rtc_set_remote', { description: { type: value.type, sdp: value.sdp } });
        this.remoteDescription = description(value);
        this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable';
    }

    async addIceCandidate(candidate) {
        if (!candidate?.candidate) return;
        const { sdpMid = null, sdpMLineIndex = null } = candidate;
        await this.call('rtc_add_candidate', { candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex } });
    }

    handle(message) {
        switch (message.type) {
            case 'candidate':
                this.reportCandidate(message.candidate);
                break;
            case 'connectionState':
                this.connectionState = message.state;
                this.onconnectionstatechange?.(new Event('connectionstatechange'));
                break;
            case 'signalingState':
                this.signalingState = message.state;
                break;
            case 'channel':
                this.channel = new BridgeDataChannel(this, message.label);
                this.ondatachannel?.({ channel: this.channel });
                break;
            default:
                this.channel?.handle(message);
        }
    }

    close() {
        if (this.isClosed) return;
        this.isClosed = true;
        this.connectionState = 'closed';
        this.signalingState = 'closed';
        if (this.id !== null) this.call('rtc_close').catch(() => {});
        this.channel?.closed();
        internals().unregisterCallback?.(this.events.id);
    }
}
