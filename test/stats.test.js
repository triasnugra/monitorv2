import test from 'node:test'; import assert from 'node:assert/strict';
import { summarize, maxDrawdownR, compareEngines, pairSetups, markClusters, periodStats, wilson } from '../src/statistics/stats.js';

const mk = (id, engine, result, r, over = {}) => ({ setupId: id, engine, symbol: 'SUIUSDT', ticker: 'SUI', direction: 'SHORT', entryPrice: 1.144,
  analysisTimeUtc: '2026-10-08T01:47:00.000Z',
  evaluation: { result, rMultiple: r, entryTimeUtc: ['TP', 'SL'].includes(result) ? '2026-10-08T02:47:00.000Z' : null,
    resultTimeUtc: ['TP', 'SL'].includes(result) ? '2026-10-08T05:47:00.000Z' : null }, ...over });

test('PENDING/EXPIRED/INVALID/AMBIGUOUS tidak dihitung menang/kalah', () => {
  const l = [mk('1', 'crypto', 'TP', 2), mk('2', 'crypto', 'SL', -1), mk('3', 'crypto', 'PENDING'), mk('4', 'crypto', 'EXPIRED'), mk('5', 'crypto', 'INVALID'), mk('6', 'crypto', 'AMBIGUOUS')];
  const s = summarize(l);
  assert.equal(s.published, 6); assert.equal(s.resolved, 2); assert.equal(s.winRate, 0.5);
  assert.equal(s.expectancyR, 0.5); assert.equal(s.totalR, 1); assert.equal(s.triggered, 2);
  assert.equal(s.avgMinutesToEntry, 60); assert.equal(s.avgMinutesToResult, 240);
  assert.equal(s.counts.PENDING, 1); assert.equal(s.counts.AMBIGUOUS, 1);
});
test('max drawdown dalam R', () => { assert.equal(maxDrawdownR([2, -1, -1, 2, -1]), 2); assert.equal(maxDrawdownR([1, 1]), 0); });
test('wilson CI wajar', () => { const [lo, hi] = wilson(5, 10); assert.ok(lo < 0.5 && hi > 0.5); assert.equal(wilson(0, 0), null); });
test('verdict menolak sampel kecil', () => {
  const a = Array.from({ length: 5 }, (_, i) => mk('a' + i, 'crypto', 'TP', 2)), b = Array.from({ length: 5 }, (_, i) => mk('b' + i, 'tn', 'SL', -1));
  assert.equal(compareEngines(a, b, { minSample: 30 }).verdict, 'INSUFFICIENT_SAMPLE');
});
test('verdict dengan sampel cukup: selisih nyata vs tidak signifikan', () => {
  const gen = (e, n, winEvery, p) => Array.from({ length: n }, (_, i) => (i % winEvery === 0 ? mk(p + i, e, 'TP', 2) : mk(p + i, e, 'SL', -1)));
  assert.equal(compareEngines(gen('crypto', 60, 2, 'a'), gen('tn', 60, 6, 'b'), { minSample: 30, iterations: 1000 }).verdict, 'A_BETTER');
  assert.equal(compareEngines(gen('crypto', 40, 3, 'a'), gen('tn', 40, 3, 'b'), { minSample: 30, iterations: 1000 }).verdict, 'NO_SIGNIFICANT_DIFFERENCE');
});
test('pasangan setup: arah sama = COMPARABLE, arah beda = CONFLICT, ticker sama saja tidak cukup', () => {
  const a = [mk('c1', 'crypto', 'TP', 2)], b = [mk('t1', 'tn', 'SL', -1, { direction: 'LONG' })];
  const p = pairSetups(a, b, 120); assert.equal(p.length, 1); assert.equal(p[0].relation, 'CONFLICT');
  assert.equal(pairSetups(a, [mk('t2', 'tn', 'SL', -1, { analysisTimeUtc: '2026-10-09T01:47:00.000Z' })], 120).length, 0);
});
test('klaster near-duplicate: hanya yang pertama primary', () => {
  const l = [mk('x1', 'crypto', 'PENDING'), mk('x2', 'crypto', 'PENDING', null, { analysisTimeUtc: '2026-10-08T03:00:00.000Z', entryPrice: 1.145 }),
    mk('x3', 'crypto', 'PENDING', null, { analysisTimeUtc: '2026-10-08T03:00:00.000Z', entryPrice: 1.3 })];
  const c = markClusters(l); assert.equal(c.get('x1').isPrimary, true); assert.equal(c.get('x2').isPrimary, false); assert.equal(c.get('x3').isPrimary, true);
});
test('statistik periode memakai tanggal WIB', () => {
  const s = mk('p', 'crypto', 'TP', 2); s.evaluation.resultTimeUtc = '2026-10-08T18:00:00.000Z';
  assert.equal(periodStats([s], 'daily')[0].period, '2026-10-09'); assert.equal(periodStats([s], 'monthly')[0].period, '2026-10');
});
