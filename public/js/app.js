/**
 * TMessage client — Telegram-style UI, WebRTC, video notes.
 */
import { api, setToken, setRefreshToken, getToken, assetBase } from './api.js';
import { connectSocket, sendTyping, sendResync, sendHeartbeat, sendCallSignal } from './ws.js';
import {
  startOutgoingCall,
  answerIncomingCall,
  setMicMuted,
  setCameraEnabled,
  switchCameraFacing,
} from './webrtc.js';

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
/** @type {any} */
let voiceSession = null;
let callChatId = null;
/** @type {{ chatId: number; sdp: any; mediaKind: string; fromUserId: number } | null} */
let pendingIncomingCall = null;
let replyTo = null;
let heartbeatTimer = null;
let settings = { notify_sound: 1, notify_desktop: 1, theme: 'dark' };
/** @type {MediaRecorder | null} */
let mediaRecorder = null;
let receiptReloadTimer;
let chatListRenderTimer;
const deliveredPending = new Set();
let deliveredFlushTimer = null;

let toastTimer = null;
let chatFilterDebounce = null;

let micMutedUi = false;
let camOffUi = false;

const videoNoteState = {
  active: false,
  mediaRecorder: null,
  stream: null,
  chunks: [],
  tickTimer: null,
  maxTimer: null,
};

let recordHoldTimer = null;
let recordLongPressStarted = false;

const $ = (sel) => document.querySelector(sel);
const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
  '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
  '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
  '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
  '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉',
  '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤙', '💪',
  '❤️', '🧡', '💛', '�', '�', '💜', '🖤', '🤍', '🤎', '�',
  '🔥', '�', '✨', '🎉', '🎊', '🎈', '🎁', '🎀', '🎗️', '🎟️',
  '🎵', '🎶', '🎤', '🎧', '�', '🎸', '🥁', '🎹', '🎺', '🎻'
];

function isMobileLayout() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
}

function openMobileChatView() {
  $('#main-layout')?.classList.add('mobile-chat-open');
}

function closeMobileChatView() {
  $('#main-layout')?.classList.remove('mobile-chat-open');
}

window.addEventListener('resize', () => {
  if (!isMobileLayout()) closeMobileChatView();
});

function showToast(message) {
  const root = $('#toast-root');
  if (!root || !message) return;
  root.textContent = message;
  root.classList.add('toast-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    root.classList.remove('toast-visible');
    root.textContent = '';
  }, 4200);
}

function hideMsgContext() {
  $('#msg-context-menu')?.classList.add('hidden');
}

function showMsgContext(clientX, clientY, m) {
  const menu = $('#msg-context-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ctx-item';
  copy.textContent = 'Copy';
  copy.addEventListener('click', (e) => {
    e.stopPropagation();
    const txt = m.body || m.file_name || '';
    navigator.clipboard?.writeText(txt).catch(() => {});
    hideMsgContext();
  });
  menu.appendChild(copy);
  if (m.sender_id === me?.id) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ctx-item ctx-danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      hideMsgContext();
      if (!confirm('Delete message?')) return;
      try {
        await api(`/messages/message/${m.id}`, { method: 'DELETE' });
      } catch (err) {
        alert(err.data?.error || err.message);
      }
    });
    menu.appendChild(del);
  }
  menu.classList.remove('hidden');
  const pad = 8;
  menu.style.left = `${Math.min(clientX, window.innerWidth - 160 - pad)}px`;
  menu.style.top = `${Math.min(clientY, window.innerHeight - 120 - pad)}px`;
}

document.addEventListener('click', () => hideMsgContext());
document.addEventListener('scroll', () => hideMsgContext(), true);

function attachMessageLongPress(div, m) {
  let t = null;
  const clear = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  div.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    t = setTimeout(() => {
      t = null;
      showMsgContext(e.clientX, e.clientY, m);
    }, 480);
  });
  div.addEventListener('pointerup', clear);
  div.addEventListener('pointerleave', clear);
  div.addEventListener('pointercancel', clear);
}

function scheduleReceiptReload() {
  clearTimeout(receiptReloadTimer);
  receiptReloadTimer = setTimeout(() => {
    if (activeChatId) loadMessages(activeChatId).catch(() => {});
  }, 800); // Further increased for better performance
}

function queueDeliveredAck(messageId) {
  if (!messageId || !me) return;
  deliveredPending.add(messageId);
  clearTimeout(deliveredFlushTimer);
  deliveredFlushTimer = setTimeout(flushDeliveredAcks, 250); // Increased batch delay for better performance
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
  }, 200); // Further increased for better performance
}

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
  
  // Add admin badge if user is admin
  if (tu && user.is_admin) {
    tu.innerHTML = `@${user.username} <span class="admin-badge admin">�</span>`;
  }
  
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
  
  // Use DocumentFragment for better performance
  const frag = document.createDocumentFragment();
  
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
      const unread = Number(c.unread_count) || 0;
      const badge =
        unread > 0
          ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>`
          : '';
      
      // Single innerHTML call for performance
      li.innerHTML = `
        <img class="avatar" alt="" src="${avatar ? assetBase() + avatar : ''}" />
        <div class="meta">
          <div class="name">${escapeHtml(c.name || 'Chat')}${verified}</div>
          <div class="preview">${escapeHtml((c.last_body || sub || '').slice(0, 80))}</div>
        </div>
        ${badge}
      `;
      li.addEventListener('click', () => selectChat(c.id));
      frag.appendChild(li);
    });
  
  // Replace all content at once
  ul.innerHTML = '';
  ul.appendChild(frag);
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

function syncCallToolbar(kind) {
  const isVideo = kind === 'video';
  $('#btn-call-cam')?.classList.toggle('hidden', !isVideo);
  $('#btn-call-flip')?.classList.toggle('hidden', !isVideo);
  micMutedUi = false;
  camOffUi = false;
  $('#btn-call-mute')?.classList.toggle('muted', false);
  $('#btn-call-cam')?.classList.toggle('cam-off', false);
}

async function selectChat(chatId) {
  activeChatId = chatId;
  const c = chats.find((x) => x.id === chatId);
  if (c) c.unread_count = 0;
  $('#chat-placeholder')?.classList.add('hidden');
  $('#chat-panel')?.classList.remove('hidden');
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
  if (isMobileLayout()) openMobileChatView();
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
    const box = $('#messages');
    if (box && chatId === activeChatId && messages.length) {
      const prevH = box.scrollHeight;
      const prevTop = box.scrollTop;
      const frag = document.createDocumentFragment();
      messages.forEach((m) => frag.appendChild(buildMessageElement(m)));
      box.insertBefore(frag, box.firstChild);
      box.scrollTop = prevTop + (box.scrollHeight - prevH);
    }
  } else {
    messagesByChat[chatId] = messages;
    renderMessages(chatId);
  }
  if (messages.length) oldestIdByChat[chatId] = messages[0].id;
  $('#btn-load-more')?.classList.toggle('hidden', messages.length < 40);
  if (!before) {
    messages.forEach((m) => {
      if (m.sender_id !== me?.id) queueDeliveredAck(m.id);
    });
  }
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
  div.dataset.msgId = String(m.id); // For message tracking

  const badge = m.is_admin ? ' <span class="badge" title="Admin">✔</span>' : '';
  const isVideoNote = !!(m.video_note && m.file_path && m.file_mime?.startsWith('video/'));
  let bodyHtml = escapeHtml(m.body || '');

  // Cache processed body to avoid reprocessing
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
    if (isVideoNote) {
      bodyHtml += `<div class="video-note-wrap"><video class="video-note-bubble" src="${assetBase()}${m.file_path}" playsinline loop preload="metadata"></video><button type="button" class="video-note-play" aria-label="Play">▶</button></div>`;
    } else {
      bodyHtml += `<br><video class="attach" src="${assetBase()}${m.file_path}" controls playsinline></video>`;
    }
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
    .join('');
  const reactBar = `<div class="react-row">${EMOJIS.map((e) => `<button type="button" class="react-add" data-e="${e}">${e}</button>`).join('')} ${reacts}</div>`;
  const actions = own
    ? `<button type="button" class="msg-act" data-act="edit">Edit</button>
         <button type="button" class="msg-act" data-act="del">Delete</button>`
    : '';
  const ticks = own ? receiptLabel(m) : '';
  const timeStr = formatMessageTime(m.created_at);

  // Use innerHTML only once for better performance
  div.innerHTML = `
      <div class="msg-head">
        <span class="who">${escapeHtml(m.username)}${badge}</span>
        <button type="button" class="msg-act" data-act="reply">Reply</button>
        <button type="button" class="msg-act" data-act="fwd">Fwd</button>
        ${actions}
      </div>
      <div class="body">${bodyHtml}${edited}</div>
      <div class="msg-footer">
        <span class="msg-time">${timeStr}</span>
        ${ticks}
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
  div.querySelectorAll('.video-note-wrap video').forEach((v) => {
    const wrap = v.closest('.video-note-wrap');
    const btn = wrap?.querySelector('.video-note-play');
    btn?.addEventListener('click', () => {
      if (v.paused) {
        v.play();
        btn.textContent = '⏸';
      } else {
        v.pause();
        btn.textContent = '▶';
      }
    });
    v.addEventListener('play', () => {
      if (btn) btn.textContent = '⏸';
    });
    v.addEventListener('pause', () => {
      if (btn) btn.textContent = '▶';
    });
  });
  attachMessageLongPress(div, m);
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
  
  // Only render if chat is active and messages have changed
  if (chatId !== activeChatId) return;
  
  // Clear only if completely different chat
  const currentCount = box.children.length;
  if (currentCount === 0 || Math.abs(currentCount - list.length) > 5) {
    box.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.forEach((m) => frag.appendChild(buildMessageElement(m)));
    box.appendChild(frag);
  } else {
    // Append only new messages
    const lastMsgId = box.lastElementChild?.dataset.msgId;
    const newMessages = lastMsgId ? list.filter(m => m.id > parseInt(lastMsgId)) : list;
    if (newMessages.length > 0) {
      const frag = document.createDocumentFragment();
      newMessages.forEach((m) => frag.appendChild(buildMessageElement(m)));
      box.appendChild(frag);
    }
  }
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

function bumpUnread(chatId) {
  const c = chats.find((x) => x.id === chatId);
  if (c) {
    c.unread_count = (Number(c.unread_count) || 0) + 1;
    scheduleChatListRender();
  }
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
  const preview = `${m.username}: ${m.body || m.file_name || 'Attachment'}`;
  if (m.sender_id !== me?.id && chatId !== activeChatId) {
    bumpUnread(chatId);
  }
  if (m.sender_id !== me?.id && (chatId !== activeChatId || document.hidden)) {
    showToast(`${chatLabelForId(chatId)} · ${preview}`);
  }
  if (document.hidden && settings.notify_desktop) {
    const body = preview;
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
    
    // Update admin messages if panel is open and user is admin
    if (me?.is_admin && !$('#admin-messages-tab')?.classList.contains('hidden')) {
      adminMessages.unshift(data.message);
      renderAdminMessages({ total: adminMessages.length + 1, hasMore: true });
    }
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
      text.textContent = data.isTyping ? `${chatLabelForId(data.chatId)} is typing…` : '';
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
        endVoice();
      }
      return;
    }

    if (data.signalType === 'decline' && data.fromUserId !== me?.id) {
      if (voiceSession && callChatId === cid) {
        setCallStatus('Declined');
        setTimeout(() => endVoice(), 600);
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
  const lv = $('#local-video');
  const ov = $('#call-overlay');
  if (rv) {
    rv.srcObject = null;
    rv.muted = true;
  }
  if (ra) ra.srcObject = null;
  if (lv) {
    lv.srcObject = null;
    lv.hidden = true;
  }
  ov?.classList.remove('call-overlay--video', 'call-overlay--audio');
  ov?.classList.add('hidden');
  syncCallToolbar('audio');
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

async function sendVideoNoteFile(file) {
  if (!activeChatId) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('text', ' ');
  fd.append('video_note', '1');
  if (replyTo) fd.append('reply_to_id', String(replyTo.id));
  const res = await api(`/messages/chat/${activeChatId}`, { method: 'POST', body: fd });
  appendMessage(activeChatId, res.message);
  replyTo = null;
  $('#reply-preview')?.classList.add('hidden');
}

function stopVideoNoteRecording() {
  if (!videoNoteState.active) return;
  videoNoteState.active = false;
  clearInterval(videoNoteState.tickTimer);
  clearTimeout(videoNoteState.maxTimer);
  videoNoteState.tickTimer = null;
  videoNoteState.maxTimer = null;
  const overlay = $('#video-note-overlay');
  const preview = $('#video-note-preview');
  const prog = $('#video-note-progress');
  overlay?.classList.add('hidden');
  if (prog) prog.style.strokeDashoffset = '289';
  const stream = videoNoteState.stream;
  stream?.getTracks().forEach((t) => t.stop());
  if (preview) preview.srcObject = null;
  const mr = videoNoteState.mediaRecorder;
  return new Promise((resolve) => {
    if (mr && mr.state !== 'inactive') {
      mr.onstop = () => resolve();
      mr.stop();
    } else resolve();
  }).then(() => {
    const chunks = videoNoteState.chunks;
    videoNoteState.chunks = [];
    videoNoteState.mediaRecorder = null;
    videoNoteState.stream = null;
    const blob = new Blob(chunks, { type: mr?.mimeType || 'video/webm' });
    if (blob.size > 500) {
      return sendVideoNoteFile(new File([blob], `vn-${Date.now()}.webm`, { type: blob.type }));
    }
  });
}

async function startVideoNoteRecording() {
  if (!activeChatId || videoNoteState.active) return;
  const overlay = $('#video-note-overlay');
  const preview = $('#video-note-preview');
  const hint = $('#video-note-hint');
  overlay?.classList.remove('hidden');
  if (hint) hint.textContent = 'Recording… release to send';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } },
    });
    videoNoteState.stream = stream;
    if (preview) preview.srcObject = stream;
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    videoNoteState.mediaRecorder = mr;
    videoNoteState.chunks = [];
    mr.ondataavailable = (e) => {
      if (e.data.size) videoNoteState.chunks.push(e.data);
    };
    mr.start(200);
    videoNoteState.active = true;
    const start = Date.now();
    const maxMs = 55000;
    const prog = $('#video-note-progress');
    const circ = 289;
    videoNoteState.tickTimer = setInterval(() => {
      const t = Date.now() - start;
      const p = Math.min(1, t / maxMs);
      if (prog) prog.style.strokeDashoffset = String(circ * (1 - p));
      if (t >= maxMs) stopVideoNoteRecording();
    }, 120);
    videoNoteState.maxTimer = setTimeout(() => stopVideoNoteRecording(), maxMs);
  } catch (e) {
    console.error(e);
    overlay?.classList.add('hidden');
    alert('Camera not available');
  }
}

async function runVoiceClip() {
  if (!activeChatId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const options = { mimeType: 'audio/webm;codecs=opus' };
    let mediaRecorder;
    
    try {
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (e) {
      // Fallback to default mimeType if opus not supported
      mediaRecorder = new MediaRecorder(stream);
    }
    
    const chunks = [];
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (chunks.length === 0) {
        showToast('Voice recording failed - no data captured');
        return;
      }
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
      await sendCurrentMessage('', file);
      showToast('Voice message sent');
    };
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event.error);
      showToast('Voice recording failed');
      stream.getTracks().forEach((t) => t.stop());
    };
    
    mediaRecorder.start(100); // Collect data every 100ms
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }, 4000);
  } catch (error) {
    console.error('Voice recording error:', error);
    showToast('Microphone not available or permission denied');
  }
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

export async function enterApp() {
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

$('#chat-search')?.addEventListener('input', (e) => {
  clearTimeout(chatFilterDebounce);
  chatFilterDebounce = setTimeout(() => renderChatList(e.target.value), 120);
});

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

let typingDebounce;
$('#msg-input')?.addEventListener('input', () => {
  if (!activeChatId || !socket) return;
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    sendTyping(socket, activeChatId, true);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTyping(socket, activeChatId, false), 2000);
  }, 80);
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
    const categories = {
      'Smileys': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙'],
      'Expressions': ['😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥'],
      'Neutral': ['😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮'],
      'Gestures': ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '💪'],
      'Hearts': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔'],
      'Celebration': ['🔥', '💯', '✨', '🎉', '🎊', '🎈', '🎁', '🎀', '🎗️', '🎟️'],
      'Music': ['🎵', '🎶', '🎤', '🎧', '📻', '🎸', '🥁', '🎹', '🎺', '🎻']
    };
    
    let html = '<div class="emoji-picker-header"><input type="search" id="emoji-search" placeholder="Search emojis..." /></div>';
    html += '<div class="emoji-categories">';
    
    Object.entries(categories).forEach(([category, emojis]) => {
      html += `<div class="emoji-category">
        <div class="emoji-category-title">${category}</div>
        <div class="emoji-grid">${emojis.map(e => `<button type="button" class="emoji-pick">${e}</button>`).join('')}</div>
      </div>`;
    });
    
    html += '</div>';
    pop.innerHTML = html;
    
    // Add search functionality
    const searchInput = pop.querySelector('#emoji-search');
    searchInput?.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      const allEmojis = pop.querySelectorAll('.emoji-pick');
      
      allEmojis.forEach(emoji => {
        const emojiText = emoji.textContent;
        const isVisible = query === '' || emojiText.includes(query);
        emoji.parentElement.style.display = isVisible ? '' : 'none';
      });
      
      // Show/hide categories based on visible emojis
      pop.querySelectorAll('.emoji-category').forEach(category => {
        const visibleEmojis = category.querySelectorAll('.emoji-pick[style=""], .emoji-pick:not([style])');
        category.style.display = visibleEmojis.length > 0 ? '' : 'none';
      });
    });
    
    pop.querySelectorAll('.emoji-pick').forEach((b) => {
      b.addEventListener('click', () => {
        const inp = $('#msg-input');
        if (inp) {
          inp.value += b.textContent;
          inp.focus();
        }
        pop.classList.add('hidden');
      });
    });
  } else pop.classList.add('hidden');
});

const btnRecord = $('#btn-record');
btnRecord?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !activeChatId) return;
  recordLongPressStarted = false;
  recordHoldTimer = setTimeout(() => {
    recordHoldTimer = null;
    recordLongPressStarted = true;
    startVideoNoteRecording();
  }, 350);
});
btnRecord?.addEventListener('pointerup', async () => {
  if (recordHoldTimer) {
    clearTimeout(recordHoldTimer);
    recordHoldTimer = null;
    if (!recordLongPressStarted) runVoiceClip();
    return;
  }
  if (videoNoteState.active) await stopVideoNoteRecording();
});
btnRecord?.addEventListener('pointercancel', async () => {
  if (recordHoldTimer) clearTimeout(recordHoldTimer);
  if (videoNoteState.active) await stopVideoNoteRecording();
});

$('#btn-voice')?.addEventListener('click', async () => {
  if (!activeChatId || !socket) return;
  if (voiceSession) {
    endVoice();
    return;
  }
  callChatId = activeChatId;
  const ov = $('#call-overlay');
  ov?.classList.remove('call-overlay--video');
  ov?.classList.add('call-overlay--audio');
  ov?.classList.remove('hidden');
  syncCallToolbar('audio');
  setCallStatus('Ringing…');
  try {
    voiceSession = await startOutgoingCall(
      socket,
      activeChatId,
      (stream) => {
        setCallStatus('Connected');
        const ra = $('#remote-audio');
        if (ra) {
          ra.srcObject = stream;
          ra.muted = false;
          // Force play with user interaction fallback
          const playPromise = ra.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              // Add click handler to play audio
              document.addEventListener('click', function playAudio() {
                ra.play();
                document.removeEventListener('click', playAudio);
              }, { once: true });
            });
          }
        }
      },
      () => endVoice(),
      'audio',
      null
    );
  } catch (error) {
    console.error('Voice call error:', error);
    setCallStatus('Failed');
    setTimeout(endVoice, 2000);
  }
});

$('#btn-video')?.addEventListener('click', async () => {
  if (!activeChatId || !socket) return;
  if (voiceSession) {
    endVoice();
    return;
  }
  callChatId = activeChatId;
  const ov = $('#call-overlay');
  ov?.classList.remove('call-overlay--audio');
  ov?.classList.add('call-overlay--video');
  ov?.classList.remove('hidden');
  syncCallToolbar('video');
  setCallStatus('Ringing…');
  const lv = $('#local-video');
  try {
    voiceSession = await startOutgoingCall(
      socket,
      activeChatId,
      (stream) => {
        setCallStatus('Connected');
        const rv = $('#remote-video');
        const ra = $('#remote-audio');
        if (rv) {
          rv.srcObject = stream;
          rv.muted = false;
          rv.playsInline = true;
          // Force play with user interaction fallback
          const playPromise = rv.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              document.addEventListener('click', function playVideo() {
                rv.play();
                document.removeEventListener('click', playVideo);
              }, { once: true });
            });
          }
        }
        if (ra) {
          ra.srcObject = stream;
          ra.muted = false;
          // Force play with user interaction fallback
          const playPromise = ra.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              document.addEventListener('click', function playAudio() {
                ra.play();
                document.removeEventListener('click', playAudio);
              }, { once: true });
            });
          }
        }
      },
      () => endVoice(),
      'video',
      (local) => {
        if (lv) {
          lv.srcObject = local;
          lv.hidden = false;
          lv.playsInline = true;
        }
      }
    );
  } catch (error) {
    console.error('Video call error:', error);
    setCallStatus('Failed');
    setTimeout(endVoice, 2000);
  }
});

$('#btn-call-mute')?.addEventListener('click', () => {
  const s = voiceSession?.localStream;
  if (!s) return;
  micMutedUi = !micMutedUi;
  setMicMuted(s, micMutedUi);
  $('#btn-call-mute')?.classList.toggle('muted', micMutedUi);
});

$('#btn-call-cam')?.addEventListener('click', () => {
  const s = voiceSession?.localStream;
  if (!s) return;
  camOffUi = !camOffUi;
  setCameraEnabled(s, !camOffUi);
  $('#btn-call-cam')?.classList.toggle('cam-off', camOffUi);
});

$('#btn-call-flip')?.addEventListener('click', async () => {
  if (!voiceSession?.pc || !voiceSession?.localStream) return;
  try {
    await switchCameraFacing(voiceSession.pc, voiceSession.localStream);
  } catch (e) {
    console.error(e);
  }
});

$('#btn-call-accept')?.addEventListener('click', async () => {
  const p = pendingIncomingCall;
  if (!p || !socket) return;
  pendingIncomingCall = null;
  hideIncomingSheet();
  callChatId = p.chatId;
  await selectChat(p.chatId);
  const ov = $('#call-overlay');
  const kind = p.mediaKind === 'video' ? 'video' : 'audio';
  ov?.classList.toggle('call-overlay--video', kind === 'video');
  ov?.classList.toggle('call-overlay--audio', kind === 'audio');
  ov?.classList.remove('hidden');
  syncCallToolbar(kind);
  setCallStatus('Connecting…');
  const rv = $('#remote-video');
  const ra = $('#remote-audio');
  const lv = $('#local-video');
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
          rv.playsInline = true;
          // Force play with user interaction fallback
          const playPromise = rv.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              document.addEventListener('click', function playVideo() {
                rv.play();
                document.removeEventListener('click', playVideo);
              }, { once: true });
            });
          }
        } else if (ra) {
          ra.srcObject = stream;
          ra.muted = false;
          // Force play with user interaction fallback
          const playPromise = ra.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              document.addEventListener('click', function playAudio() {
                ra.play();
                document.removeEventListener('click', playAudio);
              }, { once: true });
            });
          }
        }
      },
      () => endVoice(),
      kind,
      kind === 'video'
        ? (local) => {
            if (lv) {
              lv.srcObject = local;
              lv.hidden = false;
            }
          }
        : null
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

$('#btn-back-chats')?.addEventListener('click', () => {
  closeMobileChatView();
});

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
  const wantDesktop = $('#set-notify-desktop')?.checked;
  if (wantDesktop && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
  try {
    await api('/settings/me', {
      method: 'PATCH',
      body: JSON.stringify({
        notify_desktop: wantDesktop,
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

$('#btn-add-by-username')?.addEventListener('click', async () => {
  const inp = $('#add-by-username');
  const status = $('#add-by-username-status');
  const name = inp?.value?.trim().toLowerCase();
  if (!name) {
    if (status) status.textContent = 'Enter a username';
    return;
  }
  if (status) status.textContent = '';
  try {
    const { user } = await api(`/users/search?username=${encodeURIComponent(name)}`);
    if (!user) {
      if (status) status.textContent = 'User not found';
      return;
    }
    const { chatId } = await api(`/chats/private/${user.id}`, { method: 'POST' });
    $('#modal-overlay')?.classList.add('hidden');
    await loadChats();
    await selectChat(chatId);
    sendResync(socket);
  } catch (err) {
    if (status) status.textContent = err.data?.error || err.message || 'Failed';
  }
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

// Admin Panel Functions
let adminUsers = [];
let adminMessages = [];
let adminMessageOffset = 0;

async function loadAdminUsers() {
  try {
    const users = await api('/admin/users');
    adminUsers = users;
    renderAdminUsers();
  } catch (error) {
    console.error('Failed to load admin users:', error);
    showToast('Failed to load users');
  }
}

async function loadAdminMessages(offset = 0) {
  try {
    const response = await api(`/admin/messages?limit=50&offset=${offset}`);
    if (offset === 0) {
      adminMessages = response.messages;
    } else {
      adminMessages = [...adminMessages, ...response.messages];
    }
    renderAdminMessages(response.pagination);
  } catch (error) {
    console.error('Failed to load admin messages:', error);
    showToast('Failed to load messages');
  }
}

function renderAdminUsers() {
  const container = $('#admin-users-list');
  if (!container) return;
  
  const searchTerm = $('#admin-user-search')?.value.toLowerCase() || '';
  const filteredUsers = adminUsers.filter(user => 
    user.username.toLowerCase().includes(searchTerm)
  );
  
  const frag = document.createDocumentFragment();
  filteredUsers.forEach(user => {
    const item = document.createElement('div');
    item.className = 'admin-user-item';
    
    const badges = [];
    if (user.is_admin) badges.push('<span class="admin-badge admin">� Admin</span>');
    if (user.is_banned) badges.push('<span class="admin-badge banned">🚫 Banned</span>');
    
    const isCurrentUser = me?.username === user.username;
    
    item.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">${escapeHtml(user.username)}${badges.join('')}</div>
        <div class="admin-user-details">
          ID: ${user.id} | Joined: ${new Date(user.created_at * 1000).toLocaleDateString()}
        </div>
      </div>
      <div class="admin-actions">
        ${!user.is_admin && !user.is_banned ? 
          `<button class="admin-btn ban" data-username="${user.username}">Ban</button>` : ''}
        ${user.is_banned ? 
          `<button class="admin-btn unban" data-username="${user.username}">Unban</button>` : ''}
        ${!user.is_admin && !isCurrentUser ? 
          `<button class="admin-btn delete" data-username="${user.username}">Delete</button>` : ''}
      </div>
    `;
    
    // Add event listeners
    const banBtn = item.querySelector('.ban');
    const unbanBtn = item.querySelector('.unban');
    const deleteBtn = item.querySelector('.delete');
    
    if (banBtn) {
      banBtn.addEventListener('click', () => banUser(user.username));
    }
    if (unbanBtn) {
      unbanBtn.addEventListener('click', () => unbanUser(user.username));
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => deleteUser(user.username));
    }
    
    frag.appendChild(item);
  });
  
  container.innerHTML = '';
  container.appendChild(frag);
}

function renderAdminMessages(pagination) {
  const container = $('#admin-messages-list');
  if (!container) return;
  
  const frag = document.createDocumentFragment();
  adminMessages.forEach(msg => {
    const item = document.createElement('div');
    item.className = 'admin-message-item';
    
    item.innerHTML = `
      <div class="admin-message-info">
        <div class="admin-message-sender">${escapeHtml(msg.sender_username || msg.username)} ${msg.chat_name ? `in ${escapeHtml(msg.chat_name)}` : ''}</div>
        <div class="admin-message-content">${escapeHtml(msg.body || (msg.file_name ? '📎 ' + msg.file_name : '📎 Attachment'))}</div>
        <div class="admin-message-time">${new Date(msg.created_at * 1000).toLocaleString()}</div>
      </div>
      <div class="admin-actions">
        <button class="admin-btn delete" data-message-id="${msg.id}">Delete</button>
      </div>
    `;
    
    const deleteBtn = item.querySelector('.delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => deleteMessage(msg.id));
    }
    
    frag.appendChild(item);
  });
  
  container.innerHTML = '';
  container.appendChild(frag);
  
  // Update count
  const countEl = $('#admin-message-count');
  if (countEl) {
    countEl.textContent = `Showing ${adminMessages.length} of ${pagination.total} messages`;
  }
  
  // Add load more button if needed
  if (pagination.hasMore) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'btn primary';
    loadMoreBtn.textContent = 'Load More';
    loadMoreBtn.style.marginTop = '12px';
    loadMoreBtn.addEventListener('click', () => {
      adminMessageOffset = adminMessages.length;
      loadAdminMessages(adminMessageOffset);
    });
    container.appendChild(loadMoreBtn);
  }
}

async function banUser(username) {
  if (!confirm(`Ban user "${username}"?`)) return;
  
  try {
    const reason = prompt('Ban reason (optional):');
    await api('/admin/ban', {
      method: 'POST',
      body: JSON.stringify({ username, reason: reason || undefined })
    });
    showToast(`User "${username}" banned`);
    await loadAdminUsers();
  } catch (error) {
    console.error('Failed to ban user:', error);
    showToast(error.data?.error || 'Failed to ban user');
  }
}

async function unbanUser(username) {
  if (!confirm(`Unban user "${username}"?`)) return;
  
  try {
    await api('/admin/unban', {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    showToast(`User "${username}" unbanned`);
    await loadAdminUsers();
  } catch (error) {
    console.error('Failed to unban user:', error);
    showToast(error.data?.error || 'Failed to unban user');
  }
}

async function deleteUser(username) {
  if (!confirm(`DELETE user "${username}" permanently? This cannot be undone!`)) return;
  
  try {
    await api('/admin/deleteUser', {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    showToast(`User "${username}" deleted`);
    await loadAdminUsers();
  } catch (error) {
    console.error('Failed to delete user:', error);
    showToast(error.data?.error || 'Failed to delete user');
  }
}

async function deleteMessage(messageId) {
  if (!confirm(`Delete message ${messageId}?`)) return;
  
  try {
    await api('/admin/deleteMessage', {
      method: 'POST',
      body: JSON.stringify({ messageId })
    });
    showToast(`Message ${messageId} deleted`);
    // Remove from local array and re-render
    adminMessages = adminMessages.filter(m => m.id !== messageId);
    renderAdminMessages({ total: adminMessages.length, hasMore: true });
  } catch (error) {
    console.error('Failed to delete message:', error);
    showToast(error.data?.error || 'Failed to delete message');
  }
}

// Admin tab switching
function switchAdminTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  // Update tab content
  document.querySelectorAll('.admin-tab-content').forEach(content => {
    content.classList.add('hidden');
  });
  document.getElementById(`admin-${tabName}-tab`)?.classList.remove('hidden');
  
  // Load data if needed
  if (tabName === 'users' && adminUsers.length === 0) {
    loadAdminUsers();
  } else if (tabName === 'messages' && adminMessages.length === 0) {
    loadAdminMessages();
  }
}

// Admin Panel Event Listeners
document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    switchAdminTab(tab.dataset.tab);
  });
});

$('#admin-refresh-users')?.addEventListener('click', loadAdminUsers);

$('#admin-refresh-messages')?.addEventListener('click', () => {
  adminMessageOffset = 0;
  loadAdminMessages();
});

$('#admin-user-search')?.addEventListener('input', () => {
  renderAdminUsers();
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
