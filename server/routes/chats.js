/**
 * Chats: private, groups, channels.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');
const { isUserOnline } = require('../services/wsHub');

const router = express.Router();

function getPrivateChatBetween(db, a, b) {
  const rows = db
    .prepare(
      `SELECT c.id FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
       WHERE c.type = 'private'`
    )
    .all(a, b);
  return rows[0]?.id;
}

router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const rows = db
    .prepare(
      `SELECT c.*, cm.role,
        (SELECT body FROM messages m WHERE m.chat_id = c.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_body,
        (SELECT created_at FROM messages m WHERE m.chat_id = c.id AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 1) AS last_at
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
       ORDER BY COALESCE(last_at, c.created_at) DESC`
    )
    .all(uid);

  const enriched = rows.map((r) => {
    let title = r.name;
    let peer = null;
    if (r.type === 'private') {
      const other = db
        .prepare(
          `SELECT u.id, u.username, u.avatar_url, u.is_admin, u.last_seen, u.status_text FROM users u
           JOIN chat_members cm ON cm.user_id = u.id
           WHERE cm.chat_id = ? AND u.id != ?`
        )
        .get(r.id, uid);
      if (other) {
        title = other.username;
        peer = {
          ...other,
          online: isUserOnline(other.id),
        };
      }
    }
    const unreadRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         JOIN message_receipts rec ON rec.message_id = m.id AND rec.user_id = ?
         WHERE m.chat_id = ? AND m.deleted = 0 AND m.sender_id != ? AND rec.read_at IS NULL`
      )
      .get(uid, r.id, uid);
    const unread_count = unreadRow?.n ?? 0;
    return {
      id: r.id,
      type: r.type,
      name: title || r.name,
      description: r.description,
      avatar_url: r.avatar_url,
      role: r.role,
      last_body: r.last_body,
      last_at: r.last_at,
      unread_count,
      peer,
    };
  });
  res.json({ chats: enriched });
});

router.post(
  '/private/:userId',
  authMiddleware,
  (req, res) => {
    const otherId = Number(req.params.userId);
    if (!otherId || otherId === req.user.id) {
      return res.status(400).json({ error: 'Invalid user' });
    }
    const db = getDb();
    const other = db.prepare('SELECT id FROM users WHERE id = ? AND is_banned = 0').get(otherId);
    if (!other) return res.status(404).json({ error: 'User not found' });

    let chatId = getPrivateChatBetween(db, req.user.id, otherId);
    if (!chatId) {
      const info = db
        .prepare(`INSERT INTO chats (type, name, created_by) VALUES ('private', NULL, ?)`)
        .run(req.user.id);
      chatId = info.lastInsertRowid;
      db.prepare(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member'), (?, ?, 'member')`
      ).run(chatId, req.user.id, chatId, otherId);
    }
    res.json({ chatId });
  }
);

router.post(
  '/',
  authMiddleware,
  [
    body('type').isIn(['group', 'channel']),
    body('name').trim().isLength({ min: 1, max: 64 }),
    body('description').optional().isLength({ max: 500 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { type, name, description } = req.body;
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO chats (type, name, description, created_by) VALUES (?, ?, ?, ?)`
      )
      .run(type, name, description || '', req.user.id);
    const chatId = info.lastInsertRowid;
    db.prepare(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')`
    ).run(chatId, req.user.id);
    res.status(201).json({ chatId });
  }
);

router.post(
  '/:chatId/members',
  authMiddleware,
  [body('userId').isInt()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const chatId = Number(req.params.chatId);
    const userId = Number(req.body.userId);
    const db = getDb();
    const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId);
    if (!chat || chat.type === 'private') {
      return res.status(400).json({ error: 'Cannot add members to this chat' });
    }
    const me = db
      .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, req.user.id);
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_banned = 0').get(userId);
    if (!u) return res.status(404).json({ error: 'User not found' });
    try {
      db.prepare(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')`
      ).run(chatId, userId);
    } catch {
      return res.status(409).json({ error: 'Already a member' });
    }
    res.json({ ok: true });
  }
);

router.get('/:chatId/members', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const db = getDb();
  const ok = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  const members = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_url, u.is_admin, cm.role
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = ?`
    )
    .all(chatId);
  const withPresence = members.map((m) => ({
    ...m,
    online: isUserOnline(m.id),
  }));
  res.json({ members: withPresence });
});

router.delete('/:chatId', authMiddleware, (req, res) => {
  const chatId = Number(req.params.chatId);
  const db = getDb();
  const row = db
    .prepare('SELECT c.type, cm.role FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE c.id = ? AND cm.user_id = ?')
    .get(chatId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.type === 'private') {
    return res.status(400).json({ error: 'Cannot delete private chat here' });
  }
  if (row.role !== 'owner' && !req.user.is_admin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  res.json({ ok: true });
});

module.exports = router;
