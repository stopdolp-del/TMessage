/**
 * Registration and login: username + password, JWT access + refresh sessions.
 */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { signAccessToken } = require('../utils/jwt');
const config = require('../config');
const { authMiddleware } = require('../middleware/authMiddleware');
const {
  createRefreshSession,
  revokeRefreshSession,
  revokeAllUserSessions,
  validateRefreshToken,
} = require('../services/sessions');

const router = express.Router();
const SALT = 12;

/** Stable unique internal email (avoids UNIQUE collisions for similar usernames). */
function placeholderEmail(username) {
  const h = crypto.createHash('sha256').update(`\0${String(username)}\0`, 'utf8').digest('hex').slice(0, 28);
  return `u_${h}@tmessage.local`;
}

router.post(
  '/register',
  [
    body('username')
      .trim()
      .isLength({ min: 2, max: 32 })
      .matches(/^[\p{L}\p{N}_.-]+$/u)
      .withMessage('Username: 2–32 chars, letters, numbers, _ . -'),
    body('password').isLength({ min: 8, max: 128 }).withMessage('Password: at least 8 characters'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return res.status(400).json({
          error: 'Invalid data',
          details: first.msg,
        });
      }
      const { username, password } = req.body;
      const db = getDb();
      const uname = username.trim();
      const exists = db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(uname.toLowerCase());
      if (exists) {
        return res.status(409).json({ error: 'User exists' });
      }
      const hash = await bcrypt.hash(password, SALT);
      const email = placeholderEmail(uname);
      const isAdmin = uname.toLowerCase() === config.adminUsername.toLowerCase();
      const result = db
        .prepare(
          `INSERT INTO users (email, password_hash, username, is_verified, is_admin, verification_token, verification_expires)
         VALUES (?, ?, ?, 1, ?, NULL, NULL)`
        )
        .run(email, hash, uname, isAdmin ? 1 : 0);
      const userId = result.lastInsertRowid;
      const accessToken = signAccessToken({ sub: userId });
      const refreshToken = createRefreshSession(userId);
      db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
      res.status(201).json({
        token: accessToken,
        refreshToken,
        user: {
          id: userId,
          username: uname,
          is_admin: !!isAdmin,
        },
      });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : '';
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        return res.status(409).json({ error: 'User exists' });
      }
      next(e);
    }
  }
);

router.post(
  '/login',
  [
    body('username').trim().notEmpty().withMessage('Username required'),
    body('password').isString().notEmpty().withMessage('Password required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return res.status(400).json({ error: 'Invalid data', details: first.msg });
      }
      const username = req.body.username.trim();
      const { password } = req.body;
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(username.toLowerCase());
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      if (user.is_banned) {
        return res.status(403).json({ error: 'Account suspended' });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const accessToken = signAccessToken({ sub: user.id });
      const refreshToken = createRefreshSession(user.id);
      db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(user.id);
      res.json({
        token: accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          avatar_url: user.avatar_url,
          is_admin: !!user.is_admin,
        },
      });
    } catch (e) {
      next(e);
    }
  }
);

router.post('/refresh', [body('refreshToken').isString().notEmpty()], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const v = validateRefreshToken(req.body.refreshToken);
  if (!v) return res.status(401).json({ error: 'Invalid refresh token' });
  const db = getDb();
  const user = db.prepare('SELECT id, is_banned FROM users WHERE id = ?').get(v.userId);
  if (!user || user.is_banned) return res.status(403).json({ error: 'Forbidden' });
  const accessToken = signAccessToken({ sub: user.id });
  res.json({ token: accessToken });
});

router.post('/logout', (req, res) => {
  revokeRefreshSession(req.body?.refreshToken);
  res.json({ ok: true });
});

router.post(
  '/change-password',
  authMiddleware,
  [body('currentPassword').isString(), body('newPassword').isLength({ min: 8, max: 128 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const ok = await bcrypt.compare(req.body.currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    const hash = await bcrypt.hash(req.body.newPassword, SALT);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    revokeAllUserSessions(req.user.id);
    const refreshToken = createRefreshSession(req.user.id);
    res.json({ ok: true, refreshToken });
  }
);

router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const u = db
    .prepare(
      `SELECT id, username, avatar_url, bio, status_text, is_admin, created_at, last_seen
       FROM users WHERE id = ?`
    )
    .get(req.user.id);
  res.json({ user: u });
});

module.exports = router;
