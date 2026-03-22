/**
 * Messages: text, media, replies, forwards, reactions, receipts, edit/delete.
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');
const { spamGuard } = require('../middleware/spamGuard');
const { broadcastToChat } = require('../services/wsHub');
const { enrichMessages, seedReceiptsForNewMessage } = require('../services/messageHelpers');
const config = require('../config');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `f-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

const MSG_SELECT = `SELECT m.*, u.username, u.avatar_url, u.is_admin,
  ru.username AS reply_username, rm.body AS reply_body
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages rm ON rm.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = rm.sender_id`;

/** Keep msg_type within legacy CHECK (text|image|file|system); use file_mime for video/voice in UI. */
function detectMsgType(file) {
  if (!file) return 'text';
  if (file.mimetype.startsWith('image/')) return 'image';
  return 'file';
}

router.get('/chat/:chatId', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? Number(req.query.before) : null;
  const db = getDb();
  const ok = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  let rows;
  if (before) {
    rows = db
      .prepare(
        `${MSG_SELECT}
         WHERE m.chat_id = ? AND m.deleted = 0 AND m.id < ?
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(chatId, before, limit);
  } else {
    rows = db
      .prepare(
        `${MSG_SELECT}
         WHERE m.chat_id = ? AND m.deleted = 0
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(chatId, limit);
  }
  rows.reverse();
  res.json({ messages: enrichMessages(rows, req.user.id) });
});

router.post(
  '/chat/:chatId',
  authMiddleware,
  spamGuard,
  upload.single('file'),
  (req, res) => {
    const chatId = Number(req.params.chatId);
    const db = getDb();
    const ok = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });

    const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId);
    if (chat?.type === 'channel') {
      const role = db
        .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
        .get(chatId, req.user.id);
      if (role?.role === 'member') {
        return res.status(403).json({ error: 'Only admins can post in channels' });
      }
    }

    let body = req.body.text != null ? String(req.body.text) : '';
    const replyToId = req.body.reply_to_id ? Number(req.body.reply_to_id) : null;
    if (replyToId) {
      const r = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(replyToId, chatId);
      if (!r) return res.status(400).json({ error: 'Invalid reply target' });
    }

    let msgType = 'text';
    let fileName = null;
    let filePath = null;
    let fileMime = null;
    let fileSize = null;

    if (req.file) {
      fileName = req.file.originalname;
      filePath = `/uploads/${req.file.filename}`;
      fileMime = req.file.mimetype;
      fileSize = req.file.size;
      msgType = detectMsgType(req.file);
      if (!body) body = fileName;
    } else if (!body.trim()) {
      return res.status(400).json({ error: 'Empty message' });
    }

    const info = db
      .prepare(
        `INSERT INTO messages (chat_id, sender_id, body, msg_type, file_name, file_path, file_mime, file_size, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(chatId, req.user.id, body, msgType, fileName, filePath, fileMime, fileSize, replyToId);

    const mid = info.lastInsertRowid;
    seedReceiptsForNewMessage(mid, chatId, req.user.id);

    const row = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(mid);
    const enriched = enrichMessages([row], req.user.id)[0];

    broadcastToChat(chatId, { type: 'new_message', chatId, message: enriched }, null);
    res.status(201).json({ message: enriched });
  }
);

router.patch('/message/:messageId', authMiddleware, (req, res) => {
  const messageId = Number(req.params.messageId);
  const body = req.body.body != null ? String(req.body.body) : '';
  if (!body.trim()) return res.status(400).json({ error: 'Empty' });
  const db = getDb();
  const msg = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.id = ? AND m.deleted = 0`
    )
    .get(req.user.id, messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    'UPDATE messages SET body = ?, edited_at = ?, edit_count = COALESCE(edit_count,0) + 1 WHERE id = ?'
  ).run(body, now, messageId);
  const row = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(messageId);
  const enriched = enrichMessages([row], req.user.id)[0];
  broadcastToChat(msg.chat_id, { type: 'message_edited', chatId: msg.chat_id, message: enriched }, null);
  res.json({ message: enriched });
});

router.post('/message/:messageId/forward', authMiddleware, (req, res) => {
    const messageId = Number(req.params.messageId);
    if (!Array.isArray(req.body.chatIds) || !req.body.chatIds.length) {
      return res.status(400).json({ error: 'chatIds array required' });
    }
    const db = getDb();
    const src = db.prepare('SELECT * FROM messages WHERE id = ? AND deleted = 0').get(messageId);
    if (!src) return res.status(404).json({ error: 'Not found' });
    const canSee = db
      .prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(src.chat_id, req.user.id);
    if (!canSee) return res.status(403).json({ error: 'Forbidden' });
    const fromChat = db.prepare('SELECT name FROM chats WHERE id = ?').get(src.chat_id);
    const fromUser = db.prepare('SELECT username FROM users WHERE id = ?').get(src.sender_id);
    const label = `${fromUser?.username || 'User'} @ ${fromChat?.name || 'chat'}`;

    const created = [];
    for (const cid of req.body.chatIds) {
      const chatId = Number(cid);
      const mem = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
      if (!mem) continue;
      const info = db
        .prepare(
          `INSERT INTO messages (chat_id, sender_id, body, msg_type, file_name, file_path, file_mime, file_size,
           forward_from_message_id, forward_from_chat_id, forward_from_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          chatId,
          req.user.id,
          src.body,
          src.msg_type,
          src.file_name,
          src.file_path,
          src.file_mime,
          src.file_size,
          src.id,
          src.chat_id,
          label
        );
      const mid = info.lastInsertRowid;
      seedReceiptsForNewMessage(mid, chatId, req.user.id);
      const row = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(mid);
      const enriched = enrichMessages([row], req.user.id)[0];
      broadcastToChat(chatId, { type: 'new_message', chatId, message: enriched }, null);
      created.push(enriched);
    }
    res.json({ messages: created });
});

router.post(
  '/message/:messageId/react',
  authMiddleware,
  [body('emoji').isString().isLength({ min: 1, max: 16 })],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const messageId = Number(req.params.messageId);
    const emoji = String(req.body.emoji);
    const allowed = ['👍', '❤️', '🔥', '😂', '😮', '😢', '🎉', '👏'];
    if (!allowed.includes(emoji)) return res.status(400).json({ error: 'Emoji not allowed' });
    const db = getDb();
    const msg = db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
         WHERE m.id = ? AND m.deleted = 0`
      )
      .get(req.user.id, messageId);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    db.prepare('INSERT OR REPLACE INTO message_reactions (message_id, user_id, emoji) VALUES (?,?,?)').run(
      messageId,
      req.user.id,
      emoji
    );
    broadcastToChat(msg.chat_id, {
      type: 'reaction_update',
      chatId: msg.chat_id,
      messageId,
      userId: req.user.id,
      emoji,
    });
    res.json({ ok: true });
  }
);

router.delete('/message/:messageId/react', authMiddleware, (req, res) => {
  const messageId = Number(req.params.messageId);
  const db = getDb();
  const msg = db
    .prepare(
      `SELECT m.chat_id FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.id = ?`
    )
    .get(req.user.id, messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, req.user.id);
  broadcastToChat(msg.chat_id, { type: 'reaction_update', chatId: msg.chat_id, messageId, userId: req.user.id, emoji: null });
  res.json({ ok: true });
});

router.post('/delivered/:messageId', authMiddleware, (req, res) => {
  const messageId = Number(req.params.messageId);
  const db = getDb();
  const msg = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.id = ? AND m.deleted = 0`
    )
    .get(req.user.id, messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id === req.user.id) return res.json({ ok: true });
  const now = Math.floor(Date.now() / 1000);
  const ex = db.prepare('SELECT * FROM message_receipts WHERE message_id = ? AND user_id = ?').get(messageId, req.user.id);
  if (ex) {
    db.prepare('UPDATE message_receipts SET delivered_at = ? WHERE message_id = ? AND user_id = ?').run(
      now,
      messageId,
      req.user.id
    );
  } else {
    db.prepare('INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at) VALUES (?,?,?,?)').run(
      messageId,
      req.user.id,
      now,
      null
    );
  }
  broadcastToChat(msg.chat_id, {
    type: 'receipt_update',
    chatId: msg.chat_id,
    messageId,
    userId: req.user.id,
    status: 'delivered',
  });
  res.json({ ok: true });
});

router.post(
  '/read',
  authMiddleware,
  [body('chatId').isInt(), body('upToMessageId').isInt()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const chatId = Number(req.body.chatId);
    const upTo = Number(req.body.upToMessageId);
    const db = getDb();
    const ok = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    const msgs = db
      .prepare(
        'SELECT id FROM messages WHERE chat_id = ? AND id <= ? AND deleted = 0 AND sender_id != ?'
      )
      .all(chatId, upTo, req.user.id);
    const now = Math.floor(Date.now() / 1000);
    msgs.forEach(({ id }) => {
      const ex = db.prepare('SELECT * FROM message_receipts WHERE message_id = ? AND user_id = ?').get(id, req.user.id);
      if (ex) {
        db.prepare('UPDATE message_receipts SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE message_id = ? AND user_id = ?').run(
          now,
          now,
          id,
          req.user.id
        );
      } else {
        db.prepare(
          'INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at) VALUES (?,?,?,?)'
        ).run(id, req.user.id, now, now);
      }
      broadcastToChat(chatId, {
        type: 'receipt_update',
        chatId,
        messageId: id,
        userId: req.user.id,
        status: 'read',
      });
    });
    res.json({ ok: true, count: msgs.length });
  }
);

router.delete('/message/:messageId', authMiddleware, (req, res) => {
  const messageId = Number(req.params.messageId);
  const db = getDb();
  const msg = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.id = ?`
    )
    .get(req.user.id, messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const isOwner = msg.sender_id === req.user.id;
  const isAdmin = req.user.is_admin;
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
  broadcastToChat(msg.chat_id, { type: 'message_deleted', chatId: msg.chat_id, messageId }, null);
  res.json({ ok: true });
});

module.exports = router;
