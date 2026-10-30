// tn: membaca data/journal.json (JSON publik yang juga dimuat halaman /tn/). Tanpa browser.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, cfg, fetchImpl) {
  let lastErr;
  for (let i = 0; i < (cfg.retries ?? 3); i++) {
    try {
      const sep = url.includes('?') ? '&' : '?';
      const res = await fetchImpl(`${url}${sep}_=${Date.now()}`, {
        signal: AbortSignal.timeout(cfg.fetchTimeoutMs ?? 30000),
        headers: { 'cache-control': 'no-cache' },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP_${res.status}`);
        lastErr.status = res.status;
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000 * 2 ** i);
  }
  throw lastErr;
}

export async function scrapeTn(cfg, fetchImpl = globalThis.fetch) {
  const t0 = Date.now();
  const diag = { httpStatus: null, errors: [], warnings: [], durationMs: 0, source: cfg.journalUrl, forward: null, meta: null };
  const out = (status, items = []) => { diag.durationMs = Date.now() - t0; return { status, items, diagnostics: diag }; };

  let journal;
  try {
    journal = await getJson(cfg.journalUrl, cfg, fetchImpl);
  } catch (e) {
    diag.httpStatus = e.status ?? null;
    diag.errors.push(`JOURNAL_${e.status ? `HTTP_${e.status}` : 'FETCH_ERROR'}: ${String(e.message).slice(0, 200)}`);
    return out('FAILED');
  }
  if (!Array.isArray(journal)) {
    diag.httpStatus = 200;
    diag.errors.push('JOURNAL_NOT_ARRAY');
    return out('FAILED');
  }
  diag.httpStatus = 200;

  // Ringkasan forward-test: hanya untuk diagnostik. Gagal di sini tidak menggagalkan koleksi.
  try {
    const f = await getJson(cfg.forwardReportUrl, { ...cfg, retries: 1 }, fetchImpl);
    diag.forward = { ready: f.ready ?? null, locked: f.locked ?? null, counts: f.counts ?? null, dibuat: f.dibuat ?? null };
  } catch (e) {
    diag.warnings.push(`FORWARD_REPORT_UNAVAILABLE: ${String(e.message).slice(0, 120)}`);
  }
  return out(journal.length === 0 ? 'OK_NO_SETUPS' : 'OK', journal);
}
