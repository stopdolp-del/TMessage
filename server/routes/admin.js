/**
 * Admin-only: ban users, delete any message, manage chats.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');
const { broadcastToChat } = require('../services/wsHub');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

router.use(authMiddleware, requireAdmin);

router.post(
  '/users/:id/ban',
  [body('banned').isBoolean()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot ban yourself' });
    const db = getDb();
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(req.body.banned ? 1 : 0, id);
    res.json({ ok: true });
  }
);

router.delete('/messages/:messageId', (req, res) => {
  const messageId = Number(req.params.messageId);
  const db = getDb();
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
  broadcastToChat(msg.chat_id, { type: 'message_deleted', chatId: msg.chat_id, messageId }, null);
  res.json({ ok: true });
});

router.delete('/chats/:chatId', (req, res) => {
  const chatId = Number(req.params.chatId);
  const db = getDb();
  const c = db.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  res.json({ ok: true });
});

router.post(
  '/chats/:chatId/members/:userId',
  [body('role').optional().isIn(['owner', 'admin', 'member'])],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const chatId = Number(req.params.chatId);
    const userId = Number(req.params.userId);
    const role = req.body.role || 'member';
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId);
    if (!exists) return res.status(404).json({ error: 'Not found' });
    const row = db
      .prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId);
    if (row) {
      db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run(
        role,
        chatId,
        userId
      );
    } else {
      db.prepare('INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, ?)').run(
        chatId,
        userId,
        role
      );
    }
    res.json({ ok: true });
  }
);

module.exports = router;
