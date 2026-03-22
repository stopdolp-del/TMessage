const jwt = require('jsonwebtoken');
const config = require('../config');

const ACCESS_TTL = '15m';

function signAccessToken(payload) {
  return jwt.sign({ ...payload, typ: 'access' }, config.jwtSecret, { expiresIn: ACCESS_TTL });
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, config.jwtSecret);
  if (decoded.typ != null && decoded.typ !== 'access') {
    throw new Error('Invalid token type');
  }
  return decoded;
}

module.exports = { signAccessToken, verifyAccessToken, ACCESS_TTL };
