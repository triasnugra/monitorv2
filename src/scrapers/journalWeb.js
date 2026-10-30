import { waitForDomQuiet, withTimeout } from '../browser/session.js';
import { readJournalTable, rowsToEntries, entryKey, num } from '../parsers/journal.js';
import { extractTnv2Cards } from '../parsers/tnv2.js';

/*
 * Mesin journal-web: halaman dibuka di browser, tombol scan ditekan, lalu JURNAL yang tampil di halaman dibaca.
 * Sumber data (urut prioritas):
 *   1. JSON jurnal yang dimuat halaman itu sendiri (ditangkap dari jaringan; tidak menebak URL),
 *      dengan `hasil`/`R` DITIMPA oleh yang tertampil di tabel jurnal bila berbeda (tabel = apa yang dilihat pengguna).
 *   2. Tabel jurnal di DOM (header aset/arah/entry/sl/tp/hasil), bila JSON tidak tertangkap.
 * Baris yang hanya ada di tabel ditambahkan juga. Kartu "Sinyal setup" tidak dicatat (hanya diagnostik).
 */
const looksLikeEntry = (e) => e && typeof e === 'object' && ('aset' in e) && ('arah' in e) && ('entry' in e);

export function pickJournalArray(body) {
  if (Array.isArray(body)) return body.length && body.every(looksLikeEntry) ? body : (body.some(looksLikeEntry) ? body.filter(looksLikeEntry) : null);
  if (body && typeof body === 'object') {
    for (const v of Object.values(body)) { const a = pickJournalArray(v); if (a) return a; }
  }
  return null;
}
const normHasil = (h) => String(h ?? '').trim().toLowerCase();
const sameR = (a, b) => (num(a) ?? null) === (num(b) ?? null);

/** Gabungkan entri JSON dan entri tabel (fungsi murni; diuji tanpa browser). */
export function mergeJournal(jsonEntries, domEntries) {
  const stats = { jsonRows: jsonEntries?.length ?? 0, domRows: domEntries?.length ?? 0, domOnly: 0, jsonOnly: 0, hasilOverridden: 0 };
  if (!jsonEntries?.length) return { items: domEntries.map((e) => ({ ...e, _src: 'dom' })), stats };
  const dom = new Map(domEntries.map((e) => [entryKey(e), e]));
  const seen = new Set();
  const items = jsonEntries.map((j) => {
    const k = entryKey(j);
    const d = dom.get(k);
    seen.add(k);
    if (!d) { stats.jsonOnly++; return { ...j, _src: 'json' }; }
    const hasilDiff = normHasil(d.hasil) !== normHasil(j.hasil);
    if (hasilDiff) stats.hasilOverridden++;
    // Tabel = yang dilihat pengguna: hasil dan R dari tabel dipakai bila berbeda dari JSON.
    if (hasilDiff || (d.R !== '' && !sameR(d.R, j.R))) {
      return { ...j, hasil: d.hasil ?? j.hasil, R: d.R, _src: 'json+dom', ...(hasilDiff ? { _jsonHasil: j.hasil ?? null } : {}) };
    }
    return { ...j, _src: 'json+dom' };
  });
  for (const d of domEntries) if (!seen.has(entryKey(d))) { stats.domOnly++; items.push({ ...d, _src: 'dom' }); }
  return { items, stats };
}

export async function scrapeJournalWeb(page, cfg) {
  const t0 = Date.now();
  const diag = { httpStatus: null, jsErrors: [], failedRequests: [], errors: [], warnings: [], stable: null, durationMs: 0, meta: null, journal: null };
  let liveCards = null; // kartu "Sinyal setup" yang lolos gerbang -> tab Setup (dicatat terpisah dari jurnal)
  const out = (status, items = []) => { diag.durationMs = Date.now() - t0; return { status, items, liveCards, diagnostics: diag }; };
  const captured = [];

  page.on('pageerror', (e) => diag.jsErrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => diag.failedRequests.push(r.url().slice(0, 200)));
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (/binance|coingecko|coinpaprika/i.test(u)) return;
      if (!/\.json(\?|$)/i.test(u) && !/journal|jurnal/i.test(u) && !/json/i.test(r.headers()['content-type'] || '')) return;
      const arr = pickJournalArray(await withTimeout(r.json(), 8000, 'resp-json'));
      if (arr) captured.push({ url: u.slice(0, 200), arr });
    } catch { /* bukan jurnal */ }
  });

  try {
    const resp = await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: cfg.gotoTimeoutMs ?? 45000 });
    diag.httpStatus = resp?.status?.() ?? null;
    if (diag.httpStatus >= 400) { diag.errors.push(`HTTP_${diag.httpStatus}`); return out('FAILED'); }
  } catch (e) {
    diag.errors.push(`GOTO_${/timeout/i.test(e.message) ? 'TIMEOUT' : 'ERROR'}: ${e.message.slice(0, 200)}`);
    return out('FAILED');
  }

  let triggered = false;
  try {
    const btn = page.locator(cfg.scanSelector ?? '#go, button:has-text("Scan ulang"), button:has-text("Pindai ulang")').first();
    await btn.click({ timeout: 10000 });
    triggered = true;
  } catch { diag.warnings.push('Tombol scan tidak ditemukan/tidak bisa diklik; mengandalkan pemindaian saat load.'); }

  try {
    const grace = cfg.stepGraceMs ?? 15000;
    const q = await withTimeout(page.evaluate(waitForDomQuiet, { quietMs: cfg.quietMs ?? 4000, timeoutMs: cfg.scanTimeoutMs ?? 120000 }), (cfg.scanTimeoutMs ?? 120000) + grace, 'wait-dom');
    diag.stable = q.stable;
    if (!q.stable) diag.warnings.push('DOM belum stabil sampai batas waktu scan.');
  } catch (e) {
    diag.errors.push(e.code === 'STEP_TIMEOUT' ? `SCAN_TIMEOUT: ${e.message}` : `WAIT_ERROR: ${e.message.slice(0, 200)}`);
    return out('FAILED');
  }

  // Tabel jurnal dimuat async ("Memuat jurnal…"): tunggu sampai tabel ber-header aset muncul.
  let tableSeen = true;
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('table')].some((t) => {
      const th = [...t.querySelectorAll('th')].map((x) => (x.textContent || '').trim().toLowerCase());
      return th.some((x) => ['aset', 'koin', 'coin', 'ticker', 'pair', 'simbol', 'symbol'].includes(x)) && th.includes('sl');
    }), null, { timeout: cfg.journalWaitMs ?? 30000 });
  } catch { tableSeen = false; }

  let tables = [];
  try { tables = await withTimeout(page.evaluate(readJournalTable), cfg.stepGraceMs ?? 30000, 'read-journal'); }
  catch (e) { diag.errors.push(`JOURNAL_DOM_ERROR: ${e.message.slice(0, 200)}`); }
  const domBest = tables.map((t) => ({ t, entries: rowsToEntries(t) })).sort((a, b) => b.entries.length - a.entries.length)[0];
  const domEntries = domBest?.entries ?? [];
  const jsonBest = [...captured].sort((a, b) => (/journal|jurnal/i.test(b.url) - /journal|jurnal/i.test(a.url)) || b.arr.length - a.arr.length)[0];

  // Kartu "Sinyal setup" yang LOLOS gerbang = daftar SETUP siap eksekusi (data/setup.json), terpisah dari jurnal.
  // Daftar kosong hanya dianggap terkonfirmasi bila halaman memang menampilkan kartu (semua ditolak) atau ringkasan "Selesai: 0".
  let live = null;
  try {
    const g = await withTimeout(page.evaluate(extractTnv2Cards, cfg.gate ?? {}), cfg.stepGraceMs ?? 30000, 'live-cards');
    live = { cards: g.meta.totalCards, passed: g.meta.passedCount, rejected: g.meta.rejectedCount, summary: g.meta.summaryText };
    liveCards = { items: g.items, confirmed: g.items.length > 0 || g.meta.totalCards > 0 || g.meta.confirmedEmpty === true, rejected: g.meta.rejectedCount };
  } catch (e) { diag.warnings.push(`LIVE_CARDS_ERROR: ${String(e.message).slice(0, 160)}`); }

  const { items, stats } = mergeJournal(jsonBest?.arr ?? null, domEntries);
  diag.journal = { ...stats, jsonUrl: jsonBest?.url ?? null, tableId: domBest?.t?.id ?? null, tableSeen, tables: tables.length };
  diag.meta = { live, summaryCount: null, totalCards: items.length };
  if (jsonBest && stats.domRows && stats.jsonRows !== stats.domRows) {
    diag.warnings.push(`JOURNAL_COUNT_DIFF: JSON ${stats.jsonRows} baris, tabel ${stats.domRows} baris (tabel bisa membatasi tampilan).`);
  }
  if (stats.hasilOverridden) diag.warnings.push(`JOURNAL_HASIL_OVERRIDDEN: ${stats.hasilOverridden} baris memakai hasil dari tabel (berbeda dari JSON).`);
  if (stats.domOnly) diag.warnings.push(`JOURNAL_DOM_ONLY: ${stats.domOnly} baris hanya ada di tabel.`);

  if (items.length) return out('OK', items);
  if (domBest && !domEntries.length) return out('OK_NO_SETUPS');          // tabel ada, 0 baris
  if (!tableSeen && !jsonBest) { diag.warnings.push('Tabel jurnal tidak ditemukan dan tidak ada JSON jurnal tertangkap. Jalankan Discover.'); return out('NEEDS_SELECTOR_VERIFICATION'); }
  return out(triggered ? 'ZERO_CARDS_UNCONFIRMED' : 'FAILED');
}
