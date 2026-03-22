/**
 * TMessage web entry — API: https://tmessage.onrender.com/api
 */
import { setToken, setRefreshToken } from './js/api.js';

const API_ORIGIN = (() => {
  const o = typeof window !== 'undefined' && window.__TMessage_API_ORIGIN__;
  const s = o != null ? String(o).trim() : '';
  return s ? s.replace(/\/$/, '') : 'https://tmessage.onrender.com';
})();

const REGISTER_URL = `${API_ORIGIN}/api/register`;
const CAPTCHA_URL = `${API_ORIGIN}/api/register/captcha`;

async function loadRegisterCaptcha() {
  const qEl = document.getElementById('register-captcha-q');
  const idEl = document.getElementById('register-captcha-id');
  const ansEl = document.getElementById('register-captcha-answer');
  if (!qEl || !idEl) return;
  qEl.textContent = 'Loading…';
  try {
    const res = await fetch(CAPTCHA_URL);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.details || `Captcha failed (${res.status})`);
    idEl.value = data.id || '';
    qEl.textContent = data.question || 'Answer below';
    if (ansEl) ansEl.value = '';
  } catch (e) {
    console.error('[TMessage] captcha', e);
    qEl.textContent = 'Could not load. Tap “New question”.';
  }
}

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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

onReady(() => {
  const form = document.getElementById('form-register');
  if (!form) return;

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.getAttribute('data-tab') === 'register') loadRegisterCaptcha();
    });
  });

  document.getElementById('btn-captcha-refresh')?.addEventListener('click', () => loadRegisterCaptcha());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const usernameInput = form.querySelector('input[name="username"]');
    const passwordInput = form.querySelector('input[name="password"]');
    const captchaId = document.getElementById('register-captcha-id')?.value || '';
    const captchaAnswer = document.getElementById('register-captcha-answer')?.value ?? '';

    showRegisterMessage('');
    setRegisterFormLoading(form, true);

    try {
      const res = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: usernameInput?.value ?? '',
          password: passwordInput?.value ?? '',
          captchaId,
          captchaAnswer,
        }),
      });

      let data = {};
      const raw = await res.text();
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error('[TMessage] register JSON', e);
        }
      }

      if (!res.ok) {
        throw new Error(data.error || data.details || data.message || `Registration failed (${res.status})`);
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
      await loadRegisterCaptcha();
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
