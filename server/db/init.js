/**
 * SQLite via sql.js (pure JS/WASM — no native compile; works on Windows without VS).
 * Mimics better-sqlite3 prepare().run/get/all for minimal churn in route code.
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const config = require('../config');
const { runMigrations } = require('./migrations');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT DEFAULT '',
  is_verified INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  verification_expires INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('private','group','channel')),
  name TEXT,
  description TEXT DEFAULT '',
  avatar_url TEXT,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT,
  msg_type TEXT NOT NULL DEFAULT 'text' CHECK (msg_type IN ('text','image','file','system')),
  file_name TEXT,
  file_path TEXT,
  file_mime TEXT,
  file_size INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);
`;

/** @type {import('sql.js').Database | null} */
let rawDb = null;
/** @type {ReturnType<typeof wrapDb> | null} */
let wrapped = null;

function persist() {
  if (!rawDb) return;
  const data = rawDb.export();
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.writeFileSync(config.databasePath, Buffer.from(data));
}

function wrapDb(db) {
  return {
    /**
     * @param {string} sql
     */
    prepare(sql) {
      try {
        return {
          run(...params) {
            try {
              if (params.length) db.run(sql, params);
              else db.run(sql);
              // Must read last_insert_rowid BEFORE persist() — sql.js export() resets it to 0.
              let lastInsertRowid = 0;
              if (/^\s*INSERT/i.test(sql)) {
                const r = db.exec('SELECT last_insert_rowid() AS id');
                lastInsertRowid = r[0]?.values[0]?.[0] ?? 0;
              }
              persist();
              return { lastInsertRowid };
            } catch (error) {
              console.error('[DB] Query run error:', { sql, params, error });
              throw new Error(`Database run error: ${error.message}`);
            }
          },
          get(...params) {
            try {
              const stmt = db.prepare(sql);
              try {
                if (params.length) stmt.bind(params);
                if (!stmt.step()) return undefined;
                return stmt.getAsObject();
              } finally {
                stmt.free();
              }
            } catch (error) {
              console.error('[DB] Query get error:', { sql, params, error });
              throw new Error(`Database get error: ${error.message}`);
            }
          },
          all(...params) {
            try {
              const stmt = db.prepare(sql);
              const rows = [];
              try {
                if (params.length) stmt.bind(params);
                while (stmt.step()) {
                  rows.push(stmt.getAsObject());
                }
                return rows;
              } finally {
                stmt.free();
              }
            } catch (error) {
              console.error('[DB] Query all error:', { sql, params, error });
              throw new Error(`Database all error: ${error.message}`);
            }
          },
        };
      } catch (error) {
        console.error('[DB] Prepare error:', { sql, error });
        throw new Error(`Database prepare error: ${error.message}`);
      }
    },
  };
}

/**
 * Load WASM, open file, apply schema. Must run once before getDb().
 */
async function initDb() {
  if (wrapped) return wrapped;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.mkdirSync(config.uploadsPath, { recursive: true });

  const SQL = await initSqlJs();
  const fp = config.databasePath;
  if (fs.existsSync(fp)) {
    const buf = fs.readFileSync(fp);
    rawDb = new SQL.Database(new Uint8Array(buf));
  } else {
    rawDb = new SQL.Database();
  }
  rawDb.run('PRAGMA foreign_keys = ON;');
  rawDb.exec(SCHEMA);
  runMigrations(rawDb);
  persist();
  wrapped = wrapDb(rawDb);
  return wrapped;
}

function getDb() {
  if (!wrapped) {
    throw new Error('Database not initialized — call await initDb() first');
  }
  return wrapped;
}

/**
 * Ensure configured admin usernames always have admin + verified flags in DB.
 */
function seedAdmin() {
  try {
    console.log('[DB] Seeding admin users...');
    const db = getDb();
    const adminNames = config.getAdminUsernames();
    console.log('[DB] Admin usernames:', adminNames);
    
    adminNames.forEach(name => {
      try {
        const result = db.prepare('UPDATE users SET is_admin = 1, is_verified = 1 WHERE lower(username) = ?').run(name);
        console.log(`[DB] Updated admin ${name}:`, result.changes, 'rows affected');
      } catch (error) {
        console.error(`[DB] Failed to update admin ${name}:`, error);
      }
    });
    
    console.log('[DB] Admin seeding completed');
  } catch (error) {
    console.error('[DB] Error in seedAdmin:', error);
  }
}

module.exports = { initDb, getDb, seedAdmin };
