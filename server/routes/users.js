/**
 * User profiles and search.
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');
const config = require('../config');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsPath),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `avatar-${req.user.id}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) {
      return cb(new Error('Only images allowed'));
    }
    cb(null, true);
  },
});

router.patch(
  '/me',
  authMiddleware,
  [
    body('username').optional().trim().isLength({ min: 2, max: 32 }),
    body('bio').optional().isLength({ max: 500 }),
    body('status_text').optional().isLength({ max: 140 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const db = getDb();
    const fields = [];
    const vals = [];
    if (req.body.username != null) {
      fields.push('username = ?');
      vals.push(req.body.username);
    }
    if (req.body.bio != null) {
      fields.push('bio = ?');
      vals.push(req.body.bio);
    }
    if (req.body.status_text != null) {
      fields.push('status_text = ?');
      vals.push(req.body.status_text);
    }
    if (!fields.length) {
      const u = db
        .prepare(
          'SELECT id, username, avatar_url, bio, status_text, is_admin FROM users WHERE id = ?'
        )
        .get(req.user.id);
      return res.json({ user: u });
    }
    vals.push(req.user.id);
    db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    const u = db
      .prepare(
        'SELECT id, username, avatar_url, bio, status_text, is_admin FROM users WHERE id = ?'
      )
      .get(req.user.id);
    res.json({ user: u });
  }
);

router.post('/me/avatar', authMiddleware, (req, res) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = `/uploads/${req.file.filename}`;
    const db = getDb();
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, req.user.id);
    res.json({ avatar_url: url });
  });
});

router.get('/search', authMiddleware, (req, res) => {
  const username = (req.query.username ?? '').toString().trim();
  if (username.length > 0) {
    const db = getDb();
    const u = db
      .prepare(
        `SELECT id, username, avatar_url, is_admin FROM users
         WHERE is_banned = 0 AND lower(username) = lower(?) AND id != ?`
      )
      .get(username, req.user.id);
    return res.json({ user: u || null });
  }
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ users: [] });
  const db = getDb();
  const like = `%${q}%`;
  const users = db
    .prepare(
      `SELECT id, username, avatar_url, is_admin FROM users
       WHERE is_banned = 0 AND username LIKE ? AND id != ?
       LIMIT 20`
    )
    .all(like, req.user.id);
  res.json({ users });
});

router.get('/:id', authMiddleware, (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const u = db
    .prepare(
      'SELECT id, username, avatar_url, bio, status_text, last_seen, is_admin, created_at FROM users WHERE id = ? AND is_banned = 0'
    )
    .get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const settings = db.prepare('SELECT privacy_show_last_seen FROM user_settings WHERE user_id = ?').get(id);
  const showSeen = settings == null || settings.privacy_show_last_seen;
  if (!showSeen && req.user.id !== id) {
    delete u.last_seen;
  }
  res.json({ user: u });
});

module.exports = router;
