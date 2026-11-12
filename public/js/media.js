const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

// The microphone, and for a video call the camera too. Where the camera can't be used (there is
// none, it's blocked, or another program has it) a video call still gets the microphone, so the
// stream may come back without video.
export async function getCallMedia(video) {
    const audio = { echoCancellation: true, noiseSuppression: true };
    if (video) {
        try {
            return await navigator.mediaDevices.getUserMedia({ audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } });
        } catch {
            // Falls through to the microphone alone.
        }
    }
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

// Asks which screen or window to share. Audio isn't shared.
export function getScreenMedia() {
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
}

// Records a voice message. stop() resolves to the recording; cancel() throws it away.
export async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.ondataavailable = ({ data }) => {
        if (data.size > 0) chunks.push(data);
    };
    recorder.start();

    async function finish(keep) {
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        for (const track of stream.getTracks()) track.stop();
        return keep ? new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }) : null;
    }

    return { stop: () => finish(true), cancel: () => finish(false) };
}

export function voiceMessageName(type) {
    const base = type.split(';')[0];
    const extension = base === 'audio/mp4' ? 'm4a' : base === 'audio/ogg' ? 'ogg' : 'webm';
    return `Voice message.${extension}`;
}
