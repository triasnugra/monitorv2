import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { extractCryptoCards } from '../src/parsers/crypto.js';

// DATA_DIR harus di-set sebelum store.js dievaluasi (dimuat dinamis di bawah).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pipe-'));
process.env.DATA_DIR = path.join(tmp, 'data');
const { collect, evaluateAll, build } = await import('../src/index.js');
const store = await import('../src/storage/store.js');

const html = fs.readFileSync(new URL('./fixtures/crypto-setups.html', import.meta.url), 'utf8');
const journal = JSON.parse(fs.readFileSync(new URL('./fixtures/tn-journal-sample.json', import.meta.url), 'utf8'));
const cryptoItems = extractCryptoCards(parseHTML(html).document).items;

const settings = { cancelPatterns: ['batal', 'cancel'], rawRetentionPerEngine: 3, entryTtlHours: 72, maxHoldDays: 30,
  sanityMaxDeviation: 0.5, minSamplePerEngine: 30, bootstrapIterations: 200, pairWindowMinutes: 120,
  cluster: { windowHours: 24, entryTolerance: 0.01 }, binanceBaseUrls: [] };
const sources = { crypto: { url: 'https://example.invalid/crypto/' }, tn: { url: 'https://example.invalid/tn/' } };

const T1 = Date.parse('2026-10-16T06:00:00Z');
const T2 = T1 + 30 * 60e3;
const T3 = T2 + 30 * 60e3;

/** Scraper palsu: mengembalikan item yang sama seperti hasil scraper asli (fixture). */
function fake({ crypto, tn }) {
  return async (engine) => {
    if (engine === 'crypto') return crypto ?? { status: 'OK', items: cryptoItems.map((c) => structuredClone(c)),
      diagnostics: { errors: [], warnings: [], httpStatus: null, durationMs: 1, meta: { summaryCount: 30, confirmedEmpty: false } } };
    return tn ?? { status: 'OK', items: journal, diagnostics: { errors: [], warnings: [], httpStatus: 200, durationMs: 1, forward: null } };
  };
}
const freshMeta = () => ({ trackingStartedUtc: {} });

test('putaran pertama: setup Mesin 1 yang sudah ada ditandai tidak diketahui waktunya; Mesin 2 memakai waktu sumber', async () => {
  const meta = freshMeta();
  const rep = await collect({ sources, settings, now: T1, scrapeEngine: fake({}), meta });
  assert.equal(rep.crypto.added, 30);
  assert.equal(rep.tn.added, journal.length);
  const setups = store.loadSetups();
  assert.equal(setups.filter((s) => s.engine === 'crypto' && s.analysisTimeSource === 'unknown_before_tracking').length, 30);
  assert.equal(setups.filter((s) => s.engine === 'tn' && s.analysisTimeSource === 'source').length, journal.length);
  assert.ok(meta.trackingStartedUtc.crypto && meta.trackingStartedUtc.tn);
  assert.equal(store.loadMeta().trackingStartedUtc.crypto, meta.trackingStartedUtc.crypto);
});

test('putaran berulang tidak membuat duplikat (idempoten) dan tidak menghapus histori', async () => {
  const meta = store.loadMeta();
  const before = store.loadSetups().length;
  const rep = await collect({ sources, settings, now: T2, scrapeEngine: fake({}), meta });
  assert.equal(rep.crypto.added, 0);
  assert.equal(rep.tn.added, 0);
  assert.equal(store.loadSetups().length, before);
  assert.equal(store.loadSetups().find((s) => s.engine === 'crypto').seenCount, 2);
});

test('setup Mesin 1 baru setelah pelacakan dimulai: waktu = perkiraan (first_seen)', async () => {
  const meta = store.loadMeta();
  const changed = structuredClone(cryptoItems[0]);
  changed.rows[0].value = '11.700'; // level berbeda -> ID berbeda
  const crypto = { status: 'OK', items: [changed, ...cryptoItems.slice(1).map((c) => structuredClone(c))],
    diagnostics: { errors: [], warnings: [], httpStatus: null, durationMs: 1, meta: { summaryCount: 30, confirmedEmpty: false } } };
  const rep = await collect({ sources, settings, now: T3, scrapeEngine: fake({ crypto }), meta });
  assert.equal(rep.crypto.added, 1);
  const newOne = store.loadSetups().find((s) => s.engine === 'crypto' && s.entryPrice === 11.7);
  assert.equal(newOne.analysisTimeSource, 'first_seen');
  assert.equal(newOne.analysisTimeUtc, new Date(T3).toISOString());
});

test('scrape gagal tidak menghapus setup dan tidak mengaktifkan ulang pelacakan', async () => {
  const meta = store.loadMeta();
  const before = store.loadSetups().length;
  const started = meta.trackingStartedUtc.crypto;
  const crypto = { status: 'FAILED', items: [], diagnostics: { errors: ['HTTP_503'], warnings: [], httpStatus: 503, durationMs: 1, meta: null } };
  const rep = await collect({ sources, settings, now: T3 + 3600e3, scrapeEngine: fake({ crypto }), meta });
  assert.equal(rep.crypto.emptyKind, 'FETCH_FAILED');
  assert.equal(store.loadSetups().length, before);
  assert.equal(store.loadMeta().trackingStartedUtc.crypto, started);
});

test('jumlah kartu tidak sama dengan ringkasan halaman -> peringatan SUMMARY_COUNT_MISMATCH', async () => {
  const meta = store.loadMeta();
  const crypto = { status: 'OK', items: cryptoItems.slice(0, 29).map((c) => structuredClone(c)),
    diagnostics: { errors: [], warnings: [], httpStatus: null, durationMs: 1, meta: { summaryCount: 30, confirmedEmpty: false } } };
  const rep = await collect({ sources, settings, now: T3 + 7200e3, scrapeEngine: fake({ crypto }), meta });
  assert.ok(rep.crypto.warnings.some((w) => w.startsWith('SUMMARY_COUNT_MISMATCH')));
});

test('evaluasi: setup tanpa waktu analisis tidak dievaluasi (INVALID), setup lain diproses', async () => {
  const provider = { getCandles: async () => [] };
  await evaluateAll({ provider, settings, now: T3 + 4 * 3600e3 });
  const setups = store.loadSetups();
  const unknown = setups.filter((s) => s.analysisTimeSource === 'unknown_before_tracking');
  assert.equal(unknown.length, 30);
  assert.ok(unknown.every((s) => s.evaluation.result === 'INVALID' && s.evaluation.reasonCode === 'ANALYSIS_TIME_UNKNOWN'));
  const tn = setups.find((s) => s.engine === 'tn' && s.evaluation?.result);
  assert.ok(tn, 'setup Mesin 2 harus ter-evaluasi');
  assert.notEqual(tn.evaluation.result, 'INVALID');
});

test('dashboard: setup waktu-tidak-diketahui masuk Data Quality; sumber dibandingkan dengan evaluasi', async () => {
  const outDir = path.join(tmp, 'site');
  const dash = build({ settings, now: T3 + 4 * 3600e3, siteDataDir: outDir });
  assert.equal(dash.quality.unknownAnalysisTime.length, 30);
  assert.ok(Array.isArray(dash.quality.sourceDisagreements));
  assert.ok(fs.existsSync(path.join(outDir, 'dashboard.json')));
});
