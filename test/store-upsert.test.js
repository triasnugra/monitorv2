import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertSetups } from '../src/storage/store.js';
import { parseJournalEntry, TN_TIMEFRAME } from '../src/parsers/tn.js';
import { buildRecord } from '../src/normalize.js';

const entry = (over = {}) => ({
  id: '2026-10-20|Aturan Eliz|DOT', h: 'abc123', waktu: '2026-10-20 05:04 UTC', t: Date.parse('2026-10-20T05:04:35Z'),
  aset: 'DOT', arah: 'SHORT', entry: 1.268, sl: 1.306, tp: 1.1919, alasan: 'Fib 0.75 tren turun', hasil: 'menunggu', R: '', ...over,
});
const rec = (e) => buildRecord(parseJournalEntry(e), { scanTimeMs: Date.parse('2026-10-20T06:00:00Z'), firstRun: false, sourceUrl: '' });

test('Mesin 2: timeframe terisi dan tidak masuk missingFields', () => {
  const r = rec(entry());
  assert.equal(r.timeframe, TN_TIMEFRAME);
  assert.ok(!r.missingFields.includes('timeframe'));
});

test('upsert memperbarui sourceResult/sourceR/rawData dan menyimpan nilai pertama', () => {
  const t1 = '2026-10-20T06:00:00.000Z', t2 = '2026-10-21T06:00:00.000Z', t3 = '2026-10-22T06:00:00.000Z';
  let { setups } = upsertSetups([], [rec(entry())], t1);
  assert.equal(setups[0].sourceResult, 'menunggu');
  ({ setups } = upsertSetups(setups, [rec(entry({ hasil: 'SL', R: -1, tx: 123 }))], t2));
  assert.equal(setups[0].sourceResult, 'SL');
  assert.equal(setups[0].sourceR, -1);
  assert.equal(setups[0].rawData.tx, 123);
  assert.equal(setups[0].firstSourceResult, 'menunggu');
  assert.equal(setups[0].seenCount, 2);
  ({ setups } = upsertSetups(setups, [rec(entry({ hasil: 'SL', R: -1, tx: 123 }))], t3));
  assert.equal(setups[0].firstSourceResult, 'menunggu', 'nilai pertama tidak boleh tertimpa lagi');
  assert.equal(setups.length, 1, 'idempoten: tidak ada duplikat');
});

test('upsert tidak menyentuh evaluasi dan tidak menghapus setup', () => {
  const t1 = '2026-10-20T06:00:00.000Z';
  let { setups } = upsertSetups([], [rec(entry()), rec(entry({ h: 'zzz', aset: 'ADA' }))], t1);
  setups[0].evaluation = { result: 'SL', reasonCode: null };
  ({ setups } = upsertSetups(setups, [rec(entry({ hasil: 'TP', R: 2 }))], '2026-10-21T00:00:00.000Z'));
  assert.equal(setups.length, 2);
  assert.equal(setups.find((s) => s.rawData.h === 'abc123').evaluation.result, 'SL');
});

test('record lama tanpa timeframe diisi saat terlihat lagi', () => {
  const t1 = '2026-10-20T06:00:00.000Z';
  let { setups } = upsertSetups([], [rec(entry())], t1);
  setups[0].timeframe = null; setups[0].missingFields = ['timeframe'];
  ({ setups } = upsertSetups(setups, [rec(entry())], '2026-10-21T00:00:00.000Z'));
  assert.equal(setups[0].timeframe, TN_TIMEFRAME);
  assert.deepEqual(setups[0].missingFields, []);
});

test('agregasi: Mesin 2 dikelompokkan sebagai 1D walau timeframe tersimpan null', async () => {
  const { buildDashboard } = await import('../src/aggregate.js');
  const s = { ...rec(entry()), timeframe: null, evaluation: { result: 'TP', evaluatedAtUtc: '2026-10-22T00:00:00Z', resultTimeUtc: '2026-10-22T00:00:00Z', resultTimeSource: 'candle', notes: [] } };
  const d = buildDashboard({ setups: [s], diagnostics: { runs: [] }, cfg: { minSamplePerEngine: 30, bootstrapIterations: 50, pairWindowMinutes: 120, cluster: { windowHours: 24, entryTolerance: 0.01 } }, nowIso: '2026-10-27T00:00:00Z' });
  assert.deepEqual(Object.keys(d.engines.candle.independent.tn.byTimeframe), [TN_TIMEFRAME]);
});
