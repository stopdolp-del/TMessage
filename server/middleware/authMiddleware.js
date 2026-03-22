const { verifyAccessToken } = require('../utils/jwt');
const { getDb } = require('../db/init');

/**
 * Bearer JWT (access), attaches req.user
 */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = verifyAccessToken(token);
    const db = getDb();
    const user = db
      .prepare(
        'SELECT id, username, avatar_url, is_banned, is_admin FROM users WHERE id = ?'
      )
      .get(decoded.sub);
    if (!user || user.is_banned) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.user = user;
    req.token = token;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = verifyAccessToken(token);
    const db = getDb();
    const user = db
      .prepare('SELECT id, username, avatar_url, is_banned, is_admin FROM users WHERE id = ?')
      .get(decoded.sub);
    if (user && !user.is_banned) {
      req.user = user;
      req.token = token;
    }
  } catch {
    /* ignore */
  }
  next();
}

module.exports = { authMiddleware, optionalAuth };
