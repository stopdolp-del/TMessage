/**
 * Short-lived math captcha for registration. In-memory.
 */
const crypto = require('crypto');

const store = new Map();
const TTL_MS = 10 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires < now) store.delete(k);
  }
}

function createCaptcha() {
  cleanup();
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const id = crypto.randomBytes(16).toString('hex');
  store.set(id, { sum: a + b, expires: Date.now() + TTL_MS });
  return { id, question: `What is ${a} + ${b}?` };
}

function validateCaptcha(id, answer) {
  cleanup();
  if (id == null || id === '') return false;
  const row = store.get(String(id));
  if (!row) return false;
  store.delete(String(id));
  if (row.expires < Date.now()) return false;
  const n = Number(String(answer).trim());
  return Number.isFinite(n) && Math.trunc(n) === row.sum;
}

module.exports = { createCaptcha, validateCaptcha };
