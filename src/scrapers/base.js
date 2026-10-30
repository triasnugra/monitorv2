import { waitForDomQuiet, readSnapshot, withTimeout } from '../browser/session.js';

/**
 * Scraper berbasis browser. `extract` adalah fungsi mandiri yang dijalankan di dalam halaman
 * dan harus mengembalikan { items, meta }. Jika extract tidak diberikan, status
 * NEEDS_SELECTOR_VERIFICATION (tidak menebak selector).
 *
 * Status:
 *  OK                           item terbaca (>0)
 *  OK_NO_SETUPS                 scan selesai dan 0 setup terkonfirmasi
 *  ZERO_CARDS_UNCONFIRMED       0 item, tetapi "tidak ada setup" tidak bisa dibuktikan
 *  NEEDS_SELECTOR_VERIFICATION  extractor belum tersedia
 *  FAILED                       HTTP error / timeout / scan tidak terpicu / error lain
 */
export async function runScrape(page, cfg, extract, extractArg) {
  const t0 = Date.now();
  const diag = { httpStatus: null, jsErrors: [], failedRequests: [], errors: [], warnings: [], stable: null, cardCount: 0, durationMs: 0, meta: null };
  const out = (status, extra = {}) => { diag.durationMs = Date.now() - t0; return { status, items: [], snapshot: null, diagnostics: diag, ...extra }; };

  page.on('pageerror', (e) => diag.jsErrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => diag.failedRequests.push(r.url().slice(0, 200)));

  try {
    const resp = await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: cfg.gotoTimeoutMs });
    diag.httpStatus = resp?.status?.() ?? null;
    if (diag.httpStatus >= 400) { diag.errors.push(`HTTP_${diag.httpStatus}`); return out('FAILED'); }
  } catch (e) {
    diag.errors.push(`GOTO_${/timeout/i.test(e.message) ? 'TIMEOUT' : 'ERROR'}: ${e.message.slice(0, 200)}`);
    return out('FAILED');
  }

  let triggered = false;
  try {
    await page.getByText(cfg.scanButtonText, { exact: true }).first().click({ timeout: 10000 });
    triggered = true;
  } catch {
    diag.warnings.push(`Tombol '${cfg.scanButtonText}' tidak ditemukan/tidak bisa diklik; mengandalkan pemindaian saat load.`);
  }

  try {
    const grace = cfg.stepGraceMs ?? 15000;
    const q = await withTimeout(page.evaluate(waitForDomQuiet, { quietMs: cfg.quietMs, timeoutMs: cfg.scanTimeoutMs }), cfg.scanTimeoutMs + grace, 'wait-dom');
    diag.stable = q.stable;
    if (!q.stable) diag.warnings.push('DOM belum stabil sampai batas waktu scan.');
  } catch (e) {
    diag.errors.push(e.code === 'STEP_TIMEOUT' ? `SCAN_TIMEOUT: ${e.message}` : `WAIT_ERROR: ${e.message.slice(0, 200)}`);
    return out('FAILED');
  }

  let snapshot;
  try { snapshot = await withTimeout(page.evaluate(readSnapshot), cfg.stepGraceMs ?? 20000, 'snapshot'); }
  catch (e) { diag.errors.push(`SNAPSHOT_ERROR: ${e.message.slice(0, 200)}`); return out('FAILED'); }

  if (!extract) {
    diag.warnings.push('Extractor belum tersedia untuk sumber ini.');
    return out('NEEDS_SELECTOR_VERIFICATION', { snapshot });
  }

  let res;
  try { res = await withTimeout(page.evaluate(extract, extractArg), cfg.stepGraceMs ?? 30000, 'extract'); }
  catch (e) { diag.errors.push(`EXTRACT_ERROR: ${e.message.slice(0, 200)}`); return out('FAILED', { snapshot }); }

  const items = Array.isArray(res?.items) ? res.items : [];
  diag.meta = res?.meta ?? null;
  diag.cardCount = items.length;

  if (items.length > 0) return out('OK', { items });
  if (!triggered && diag.stable === false) { diag.errors.push('SCAN_NOT_CONFIRMED'); return out('FAILED', { snapshot }); }
  if ((cfg.noSetupMarkerText && snapshot.text.includes(cfg.noSetupMarkerText)) || diag.meta?.confirmedEmpty === true) {
    return out('OK_NO_SETUPS', { snapshot });
  }
  return out('ZERO_CARDS_UNCONFIRMED', { snapshot });
}
