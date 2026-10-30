import test from 'node:test';
import assert from 'node:assert/strict';
import { traceCandles } from '../src/evaluator/trace.js';
const T = Date.parse('2026-10-19T10:12:00Z');
const setup = { direction: 'LONG', entryPrice: 0.459, takeProfit: [0.539], stopLoss: 0.442, analysisTimeUtc: new Date(T).toISOString() };
test('jejak: TP tersentuh sebelum entry terlihat sebagai TP tanpa ENTRY (kasus EXPIRED)', () => {
  const c = [
    { t: T - 60e3, o: 0.5, h: 0.5, l: 0.45, c: 0.46 },      // sebelum analisis: tidak ditampilkan
    { t: T, o: 0.50, h: 0.54, l: 0.50, c: 0.53 },           // naik tanpa menyentuh 0.459
    { t: T + 60e3, o: 0.53, h: 0.55, l: 0.52, c: 0.54 },
  ];
  const r = traceCandles(setup, c);
  assert.equal(r.length, 2);
  assert.equal(r[0].touches, 'TP');
  assert.equal(r[1].touches, 'TP');
});
test('jejak: candle yang menyentuh entry dan SL sekaligus ditandai keduanya', () => {
  const r = traceCandles(setup, [{ t: T, o: 0.46, h: 0.46, l: 0.44, c: 0.45 }]);
  assert.equal(r[0].touches, 'ENTRY SL');
});

import { selectSetups } from '../src/evaluator/trace.js';
test('selectSetups: filter koin/mesin/hasil, terbaru dulu, dibatasi max', () => {
  const mk = (id, ticker, engine, result, t) => ({ setupId: id, ticker, engine, analysisTimeUtc: t, evaluation: { result } });
  const all = [mk('a', 'WLD', 'crypto', 'EXPIRED', '2026-10-19T10:00:00Z'), mk('b', 'WLD', 'crypto', 'EXPIRED', '2026-10-20T10:00:00Z'),
    mk('c', 'WLD', 'tn', 'SL', '2026-10-18T10:00:00Z'), mk('d', 'ETH', 'crypto', 'EXPIRED', '2026-10-21T10:00:00Z')];
  assert.deepEqual(selectSetups(all, { ticker: 'wld', engine: 'crypto', result: 'EXPIRED' }).map((s) => s.setupId), ['b', 'a']);
  assert.equal(selectSetups(all, { result: 'EXPIRED', max: 1 }).length, 1);
  assert.deepEqual(selectSetups(all, { id: 'c' }).map((s) => s.setupId), ['c']);
});

import { describeCoverage } from '../src/evaluator/trace.js';
test('describeCoverage: menjelaskan mesin salah nama, koin tak ada, dan data kosong', () => {
  const mk = (ticker, engine, result) => ({ ticker, engine, evaluation: { result } });
  const all = [mk('WLD', 'crypto', 'EXPIRED'), mk('TIA', 'tn', 'SL'), mk('TIA', 'tn', 'EXPIRED')];
  const wrongEngine = describeCoverage(all, { engine: 'mesin2', ticker: 'TIA' });
  assert.equal(wrongEngine.engineKnown, false);
  const wrongPair = describeCoverage(all, { engine: 'crypto', ticker: 'TIA' });   // TIA ada, tetapi di mesin tn
  assert.equal(wrongPair.engineKnown, true); assert.equal(wrongPair.tickerKnown, false); assert.deepEqual(wrongPair.tickers, ['WLD']);
  assert.deepEqual(describeCoverage(all, { engine: 'tn', ticker: 'tia' }).byResult, { SL: 1, EXPIRED: 1 });
  assert.equal(describeCoverage([], {}).total, 0);
});
