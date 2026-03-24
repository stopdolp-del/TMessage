const { verifyAccessToken } = require('../utils/jwt');
const { getDb } = require('../db/init');

/**
 * Bearer JWT (access), attaches req.user
 */
function authMiddleware(req, res, next) {
  try {
    console.log('[AUTH] Checking authentication for:', req.method, req.url);
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    
    if (!token) {
      console.log('[AUTH] No token provided');
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }
    
    try {
      console.log('[AUTH] Verifying token...');
      const decoded = verifyAccessToken(token);
      console.log('[AUTH] Token decoded for user ID:', decoded.sub);
      
      const db = getDb();
      const user = db
        .prepare(
          'SELECT id, username, avatar_url, is_banned, is_admin FROM users WHERE id = ?'
        )
        .get(decoded.sub);
        
      if (!user) {
        console.log('[AUTH] User not found for ID:', decoded.sub);
        return res.status(403).json({ error: 'Forbidden - User not found' });
      }
      
      if (user.is_banned) {
        console.log('[AUTH] Banned user attempted access:', user.username);
        return res.status(403).json({ error: 'Forbidden - User is banned' });
      }
      
      console.log('[AUTH] Authentication successful for:', user.username);
      req.user = user;
      req.token = token;
      next();
    } catch (tokenError) {
      console.error('[AUTH] Token verification failed:', tokenError);
      return res.status(401).json({ error: 'Invalid token' });
    }
  } catch (error) {
    console.error('[AUTH] Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication error' });
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
