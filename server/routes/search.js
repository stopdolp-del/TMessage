/**
 * Global search: users and messages (member-only chats).
 */
const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) {
    return res.json({ users: [], messages: [] });
  }
  const scope = (req.query.scope || 'all').toString();
  const chatFilter = req.query.chatId ? Number(req.query.chatId) : null;
  const db = getDb();
  const uid = req.user.id;
  const like = `%${q}%`;
  const out = { users: [], messages: [] };

  if (scope === 'all' || scope === 'users') {
    out.users = db
      .prepare(
        `SELECT id, username, avatar_url, is_admin FROM users
         WHERE is_banned = 0 AND username LIKE ? AND id != ?
         LIMIT 30`
      )
      .all(like, uid);
  }

  if (scope === 'all' || scope === 'messages') {
    let sql = `SELECT m.id, m.chat_id, m.body, m.created_at, m.msg_type, u.username AS sender_name
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
         JOIN users u ON u.id = m.sender_id
         WHERE m.deleted = 0 AND (m.body LIKE ? OR m.file_name LIKE ?)`;
    const params = [uid, like, like];
    if (chatFilter) {
      sql += ' AND m.chat_id = ?';
      params.push(chatFilter);
    }
    sql += ' ORDER BY m.id DESC LIMIT 40';
    out.messages = db.prepare(sql).all(...params);
  }

  res.json(out);
});

module.exports = router;
