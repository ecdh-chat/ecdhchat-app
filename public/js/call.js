import * as alerts from './alerts.js';
import { CALL_RING_TIMEOUT_MS } from './config.js';
import { getCallMedia, getScreenMedia } from './media.js';
import { MessageType, encode } from './messages.js';

const $ = (id) => document.getElementById(id);

// A voice or video call on top of the open Connection. Camera and microphone are only on while
// a call is ringing or active. Either person can share a screen during the call, if both apps
// support it; it travels on the same encrypted connection the code check covers.
//
// state: idle → outgoing | incoming → active → idle
export class Call {
    constructor({ connection, onSystem, onBusyChange }) {
        this.connection = connection;
        this.onSystem = onSystem;
        this.onBusyChange = onBusyChange;
        this.state = 'idle';
        this.video = false;
        this.local = null;
        this.remote = new MediaStream();
        this.timer = null;
        this.clock = null;
        this.startedAt = 0;
        this.screen = null;
        this.screenAllowed = false;
        this.els = {
            banner: $('callBanner'),
            bannerText: $('callBannerText'),
            screen: $('callScreen'),
            remoteVideo: $('remoteVideo'),
            localVideo: $('localVideo'),
            status: $('callStatus'),
            mute: $('muteButton'),
            camera: $('cameraButton'),
            share: $('shareButton'),
            sharing: $('sharingNote'),
        };
        $('callAccept').onclick = () => this.accept();
        $('callDecline').onclick = () => this.decline();
        $('hangUpButton').onclick = () => this.hangUp();
        this.els.mute.onclick = () => this.toggle('audio', this.els.mute);
        this.els.camera.onclick = () => this.toggle('video', this.els.camera);
        this.els.share.onclick = () => (this.screen ? this.stopSharing() : this.startSharing());
    }

    // Set once the other app has said whether it supports screen sharing.
    setScreenSharing(allowed) {
        this.screenAllowed = allowed && Boolean(navigator.mediaDevices?.getDisplayMedia);
        this.els.share.hidden = !this.screenAllowed || this.state !== 'active';
    }

    async startSharing() {
        if (this.state !== 'active' || !this.screenAllowed || this.screen) return;
        let screen;
        try {
            screen = await getScreenMedia();
        } catch {
            return; // The person closed the picker.
        }
        if (this.state !== 'active') return screen.getTracks().forEach((track) => track.stop());
        this.screen = screen;
        const [track] = screen.getVideoTracks();
        // The browser's own "Stop sharing" button ends the track.
        track.addEventListener('ended', () => this.stopSharing());
        await this.connection.peer.setVideoTrack(track, screen).catch(() => {});
        this.send('screen-on');
        this.els.screen.classList.add('sharing');
        this.els.sharing.hidden = false;
        this.setPressed(this.els.share, true);
    }

    async stopSharing() {
        if (!this.screen) return;
        for (const track of this.screen.getTracks()) track.stop();
        this.screen = null;
        this.els.screen.classList.remove('sharing');
        this.els.sharing.hidden = true;
        this.setPressed(this.els.share, false);
        if (this.state !== 'active') return;
        const camera = this.video ? this.local?.getVideoTracks()[0] ?? null : null;
        await this.connection.peer.setVideoTrack(camera, this.local).catch(() => {});
        this.send('screen-off');
    }

    async start(video) {
        if (this.state !== 'idle') return;
        this.video = video;
        this.setState('outgoing');
        try {
            this.local = await getCallMedia(video);
        } catch {
            this.reset();
            this.onSystem('Couldn’t use your microphone or camera. Check this site’s permissions in your browser.');
            return;
        }
        if (this.state !== 'outgoing') return this.stopLocal();

        this.showScreen('Calling…');
        this.send('invite');
        this.timer = setTimeout(() => {
            this.send('end');
            this.reset();
            this.onSystem('No answer.');
        }, CALL_RING_TIMEOUT_MS);
    }

    handleMessage({ action, video }) {
        switch (action) {
            case 'invite':
                if (this.state !== 'idle') return this.send('busy', video);
                this.video = video;
                this.setState('incoming');
                this.els.bannerText.textContent = video ? 'Incoming video call' : 'Incoming voice call';
                this.els.banner.hidden = false;
                alerts.alertCall();
                this.timer = setTimeout(() => {
                    this.reset();
                    this.onSystem('Missed call.');
                }, CALL_RING_TIMEOUT_MS);
                break;
            case 'accept':
                if (this.state === 'outgoing') this.activate();
                break;
            case 'decline':
            case 'busy':
                if (this.state !== 'outgoing') return;
                this.reset();
                this.onSystem(action === 'busy' ? 'They’re busy right now.' : 'Call declined.');
                break;
            case 'screen-on':
            case 'screen-off':
                if (this.state !== 'active') return;
                this.els.screen.classList.toggle('remote-sharing', action === 'screen-on');
                if (action === 'screen-on') this.playRemote();
                break;
            case 'end': {
                if (this.state === 'idle') return;
                const note = this.state === 'incoming' ? 'Missed call.' : this.summary();
                this.reset();
                this.onSystem(note);
                break;
            }
        }
    }

    async accept() {
        if (this.state !== 'incoming') return;
        clearTimeout(this.timer);
        this.els.banner.hidden = true;
        try {
            this.local = await getCallMedia(this.video);
        } catch {
            this.send('decline');
            this.reset();
            this.onSystem('Couldn’t use your microphone or camera. Check this site’s permissions in your browser.');
            return;
        }
        if (this.state !== 'incoming') return this.stopLocal();
        this.send('accept');
        this.activate();
    }

    decline() {
        if (this.state !== 'incoming') return;
        this.send('decline');
        this.reset();
        this.onSystem('You declined the call.');
    }

    hangUp() {
        if (this.state === 'idle') return;
        this.send('end');
        const note = this.state === 'active' ? this.summary() : 'Call cancelled.';
        this.reset();
        this.onSystem(note);
    }

    handleTrack({ track }) {
        if (!this.remote.getTracks().includes(track)) this.remote.addTrack(track);
        if (this.state === 'active') this.playRemote();
    }

    // The chat is closing; stop everything without telling anyone.
    dispose() {
        if (this.state !== 'idle') this.reset();
    }

    activate() {
        clearTimeout(this.timer);
        this.setState('active');
        this.startedAt = Date.now();
        this.connection.enableRenegotiation();
        this.connection.peer.setLocalMedia(this.local);
        this.showScreen(this.duration());
        this.playRemote();
        this.clock = setInterval(() => { this.els.status.textContent = this.duration(); }, 1000);
    }

    reset() {
        clearTimeout(this.timer);
        clearInterval(this.clock);
        for (const track of this.screen?.getTracks() ?? []) track.stop();
        this.screen = null;
        this.els.screen.classList.remove('sharing', 'remote-sharing');
        this.els.sharing.hidden = true;
        this.els.share.hidden = true;
        this.stopLocal();
        this.connection.peer.setLocalMedia(null);
        this.els.banner.hidden = true;
        this.els.screen.hidden = true;
        this.els.remoteVideo.srcObject = null;
        this.els.localVideo.srcObject = null;
        this.setState('idle');
    }

    setState(state) {
        this.state = state;
        this.onBusyChange(state !== 'idle');
    }

    showScreen(status) {
        this.els.screen.hidden = false;
        this.els.screen.classList.toggle('voice', !this.video);
        this.els.camera.hidden = !this.video;
        this.els.share.hidden = !this.screenAllowed || this.state !== 'active';
        this.els.localVideo.srcObject = this.video ? this.local : null;
        this.els.status.textContent = status;
        this.setPressed(this.els.mute, false);
        this.setPressed(this.els.camera, false);
        this.setPressed(this.els.share, false);
    }

    playRemote() {
        this.els.remoteVideo.srcObject = this.remote;
        this.els.remoteVideo.play().catch(() => {});
    }

    toggle(kind, button) {
        if (!this.local) return;
        const off = button.getAttribute('aria-pressed') !== 'true';
        for (const track of this.local.getTracks()) {
            if (track.kind === kind) track.enabled = !off;
        }
        this.setPressed(button, off);
    }

    setPressed(button, pressed) {
        const labels = {
            [this.els.mute.id]: pressed ? 'Unmute' : 'Mute',
            [this.els.camera.id]: pressed ? 'Turn camera on' : 'Turn camera off',
            [this.els.share.id]: pressed ? 'Stop sharing your screen' : 'Share your screen',
        };
        const label = labels[button.id];
        button.setAttribute('aria-pressed', String(pressed));
        button.setAttribute('aria-label', label);
        button.title = label;
    }

    stopLocal() {
        for (const track of this.local?.getTracks() ?? []) track.stop();
        this.local = null;
    }

    send(action, video = this.video) {
        this.connection.send(encode(MessageType.CALL, { action, video }));
    }

    duration() {
        const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    summary() {
        return `Call ended · ${this.duration()}`;
    }
}
