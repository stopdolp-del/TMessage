/**
 * TMessage web entry. Optional: window.__TMessage_API_ORIGIN__ = 'https://your-app.onrender.com'
 */
import { setToken, setRefreshToken } from './js/api.js';

const API_ORIGIN = (() => {
  const o = typeof window !== 'undefined' && window.__TMessage_API_ORIGIN__;
  const s = o != null ? String(o).trim() : '';
  return s ? s.replace(/\/$/, '') : 'https://tmessage.onrender.com';
})();

const REGISTER_URL = `${API_ORIGIN}/api/register`;

function showRegisterMessage(msg) {
  const el = document.getElementById('register-error');
  if (el) el.textContent = msg || '';
}

function setRegisterFormLoading(form, loading) {
  const btn = form?.querySelector?.('button[type="submit"]');
  if (btn) {
    btn.disabled = !!loading;
    btn.dataset.loading = loading ? '1' : '';
  }
}

function onReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}

onReady(() => {
  const form = document.getElementById('form-register');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const usernameInput = form.querySelector('input[name="username"]');
    const passwordInput = form.querySelector('input[name="password"]');

    showRegisterMessage('');
    setRegisterFormLoading(form, true);

    try {
      const res = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: usernameInput?.value ?? '',
          password: passwordInput?.value ?? '',
        }),
      });

      let data = {};
      const raw = await res.text();
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (parseErr) {
          console.error('[TMessage] register: invalid JSON body', parseErr, raw);
        }
      }

      if (!res.ok) {
        const msg =
          data.error ||
          data.details ||
          data.message ||
          `Registration failed (${res.status})`;
        throw new Error(msg);
      }

      if (data.token) setToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);

      showRegisterMessage('Registered successfully');

      const { enterApp } = await import('./js/app.js');
      await enterApp();
    } catch (err) {
      console.error('[TMessage] register', err);
      alert(err?.message || 'Registration failed');
      showRegisterMessage(err?.message || 'Registration failed');
    } finally {
      setRegisterFormLoading(form, false);
    }
  });
});

(async () => {
  try {
    await import('./js/app.js');
  } catch (e) {
    console.error('[TMessage] failed to load app', e);
    const m = document.createElement('p');
    m.style.cssText = 'padding:24px;font-family:system-ui,sans-serif;color:#c00';
    m.textContent = 'TMessage could not start. Open the developer console for details.';
    document.body?.appendChild(m);
  }
})();
