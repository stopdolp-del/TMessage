/**
 * Admin-only: manage users, view all messages, ban/unban users.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');
const { broadcastToChat } = require('../services/wsHub');
const config = require('../config');

const router = express.Router();

function requireAdmin(req, res, next) {
  console.log('[ADMIN CHECK]', {
    user: req.user,
    username: req.user?.username,
    isAdmin: req.user ? config.isAdmin(req.user.username) : false
  });
  
  if (!req.user) {
    console.log('[ADMIN] No user found in request');
    return res.status(401).json({ error: "Not logged in" });
  }
  
  if (!config.isAdmin(req.user.username)) {
    console.log('[ADMIN] User not admin:', req.user.username);
    return res.status(403).json({ error: "Forbidden - Admin access required" });
  }
  
  console.log('[ADMIN] Access granted to:', req.user.username);
  next();
}

router.use(authMiddleware, requireAdmin);

// Get all users
router.get('/users', (req, res) => {
  try {
    console.log('[ADMIN] Getting all users');
    const db = getDb();
    const users = db.prepare(`
      SELECT id, username, email, created_at, is_banned, is_admin, is_verified 
      FROM users 
      ORDER BY created_at DESC
    `).all();
    console.log('[ADMIN] Retrieved users:', users.length);
    res.json(users);
  } catch (error) {
    console.error('[ADMIN] Error getting users:', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// Ban user by username
router.post('/ban', [
  body('username').trim().isLength({ min: 1 }).withMessage('Username is required'),
  body('reason').optional().isLength({ max: 500 }).withMessage('Reason too long')
], (req, res) => {
  try {
    console.log('[ADMIN] Ban request:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { username, reason } = req.body;
    const db = getDb();
    
    // Check if user exists
    const user = db.prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) {
      console.log('[ADMIN] User not found:', username);
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Don't allow banning admins
    if (config.isAdmin(user.username)) {
      console.log('[ADMIN] Attempt to ban admin:', user.username);
      return res.status(400).json({ error: 'Cannot ban admin users' });
    }
    
    // Update ban status
    db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(user.id);
    
    // Log the ban action
    console.log(`[ADMIN] ${req.user.username} banned user: ${user.username} (ID: ${user.id})${reason ? ` - Reason: ${reason}` : ''}`);
    
    res.json({ 
      success: true, 
      user: { id: user.id, username: user.username, banned: true },
      reason: reason || null
    });
  } catch (error) {
    console.error('[ADMIN] Error banning user:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// Unban user by username
router.post('/unban', [
  body('username').trim().isLength({ min: 1 }).withMessage('Username is required')
], (req, res) => {
  try {
    console.log('[ADMIN] Unban request:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { username } = req.body;
    const db = getDb();
    
    // Check if user exists
    const user = db.prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) {
      console.log('[ADMIN] User not found for unban:', username);
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update ban status
    db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(user.id);
    
    // Log the unban action
    console.log(`[ADMIN] ${req.user.username} unbanned user: ${user.username} (ID: ${user.id})`);
    
    res.json({ 
      success: true, 
      user: { id: user.id, username: user.username, banned: false }
    });
  } catch (error) {
    console.error('[ADMIN] Error unbanning user:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// Get all messages
router.get('/messages', (req, res) => {
  try {
    console.log('[ADMIN] Getting messages');
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    
    const messages = db.prepare(`
      SELECT 
        m.id,
        m.body,
        m.file_name,
        m.created_at,
        m.deleted,
        m.chat_id,
        u.id as sender_id,
        u.username as sender_username,
        c.name as chat_name,
        c.type as chat_type
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN chats c ON m.chat_id = c.id
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);
    
    const total = db.prepare('SELECT COUNT(*) as count FROM messages').get();
    
    console.log('[ADMIN] Retrieved messages:', messages.length, 'total:', total.count);
    
    res.json({
      messages,
      pagination: {
        total: total.count,
        limit,
        offset,
        hasMore: offset + limit < total.count
      }
    });
  } catch (error) {
    console.error('[ADMIN] Error getting messages:', error);
    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

// Delete user
router.post('/deleteUser', [
  body('username').trim().isLength({ min: 1 }).withMessage('Username is required')
], (req, res) => {
  try {
    console.log('[ADMIN] Delete user request:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { username } = req.body;
    const db = getDb();
    
    const user = db.prepare('SELECT id, username, is_admin FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) {
      console.log('[ADMIN] User not found for deletion:', username);
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (user.is_admin) {
      console.log('[ADMIN] Attempt to delete admin:', user.username);
      return res.status(400).json({ error: 'Cannot delete admin users' });
    }
    
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    
    // Delete user (cascade will handle related records if foreign keys are set up)
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    
    console.log(`[ADMIN] ${req.user.username} deleted user: ${user.username}`);
    
    res.json({ 
      success: true, 
      message: `User ${user.username} deleted successfully`,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    console.error('[ADMIN] Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Delete message
router.post('/deleteMessage', [
  body('messageId').isInt({ min: 1 }).withMessage('Valid message ID is required')
], (req, res) => {
  try {
    console.log('[ADMIN] Delete message request:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    
    const { messageId } = req.body;
    const db = getDb();
    
    const msg = db.prepare('SELECT id, chat_id, body FROM messages WHERE id = ?').get(messageId);
    if (!msg) {
      console.log('[ADMIN] Message not found:', messageId);
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Soft delete the message
    db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
    
    // Broadcast deletion via WebSocket
    broadcastToChat(msg.chat_id, { 
      type: 'message_deleted', 
      chatId: msg.chat_id, 
      messageId: messageId 
    }, null);
    
    console.log(`[ADMIN] ${req.user.username} deleted message: ${messageId}`);
    
    res.json({ 
      success: true, 
      message: `Message ${messageId} deleted successfully`,
      messageId: messageId
    });
  } catch (error) {
    console.error('[ADMIN] Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Get banned users list
router.get('/banned', (req, res) => {
  try {
    console.log('[ADMIN] Getting banned users');
    const db = getDb();
    const users = db.prepare(`
      SELECT id, username, email, created_at, is_banned
      FROM users 
      WHERE is_banned = 1
      ORDER BY created_at DESC
    `).all();
    console.log('[ADMIN] Retrieved banned users:', users.length);
    res.json({ bannedUsers: users, count: users.length });
  } catch (error) {
    console.error('[ADMIN] Error getting banned users:', error);
    res.status(500).json({ error: 'Failed to retrieve banned users' });
  }
});

// Search users by username
router.get('/searchUsers', (req, res) => {
  try {
    const query = (req.query.q || '').trim().toLowerCase();
    console.log('[ADMIN] Search users:', query);
    
    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }
    
    const db = getDb();
    const users = db.prepare(`
      SELECT id, username, email, created_at, is_banned, is_admin, is_verified
      FROM users 
      WHERE LOWER(username) LIKE ?
      ORDER BY created_at DESC
      LIMIT 50
    `).all(`%${query}%`);
    
    console.log('[ADMIN] Search results:', users.length);
    res.json({ users, count: users.length });
  } catch (error) {
    console.error('[ADMIN] Error searching users:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

router.post(
  '/users/:id/ban',
  [body('banned').isBoolean()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot ban yourself' });
    const db = getDb();
    const u = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    
    // Don't allow banning admins
    if (config.isAdmin(u.username)) {
      return res.status(400).json({ error: 'Cannot ban admin users' });
    }
    
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(req.body.banned ? 1 : 0, id);
    console.log(`[ADMIN] ${req.user.username} ${req.body.banned ? 'banned' : 'unbanned'} user: ${u.username} (ID: ${u.id})`);
    res.json({ ok: true });
  }
);

router.post(
  '/users/ban-by-username',
  [body('username').trim().isLength({ min: 1 }), body('banned').isBoolean()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { username, banned } = req.body;
    const db = getDb();
    const u = db.prepare('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.id === req.user.id) return res.status(400).json({ error: 'Cannot ban yourself' });
    
    // Don't allow banning admins
    if (config.isAdmin(u.username)) {
      return res.status(400).json({ error: 'Cannot ban admin users' });
    }
    
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned ? 1 : 0, u.id);
    console.log(`[ADMIN] ${req.user.username} ${banned ? 'banned' : 'unbanned'} user: ${u.username} (ID: ${u.id})`);
    res.json({ ok: true, user: { id: u.id, username: u.username, banned } });
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
