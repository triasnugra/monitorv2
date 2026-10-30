import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { extractTnv2Cards, parseTnv2Card } from '../src/parsers/tnv2.js';
import { buildRecord } from '../src/normalize.js';

// Kartu "Sinyal setup" pada mesin keluarga tn (tnv2 dst.): dipakai sebagai diagnostik gerbang v2.
// Pencatatan setup sendiri berasal dari JURNAL (lihat journal-web.test.js).
const ctx = { scanTimeMs: Date.parse('2026-10-16T06:00:00Z'), firstRun: false, sourceUrl: 'u' };
const html = fs.readFileSync(new URL('./fixtures/tnv2-setups.html', import.meta.url), 'utf8');
const v2Cards = (opts = {}) => extractTnv2Cards(opts, parseHTML(html).document);
const v2Rec = (card, c = ctx) => buildRecord(parseTnv2Card(card), c);

test('gerbang v2: hanya kartu yang lolos dikembalikan, kartu ditolak hanya dihitung', () => {
  const { items, meta } = v2Cards();
  assert.equal(items.length, 9);
  assert.equal(meta.totalCards, 11);
  assert.equal(meta.rejectedCount, 2);
  const tickers = items.map((c) => c.ticker);
  assert.ok(!tickers.includes('AAA') && !tickers.includes('BBB'), 'kartu ditolak tidak boleh ikut dicatat');
  assert.deepEqual(meta.rejected.map((r) => r.ticker).sort(), ['AAA', 'BBB']);
  assert.equal(meta.rejectMarkerUnmatched, false);
});

test('gerbang v2: penanda ditolak lewat teks kartu, class, dan heading semuanya terdeteksi', () => {
  const card = (t, extra = '') => `<div class="c${extra}"><div class="t"><b>${t}</b><span><span class="bd L">LONG</span> <span class="ch ok">AKTIF</span></span></div><div class="g4"><div><span>Entry limit</span>1</div><div><span>SL 3%</span>0.9</div><div><span>TP 2R</span>1.2</div></div></div>`;
  const doc = parseHTML(`<html><body><div id="out"><h3>Lolos gerbang v2</h3>${card('OK1')}${card('OK2')}<h3>Ditolak gerbang v2</h3>${card('NO1')}${card('NO2')}${card('NO3', ' rejected')}</div></body></html>`).document;
  const { items, meta } = extractTnv2Cards({}, doc);
  assert.deepEqual(items.map((c) => c.ticker), ['OK1', 'OK2']);
  assert.equal(meta.rejectedCount, 3);
});

test('gerbang v2: mode ketat requirePassText menolak kartu tanpa penanda lolos', () => {
  const { items } = v2Cards({ requirePassText: 'AKTIF' });
  assert.ok(items.length > 0 && items.length < 9);
  assert.ok(items.every((c) => /AKTIF/.test(c.rawText)));
});

test('gerbang v2: kata "ditolak" di halaman tanpa kartu terdeteksi memicu peringatan penanda', () => {
  const doc = parseHTML('<html><body><div id="out"><div class="c"><div class="t"><b>ZZZ</b><span><span class="bd L">LONG</span></span></div><div class="g4"><div><span>Entry limit</span>1</div></div></div></div><p>Sinyal ditolak oleh gerbang</p></body></html>').document;
  const { items, meta } = extractTnv2Cards({}, doc);
  assert.equal(items.length, 1);
  assert.equal(meta.rejectMarkerUnmatched, true);
});

test('kartu TRX tnv2: nilai dibaca dari label, bukan urutan', () => {
  const trx = v2Cards().items.find((c) => c.ticker === 'TRX');
  const r = v2Rec(trx);
  assert.equal(r.engine, 'tnv2');
  assert.equal(r.symbol, 'TRXUSDT');
  assert.equal(r.direction, 'LONG');
  assert.equal(r.entryType, 'limit');
  assert.equal(r.entryPrice, 0.329);
  assert.equal(r.stopLoss, 0.312);
  assert.deepEqual(r.takeProfit, [0.361]);
  assert.equal(r.timeframe, '1D');
  assert.equal(r.originalStatus, 'AKTIF');
  assert.equal(r.riskAmountUsd, 10);
  assert.equal(r.quantity, 609);
  assert.equal(r.rawData.gate, 'PASSED_V2');
  assert.equal(r.rawData.slDistancePct, 5);
  assert.equal(r.rawData.tpMultiple, 2);
  assert.equal(r.rawData.targetRange, 0.349);
  assert.equal(r.rawData.style, 'scalping');
  assert.equal(r.analysisTimeSource, 'first_seen');
});

test('semua kartu lolos: ID unik, arah konsisten dengan level', () => {
  const recs = v2Cards().items.map((c) => v2Rec(c));
  assert.equal(new Set(recs.map((r) => r.setupId)).size, recs.length);
  const bad = recs.filter((r) => (r.direction === 'LONG'
    ? !(r.stopLoss < r.entryPrice && r.entryPrice < r.takeProfit[0])
    : !(r.takeProfit[0] < r.entryPrice && r.entryPrice < r.stopLoss)));
  assert.deepEqual(bad.map((r) => r.ticker), []);
  assert.ok(recs.every((r) => r.riskPercent === null));
});

test('ID tnv2 stabil antar-scan dan tidak tergantung waktu scan', () => {
  const card = v2Cards().items[0];
  assert.equal(v2Rec(card, { ...ctx, scanTimeMs: 1e12 }).setupId, v2Rec(card, { ...ctx, scanTimeMs: 1e12 + 3600e3 }).setupId);
});

test('waktu analisis dari sumber (jika tersedia) dipakai, bukan waktu scan', () => {
  const card = { ...v2Cards().items[0], analysisTimeMs: Date.parse('2026-10-15T01:00:00Z') };
  const r = v2Rec(card);
  assert.equal(r.analysisTimeSource, 'source');
  assert.equal(r.analysisTimeUtc, '2026-10-15T01:00:00.000Z');
});

test('kartu rusak: field hilang menjadi null dan tercatat, tidak melempar error', () => {
  const r = v2Rec({ ticker: 'XYZ', direction: null, chips: [], rows: [], notes: [], size: null, rawText: '' });
  assert.equal(r.stopLoss, null);
  assert.equal(r.direction, null);
  assert.ok(r.missingFields.includes('stopLoss') && r.missingFields.includes('direction'));
});

