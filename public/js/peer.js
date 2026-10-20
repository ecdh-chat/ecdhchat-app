import { createPeerConnection } from './platform.js';

const HIGH_WATER_MARK = 1024 * 1024;
const LOW_WATER_MARK = 256 * 1024;

export class Peer {
    constructor({ role, iceServers, relayOnly, onSignal, onOpen, onFrame, onClose, onStateChange, onTrack }) {
        this.role = role;
        this.onSignal = onSignal;
        this.handlers = { onOpen, onFrame, onClose };
        this.channel = null;
        this.senders = new Map();
        this.signals = Promise.resolve();
        this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
        this.pc = createPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });

        this.pc.onicecandidate = ({ candidate }) => {
            if (candidate) onSignal({ candidate: candidate.toJSON() });
        };
        this.pc.onconnectionstatechange = () => onStateChange(this.pc.connectionState);
        this.pc.ontrack = (event) => onTrack?.(event);

        if (role === 'creator') {
            this.attach(this.pc.createDataChannel('ecdh.chat'));
        } else {
            this.pc.ondatachannel = ({ channel }) => this.attach(channel);
        }
    }

    attach(channel) {
        if (this.channel) {
            channel.close();
            return;
        }
        this.channel = channel;
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
        channel.onopen = () => this.handlers.onOpen();
        channel.onmessage = ({ data }) => {
            if (data instanceof ArrayBuffer) this.handlers.onFrame(data);
        };
        channel.onclose = () => {
            this.resolveClosed();
            this.handlers.onClose();
        };
    }

    async offer() {
        await this.pc.setLocalDescription();
        this.onSignal({ sdp: this.pc.localDescription.toJSON() });
    }

    // Signals arrive from the server, so they're applied one at a time and only the
    // single offer/answer exchange this chat needs is accepted.
    handleSignal(signal) {
        this.signals = this.signals.then(async () => {
            if (signal.sdp) {
                if (this.pc.remoteDescription) return;
                if (signal.sdp.type !== (this.role === 'creator' ? 'answer' : 'offer')) throw new Error('Unexpected description');
                await this.pc.setRemoteDescription(signal.sdp);
                if (signal.sdp.type === 'offer') {
                    await this.pc.setLocalDescription();
                    this.onSignal({ sdp: this.pc.localDescription.toJSON() });
                }
            } else if (signal.candidate) {
                await this.pc.addIceCandidate(signal.candidate);
            }
        });
        return this.signals;
    }

    async send(bytes) {
        const { channel } = this;
        if (channel.bufferedAmount > HIGH_WATER_MARK) {
            await new Promise((resolve) => {
                channel.addEventListener('bufferedamountlow', resolve, { once: true });
                channel.addEventListener('close', resolve, { once: true });
            });
        }
        channel.send(bytes);
    }

    // Puts a call's tracks on the connection (or takes them off with null). The first track of
    // each kind needs a renegotiation; after that tracks are swapped in place.
    setLocalMedia(stream) {
        for (const kind of ['audio', 'video']) {
            const track = stream?.getTracks().find((candidate) => candidate.kind === kind) ?? null;
            const sender = this.senders.get(kind);
            if (sender) sender.replaceTrack(track).catch(() => {});
            else if (track) this.senders.set(kind, this.pc.addTrack(track, stream));
        }
    }

    // Swaps only the video being sent (camera, a shared screen, or nothing). A first video track
    // in a voice call needs a renegotiation, which goes over the encrypted channel.
    setVideoTrack(track, stream) {
        const sender = this.senders.get('video');
        if (sender) return sender.replaceTrack(track);
        if (track) this.senders.set('video', this.pc.addTrack(track, stream));
        return Promise.resolve();
    }

    fingerprints() {
        const local = fingerprint(this.pc.localDescription.sdp);
        const remote = fingerprint(this.pc.remoteDescription.sdp);
        return this.role === 'creator' ? { creator: local, joiner: remote } : { creator: remote, joiner: local };
    }

    close() {
        this.handlers = { onOpen() {}, onFrame() {}, onClose() {} };
        this.channel?.close();
        this.pc.close();
    }
}

export function fingerprint(sdp) {
    const lines = sdp
        .split(/\r?\n/)
        .filter((line) => line.startsWith('a=fingerprint:'))
        .map((line) => {
            const [algorithm, value] = line.slice('a=fingerprint:'.length).trim().split(/\s+/);
            return `${algorithm.toLowerCase()} ${value.toUpperCase()}`;
        });
    return [...new Set(lines)].sort().join(',');
}
