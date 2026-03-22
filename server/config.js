/**
 * Central configuration loaded from environment variables.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');

/**
 * When Electron sets TMESSING_USER_DATA (app.getPath('userData')), DB and uploads live there
 * so the app works when installed under Program Files (writable user folder).
 */
function resolveDatabasePath() {
  if (process.env.TMESSING_USER_DATA) {
    return path.join(process.env.TMESSING_USER_DATA, 'tmessing.db');
  }
  return path.join(ROOT, 'database', 'tmessing.db');
}

function resolveUploadsPath() {
  if (process.env.TMESSING_USER_DATA) {
    return path.join(process.env.TMESSING_USER_DATA, 'uploads');
  }
  return path.join(ROOT, 'uploads');
}

/** Set after HTTP server listens (dynamic port). */
let runtimePort = Number(process.env.PORT) || 3000;

function setRuntimePort(p) {
  runtimePort = p;
  process.env.TMESSING_PUBLIC_PORT = String(p);
}

module.exports = {
  get port() {
    return runtimePort;
  },
  setRuntimePort,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  nodeEnv: process.env.NODE_ENV || 'development',
  /** First account with this username becomes admin (case-insensitive). */
  adminUsername: (process.env.ADMIN_USERNAME || 'stopdolp').toLowerCase(),
  databasePath: resolveDatabasePath(),
  uploadsPath: resolveUploadsPath(),
  root: ROOT,
};
