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
const { createCaptcha, validateCaptcha } = require('../services/captchaStore');

const router = express.Router();
const SALT = 12;

router.get('/register/captcha', (req, res) => {
  res.json(createCaptcha());
});

/** Stable unique internal email (avoids UNIQUE collisions for similar usernames). */
function placeholderEmail(username) {
  const h = crypto.createHash('sha256').update(`\0${String(username)}\0`, 'utf8').digest('hex').slice(0, 28);
  return `u_${h}@tmessage.local`;
}

router.post('/register', async (req, res) => {
  try {
    console.log('[REGISTER] Request body:', req.body);
    
    const { username, password, answer } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }

    if (answer != 15) {
      console.log('[REGISTER] Wrong captcha answer:', answer);
      return res.status(400).json({ error: "Wrong captcha" });
    }

    const db = getDb();
    console.log('[REGISTER] Checking if user exists:', username);

    const existing = db.prepare("SELECT id FROM users WHERE lower(username) = ?").get(username.toLowerCase());

    if (existing) {
      console.log('[REGISTER] User already exists:', username);
      return res.status(409).json({ error: "User already exists" });
    }

    console.log('[REGISTER] Creating new user:', username);
    const hash = await bcrypt.hash(password, SALT);
    const email = placeholderEmail(username);
    const isAdmin = config.isAdmin(username);
    
    const result = db.prepare(
      `INSERT INTO users (email, password_hash, username, is_verified, is_admin, verification_token, verification_expires)
       VALUES (?, ?, ?, 1, ?, NULL, NULL)`
    ).run(email, hash, username, isAdmin ? 1 : 0);
    
    console.log('[REGISTER] User created successfully:', username, 'ID:', result.lastInsertRowid);
    
    return res.json({ success: true });

  } catch (err) {
    console.error("[REGISTER] CRASH:", err);
    const msg = err && err.message ? String(err.message) : '';
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      return res.status(409).json({ error: "User already exists" });
    }
    return res.status(500).json({ error: err.message || "Registration failed" });
  }
});

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
