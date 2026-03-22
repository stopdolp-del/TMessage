/**
 * Incremental schema migrations for sql.js (ALTER / new tables).
 */
function safeAlter(db, sql) {
  try {
    db.run(sql);
  } catch {
    /* duplicate column etc. */
  }
}

/**
 * @param {import('sql.js').Database} db
 */
function runMigrations(db) {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL)`);
  let v = 0;
  try {
    const r = db.exec('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations');
    v = r[0]?.values[0]?.[0] ?? 0;
  } catch {
    v = 0;
  }

  if (v < 1) {
    safeAlter(db, 'ALTER TABLE users ADD COLUMN last_seen INTEGER');
    safeAlter(db, 'ALTER TABLE users ADD COLUMN password_reset_token TEXT');
    safeAlter(db, 'ALTER TABLE users ADD COLUMN password_reset_expires INTEGER');
    safeAlter(db, 'ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT \'\'');
    db.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)');
    v = 1;
  }

  if (v < 2) {
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN reply_to_id INTEGER');
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN forward_from_message_id INTEGER');
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN forward_from_chat_id INTEGER');
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN forward_from_label TEXT');
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN edited_at INTEGER');
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN edit_count INTEGER DEFAULT 0');
    db.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)');
    v = 2;
  }

  if (v < 3) {
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.run(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
    db.run(`
      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        delivered_at INTEGER,
        read_at INTEGER,
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`);
    db.run(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id INTEGER PRIMARY KEY,
        theme TEXT DEFAULT 'dark',
        notify_desktop INTEGER DEFAULT 1,
        notify_sound INTEGER DEFAULT 1,
        privacy_show_last_seen INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_receipts_msg ON message_receipts(message_id)');
    db.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)');
    v = 3;
  }

  if (v < 4) {
    // No email verification: all accounts can use the app immediately.
    db.run('UPDATE users SET is_verified = 1');
    db.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (4)');
    v = 4;
  }

  if (v < 5) {
    safeAlter(db, 'ALTER TABLE messages ADD COLUMN video_note INTEGER DEFAULT 0');
    db.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (5)');
  }
}

module.exports = { runMigrations };
