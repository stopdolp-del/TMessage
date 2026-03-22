/**
 * Attach reactions and receipt summaries to message rows.
 */
const { getDb } = require('../db/init');

function loadReactionsForMessages(db, messageIds) {
  if (!messageIds.length) return {};
  const ph = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (${ph})`)
    .all(...messageIds);
  const map = {};
  rows.forEach((r) => {
    if (!map[r.message_id]) map[r.message_id] = [];
    map[r.message_id].push({ userId: r.user_id, emoji: r.emoji });
  });
  return map;
}

function receiptSummary(db, msg, viewerId) {
  if (msg.sender_id !== viewerId) return undefined;
  const others = db
    .prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?')
    .all(msg.chat_id, viewerId);
  if (!others.length) return { delivered: true, read: true };
  let allDel = true;
  let allRead = true;
  for (const { user_id: uid } of others) {
    const rec = db
      .prepare('SELECT delivered_at, read_at FROM message_receipts WHERE message_id = ? AND user_id = ?')
      .get(msg.id, uid);
    if (!rec || !rec.delivered_at) allDel = false;
    if (!rec || !rec.read_at) allRead = false;
  }
  return { delivered: allDel, read: allRead };
}

function enrichMessages(rows, viewerId) {
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const reactions = loadReactionsForMessages(db, ids);
  return rows.map((m) => ({
    ...m,
    reactions: reactions[m.id] || [],
    receipt: receiptSummary(db, m, viewerId),
  }));
}

function seedReceiptsForNewMessage(messageId, chatId, senderId) {
  const db = getDb();
  const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId);
  const now = Math.floor(Date.now() / 1000);
  members.forEach(({ user_id: uid }) => {
    if (uid === senderId) {
      db.prepare(
        'INSERT OR REPLACE INTO message_receipts (message_id, user_id, delivered_at, read_at) VALUES (?,?,?,?)'
      ).run(messageId, uid, now, now);
    } else {
      try {
        db.prepare(
          'INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at) VALUES (?,?,NULL,NULL)'
        ).run(messageId, uid);
      } catch {
        /* duplicate */
      }
    }
  });
}

module.exports = { enrichMessages, seedReceiptsForNewMessage };
