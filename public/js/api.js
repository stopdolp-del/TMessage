/**
 * REST: JWT + refresh. API host: same origin or window.__TMessage_API_ORIGIN__ (also accepts legacy __TMessing_API_ORIGIN__).
 */
const DEFAULT_API = 'https://tmessage.onrender.com';

export function apiOrigin() {
  const raw =
    typeof window !== 'undefined'
      ? String(
          window.__TMessage_API_ORIGIN__ ??
            window.__TMessing_API_ORIGIN__ ??
            ''
        ).trim()
      : '';
  if (raw) return raw.replace(/\/$/, '');
  return DEFAULT_API;
}

export function assetBase() {
  return apiOrigin();
}

export const BASE = () => `${apiOrigin()}/api`;

/** Map API JSON + status to a single user-facing message. */
export function formatApiError(status, data) {
  if (data?.error) {
    if (data.details) return `${data.error}: ${data.details}`;
    return data.error;
  }
  if (status === 409) return 'User exists';
  if (status === 400) return 'Invalid data';
  if (status === 401) return 'Invalid credentials';
  return 'Request failed';
}

function getToken() {
  return localStorage.getItem('tm_token');
}

function setToken(t) {
  if (t) localStorage.setItem('tm_token', t);
  else localStorage.removeItem('tm_token');
}

function getRefreshToken() {
  return localStorage.getItem('tm_refresh');
}

function setRefreshToken(t) {
  if (t) localStorage.setItem('tm_refresh', t);
  else localStorage.removeItem('tm_refresh');
}

async function tryRefresh() {
  const r = getRefreshToken();
  if (!r) return false;
  try {
    const res = await fetch(`${BASE()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: r }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setToken(null);
      setRefreshToken(null);
      return false;
    }
    if (data.token) setToken(data.token);
    return true;
  } catch (e) {
    console.error('[TMessage] refresh failed', e);
    return false;
  }
}

const NO_REFRESH_PATHS = new Set([
  '/auth/refresh',
  '/auth/login',
  '/auth/register',
  '/login',
  '/register',
]);

async function api(path, opts = {}) {
  console.log('[API] Request:', path, opts.method || 'GET');
  
  const headers = { ...opts.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${BASE()}${path}`, { ...opts, headers });
    console.log('[API] Response:', path, res.status);
  } catch (e) {
    console.error('[API] Network error:', path, e);
    const err = new Error('Network error — check API URL and connection');
    err.status = 0;
    err.data = {};
    throw err;
  }

  if (res.status === 401 && !NO_REFRESH_PATHS.has(path)) {
    console.log('[API] Attempting token refresh for:', path);
    const ok = await tryRefresh();
    if (ok) {
      headers.Authorization = `Bearer ${getToken()}`;
      try {
        res = await fetch(`${BASE()}${path}`, { ...opts, headers });
        console.log('[API] Refresh retry response:', path, res.status);
      } catch (e) {
        console.error('[API] Network retry error:', path, e);
        throw e;
      }
    }
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseError) {
    console.error('[API] JSON parse error:', path, parseError, 'Raw text:', text);
    data = { raw: text };
  }
  
  if (!res.ok) {
    const msg = formatApiError(res.status, data);
    console.error('[API] API error:', path, res.status, msg, data);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  
  console.log('[API] Success:', path);
  return data;
}

export { api, getToken, setToken, getRefreshToken, setRefreshToken };
