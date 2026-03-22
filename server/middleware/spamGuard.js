/**
 * Basic anti-spam: track last action timestamps per user id (in-memory).
 * Complement express-rate-limit on HTTP.
 */
const lastAction = new Map();
const MIN_MS = 400;

function spamGuard(req, res, next) {
  const uid = req.user?.id;
  if (!uid) return next();
  const now = Date.now();
  const prev = lastAction.get(uid) || 0;
  if (now - prev < MIN_MS) {
    return res.status(429).json({ error: 'Slow down' });
  }
  lastAction.set(uid, now);
  next();
}

module.exports = { spamGuard };
