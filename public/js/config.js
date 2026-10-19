// Keeps every encrypted frame under 64 KB, the data channel message size all browsers accept.
export const CHUNK_SIZE = 60 * 1024;
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 10000;
export const MAX_INCOMING_TRANSFERS = 3;
export const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const INLINE_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
export const IMAGE_MAX_DIMENSION = 2560;
export const MAX_RECORDING_MS = 5 * 60 * 1000;

export const CONNECT_TIMEOUT_MS = 20 * 1000;
export const HANDSHAKE_TIMEOUT_MS = 10 * 1000;
export const TYPING_SEND_INTERVAL_MS = 3 * 1000;
export const TYPING_DISPLAY_MS = 6 * 1000;
export const CALL_RING_TIMEOUT_MS = 45 * 1000;
