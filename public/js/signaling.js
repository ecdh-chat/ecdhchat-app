import { serverOrigin, socketUrl } from './platform.js';

export function connectSignaling({ onMessage, onClose }) {
    const socket = new WebSocket(socketUrl(serverOrigin()));
    const opened = new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

    socket.onmessage = ({ data }) => {
        let message;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (message && typeof message === 'object') onMessage(message);
    };
    socket.onclose = () => onClose();

    return {
        send(message) {
            opened.then(() => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
            });
        },

        close() {
            socket.onclose = null;
            socket.close();
        },
    };
}
