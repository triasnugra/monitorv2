/** Batas waktu keras untuk satu langkah. page.evaluate() Playwright TIDAK punya timeout bawaan. */
export function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(`STEP_TIMEOUT:${label} setelah ${ms}ms`), { code: 'STEP_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export async function withBrowser(fn) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'id-ID', timezoneId: 'UTC' });
    ctx.setDefaultTimeout(30000);
    ctx.setDefaultNavigationTimeout(45000);
    return await fn(ctx);
  } finally {
    await withTimeout(browser.close(), 15000, 'browser.close').catch(() => {});
  }
}

// Dijalankan DI DALAM browser (via page.evaluate). Menunggu DOM diam selama quietMs.
export function waitForDomQuiet({ quietMs, timeoutMs }) {
  return new Promise((resolve) => {
    let last = Date.now(); const start = last;
    const mo = new MutationObserver(() => { last = Date.now(); });
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    const iv = setInterval(() => {
      const now = Date.now();
      if (now - last >= quietMs) { clearInterval(iv); mo.disconnect(); resolve({ stable: true, waitedMs: now - start }); }
      else if (now - start >= timeoutMs) { clearInterval(iv); mo.disconnect(); resolve({ stable: false, waitedMs: now - start }); }
    }, 250);
  });
}
export function readSnapshot() {
  return { text: document.body.innerText, html: document.documentElement.outerHTML };
}
