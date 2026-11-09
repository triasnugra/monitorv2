import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildDashboard } from '../src/aggregate.js';

// site/live-overlay.js adalah skrip klasik (dimuat browser); di sini dimuat lewat vm.
const load = () => {
  const ctx = { module: { exports: {} }, console };
  ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../site/live-overlay.js', import.meta.url), 'utf8'), ctx);
  return ctx.module.exports;
};
const LO = load();

const row = (o = {}) => ({
  id: 'tnv2-1', engine: 'tnv2', ticker: 'SOL', direction: 'SHORT', entry: 95, tp: [86.834], sl: 99.083,
  analysisUtc: '2026-11-04T03:58:47.770Z', readyEver: false, hasSource: true,
  resultSrc: 'PENDING', sourceHasil: 'menunggu', rSrc: null, execSrc: 'MENUNGGU', accSrc: null, ...o,
});
const dash = (rows) => ({
  engineIds: ['tnv2'], liveSources: { tnv2: { url: 'https://x/tnv2/data/journal.json', inheritedEngineIds: ['v1hash'], legacyWithoutEngine: 'inherited' } },
  jurnal: rows, jurnalStats: { source: {} }, live: { engines: {} },
});
const entry = (o = {}) => ({ waktu: '2026-11-04 03:58 UTC', t: 1793764727773, aset: 'SOL', arah: 'SHORT', entry: 95, sl: 99.083, tp: 86.834, hasil: 'TP', R: 2, engine: 'v2hash', tx: 1794171600000, ...o });

test('baris PENDING menjadi TP dari jurnal mesin (WIB, R, terpakai, akurat)', () => {
  const D = dash([row()]);
  const r = LO.applyLive(D, { tnv2: [entry()] });
  assert.equal(r.changed, 1);
  const x = D.jurnal[0];
  assert.equal(x.resultSrc, 'TP'); assert.equal(x.rSrc, 2); assert.equal(x.execSrc, 'TERPAKAI'); assert.equal(x.accSrc, 'AKURAT');
  assert.equal(x.resultSrcWib, '2026-11-09 04:00'); assert.equal(x.liveUpdated, true);
  assert.equal(D.jurnalStats.source.tnv2.semua.tp, 1);
});

test('salinan v1 (engine turunan) tidak dipakai, hanya sinyal milik mesin', () => {
  const D = dash([row()]);
  const r = LO.applyLive(D, { tnv2: [entry({ engine: 'v1hash', hasil: 'SL', R: -1 })] });
  assert.equal(r.changed, 0); assert.equal(D.jurnal[0].resultSrc, 'PENDING');
});

test('hasil final tidak pernah ditimpa; menunggu tetap menunggu', () => {
  const D = dash([row({ resultSrc: 'SL', execSrc: 'TERPAKAI', accSrc: 'MELESET' }), row({ id: 'b', ticker: 'ETH' })]);
  const r = LO.applyLive(D, { tnv2: [entry(), entry({ aset: 'ETH', hasil: 'menunggu', R: '' })] });
  assert.equal(r.changed, 0); assert.equal(D.jurnal[0].resultSrc, 'SL'); assert.equal(D.jurnal[1].resultSrc, 'PENDING');
});

test('tidak terisi / kedaluwarsa -> EXPIRED tidak terpakai; entry beda tidak cocok', () => {
  const D = dash([row(), row({ id: 'c', entry: 96 })]);
  LO.applyLive(D, { tnv2: [entry({ hasil: 'tidak terisi', R: 0 })] });
  assert.equal(D.jurnal[0].resultSrc, 'EXPIRED'); assert.equal(D.jurnal[0].execSrc, 'TIDAK_TERPAKAI');
  assert.equal(D.jurnal[1].resultSrc, 'PENDING');
});

test('SL memakai R -1 dan jurnal yang gagal diambil diabaikan', async () => {
  const D = dash([row()]);
  const r = await LO.loadLive(D, async () => { throw new Error('offline'); });
  assert.deepEqual([...r.failed], ['tnv2']); assert.equal(r.changed, 0);
  const ok = await LO.loadLive(D, async () => ({ ok: true, json: async () => [entry({ hasil: 'SL', R: -1 })] }));
  assert.equal(D.jurnal[0].resultSrc, 'SL'); assert.equal(D.jurnal[0].rSrc, -1); assert.equal(ok.changed, 1);
});

test('buildDashboard memberi liveSources (journalUrl > JSON tertangkap > turunan dari url; crypto dilewati)', () => {
  const sources = {
    crypto: { url: 'https://a/crypto/' }, tn: { url: 'https://a/tn/', journalUrl: 'https://a/tn/data/journal.json' },
    tnv2: { url: 'https://a/tnv2/', inheritedEngineIds: ['h'], legacyWithoutEngine: 'inherited' }, grox: { url: 'https://a/grox/' },
  };
  const diagnostics = { runs: [{ engines: { grox: { journal: { jsonUrl: 'https://a/grox/data/jurnal.json?_=123' } } } }] };
  const d = buildDashboard({ jurnal: [], live: null, diagnostics, cfg: { cluster: { windowHours: 24, entryTolerance: 0.01 }, minSamplePerEngine: 30, bootstrapIterations: 10, pairWindowMinutes: 120 }, nowIso: '2026-11-09T00:00:00Z', sources });
  assert.equal(d.liveSources.crypto, undefined);
  assert.equal(d.liveSources.tn.url, 'https://a/tn/data/journal.json');
  assert.equal(d.liveSources.tnv2.url, 'https://a/tnv2/data/journal.json');
  assert.deepEqual(d.liveSources.tnv2.inheritedEngineIds, ['h']);
  assert.equal(d.liveSources.grox.url, 'https://a/grox/data/jurnal.json');
});

test('build tidak berhenti bila evaluasi TP/SL kehilangan resultTimeUtc (data rusak)', async () => {
  const { periodStats, summarize } = await import('../src/statistics/stats.js');
  const bad = { setupId: 'x', analysisTimeUtc: '2026-11-01T00:00:00Z', evaluation: { result: 'SL', rMultiple: null, resultTimeUtc: null, evaluatedAtUtc: '2026-11-05T07:39:55Z' } };
  assert.doesNotThrow(() => periodStats([bad], 'daily'));
  assert.equal(periodStats([bad], 'daily')[0].period, '2026-11-05');
  assert.doesNotThrow(() => summarize([bad]));
});

test('upsert: record yang dulu terbaca salinan v1 menjadi milik mesin bila scan kini membacanya sebagai own', async () => {
  const { upsertSetups } = await import('../src/storage/store.js');
  const cur = { setupId: 'tnv2-1', lineage: 'inherited_v1', seenCount: 1, sourceResult: 'menunggu' };
  const { setups } = upsertSetups([cur], [{ setupId: 'tnv2-1', lineage: 'own', sourceResult: 'TP', sourceR: 2, originalStatus: 'TP', rawData: {} }], '2026-11-09T00:00:00Z', []);
  assert.equal(setups[0].lineage, 'own'); assert.equal(setups[0].sourceResult, 'TP');
  const keep = upsertSetups([{ setupId: 'a', lineage: 'inherited_v1', seenCount: 1 }], [{ setupId: 'a', sourceResult: 'x', originalStatus: 'x' }], 'n', []);
  assert.equal(keep.setups[0].lineage, 'inherited_v1');
});
