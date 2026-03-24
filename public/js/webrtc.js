/**
 * WebRTC: STUN + optional TURN via window.__TMessage_TURN__
 */
import { sendCallSignal } from './ws.js';

function buildIceServers() {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (typeof window !== 'undefined' && Array.isArray(window.__TMessage_TURN__)) {
    servers.push(...window.__TMessage_TURN__);
  }
  return servers;
}

function rtcConfig() {
  return { 
    iceServers: buildIceServers(), 
    iceCandidatePoolSize: 10,
    sdpSemantics: 'unified-plan'
  };
}

function attachIce(ws, chatId, pc, media) {
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendCallSignal(ws, chatId, { signalType: 'candidate', candidate: ev.candidate, media });
    }
  };
}

function mediaConstraints(withVideo, facingMode = 'user') {
  if (!withVideo) return { audio: true, video: false };
  return {
    audio: true,
    video: {
      facingMode,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  };
}

function bindConnectionRecovery(pc) {
  let once = false;
  pc.addEventListener('connectionstatechange', () => {
    const s = pc.connectionState;
    if ((s === 'failed' || s === 'disconnected') && !once) {
      once = true;
      try {
        pc.restartIce();
      } catch {
        /* ignore */
      }
    }
  });
}

export function startOutgoingCall(
  ws,
  chatId,
  onRemoteStream,
  onEnd,
  mediaKind = 'audio',
  onLocalStream
) {
  const withVideo = mediaKind === 'video';
  const pc = new RTCPeerConnection(rtcConfig());
  bindConnectionRecovery(pc);
  attachIce(ws, chatId, pc, mediaKind);
  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream?.(ev.streams[0]);
  };

  let closed = false;
  let localStream = null;

  return navigator.mediaDevices
    .getUserMedia(mediaConstraints(withVideo))
    .then((stream) => {
      localStream = stream;
      onLocalStream?.(stream);
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
      localStream,
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
        try {
          localStream?.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        pc.close();
      },
    }))
    .catch((e) => {
      onEnd?.(e);
      throw e;
    });
}

export function answerIncomingCall(
  ws,
  chatId,
  offerSdp,
  onRemoteStream,
  onEnd,
  mediaKind = 'audio',
  onLocalStream
) {
  const withVideo = mediaKind === 'video';
  const pc = new RTCPeerConnection(rtcConfig());
  bindConnectionRecovery(pc);
  attachIce(ws, chatId, pc, mediaKind);
  pc.ontrack = (ev) => {
    if (ev.streams[0]) onRemoteStream?.(ev.streams[0]);
  };

  let closed = false;
  let localStream = null;

  return navigator.mediaDevices
    .getUserMedia(mediaConstraints(withVideo))
    .then((stream) => {
      localStream = stream;
      onLocalStream?.(stream);
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
      localStream,
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
        try {
          localStream?.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        pc.close();
      },
    }))
    .catch((e) => {
      onEnd?.(e);
      throw e;
    });
}

export function setMicMuted(stream, muted) {
  if (!stream) return;
  stream.getAudioTracks().forEach((t) => {
    t.enabled = !muted;
  });
}

export function setCameraEnabled(stream, on) {
  if (!stream) return;
  stream.getVideoTracks().forEach((t) => {
    t.enabled = on;
  });
}

export async function switchCameraFacing(pc, localStream) {
  if (!pc || !localStream) return;
  const prev = localStream.getVideoTracks()[0];
  const curFacing = prev?.getSettings?.()?.facingMode;
  const nextFacing = curFacing === 'environment' ? 'user' : 'environment';
  const tmp = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: nextFacing,
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  const newVt = tmp.getVideoTracks()[0];
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (sender && newVt) await sender.replaceTrack(newVt);
  if (prev) {
    prev.stop();
    localStream.removeTrack(prev);
  }
  if (newVt) {
    tmp.removeTrack(newVt);
    localStream.addTrack(newVt);
  }
}
