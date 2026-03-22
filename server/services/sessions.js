/**
 * Opaque refresh tokens stored hashed in SQLite.
 */
const { getDb } = require('../db/init');
const { sha256Hex, randomToken } = require('../utils/cryptoUtil');

const REFRESH_DAYS = 30;

function createRefreshSession(userId) {
  const db = getDb();
  const raw = randomToken(32);
  const hash = sha256Hex(raw);
  const expires = Math.floor(Date.now() / 1000) + REFRESH_DAYS * 86400;
  db.prepare('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(userId, hash, expires);
  return raw;
}

function revokeRefreshSession(token) {
  if (!token) return;
  const db = getDb();
  const hash = sha256Hex(token);
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
}

function revokeAllUserSessions(userId) {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * @returns {{ userId: number } | null}
 */
function validateRefreshToken(token) {
  if (!token) return null;
  const db = getDb();
  const hash = sha256Hex(token);
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hash);
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  return { userId: row.user_id };
}

module.exports = {
  createRefreshSession,
  revokeRefreshSession,
  revokeAllUserSessions,
  validateRefreshToken,
};
