import fs from 'node:fs';
import { buildRecord } from './normalize.js';
import { parseCryptoCard } from './parsers/crypto.js';
import { parseWebJournalEntry } from './parsers/journal.js';
import { ENGINES, ENGINE_IDS, engineById } from './engines.js';
import { applyLiveScan } from './live.js';
import { splitItems, tagLineage, isHidden } from './lineage.js';
import { mapSourceResult } from './sourceEval.js';
import { parseJournalEntry } from './parsers/tn.js';
import { evaluateSetup, FINAL } from './evaluator/evaluate.js';
import { createBinanceProvider } from './price-data/binance.js';
import { buildDashboard } from './aggregate.js';
import * as store from './storage/store.js';
import { toIso } from './util/time.js';

export const TO_RECORD = {
  crypto: (item, ctx) => buildRecord(parseCryptoCard(item), ctx),
  tn: (item, ctx) => buildRecord(parseJournalEntry(item), ctx),
  // Mesin journal-web: sumber = jurnal yang tampil di halaman. ID dari menit+aset+arah+entry (stabil antar sumber).
  ...Object.fromEntries(ENGINES.filter((e) => e.kind === 'journal-web')
    .map((e) => [e.id, (item, ctx) => buildRecord(parseWebJournalEntry(item, e.id, e.timeframe), ctx)])),
};

const readCfg = (f) => JSON.parse(fs.readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8'));

/**
 * Koleksi satu putaran. scrapeEngine(engine, cfg) -> { status, items, diagnostics }.
 * Semua dependensi diinjeksi agar bisa diuji tanpa jaringan.
 */
export async function collect({ engines = ENGINE_IDS, sources, settings, now = Date.now(), scrapeEngine, toRecord = TO_RECORD, meta }) {
  const nowIso = toIso(now);
  const report = {};
  let setups = store.loadJurnal();   // JURNAL: riwayat semua setup
  const live = store.loadLive();      // SETUP: daftar siap eksekusi saat ini (terpisah)
  const tagged = tagLineage(setups, sources);
  if (tagged) console.log(`Lineage: ${tagged} record lama diberi tanda (v1 turunan disembunyikan dari penilaian).`);
  // Migrasi: record lama yang berasal dari KARTU tnv2 (bukan jurnal) dibuang; jurnal kini sumber resmi.
  const before = setups.length;
  setups = setups.filter((x) => x.rawData?.gate !== 'PASSED_V2');
  if (setups.length !== before) console.log(`Migrasi: ${before - setups.length} record kartu tnv2 lama dibuang (diganti jurnal).`);
  for (const engine of engines) {
    const r = { status: 'FAILED', cards: 0, parsed: 0, added: 0, errors: [], warnings: [], emptyKind: null, httpStatus: null, durationMs: null, forward: null, trackingStarted: false };
    try {
      const firstRun = !meta.trackingStartedUtc[engine];
      const res = await scrapeEngine(engine, sources[engine]);
      r.status = res.status;
      r.cards = res.items.length;
      r.errors = [...res.diagnostics.errors];
      r.warnings = [...res.diagnostics.warnings];
      r.httpStatus = res.diagnostics.httpStatus ?? null;
      r.durationMs = res.diagnostics.durationMs ?? null;
      r.forward = res.diagnostics.forward ?? null;

      r.journal = res.diagnostics.journal ?? null;
      r.live = res.diagnostics.meta?.live ?? res.diagnostics.live ?? null;
      // Jumlah ringkasan halaman bisa mencakup kartu yang ditolak gerbang; bandingkan dengan total kartu, bukan hanya yang lolos.
      const sc = res.diagnostics.meta?.summaryCount;
      const total = res.diagnostics.meta?.totalCards ?? res.items.length;
      if (sc != null && sc !== res.items.length && sc !== total) {
        r.warnings.push(`SUMMARY_COUNT_MISMATCH: halaman melaporkan ${sc}, terbaca ${res.items.length} lolos dari ${total} kartu`);
      }

      // Mesin turunan /tn/: jurnalnya memuat sinyal v1 (tanpa gerbang) yang sama dengan tn. Hanya sinyal milik mesin ini yang dicatat.
      let recordItems = res.items;
      if (engineById(engine)?.kind === 'journal-web') {
        const sp = splitItems(res.items, sources[engine]);
        recordItems = sp.own;
        r.lineage = { own: sp.own.length, inherited: sp.inherited.length, unverified: sp.unverified.length, ownEngineIds: sp.ownEngineIds };
        if (sp.unverified.length) r.warnings.push(`JOURNAL_LINEAGE_UNVERIFIED: ${sp.unverified.length} baris hanya dari tabel (tanpa field engine) tidak dicatat karena asalnya tidak bisa dipastikan.`);
      }
      const records = [];
      for (const item of recordItems) {
        try { const rec = toRecord[engine](item, { scanTimeMs: now, firstRun, sourceUrl: sources[engine].url }); if (sources[engine].inheritedEngineIds?.length) rec.lineage = 'own'; records.push(rec); }
        catch (e) { r.errors.push(`PARSE_ERROR: ${e.message}`.slice(0, 200)); }
      }
      r.parsed = records.length;

      const up = store.upsertSetups(setups, records, nowIso, settings.cancelPatterns);
      setups = up.setups;
      r.added = up.added;

      // SETUP (siap eksekusi): dicatat terpisah dari jurnal. Kartu crypto = kartu itu sendiri; mesin lain = kartu Sinyal setup yang lolos gerbang.
      const lc = engineById(engine)?.kind === 'cards'
        ? { items: res.items, confirmed: res.items.length > 0 || res.status === 'OK_NO_SETUPS', rejected: null }
        : (res.liveCards ?? null);
      const prevLive = live.engines[engine];
      live.engines[engine] = applyLiveScan({
        prev: prevLive, engine, cards: lc?.items, confirmed: !!lc?.confirmed, scanStatus: res.status, nowIso,
        ctx: { scanTimeMs: now, firstRun: false, sourceUrl: sources[engine].url }, jurnal: setups, rejected: lc?.rejected ?? null,
        errors: res.liveDiagnostics?.errors ?? [],
      });
      r.setup = { count: live.engines[engine].items.length, stale: live.engines[engine].stale, rejected: lc?.rejected ?? null };
      if (live.engines[engine].stale) r.warnings.push('SETUP_STALE: daftar setup siap tidak terkonfirmasi pada scan ini; daftar lama dipertahankan.');

      if ((r.status === 'OK' || r.status === 'OK_NO_SETUPS') && firstRun) {
        meta.trackingStartedUtc[engine] = nowIso;
        r.trackingStarted = true;
      }
      r.emptyKind = res.status === 'FAILED' ? 'FETCH_FAILED'
        : res.status === 'NEEDS_SELECTOR_VERIFICATION' ? 'NEEDS_SELECTOR_VERIFICATION'
        : res.items.length === 0 ? (res.status === 'OK_NO_SETUPS' ? 'NO_SETUPS' : 'ZERO_CARDS_UNCONFIRMED')
        : null;

      try {
        store.saveRaw(engine, nowIso, { status: res.status, diagnostics: res.diagnostics, items: res.items }, settings.rawRetentionPerEngine);
      } catch (e) {
        r.warnings.push(`RAW_SAVE_FAILED: ${e.message}`.slice(0, 200)); // tidak mengubah status koleksi
      }
    } catch (e) {
      r.errors.push(`UNEXPECTED: ${e.message}`.slice(0, 200));
      r.emptyKind = 'FETCH_FAILED';
    }
    report[engine] = r;
  }
  store.saveJurnal(setups);
  live.updatedUtc = nowIso;
  store.saveLive(live);
  store.saveMeta(meta);
  return report;
}

export async function evaluateAll({ provider, settings, sources = null, now = Date.now(), reevalFinal = false }) {
  const nowIso = toIso(now);
  const setups = store.loadJurnal();
  if (sources) tagLineage(setups, sources);
  const rep = { checked: 0, changed: 0, errors: [] };
  const audit = [];
  for (const s of setups) {
    if (isHidden(s)) continue;          // salinan v1 turunan tidak dinilai ulang lewat candle
    // NO_TRADE = mesin sendiri menolak sinyal ini lewat filternya (mis. target sudah tercapai sebelum entry): bukan trade, jangan dinilai dari candle.
    if (mapSourceResult(s.sourceResult ?? s.rawData?.hasil).reasonCode === 'SOURCE_NO_TRADE') {
      if (s.evaluation?.reasonCode !== 'SOURCE_NO_TRADE') {
        const why = String(s.rawData?.alasan ?? '').split('FILTER:')[1]?.trim();
        audit.push(...store.applyEvaluation(s, { result: 'CANCELLED', reasonCode: 'SOURCE_NO_TRADE', entryTimeUtc: null, resultTimeUtc: s.analysisTimeUtc, resultTimeSource: 'mesin (NO_TRADE)',
          rMultiple: null, notes: [`Ditolak filter mesin (NO_TRADE)${why ? `: ${why}` : ''}. Tidak dievaluasi dari candle.`], priceDataError: null, evaluatedAtUtc: nowIso }, nowIso));
        rep.changed++;
      }
      continue;
    }
    if (!reevalFinal && FINAL.has(s.evaluation?.result)) continue;
    rep.checked++;
    try {
      const ev = await evaluateSetup(s, provider, { now, cfg: settings });
      const a = store.applyEvaluation(s, ev, nowIso);
      if (a.length) rep.changed++;
      audit.push(...a);
    } catch (e) {
      s.evaluation = { ...(s.evaluation || { result: 'PENDING' }), priceDataError: `${e.code || 'ERROR'}: ${e.message}`.slice(0, 200) };
      if (e.code === 'INVALID_SYMBOL') {
        audit.push(...store.applyEvaluation(s, { result: 'INVALID', reasonCode: 'UNKNOWN_SYMBOL', notes: [e.message], priceDataError: null, evaluatedAtUtc: nowIso }, nowIso));
      }
      rep.errors.push(`${s.setupId}: ${e.message}`.slice(0, 200));
    }
  }
  store.saveJurnal(setups);
  store.appendAudit(audit);
  return rep;
}

export function build({ settings, sources = null, now = Date.now(), siteDataDir = 'site/data' }) {
  const jurnal = store.loadJurnal();
  if (sources) tagLineage(jurnal, sources);
  const dash = buildDashboard({ jurnal, live: store.loadLive(), diagnostics: store.loadDiagnostics(), cfg: settings, nowIso: toIso(now) });
  store.writeJsonAtomic(`${siteDataDir}/dashboard.json`, dash);
  return dash;
}

async function main() {
  const [mode = 'all', ...flags] = process.argv.slice(2);
  const only = flags.find((f) => f.startsWith('--only='))?.split('=')[1];
  const settings = readCfg('settings.json');
  const sources = readCfg('sources.json');
  const engines = only ? only.split(',') : ENGINE_IDS;
  const run = { runAtUtc: toIso(Date.now()), engines: {}, evaluation: null, fatal: null };
  const meta = store.loadMeta();

  if (mode === 'collect' || mode === 'all') {
    const kindOf = (id) => ENGINES.find((e) => e.id === id)?.kind;
    // tn: jurnal dari file JSON, tetapi kartu SETUP-nya tetap dibaca lewat browser.
    const needBrowser = engines.some((id) => ['cards', 'journal-web', 'journal-json'].includes(kindOf(id)));
    const runCollect = (ctx) => collect({
      engines, sources, settings, meta,
      scrapeEngine: async (engine, cfg) => {
        const kind = kindOf(engine);
        const { withTimeout } = await import('./browser/session.js');
        if (kind === 'journal-json') {
          const { scrapeTn } = await import('./scrapers/tn.js');
          const res = await scrapeTn(cfg);
          if (!ctx) return res;
          // Kartu setup siap: kegagalan di sini tidak boleh menggagalkan koleksi jurnal.
          const page = await ctx.newPage();
          try {
            const { scrapeLiveCards } = await import('./scrapers/liveCards.js');
            const lv = await withTimeout(scrapeLiveCards(page, cfg), cfg.engineTimeoutMs ?? 300_000, `engine-${engine}-setup`);
            res.liveCards = lv.liveCards;
            res.liveDiagnostics = lv.diagnostics;
            res.diagnostics.live = lv.liveCards ? { cards: lv.liveCards.items.length + (lv.liveCards.rejected ?? 0), passed: lv.liveCards.items.length, rejected: lv.liveCards.rejected } : null;
            res.diagnostics.warnings.push(...lv.diagnostics.warnings.map((w) => `SETUP: ${w}`));
          } catch (e) {
            res.diagnostics.warnings.push(`SETUP_SCRAPE_FAILED: ${String(e.message).slice(0, 160)}`);
          } finally { await Promise.race([page.close(), new Promise((r) => setTimeout(r, 10_000))]).catch(() => {}); }
          return res;
        }
        const page = await ctx.newPage();
        try {
          const job = kind === 'cards'
            ? import('./scrapers/crypto.js').then((m) => m.scrape(page, cfg))
            : import('./scrapers/journalWeb.js').then((m) => m.scrapeJournalWeb(page, cfg));
          // Satu mesin yang macet tidak boleh menahan mesin lain.
          return await withTimeout(job, cfg.engineTimeoutMs ?? 300_000, `engine-${engine}`);
        } finally { await Promise.race([page.close(), new Promise((r) => setTimeout(r, 10_000))]).catch(() => {}); }
      },
    });
    try {
      if (needBrowser) {
        const { withBrowser } = await import('./browser/session.js');
        run.engines = await withBrowser((ctx) => runCollect(ctx));
      } else {
        run.engines = await runCollect(null);
      }
    } catch (e) {
      run.fatal = `COLLECT_ERROR: ${e.message}`.slice(0, 300);
    }
  }
  if (mode === 'evaluate' || mode === 'all') {
    run.evaluation = await evaluateAll({
      provider: createBinanceProvider({ bases: settings.binanceBaseUrls }),
      settings, sources,
      reevalFinal: flags.includes('--reeval-final'),
    });
  }
  const diag = store.loadDiagnostics();
  diag.runs.push(run);
  store.saveDiagnostics(diag);
  const dash = build({ settings, sources });
  console.log(JSON.stringify({ run, jurnal: dash.counts.jurnal, setupSiap: dash.counts.setupSiap }, null, 2));
  process.exit(0); // kegagalan sudah tercatat di diagnostics; exit 0 agar langkah commit tetap jalan
}

if (process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
