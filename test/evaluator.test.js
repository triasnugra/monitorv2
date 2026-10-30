import test from 'node:test'; import assert from 'node:assert/strict';
import { evaluateSetup, validateSetup } from '../src/evaluator/evaluate.js';
import { makeProvider, series, T0, suiShort } from './helpers.js';
import { toWib } from '../src/util/time.js';

const MIN = 60000, HR = 60 * MIN;
const NOW = T0 + 48 * HR;
const run = (setup, wp, minutes = 48 * 60, wick) => evaluateSetup(setup, makeProvider(series(T0, minutes, wp, wick)), { now: NOW });

test('fixture SUI SHORT: entry 1.144 lalu TP 1.029 pada 2026-10-09 01:00 WIB (data sintetis)', async () => {
  // naik ke 1.15 (menyentuh entry), turun perlahan, menyentuh 1.029 tepat di 18:00 UTC (candle menit 975 dari 01:45)
  const wp = [[0, 1.10], [60, 1.15], [300, 1.12], [975, 1.035], [976, 1.0289], [977, 1.02], [3000, 1.0]];
  const r = await run(suiShort(), wp, 2000, 0);
  assert.equal(r.result, 'TP');
  assert.equal(toWib(r.resultTimeUtc), '2026-10-09 01:00');
  assert.ok(Date.parse(r.entryTimeUtc) < Date.parse(r.resultTimeUtc));
  assert.ok(Math.abs(r.rMultiple - (1.144 - 1.029) / (1.201 - 1.144)) < 1e-9);
  assert.match(r.notes[0], /TP tersentuh setelah entry terpicu/);
});
test('SHORT: SL tersentuh lebih dulu', async () => {
  const r = await run(suiShort(), [[0, 1.10], [60, 1.15], [120, 1.21], [3000, 1.0]], 2000, 0);
  assert.equal(r.result, 'SL'); assert.equal(r.rMultiple, -1);
});
test('LONG: TP di atas entry', async () => {
  const s = { ...suiShort(), direction: 'LONG', entryPrice: 1.0, takeProfit: [1.2], stopLoss: 0.9 };
  const r = await run(s, [[0, 1.05], [60, 0.99], [200, 1.21], [3000, 1.3]], 1000, 0);
  assert.equal(r.result, 'TP'); assert.equal(r.rMultiple, 2);
});
test('entry belum tersentuh -> PENDING, bukan profit/rugi', async () => {
  const r = await run(suiShort(), [[0, 1.10], [3000, 1.12]], 600, 0);
  assert.equal(r.result, 'PENDING'); assert.equal(r.entryTimeUtc, null); assert.equal(r.rMultiple, null);
});
test('TP tercapai sebelum entry tersentuh -> EXPIRED (tidak dihitung menang)', async () => {
  const r = await run(suiShort(), [[0, 1.10], [60, 1.02], [3000, 1.0]], 600, 0);
  assert.equal(r.result, 'EXPIRED'); assert.equal(r.reasonCode, 'TP_REACHED_BEFORE_ENTRY'); assert.equal(r.rMultiple, null);
});
test('TP dan SL dalam satu candle 1m -> AMBIGUOUS, tidak menebak', async () => {
  const oneMin = series(T0, 600, [[0, 1.10], [60, 1.15], [3000, 1.15]], 0);
  const i = oneMin.findIndex((c) => c.t === T0 + 200 * MIN);
  oneMin[i] = { ...oneMin[i], h: 1.21, l: 1.02 };               // candle liar menyentuh SL dan TP sekaligus
  const r = await evaluateSetup(suiShort(), makeProvider(oneMin), { now: NOW });
  assert.equal(r.result, 'AMBIGUOUS'); assert.equal(r.reasonCode, 'TP_AND_SL_SAME_CANDLE'); assert.equal(r.rMultiple, null);
});
test('TP dan SL dalam candle 15m yang sama diselesaikan dengan 1m (SL dulu)', async () => {
  const oneMin = series(T0, 600, [[0, 1.10], [60, 1.15], [3000, 1.15]], 0);
  const base = T0 + 240 * MIN; // kelipatan 15m
  const at = (m, o, h, l, c) => { const i = oneMin.findIndex((x) => x.t === base + m * MIN); oneMin[i] = { ...oneMin[i], o, h, l, c }; };
  at(3, 1.15, 1.205, 1.15, 1.2); at(9, 1.2, 1.2, 1.02, 1.03);
  const r = await evaluateSetup(suiShort(), makeProvider(oneMin), { now: NOW });
  assert.equal(r.result, 'SL'); assert.equal(r.resultTimeUtc, new Date(base + 3 * MIN).toISOString());
});
test('candle sebelum analisis tidak dipakai', async () => {
  // spike TP di 01:45-01:46 (sebelum analisis 01:47) harus diabaikan
  const oneMin = series(T0, 300, [[0, 1.10], [300, 1.12]], 0);
  oneMin[0] = { ...oneMin[0], l: 1.0, h: 1.2 };
  const r = await evaluateSetup(suiShort(), makeProvider(oneMin), { now: NOW });
  assert.notEqual(r.result, 'TP'); assert.notEqual(r.result, 'SL');
});
test('validasi arah vs level, dan sanity harga', async () => {
  assert.equal(validateSetup({ ...suiShort(), direction: 'LONG' }).ok, false);
  assert.equal(validateSetup({ ...suiShort(), takeProfit: null }).reason, 'MISSING_TP_OR_SL');
  const r = await run({ ...suiShort(), entryPrice: 1144, takeProfit: [1029], stopLoss: 1201 }, [[0, 1.1], [3000, 1.1]], 300, 0);
  assert.equal(r.result, 'INVALID'); assert.equal(r.reasonCode, 'PRICE_SANITY');
});
test('entry kedaluwarsa setelah TTL; celah data -> AMBIGUOUS', async () => {
  const wp = [[0, 1.10], [5000, 1.10]];
  const exp = await evaluateSetup(suiShort(), makeProvider(series(T0, 5000, wp, 0)), { now: T0 + 90 * HR });
  assert.equal(exp.result, 'EXPIRED'); assert.equal(exp.resultTimeSource, 'timeout');
  const oneMin = series(T0, 5000, wp, 0).filter((c) => c.t < T0 + 30 * HR || c.t >= T0 + 31 * HR);
  const gap = await evaluateSetup(suiShort(), makeProvider(oneMin), { now: T0 + 90 * HR });
  assert.equal(gap.result, 'AMBIGUOUS'); assert.equal(gap.reasonCode, 'DATA_GAP_BLOCKS_EXPIRY');
});
test('dibatalkan mesin sebelum entry -> CANCELLED', async () => {
  const r = await evaluateSetup({ ...suiShort(), engineCancelledAtUtc: new Date(T0 + 5 * HR).toISOString() },
    makeProvider(series(T0, 3000, [[0, 1.1], [3000, 1.1]], 0)), { now: NOW });
  assert.equal(r.result, 'CANCELLED'); assert.equal(r.resultTimeSource, 'scraper');
});
test('rentang entry LONG diisi di tepi atas rentang', async () => {
  const s = { ...suiShort(), direction: 'LONG', entryPrice: null, entryRange: [1.0, 1.02], takeProfit: [1.2], stopLoss: 0.9 };
  const r = await run(s, [[0, 1.05], [60, 1.015], [200, 1.21], [3000, 1.3]], 1000, 0);
  assert.equal(r.result, 'TP'); assert.equal(r.entryFill, 1.02);
});
