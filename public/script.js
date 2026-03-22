/**
 * TMessage web entry. Optional: window.__TMessage_API_ORIGIN__ = 'https://your-app.onrender.com'
 */
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
