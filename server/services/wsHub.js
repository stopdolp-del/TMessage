/**
 * WebSocket hub: auth, chat rooms, typing, presence, WebRTC signaling.
 */
const { verifyAccessToken } = require('../utils/jwt');
const { getDb } = require('../db/init');

const userSockets = new Map(); // userId -> Set<WebSocket>
const socketUser = new Map(); // WebSocket -> userId
const socketChats = new Map(); // WebSocket -> Set<chatId>

function addUserSocket(userId, ws) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
  socketUser.set(ws, userId);
  socketChats.set(ws, new Set());
}

function removeUserSocket(ws) {
  const uid = socketUser.get(ws);
  if (uid == null) return;
  const set = userSockets.get(uid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      userSockets.delete(uid);
      broadcastPresence(uid, false);
    }
  }
  const chats = socketChats.get(ws);
  if (chats) {
    chats.forEach((cid) => {
      broadcastToChat(cid, { type: 'user_left', chatId: cid, userId: uid }, ws);
    });
  }
  socketUser.delete(ws);
  socketChats.delete(ws);
}

function broadcastPresence(userId, online) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT cm.chat_id FROM chat_members cm WHERE cm.user_id = ?`
    )
    .all(userId);
  rows.forEach(({ chat_id: chatId }) => {
    broadcastToChat(chatId, { type: 'presence', userId, online }, null);
  });
}

function getChatMemberIds(chatId) {
  const db = getDb();
  return db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map((r) => r.user_id);
}

function broadcastToChat(chatId, payload, exceptWs) {
  const memberIds = getChatMemberIds(chatId);
  const msg = JSON.stringify(payload);
  memberIds.forEach((uid) => {
    const set = userSockets.get(uid);
    if (!set) return;
    set.forEach((ws) => {
      if (ws !== exceptWs && ws.readyState === ws.OPEN) {
        const joined = socketChats.get(ws);
        if (joined && joined.has(chatId)) ws.send(msg);
      }
    });
  });
}

function handleConnection(ws, wss) {
  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      } catch {
        /* ignore */
      }
      return;
    }

    try {
    if (data.type === 'authenticate') {
      try {
        const decoded = verifyAccessToken(data.token);
        const db = getDb();
        const user = db
          .prepare(
            'SELECT id, is_banned FROM users WHERE id = ?'
          )
          .get(decoded.sub);
        if (!user || user.is_banned) {
          ws.send(JSON.stringify({ type: 'auth_error' }));
          ws.close();
          return;
        }
        addUserSocket(user.id, ws);
        const chats = db
          .prepare('SELECT chat_id FROM chat_members WHERE user_id = ?')
          .all(user.id);
        const joined = socketChats.get(ws);
        chats.forEach((c) => joined.add(c.chat_id));
        ws.send(JSON.stringify({ type: 'authenticated', userId: user.id }));
        broadcastPresence(user.id, true);
      } catch {
        ws.send(JSON.stringify({ type: 'auth_error' }));
        ws.close();
      }
      return;
    }

    const uid = socketUser.get(ws);
    if (!uid) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authenticate first' }));
      return;
    }

    if (data.type === 'join_chat') {
      const chatId = Number(data.chatId);
      const db = getDb();
      const ok = db
        .prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
        .get(chatId, uid);
      if (!ok) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not a member' }));
        return;
      }
      socketChats.get(ws).add(chatId);
      ws.send(JSON.stringify({ type: 'joined', chatId }));
      return;
    }

    if (data.type === 'leave_chat') {
      const chatId = Number(data.chatId);
      socketChats.get(ws)?.delete(chatId);
      return;
    }

    /** Reload chat memberships from DB (e.g. after added to a new group). */
    if (data.type === 'resync_chats') {
      const db = getDb();
      const chats = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(uid);
      const joined = socketChats.get(ws);
      joined.clear();
      chats.forEach((c) => joined.add(c.chat_id));
      ws.send(JSON.stringify({ type: 'resynced', count: chats.length }));
      return;
    }

    if (data.type === 'typing') {
      const chatId = Number(data.chatId);
      if (!socketChats.get(ws)?.has(chatId)) return;
      const db = getDb();
      const row = db.prepare('SELECT username FROM users WHERE id = ?').get(uid);
      broadcastToChat(
        chatId,
        {
          type: 'typing',
          chatId,
          userId: uid,
          username: row?.username || 'User',
          isTyping: !!data.isTyping,
        },
        ws
      );
      return;
    }

    /** Updates last_seen for “last seen” display. */
    if (data.type === 'heartbeat') {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, uid);
      return;
    }

    // WebRTC signaling (simple voice): forward to peer in same "call room" (chat)
    if (data.type === 'call_signal') {
      const chatId = Number(data.chatId);
      if (!socketChats.get(ws)?.has(chatId)) return;
      broadcastToChat(
        chatId,
        {
          type: 'call_signal',
          chatId,
          fromUserId: uid,
          signalType: data.signalType,
          sdp: data.sdp,
          candidate: data.candidate,
          media: data.media || 'audio',
        },
        ws
      );
      return;
    }
    if (data.type === 'call_offer' || data.type === 'call_answer' || data.type === 'ice_candidate') {
      const chatId = Number(data.chatId);
      if (!socketChats.get(ws)?.has(chatId)) return;
      const signalType =
        data.type === 'call_offer' ? 'offer' : data.type === 'call_answer' ? 'answer' : 'candidate';
      broadcastToChat(
        chatId,
        {
          type: 'call_signal',
          chatId,
          fromUserId: uid,
          signalType,
          sdp: data.sdp,
          candidate: data.candidate,
          media: data.media || 'audio',
        },
        ws
      );
      return;
    }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws]', err);
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Server error' }));
      } catch {
        /* ignore */
      }
    }
  });

  ws.on('close', () => removeUserSocket(ws));
}

function isUserOnline(userId) {
  return userSockets.has(userId);
}

module.exports = { handleConnection, broadcastToChat, isUserOnline, getChatMemberIds };
