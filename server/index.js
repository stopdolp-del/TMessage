/**
 * TMessage API + static web UI + WebSocket.
 */
/* eslint-disable no-console */
process.on('unhandledRejection', (reason) => {
  console.error('[TMessage] unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[TMessage] uncaughtException', err);
});

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');

const config = require('./config');
const { initDb, seedAdmin } = require('./db/init');
const { handleConnection } = require('./services/wsHub');
const { findFreePort } = require('./utils/port');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const chatsRoutes = require('./routes/chats');
const messagesRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');
const settingsRoutes = require('./routes/settings');
const searchRoutes = require('./routes/search');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/refresh', authLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

const publicPath = path.join(config.root, 'public');
app.use('/uploads', express.static(config.uploadsPath));

app.get('/health', (req, res) => res.json({ ok: true, port: config.port }));

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/search', searchRoutes);
/** Same handlers as /api/auth/* (clients may use /api/register and /api/login). */
app.use('/api', authRoutes);

app.use(express.static(publicPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[TMessage] API error', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws) => handleConnection(ws, wss));

/** Single in-flight start (Electron + require() must not bind twice). */
let startPromise = null;

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('error', onErr);
      reject(err);
    };
    server.once('error', onErr);
    server.listen(port, () => {
      server.removeListener('error', onErr);
      resolve(port);
    });
  });
}

async function start() {
  if (!startPromise) {
    startPromise = (async () => {
      try {
        await initDb();
        seedAdmin();

        let listenPort =
          process.env.TMESSING_AUTO_PORT === '1'
            ? await findFreePort('127.0.0.1')
            : Number(process.env.PORT) || 3000;
        config.setRuntimePort(listenPort);

        try {
          await listenOnce(listenPort);
        } catch (err) {
          if (err.code === 'EADDRINUSE' && process.env.TMESSING_AUTO_PORT !== '1') {
            listenPort = await findFreePort('127.0.0.1');
            config.setRuntimePort(listenPort);
            await listenOnce(listenPort);
          } else {
            throw err;
          }
        }

        console.log(`TMessage server listening on port ${listenPort}`);
        return { server, port: listenPort };
      } catch (e) {
        startPromise = null;
        throw e;
      }
    })();
  }
  return startPromise;
}

if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { app, server, start };
