/**
 * TMessing client: chats, reactions, receipts, search, settings, calls, theme.
 */
import { api, setToken, setRefreshToken, getToken, assetBase } from './api.js';
import { connectSocket, sendTyping, sendResync, sendHeartbeat, sendCallSignal } from './ws.js';
import { startOutgoingCall, answerIncomingCall } from './webrtc.js';

/** @type {WebSocket | null} */
let socket = null;
/** @type {any} */
let me = null;
let chats = [];
let activeChatId = null;
/** @type {Record<number, any[]>} */
const messagesByChat = {};
/** @type {Record<number, number>} */
const oldestIdByChat = {};
let typingTimer = null;
let voiceSession = null;
/** Chat id for the active WebRTC session (outgoing or accepted incoming). */
let callChatId = null;
/** @type {{ chatId: number; sdp: any; mediaKind: string; fromUserId: number } | null} */
let pendingIncomingCall = null;
/** @type {any} */
let replyTo = null;
let heartbeatTimer = null;
let settings = { notify_sound: 1, notify_desktop: 1, theme: 'dark' };
/** @type {MediaRecorder | null} */
let mediaRecorder = null;
let receiptReloadTimer;
let chatListRenderTimer;
const deliveredPending = new Set();
let deliveredFlushTimer = null;

function scheduleReceiptReload() {
  clearTimeout(receiptReloadTimer);
  receiptReloadTimer = setTimeout(() => {
    if (activeChatId) loadMessages(activeChatId).catch(() => {});
  }, 350);
}

function queueDeliveredAck(messageId) {
  if (!messageId || !me) return;
  deliveredPending.add(messageId);
  clearTimeout(deliveredFlushTimer);
  deliveredFlushTimer = setTimeout(flushDeliveredAcks, 160);
}

function flushDeliveredAcks() {
  deliveredFlushTimer = null;
  const ids = [...deliveredPending];
  deliveredPending.clear();
  if (!ids.length) return;
  void Promise.all(ids.map((id) => api(`/messages/delivered/${id}`, { method: 'POST' }).catch(() => {})));
}

function scheduleChatListRender() {
  clearTimeout(chatListRenderTimer);
  chatListRenderTimer = setTimeout(() => {
    renderChatList($('#chat-search')?.value || '');
  }, 80);
}

const $ = (sel) => document.querySelector(sel);

const EMOJIS = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🎉', '👏'];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
}

function showError(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg || '';
}

function setFormLoading(form, loading) {
  const btn = form?.querySelector?.('button[type="submit"]');
  if (btn) {
    btn.disabled = !!loading;
    btn.classList.toggle('is-loading', !!loading);
  }
}

function playBeep() {
  if (!settings.notify_sound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    o.start();
    o.stop(ctx.currentTime + 0.06);
  } catch {
    /* ignore */
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

async function refreshMe() {
  const { user } = await api('/auth/me');
  me = user;
  const tu = $('#top-user');
  if (tu) tu.textContent = user.username ? `@${user.username}` : '';
  $('#btn-admin')?.classList.toggle('hidden', !user.is_admin);
  return user;
}

async function loadSettings() {
  try {
    const { settings: s } = await api('/settings/me');
    settings = { ...settings, ...s };
    applyTheme(s.theme === 'light' ? 'light' : 'dark');
  } catch {
    applyTheme(localStorage.getItem('tm_theme') || 'dark');
  }
}

async function loadChats() {
  const { chats: list } = await api('/chats');
  chats = list;
  renderChatList();
}

function renderChatList(filter = '') {
  const ul = $('#chat-list');
  if (!ul) return;
  const q = filter.toLowerCase();
  ul.innerHTML = '';
  chats
    .filter((c) => !q || (c.name || '').toLowerCase().includes(q))
    .forEach((c) => {
      const li = document.createElement('li');
      li.className = 'chat-item' + (c.id === activeChatId ? ' active' : '');
      const avatar = c.peer?.avatar_url || c.avatar_url || '';
      const verified =
        c.type === 'private' && c.peer?.is_admin ? ' <span class="badge" title="Admin">✔</span>' : '';
      const sub =
        c.type === 'private' && c.peer?.status_text
          ? escapeHtml(c.peer.status_text)
          : '';
      li.innerHTML = `
        <img class="avatar" alt="" src="${avatar ? assetBase() + avatar : ''}" />
        <div class="meta">
          <div class="name">${escapeHtml(c.name || 'Chat')}${verified}</div>
          <div class="preview">${escapeHtml((c.last_body || sub || '').slice(0, 80))}</div>
        </div>
      `;
      li.addEventListener('click', () => selectChat(c.id));
      ul.appendChild(li);
    });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function formatLastSeen(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString();
}

function formatMessageTime(ts) {
  if (ts == null) return '';
  return new Date(Number(ts) * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function chatLabelForId(chatId) {
  const c = chats.find((x) => x.id === chatId);
  if (!c) return `Chat #${chatId}`;
  if (c.type === 'private' && c.peer) return c.peer.username;
  return c.name || `Chat #${chatId}`;
}

function setCallStatus(text) {
  const el = $('#call-status');
  if (el) el.textContent = text || '';
}

function hideIncomingSheet() {
  $('#incoming-call-sheet')?.classList.add('hidden');
}

function showIncomingSheet(data, mediaKind) {
  const title = $('#incoming-call-title');
  const sub = $('#incoming-call-sub');
  if (title) {
    title.textContent = mediaKind === 'video' ? 'Incoming video call' : 'Incoming voice call';
  }
  if (sub) {
    sub.textContent = `From ${chatLabelForId(data.chatId)}`;
  }
  $('#incoming-call-sheet')?.classList.remove('hidden');
}

function scrollMessagesToBottom(box) {
  if (!box) return;
  requestAnimationFrame(() => {
    box.scrollTop = box.scrollHeight;
  });
}

async function selectChat(chatId) {
  activeChatId = chatId;
  $('#chat-placeholder')?.classList.add('hidden');
  $('#chat-panel')?.classList.remove('hidden');
  const c = chats.find((x) => x.id === chatId);
  const title = $('#chat-title');
  const sub = $('#chat-sub');
  if (title) title.innerHTML = escapeHtml(c?.name || 'Chat');
  if (sub) {
    if (c?.type === 'private' && c.peer) {
      const online = c.peer.online ? 'online' : 'offline';
      const seen = c.peer.last_seen ? ` · ${formatLastSeen(c.peer.last_seen)}` : '';
      sub.textContent = `${online}${seen}`;
    } else sub.textContent = c?.type || '';
  }
  renderChatList($('#chat-search')?.value || '');
  await loadMessages(chatId);
  const list = messagesByChat[chatId] || [];
  const maxId = list.length ? Math.max(...list.map((m) => m.id)) : 0;
  if (maxId) {
    try {
      await api('/messages/read', {
        method: 'POST',
        body: JSON.stringify({ chatId, upToMessageId: maxId }),
      });
    } catch {
      /* ignore */
    }
  }
}

async function loadMessages(chatId, before = null) {
  let path = `/messages/chat/${chatId}?limit=40`;
  if (before) path += `&before=${before}`;
  const { messages } = await api(path);
  if (before) {
    const cur = messagesByChat[chatId] || [];
    messagesByChat[chatId] = [...messages, ...cur];
  } else {
    messagesByChat[chatId] = messages;
  }
  if (messages.length) oldestIdByChat[chatId] = messages[0].id;
  $('#btn-load-more')?.classList.toggle('hidden', messages.length < 40);
  renderMessages(chatId);
  messages.forEach((m) => {
    if (m.sender_id !== me?.id) queueDeliveredAck(m.id);
  });
}

function receiptLabel(m) {
  if (!m.receipt || m.sender_id !== me?.id) return '';
  if (m.receipt.read) return '<span class="ticks" title="Read">✓✓</span>';
  if (m.receipt.delivered) return '<span class="ticks" title="Delivered">✓</span>';
  return '<span class="ticks dim">○</span>';
}

function buildMessageElement(m) {
  const own = m.sender_id === me.id;
  const div = document.createElement('div');
  div.className = 'msg' + (own ? ' own' : '');
  div.dataset.id = String(m.id);
  const badge = m.is_admin ? ' <span class="badge" title="Admin">✔</span>' : '';
  let bodyHtml = escapeHtml(m.body || '');
  if (m.forward_from_label) {
    bodyHtml = `<div class="forward-hint">↪ ${escapeHtml(m.forward_from_label)}</div>` + bodyHtml;
  }
  if (m.reply_username) {
    bodyHtml =
      `<div class="reply-hint">↩ ${escapeHtml(m.reply_username)}: ${escapeHtml((m.reply_body || '').slice(0, 80))}</div>` +
      bodyHtml;
  }
  if (m.msg_type === 'image' && m.file_path) {
    bodyHtml += `<br><img class="attach" src="${assetBase()}${m.file_path}" alt="" loading="lazy" />`;
  } else if (m.file_path && m.file_mime?.startsWith('video/')) {
    bodyHtml += `<br><video class="attach" src="${assetBase()}${m.file_path}" controls playsinline></video>`;
  } else if (m.file_path && m.file_mime?.startsWith('audio/')) {
    bodyHtml += `<br><audio class="attach" src="${assetBase()}${m.file_path}" controls></audio>`;
  } else if (m.msg_type === 'file' && m.file_path && !m.file_mime?.startsWith('audio/')) {
    bodyHtml += `<br><a class="file-link" href="${assetBase()}${m.file_path}" target="_blank" rel="noopener">${escapeHtml(
      m.file_name || 'File'
    )}</a>`;
  }
  const edited = m.edited_at ? ' <span class="edited">(edited)</span>' : '';
  const reacts = (m.reactions || [])
    .map((r) => `<span class="react" data-emoji="${r.emoji}">${r.emoji}</span>`)
    .join(' ');
  const reactBar = `<div class="react-row">${EMOJIS.map((e) => `<button type="button" class="react-add" data-e="${e}">${e}</button>`).join('')} ${reacts}</div>`;
  const actions = own
    ? `<button type="button" class="msg-act" data-act="edit">Edit</button>
         <button type="button" class="msg-act" data-act="del">Delete</button>`
    : '';
  const ticks = own ? receiptLabel(m) : '';
  const timeStr = formatMessageTime(m.created_at);
  div.innerHTML = `
      <div class="msg-head">
        <span class="who">${escapeHtml(m.username)}${badge}</span>
        <button type="button" class="msg-act" data-act="reply">Reply</button>
        <button type="button" class="msg-act" data-act="fwd">Fwd</button>
        ${actions}
      </div>
      <div class="body">${bodyHtml}${edited}</div>
      <div class="msg-footer">
        <span class="msg-time">${escapeHtml(timeStr)}</span>${ticks}
      </div>
      ${reactBar}
    `;
  div.querySelectorAll('.react-add').forEach((btn) => {
    btn.addEventListener('click', () => toggleReaction(m.id, btn.getAttribute('data-e')));
  });
  div.querySelector('[data-act="reply"]')?.addEventListener('click', () => {
    replyTo = m;
    const rp = $('#reply-preview');
    const rt = $('#reply-preview-text');
    if (rp && rt) {
      rt.textContent = `${m.username}: ${(m.body || m.file_name || '').slice(0, 120)}`;
      rp.classList.remove('hidden');
    }
  });
  div.querySelector('[data-act="fwd"]')?.addEventListener('click', async () => {
    const cid = window.prompt('Forward to chat ID (number):');
    if (!cid) return;
    await api(`/messages/message/${m.id}/forward`, {
      method: 'POST',
      body: JSON.stringify({ chatIds: [Number(cid)] }),
    });
  });
  div.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
    const t = window.prompt('Edit message', m.body || '');
    if (t == null) return;
    await api(`/messages/message/${m.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: t }),
    });
  });
  div.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
    if (!confirm('Delete message?')) return;
    await api(`/messages/message/${m.id}`, { method: 'DELETE' });
  });
  return div;
}

function refreshMessageDom(messageId) {
  const box = $('#messages');
  if (!box || !activeChatId) return;
  const list = messagesByChat[activeChatId] || [];
  const msg = list.find((m) => m.id === messageId);
  if (!msg) return;
  const el = box.querySelector(`.msg[data-id="${messageId}"]`);
  if (!el) return;
  el.replaceWith(buildMessageElement(msg));
}

function renderMessages(chatId) {
  const box = $('#messages');
  if (!box) return;
  const list = messagesByChat[chatId] || [];
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.forEach((m) => frag.appendChild(buildMessageElement(m)));
  box.appendChild(frag);
  scrollMessagesToBottom(box);
}

async function toggleReaction(messageId, emoji) {
  const list = messagesByChat[activeChatId] || [];
  const msg = list.find((x) => x.id === messageId);
  if (!msg || !me) return;
  const mine = msg.reactions?.find((r) => r.userId === me.id);
  const prev = msg.reactions ? msg.reactions.map((r) => ({ ...r })) : [];
  try {
    if (mine?.emoji === emoji) {
      await api(`/messages/message/${messageId}/react`, { method: 'DELETE' });
      msg.reactions = (msg.reactions || []).filter((r) => r.userId !== me.id);
    } else {
      await api(`/messages/message/${messageId}/react`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      });
      msg.reactions = [...(msg.reactions || []).filter((r) => r.userId !== me.id), { userId: me.id, emoji }];
    }
    refreshMessageDom(messageId);
  } catch (e) {
    msg.reactions = prev;
    refreshMessageDom(messageId);
    console.warn('[TMessage] reaction', e);
  }
}

function patchMessage(chatId, updated) {
  const list = messagesByChat[chatId];
  if (!list) return;
  const i = list.findIndex((m) => m.id === updated.id);
  if (i >= 0) list[i] = { ...list[i], ...updated };
  if (chatId === activeChatId) renderMessages(chatId);
}

function appendMessage(chatId, m) {
  if (!messagesByChat[chatId]) messagesByChat[chatId] = [];
  if (messagesByChat[chatId].some((x) => x.id === m.id)) return;
  messagesByChat[chatId].push(m);
  if (chatId === activeChatId) {
    const box = $('#messages');
    if (box) {
      box.appendChild(buildMessageElement(m));
      scrollMessagesToBottom(box);
    }
  }
  const c = chats.find((x) => x.id === chatId);
  if (c) {
    c.last_body = m.body;
    c.last_at = m.created_at;
  }
  chats.sort((a, b) => (b.last_at || 0) - (a.last_at || 0));
  scheduleChatListRender();
  if (document.hidden && settings.notify_desktop) {
    const body = `${m.username}: ${m.body || m.file_name || ''}`;
    if (window.tmessing?.showNotification) {
      window.tmessing.showNotification('TMessage', body);
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('TMessage', { body });
      } catch {
        /* ignore */
      }
    }
  }
  if (settings.notify_sound && chatId !== activeChatId) playBeep();
  if (m.sender_id !== me?.id && chatId === activeChatId) {
    queueDeliveredAck(m.id);
  }
}

function removeMessage(chatId, messageId) {
  const arr = messagesByChat[chatId];
  if (!arr) return;
  messagesByChat[chatId] = arr.filter((m) => m.id !== messageId);
  if (chatId === activeChatId) renderMessages(chatId);
}

function onSocketEvent(data) {
  if (data.type === 'new_message' && data.message) {
    appendMessage(data.chatId, data.message);
    return;
  }
  if (data.type === 'message_edited' && data.message) {
    patchMessage(data.chatId, data.message);
    return;
  }
  if (data.type === 'message_deleted') {
    removeMessage(data.chatId, data.messageId);
    return;
  }
  if (data.type === 'reaction_update') {
    if (data.chatId === activeChatId) scheduleReceiptReload();
    return;
  }
  if (data.type === 'receipt_update' && data.chatId === activeChatId) {
    scheduleReceiptReload();
    return;
  }
  if (data.type === 'typing' && data.chatId === activeChatId && data.userId !== me?.id) {
    const bar = $('#typing-bar');
    const text = $('#typing-text');
    if (bar && text) {
      bar.classList.toggle('hidden', !data.isTyping);
      text.textContent = data.isTyping ? `${escapeHtml(data.username || 'Someone')} is typing…` : '';
    }
    return;
  }
  if (data.type === 'presence' && data.userId) {
    const c = chats.find((x) => x.type === 'private' && x.peer?.id === data.userId);
    if (c) c.peer.online = data.online;
    if (activeChatId && c?.id === activeChatId) {
      const sub = $('#chat-sub');
      if (sub) sub.textContent = data.online ? 'online' : 'offline';
    }
    return;
  }
  if (data.type === 'call_signal' && data.chatId) {
    const mk = data.media === 'video' ? 'video' : 'audio';
    const cid = data.chatId;

    if (data.signalType === 'end') {
      if (pendingIncomingCall?.chatId === cid) {
        pendingIncomingCall = null;
        hideIncomingSheet();
      }
      if (voiceSession && callChatId === cid) {
        endVoice(true);
      }
      return;
    }

    if (data.signalType === 'decline' && data.fromUserId !== me?.id) {
      if (voiceSession && callChatId === cid) {
        setCallStatus('Declined');
        setTimeout(() => endVoice(true), 600);
      }
      return;
    }

    if (data.signalType === 'offer' && data.sdp && data.fromUserId !== me?.id) {
      if (voiceSession || pendingIncomingCall) return;
      pendingIncomingCall = {
        chatId: cid,
        sdp: data.sdp,
        mediaKind: mk,
        fromUserId: data.fromUserId,
      };
      showIncomingSheet(data, mk);
      return;
    }

    if (
      voiceSession &&
      callChatId === cid &&
      data.fromUserId !== me?.id &&
      (data.signalType === 'answer' || data.signalType === 'candidate')
    ) {
      voiceSession.handleSignal?.(data);
      if (data.signalType === 'answer') setCallStatus('Connected');
    }
  }
}

/**
 * @param {boolean} [fromRemote] If true, do not send hang-up signal to peer (avoid loop).
 */
function endVoice(fromRemote) {
  if (!fromRemote && callChatId && socket && socket.readyState === WebSocket.OPEN) {
    sendCallSignal(socket, callChatId, { signalType: 'end', media: 'audio' });
  }
  hideIncomingSheet();
  pendingIncomingCall = null;
  setCallStatus('');
  callChatId = null;
  voiceSession?.close?.();
  voiceSession = null;
  const rv = $('#remote-video');
  const ra = $('#remote-audio');
  if (rv) rv.srcObject = null;
  if (ra) ra.srcObject = null;
  $('#call-overlay')?.classList.add('hidden');
}

function setupSocket() {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  socket = connectSocket({
    onEvent: onSocketEvent,
    onClose: () => {
      setTimeout(setupSocket, 2000);
    },
  });
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => sendHeartbeat(socket), 30000);
}

async function sendCurrentMessage(text, file) {
  if (!activeChatId) return;
  const fd = new FormData();
  if (text) fd.append('text', text);
  if (file) fd.append('file', file);
  if (replyTo) fd.append('reply_to_id', String(replyTo.id));
  const res = await api(`/messages/chat/${activeChatId}`, { method: 'POST', body: fd });
  appendMessage(activeChatId, res.message);
  replyTo = null;
  $('#reply-preview')?.classList.add('hidden');
}

// --- Auth ---
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.getAttribute('data-tab');
    $('#form-login')?.classList.toggle('hidden', name !== 'login');
    $('#form-register')?.classList.toggle('hidden', name !== 'register');
  });
});

$('#form-login')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  showError('auth-error', '');
  setFormLoading(form, true);
  const fd = new FormData(form);
  const username = String(fd.get('username') || '').trim();
  const password = String(fd.get('password') || '');
  try {
    const res = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(res.token);
    if (res.refreshToken) setRefreshToken(res.refreshToken);
    await enterApp();
  } catch (err) {
    console.error('[TMessage] login', err);
    showError('auth-error', err.message || 'Invalid credentials');
  } finally {
    setFormLoading(form, false);
  }
});

$('#form-register')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  showError('register-error', '');
  setFormLoading(form, true);
  const fd = new FormData(form);
  const username = String(fd.get('username') || '').trim();
  const password = String(fd.get('password') || '');
  try {
    const res = await api('/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setToken(res.token);
    if (res.refreshToken) setRefreshToken(res.refreshToken);
    await enterApp();
  } catch (err) {
    console.error('[TMessage] register', err);
    showError('register-error', err.message || 'Registration failed');
  } finally {
    setFormLoading(form, false);
  }
});

async function enterApp() {
  await refreshMe();
  await loadSettings();
  showScreen('#main-screen');
  setupSocket();
  try {
    await loadChats();
  } catch (e) {
    if (e.status === 403) {
      chats = [];
      renderChatList();
    } else throw e;
  }
}

$('#btn-logout')?.addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: localStorage.getItem('tm_refresh') }) });
  } catch {
    /* ignore */
  }
  setToken(null);
  setRefreshToken(null);
  endVoice();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  showScreen('#auth-screen');
});

$('#chat-search')?.addEventListener('input', (e) => renderChatList(e.target.value));

$('#btn-load-more')?.addEventListener('click', async () => {
  if (!activeChatId || !oldestIdByChat[activeChatId]) return;
  await loadMessages(activeChatId, oldestIdByChat[activeChatId]);
});

$('#composer')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#msg-input');
  const fileInput = $('#file-input');
  const text = input?.value?.trim() || '';
  const file = fileInput?.files?.[0];
  if (!text && !file) return;
  try {
    await sendCurrentMessage(text, file);
    if (input) input.value = '';
    if (fileInput) fileInput.value = '';
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#reply-cancel')?.addEventListener('click', () => {
  replyTo = null;
  $('#reply-preview')?.classList.add('hidden');
});

$('#msg-input')?.addEventListener('input', () => {
  if (!activeChatId || !socket) return;
  sendTyping(socket, activeChatId, true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => sendTyping(socket, activeChatId, false), 2000);
});

$('#composer')?.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('#composer')?.classList.add('drag');
});
$('#composer')?.addEventListener('dragleave', () => $('#composer')?.classList.remove('drag'));
$('#composer')?.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('#composer')?.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f && activeChatId) {
    try {
      await sendCurrentMessage(f.name, f);
    } catch (err) {
      alert(err.data?.error || err.message);
    }
  }
});

$('#btn-emoji')?.addEventListener('click', () => {
  const pop = $('#emoji-pop');
  if (!pop) return;
  if (pop.classList.contains('hidden')) {
    pop.innerHTML = EMOJIS.map((e) => `<button type="button" class="emoji-pick">${e}</button>`).join('');
    pop.querySelectorAll('.emoji-pick').forEach((b) => {
      b.addEventListener('click', () => {
        const inp = $('#msg-input');
        if (inp) inp.value += b.textContent;
        pop.classList.add('hidden');
      });
    });
    pop.classList.remove('hidden');
  } else pop.classList.add('hidden');
});

$('#btn-record')?.addEventListener('click', async () => {
  if (!activeChatId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    const chunks = [];
    mediaRecorder.ondataavailable = (ev) => chunks.push(ev.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
      await sendCurrentMessage('', file);
    };
    mediaRecorder.start();
    setTimeout(() => mediaRecorder?.stop(), 4000);
  } catch {
    alert('Microphone not available');
  }
});

$('#btn-voice')?.addEventListener('click', async () => {
  if (!activeChatId || !socket) return;
  if (voiceSession) {
    endVoice();
    return;
  }
  callChatId = activeChatId;
  $('#call-overlay')?.classList.remove('hidden');
  setCallStatus('Ringing…');
  try {
    voiceSession = await startOutgoingCall(
      socket,
      activeChatId,
      (stream) => {
        setCallStatus('Connected');
        const ra = $('#remote-audio');
        if (ra) ra.srcObject = stream;
      },
      () => endVoice(),
      'audio'
    );
  } catch {
    endVoice();
  }
});

$('#btn-video')?.addEventListener('click', async () => {
  if (!activeChatId || !socket) return;
  if (voiceSession) {
    endVoice();
    return;
  }
  callChatId = activeChatId;
  $('#call-overlay')?.classList.remove('hidden');
  setCallStatus('Ringing…');
  try {
    voiceSession = await startOutgoingCall(
      socket,
      activeChatId,
      (stream) => {
        setCallStatus('Connected');
        const rv = $('#remote-video');
        if (rv) {
          rv.srcObject = stream;
          rv.muted = false;
        }
      },
      () => endVoice(),
      'video'
    );
  } catch {
    endVoice();
  }
});

$('#btn-call-accept')?.addEventListener('click', async () => {
  const p = pendingIncomingCall;
  if (!p || !socket) return;
  pendingIncomingCall = null;
  hideIncomingSheet();
  callChatId = p.chatId;
  await selectChat(p.chatId);
  $('#call-overlay')?.classList.remove('hidden');
  setCallStatus('Connecting…');
  const rv = $('#remote-video');
  const ra = $('#remote-audio');
  const kind = p.mediaKind === 'video' ? 'video' : 'audio';
  try {
    voiceSession = await answerIncomingCall(
      socket,
      p.chatId,
      p.sdp,
      (stream) => {
        setCallStatus('Connected');
        if (kind === 'video' && rv) {
          rv.srcObject = stream;
          rv.muted = false;
        } else if (ra) {
          ra.srcObject = stream;
        }
      },
      () => endVoice(),
      kind
    );
  } catch {
    endVoice();
  }
});

$('#btn-call-decline')?.addEventListener('click', () => {
  if (!pendingIncomingCall || !socket) return;
  const p = pendingIncomingCall;
  pendingIncomingCall = null;
  hideIncomingSheet();
  sendCallSignal(socket, p.chatId, {
    signalType: 'decline',
    media: p.mediaKind === 'video' ? 'video' : 'audio',
  });
});

$('#btn-end-call')?.addEventListener('click', () => endVoice());

$('#btn-theme')?.addEventListener('click', async () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('tm_theme', next);
  try {
    await api('/settings/me', { method: 'PATCH', body: JSON.stringify({ theme: next }) });
  } catch {
    /* ignore */
  }
});

$('#btn-settings')?.addEventListener('click', async () => {
  $('#modal-overlay')?.classList.remove('hidden');
  $('#modal-settings')?.classList.remove('hidden');
  $('#modal-new')?.classList.add('hidden');
  $('#modal-profile')?.classList.add('hidden');
  $('#modal-admin')?.classList.add('hidden');
  try {
    const { settings: s } = await api('/settings/me');
    $('#set-notify-desktop').checked = !!s.notify_desktop;
    $('#set-notify-sound').checked = !!s.notify_sound;
    $('#set-privacy-seen').checked = !!s.privacy_show_last_seen;
  } catch {
    /* ignore */
  }
});

$('#form-settings')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/settings/me', {
      method: 'PATCH',
      body: JSON.stringify({
        notify_desktop: $('#set-notify-desktop').checked,
        notify_sound: $('#set-notify-sound').checked,
        privacy_show_last_seen: $('#set-privacy-seen').checked,
      }),
    });
    await loadSettings();
    $('#modal-overlay')?.classList.add('hidden');
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

let searchDebounce;
$('#global-search')?.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  const box = $('#global-search-results');
  if (!box) return;
  if (q.length < 2) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const r = await api(`/search?q=${encodeURIComponent(q)}&scope=all`);
      box.innerHTML = '';
      r.users?.forEach((u) => {
        const d = document.createElement('div');
        d.className = 'search-hit';
        d.textContent = `User: ${u.username}`;
        d.addEventListener('click', () => {
          box.classList.add('hidden');
          api(`/chats/private/${u.id}`, { method: 'POST' })
            .then(({ chatId }) => loadChats().then(() => selectChat(chatId)))
            .catch(() => {});
        });
        box.appendChild(d);
      });
      r.messages?.forEach((m) => {
        const d = document.createElement('div');
        d.className = 'search-hit';
        d.textContent = `#${m.chat_id} ${m.sender_name}: ${(m.body || '').slice(0, 60)}`;
        d.addEventListener('click', () => {
          box.classList.add('hidden');
          selectChat(m.chat_id).then(() => {
            document.getElementById('msg-input')?.focus();
          });
        });
        box.appendChild(d);
      });
      box.classList.remove('hidden');
    } catch {
      /* ignore */
    }
  }, 300);
});

$('#btn-new-chat')?.addEventListener('click', () => {
  $('#modal-overlay')?.classList.remove('hidden');
  $('#modal-new')?.classList.remove('hidden');
  $('#modal-profile')?.classList.add('hidden');
  $('#modal-admin')?.classList.add('hidden');
  $('#modal-settings')?.classList.add('hidden');
});

document.querySelectorAll('.modal-close').forEach((b) => {
  b.addEventListener('click', () => {
    $('#modal-overlay')?.classList.add('hidden');
  });
});

$('#user-search')?.addEventListener(
  'input',
  debounce(async (e) => {
    const q = e.target.value.trim();
    const ul = $('#user-results');
    if (!ul) return;
    if (q.length < 2) {
      ul.innerHTML = '';
      return;
    }
    try {
      const { users } = await api(`/users/search?q=${encodeURIComponent(q)}`);
      ul.innerHTML = '';
      users.forEach((u) => {
        const li = document.createElement('li');
        li.textContent = u.username;
        li.addEventListener('click', async () => {
          const { chatId } = await api(`/chats/private/${u.id}`, { method: 'POST' });
          $('#modal-overlay')?.classList.add('hidden');
          await loadChats();
          await selectChat(chatId);
          sendResync(socket);
        });
        ul.appendChild(li);
      });
    } catch {
      ul.innerHTML = '<li>Search failed</li>';
    }
  }, 300)
);

$('#btn-create-gc')?.addEventListener('click', async () => {
  const type = $('#gc-type')?.value;
  const name = $('#gc-name')?.value?.trim();
  if (!name) return;
  try {
    const { chatId } = await api('/chats', {
      method: 'POST',
      body: JSON.stringify({ type, name }),
    });
    $('#modal-overlay')?.classList.add('hidden');
    await loadChats();
    await selectChat(chatId);
    sendResync(socket);
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#btn-profile')?.addEventListener('click', async () => {
  $('#modal-overlay')?.classList.remove('hidden');
  $('#modal-new')?.classList.add('hidden');
  $('#modal-admin')?.classList.add('hidden');
  $('#modal-settings')?.classList.add('hidden');
  $('#modal-profile')?.classList.remove('hidden');
  const u = await refreshMe();
  const form = $('#form-profile');
  if (form) {
    form.username.value = u.username;
    form.bio.value = u.bio || '';
    if (form.status_text) form.status_text.value = u.status_text || '';
  }
  const img = $('#profile-avatar');
  if (img) {
    img.src = u.avatar_url ? assetBase() + u.avatar_url : '';
    img.alt = u.username;
  }
});

$('#form-profile')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/users/me', {
      method: 'PATCH',
      body: JSON.stringify({
        username: fd.get('username'),
        bio: fd.get('bio'),
        status_text: fd.get('status_text'),
      }),
    });
    await refreshMe();
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#form-password')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const r = await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: fd.get('currentPassword'),
        newPassword: fd.get('newPassword'),
      }),
    });
    if (r.refreshToken) setRefreshToken(r.refreshToken);
    alert('Password updated');
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#profile-avatar-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const res = await api('/users/me/avatar', { method: 'POST', body: fd });
    const img = $('#profile-avatar');
    if (img && res.avatar_url) img.src = assetBase() + res.avatar_url;
    await refreshMe();
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#btn-admin')?.addEventListener('click', () => {
  $('#modal-overlay')?.classList.remove('hidden');
  $('#modal-new')?.classList.add('hidden');
  $('#modal-profile')?.classList.add('hidden');
  $('#modal-settings')?.classList.add('hidden');
  $('#modal-admin')?.classList.remove('hidden');
});

$('#admin-ban')?.addEventListener('click', async () => {
  const id = Number($('#admin-ban-id')?.value);
  if (!id) return;
  try {
    await api(`/admin/users/${id}/ban`, { method: 'POST', body: JSON.stringify({ banned: true }) });
    alert('Banned');
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#admin-unban')?.addEventListener('click', async () => {
  const id = Number($('#admin-ban-id')?.value);
  if (!id) return;
  try {
    await api(`/admin/users/${id}/ban`, { method: 'POST', body: JSON.stringify({ banned: false }) });
    alert('Unbanned');
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#admin-del-msg')?.addEventListener('click', async () => {
  const id = Number($('#admin-msg-id')?.value);
  if (!id) return;
  try {
    await api(`/admin/messages/${id}`, { method: 'DELETE' });
    alert('Deleted');
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

$('#admin-del-chat')?.addEventListener('click', async () => {
  const id = Number($('#admin-chat-id')?.value);
  if (!id) return;
  try {
    await api(`/admin/chats/${id}`, { method: 'DELETE' });
    alert('Deleted');
    await loadChats();
  } catch (err) {
    alert(err.data?.error || err.message);
  }
});

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Boot
(async () => {
  try {
    applyTheme(localStorage.getItem('tm_theme') || 'dark');
    if (getToken()) {
      try {
        await enterApp();
      } catch (e) {
        console.error('[TMessage] enterApp', e);
        setToken(null);
        setRefreshToken(null);
        showScreen('#auth-screen');
      }
    } else {
      showScreen('#auth-screen');
    }
  } catch (e) {
    console.error('[TMessage] boot', e);
  }
})();
