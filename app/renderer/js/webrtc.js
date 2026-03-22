/**
 * WebRTC voice/video via server signaling (STUN). Add TURN for strict NAT.
 */
import { sendCallSignal } from './ws.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

function attachIce(ws, chatId, pc, media) {
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendCallSignal(ws, chatId, { signalType: 'candidate', candidate: ev.candidate, media });
    }
  };
}

function mediaConstraints(withVideo) {
  return { audio: true, video: withVideo ? { width: 640, height: 480, facingMode: 'user' } : false };
}

/**
 * Caller: creates offer after local media is ready.
 * @param {'audio'|'video'} mediaKind
 */
export function startOutgoingCall(ws, chatId, onRemoteStream, onEnd, mediaKind = 'audio') {
  const withVideo = mediaKind === 'video';
  const pc = new RTCPeerConnection({ iceServers: ICE });
  attachIce(ws, chatId, pc, mediaKind);
  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream?.(ev.streams[0]);
  };

  let closed = false;
  return navigator.mediaDevices
    .getUserMedia(mediaConstraints(withVideo))
    .then((stream) => {
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      return pc.createOffer();
    })
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      sendCallSignal(ws, chatId, {
        signalType: 'offer',
        sdp: pc.localDescription,
        media: mediaKind,
      });
    })
    .then(() => ({
      pc,
      handleSignal: async (msg) => {
        if (closed) return;
        if (msg.signalType === 'answer' && msg.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.signalType === 'candidate' && msg.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            /* ignore */
          }
        }
      },
      close: () => {
        closed = true;
        pc.close();
      },
    }))
    .catch((e) => {
      onEnd?.(e);
      throw e;
    });
}

/**
 * Callee: answers incoming offer.
 */
export function answerIncomingCall(ws, chatId, offerSdp, onRemoteStream, onEnd, mediaKind = 'audio') {
  const withVideo = mediaKind === 'video';
  const pc = new RTCPeerConnection({ iceServers: ICE });
  attachIce(ws, chatId, pc, mediaKind);
  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream?.(ev.streams[0]);
  };

  let closed = false;
  return navigator.mediaDevices
    .getUserMedia(mediaConstraints(withVideo))
    .then((stream) => {
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      return pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    })
    .then(() => pc.createAnswer())
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => {
      sendCallSignal(ws, chatId, { signalType: 'answer', sdp: pc.localDescription, media: mediaKind });
    })
    .then(() => ({
      pc,
      handleSignal: async (msg) => {
        if (closed) return;
        if (msg.signalType === 'candidate' && msg.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            /* ignore */
          }
        }
      },
      close: () => {
        closed = true;
        pc.close();
      },
    }))
    .catch((e) => {
      onEnd?.(e);
      throw e;
    });
}
