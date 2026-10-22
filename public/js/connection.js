import { CONNECT_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS } from './config.js';
import { MessageType, ProtocolError, decode, encode, pad } from './messages.js';
import { Peer, fingerprint } from './peer.js';
import { SecureChannel } from './secure-channel.js';
import { IncomingTransfers } from './transfer.js';

const OWN_GOODBYES = { ended: 'you-ended', mismatch: 'mismatch' };

// The encrypted peer-to-peer link to the other person. Whoever made the room sends the WebRTC
// offer and takes the "creator" side of the handshake.
//
// state: connecting → securing → open → closed
export class Connection {
    constructor({ role, roomId, secret, iceServers, sendSignal, onOpen, onMessage, onClose, onStateChange, onTrack }) {
        this.role = role;
        this.roomId = roomId;
        this.secret = secret;
        this.state = 'connecting';
        this.sas = '';
        this.verifiedByMe = false;
        this.verifiedByPeer = false;
        // Turned on once the other side announces it understands padded messages ('pad').
        this.padding = false;
        this.incoming = new IncomingTransfers();
        this.handlers = { onOpen, onMessage, onClose, onStateChange };
        this.channel = null;
        this.goodbye = null;
        this.makingOffer = false;
        this.sendQueue = Promise.resolve();
        this.receiving = Promise.resolve();

        this.peer = new Peer({
            role,
            iceServers,
            onSignal: sendSignal,
            onOpen: () => this.startHandshake(),
            onFrame: (frame) => this.receiveFrame(frame),
            // Frames that arrived just before the close (such as a goodbye) are handled first.
            onClose: () => this.receiving.then(() => this.close(this.state === 'connecting' ? 'connect-failed' : 'peer-left')),
            onStateChange: (state) => this.connectionStateChanged(state),
            onTrack,
        });
        this.timer = setTimeout(() => this.close('connect-failed'), CONNECT_TIMEOUT_MS);
        if (role === 'creator') this.peer.offer().catch(() => this.close('connect-failed'));
    }

    handleSignal(signal) {
        this.peer.handleSignal(signal).catch(() => this.close('connect-failed'));
    }

    send(bytes) {
        return this.queue(async () => {
            if (this.state !== 'open') return;
            await this.peer.send(await this.channel.seal(this.padding ? pad(bytes) : bytes));
        });
    }

    // Waits for the other side to hang up after reading the goodbye, so it isn't lost when this
    // side closes the connection.
    async sayGoodbye(reason) {
        if (this.state !== 'open') return this.close('you-ended');
        this.goodbye = reason;
        await Promise.race([
            this.send(encode(MessageType.BYE, { reason })).then(() => this.peer.closed),
            new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        this.close(OWN_GOODBYES[reason]);
    }

    // Calls renegotiate their media over this encrypted channel, never through the server.
    enableRenegotiation() {
        this.peer.pc.onnegotiationneeded = () => this.renegotiate();
    }

    close(reason) {
        if (this.state === 'closed') return;
        this.state = 'closed';
        clearTimeout(this.timer);
        this.incoming.clear();
        this.peer.close();
        this.channel = null;
        this.handlers.onClose(this.goodbye ? OWN_GOODBYES[this.goodbye] : reason);
    }

    startHandshake() {
        clearTimeout(this.timer);
        this.state = 'securing';
        this.timer = setTimeout(() => this.close('handshake-failed'), HANDSHAKE_TIMEOUT_MS);
        const fingerprints = this.peer.fingerprints();
        this.remoteFingerprint = this.role === 'creator' ? fingerprints.joiner : fingerprints.creator;
        this.channel = new SecureChannel({ role: this.role, roomId: this.roomId, secret: this.secret, fingerprints });
        this.channel.start().then((result) => this.handleChannel(result)).catch(() => this.close('handshake-failed'));
    }

    receiveFrame(frame) {
        if (!this.channel) return this.close('handshake-failed');
        this.receiving = this.channel.receive(frame)
            .then((result) => this.handleChannel(result))
            .catch(() => this.close(this.state === 'open' ? 'tampered' : 'handshake-failed'));
    }

    async handleChannel({ send: frames = [], ready, message }) {
        // Whatever was still being decrypted when the chat closed is dropped.
        if (this.state === 'closed') return;
        for (const frame of frames) this.queue(() => this.peer.send(frame));
        if (ready) {
            clearTimeout(this.timer);
            this.sas = ready.sas;
            this.state = 'open';
            this.handlers.onOpen();
        }
        if (!message) return;

        // Anything that fails in here closes the chat as tampered. A type from a newer version is
        // skipped.
        const decoded = decode(message);
        if (!decoded) return;
        if (decoded.type === MessageType.BYE) return this.close(decoded.reason === 'mismatch' ? 'peer-mismatch' : 'peer-ended');
        if (decoded.type === MessageType.RTC) return this.handleRtc(decoded.description);
        this.handlers.onMessage(decoded);
    }

    async renegotiate() {
        try {
            this.makingOffer = true;
            await this.peer.pc.setLocalDescription();
            await this.send(encode(MessageType.RTC, { description: this.peer.pc.localDescription.toJSON() }));
        } catch {
            this.close('network-lost');
        } finally {
            this.makingOffer = false;
        }
    }

    // "Perfect negotiation": when both sides offer at once, the joiner side yields. A description
    // with any other DTLS certificate than the one the handshake bound is an attack.
    async handleRtc(description) {
        if (fingerprint(description.sdp) !== this.remoteFingerprint) throw new ProtocolError('DTLS fingerprint changed');
        const { pc } = this.peer;
        const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        if (collision && this.role === 'creator') return;

        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
            await pc.setLocalDescription();
            await this.send(encode(MessageType.RTC, { description: pc.localDescription.toJSON() }));
        }
    }

    // Everything leaves through one queue, so records go out in the order their nonces were used.
    queue(task) {
        this.sendQueue = this.sendQueue.then(task).catch(() => this.close('network-lost'));
        return this.sendQueue;
    }

    connectionStateChanged(state) {
        if (state === 'failed') return this.close(this.state === 'open' ? 'network-lost' : 'connect-failed');
        this.handlers.onStateChange(state);
    }
}
