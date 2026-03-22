/**
 * User settings: theme, notifications, privacy.
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/authMiddleware');

const router = express.Router();

function getOrCreateSettings(userId) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(userId);
  return db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
}

router.get('/me', authMiddleware, (req, res) => {
  const s = getOrCreateSettings(req.user.id);
  res.json({ settings: s });
});

router.patch(
  '/me',
  authMiddleware,
  [
    body('theme').optional().isIn(['dark', 'light']),
    body('notify_desktop').optional().isBoolean(),
    body('notify_sound').optional().isBoolean(),
    body('privacy_show_last_seen').optional().isBoolean(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const db = getDb();
    getOrCreateSettings(req.user.id);
    const fields = [];
    const vals = [];
    if (req.body.theme != null) {
      fields.push('theme = ?');
      vals.push(req.body.theme);
    }
    if (req.body.notify_desktop != null) {
      fields.push('notify_desktop = ?');
      vals.push(req.body.notify_desktop ? 1 : 0);
    }
    if (req.body.notify_sound != null) {
      fields.push('notify_sound = ?');
      vals.push(req.body.notify_sound ? 1 : 0);
    }
    if (req.body.privacy_show_last_seen != null) {
      fields.push('privacy_show_last_seen = ?');
      vals.push(req.body.privacy_show_last_seen ? 1 : 0);
    }
    if (!fields.length) return res.json({ settings: getOrCreateSettings(req.user.id) });
    vals.push(req.user.id);
    db.prepare(`UPDATE user_settings SET ${fields.join(', ')} WHERE user_id = ?`).run(...vals);
    res.json({ settings: getOrCreateSettings(req.user.id) });
  }
);

module.exports = router;
