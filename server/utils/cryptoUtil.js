/**
 * Token hashing for refresh sessions and reset tokens (SHA-256).
 */
const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { sha256Hex, randomToken };
