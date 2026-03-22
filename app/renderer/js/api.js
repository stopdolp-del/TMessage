/**
 * REST client: access JWT + refresh token, auto-refresh on 401.
 */
const BASE = () => `${window.location.origin}/api`;

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
  } catch {
    return false;
  }
}

async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  let res = await fetch(`${BASE()}${path}`, { ...opts, headers });
  if (
    res.status === 401 &&
    path !== '/auth/refresh' &&
    path !== '/auth/login' &&
    path !== '/login'
  ) {
    const ok = await tryRefresh();
    if (ok) {
      headers.Authorization = `Bearer ${getToken()}`;
      res = await fetch(`${BASE()}${path}`, { ...opts, headers });
    }
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export { api, getToken, setToken, getRefreshToken, setRefreshToken, BASE };
