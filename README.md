# TMessing

Telegram-style desktop messenger: **Electron** + **Express** + **WebSocket** + **SQLite** (sql.js — no native compiler on Windows).

## Highlights

- **Auth:** Username/password, short-lived JWT access + refresh sessions (bcrypt + SQLite)
- **Chats:** Private, groups (roles), channels (broadcast-only posting)
- **Messages:** Replies, forwards, edit, delete, reactions (👍❤️🔥…), delivery/read ticks (✓ / ✓✓)
- **Media:** Images, video, audio/voice notes, files; drag-and-drop; previews
- **Realtime:** WebSocket + typing with username, presence, heartbeat last-seen
- **Calls:** WebRTC voice + video (STUN; add TURN for production)
- **UI:** Dark/light theme, emoji picker, global search (users + messages), settings (notifications, privacy)
- **Admin:** Ban/unban, delete messages/chats; first matching `ADMIN_USERNAME` (default `stopdolp`) is promoted on startup
- **Security:** Validation, rate limits, refresh token hashing (SHA-256), `X-Powered-By` disabled
- **Electron:** Backend starts automatically; **auto free port** (no fixed `:3000` conflict)

## Layout

| Path | Purpose |
|------|---------|
| `app/` | Electron shell + `renderer/` SPA |
| `server/` | API, `services/`, `routes/`, `db/` migrations |
| `database/` | `tmessing.db` when not using Electron userData |
| `uploads/` | Media and avatars |

## Install

```bash
copy .env.example .env
npm install
```

Set `JWT_SECRET` and optional `ADMIN_USERNAME`. The Electron app picks a free port automatically (`TMESSING_AUTO_PORT`).

## Run

**Electron (recommended — embeds API + picks a free port):**

```bash
npm run dev
```

**API only (CLI / browser at `http://127.0.0.1:3000` or `PORT` env):**

```bash
npm start
```

Do **not** run `npm start` and `npm run dev` at the same time (both would try to bind a port).

## Build Windows installer

```bash
npm run build:win
```

Output under `dist/`. Packaged app stores DB/uploads under `%APPDATA%` (Electron `userData`).

## API notes

- Access token TTL ~15m; client refreshes via `POST /api/auth/refresh` with `refreshToken`.
- `GET /api/health` returns `{ ok, port }`.
- Search: `GET /api/search?q=&scope=all|users|messages&chatId=` (optional).

## Upgrade notes (from earlier TMessing)

1. Pull changes; `npm install`.
2. Delete `database/tmessing.db` only if you accept a reset (otherwise migrations add new tables/columns).
3. Restart the app; Electron will use a free port automatically.

## License

MIT
