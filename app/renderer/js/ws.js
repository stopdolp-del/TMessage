/**
 * WebSocket client: auth, typing, real-time events, WebRTC signaling.
 */
import { getToken } from './api.js';

const WS_URL = () => {
  const u = new URL(window.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
};

export function connectSocket(handlers) {
  const ws = new WebSocket(WS_URL());
  ws.addEventListener('open', () => {
    const token = getToken();
    if (token) ws.send(JSON.stringify({ type: 'authenticate', token }));
  });
  ws.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (handlers.onEvent) handlers.onEvent(data);
  });
  ws.addEventListener('close', () => {
    if (handlers.onClose) handlers.onClose();
  });
  return ws;
}

export function sendTyping(ws, chatId, isTyping) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'typing', chatId, isTyping }));
}

export function sendResync(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'resync_chats' }));
}

export function sendCallSignal(ws, chatId, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: 'call_signal',
      chatId,
      signalType: payload.signalType,
      sdp: payload.sdp,
      candidate: payload.candidate,
      media: payload.media || 'audio',
    })
  );
}

export function sendHeartbeat(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'heartbeat' }));
}
