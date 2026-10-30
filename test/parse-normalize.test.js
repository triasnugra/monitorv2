import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { extractCryptoCards, parseCryptoCard } from '../src/parsers/crypto.js';
import { parseJournalEntry } from '../src/parsers/tn.js';
import { buildRecord, normalizeTicker, normalizeDirection } from '../src/normalize.js';

const ctx = { scanTimeMs: Date.parse('2026-10-16T06:00:00Z'), firstRun: false, sourceUrl: 'u' };
const html = fs.readFileSync(new URL('./fixtures/crypto-setups.html', import.meta.url), 'utf8');
const journal = JSON.parse(fs.readFileSync(new URL('./fixtures/tn-journal-sample.json', import.meta.url), 'utf8'));
const cryptoCards = () => extractCryptoCards(parseHTML(html).document);
const cryptoRec = (card, c = ctx) => buildRecord(parseCryptoCard(card), c);

test('ekstraksi Mesin 1 dari HTML asli: 30 kartu, cocok dengan ringkasan halaman', () => {
  const { items, meta } = cryptoCards();
  assert.equal(items.length, 30);
  assert.equal(meta.summaryCount, 30);
  assert.equal(meta.confirmedEmpty, false);
});

test('kartu AVAX: nilai dibaca dari label, bukan urutan', () => {
  const avax = cryptoCards().items.find((c) => c.ticker === 'AVAX');
  const r = cryptoRec(avax);
  assert.equal(r.symbol, 'AVAXUSDT');
  assert.equal(r.direction, 'SHORT');
  assert.equal(r.entryType, 'limit');
  assert.equal(r.entryPrice, 11.608);
  assert.equal(r.stopLoss, 12.15);
  assert.deepEqual(r.takeProfit, [8.845]);
  assert.equal(r.timeframe, '1D');
  assert.equal(r.originalStatus, 'Jauh');
  assert.equal(r.riskAmountUsd, 10);
  assert.equal(r.quantity, 18.5);
  assert.equal(r.entryReason, 'Double Deviation: sweep ke-2 lebih dangkal, tekanan beli melemah');
  assert.equal(r.rawData.tpLabel, 'TP1');
  assert.equal(r.rawData.slDistancePct, 4.7);
  assert.equal(r.rawData.rrToFinalTarget, 10.9);
  assert.equal(r.riskReward, 5.1); // dihitung dari TP1, bukan "Rasio ke target akhir"
  assert.equal(r.analysisTimeSource, 'first_seen');
});

test('semua 30 kartu: ID unik, arah konsisten dengan level, tidak ada field palsu', () => {
  const recs = cryptoCards().items.map((c) => cryptoRec(c));
  assert.equal(new Set(recs.map((r) => r.setupId)).size, 30);
  const bad = recs.filter((r) => (r.direction === 'LONG'
    ? !(r.stopLoss < r.entryPrice && r.entryPrice < r.takeProfit[0])
    : !(r.takeProfit[0] < r.entryPrice && r.entryPrice < r.stopLoss)));
  assert.deepEqual(bad.map((r) => r.ticker), []);
  // riskPercent tidak ada di kartu: harus null, bukan dihitung dari "SL x%" (itu jarak SL, bukan risiko).
  assert.ok(recs.every((r) => r.riskPercent === null));
});

test('ID Mesin 1 stabil antar-scan dan tidak tergantung waktu scan', () => {
  const card = cryptoCards().items[0];
  const a = cryptoRec(card, { ...ctx, scanTimeMs: 1e12 });
  const b = cryptoRec(card, { ...ctx, scanTimeMs: 1e12 + 3600e3 });
  assert.equal(a.setupId, b.setupId);
});

test('rentang entry dan LONG pada kartu sintetis', () => {
  const card = {
    ticker: 'ETH', direction: 'Long', chips: ['Long', '4H, swing', 'Aktif'],
    rows: [{ label: 'Entry limit', value: '2.400 - 2.420' }, { label: 'SL 3.0%', value: '2.350' }, { label: 'TP2', value: '2.600' }, { label: 'Rasio ke target akhir', value: '3.7R' }],
    notes: ['Sweep Monday Low, lalu reclaim. Harga 2.430, jarak ke entry 0.4%.', 'Konfirmasi: Retest tertahan di 4H'],
    size: 'Risiko $10: qty 4.1 ETH, nilai posisi $10', rawText: '',
  };
  const r = cryptoRec(card);
  assert.deepEqual(r.entryRange, [2.4, 2.42]);
  assert.equal(r.entryPrice, 2.41);
  assert.equal(r.direction, 'LONG');
  assert.equal(r.rawData.tpLabel, 'TP2');
  assert.equal(r.entryReason, 'Sweep Monday Low, lalu reclaim');
  assert.equal(r.rawData.price, 2430);
});

test('kartu rusak: field hilang menjadi null dan tercatat, tidak melempar error', () => {
  const r = cryptoRec({ ticker: 'XYZ', direction: null, chips: [], rows: [], notes: [], size: null, rawText: '' });
  assert.equal(r.stopLoss, null);
  assert.equal(r.direction, null);
  assert.ok(r.missingFields.includes('stopLoss') && r.missingFields.includes('direction'));
});

test('Mesin 2: ID dari hash rantai h, BTC SHORT dengan level sama di dua hari tetap dua setup', () => {
  const btc = journal.filter((e) => e.aset === 'BTC');
  const recs = btc.map((e) => buildRecord(parseJournalEntry(e), ctx));
  assert.equal(recs.length, 2);
  assert.equal(recs[0].entryPrice, recs[1].entryPrice);
  assert.notEqual(recs[0].setupId, recs[1].setupId);
});

test('Mesin 2: waktu dari t cocok dengan waktu teks, tanpa peringatan TIME_MISMATCH', () => {
  const recs = journal.map((e) => buildRecord(parseJournalEntry(e), ctx));
  assert.ok(recs.every((r) => !r.warnings.some((w) => w.startsWith('TIME_MISMATCH'))));
  const link = recs.find((r) => r.ticker === 'ZK' && r.analysisTimeUtc.startsWith('2026-10-14'));
  assert.equal(link.analysisTimeUtc.slice(0, 16), '2026-10-14T01:50');
  assert.equal(link.analysisTimeSource, 'source');
});

test('Mesin 2: hasil sumber disimpan terpisah dari status evaluasi, R bawaan tersimpan', () => {
  const zk = buildRecord(parseJournalEntry(journal.find((e) => e.h === '212f47797f1e2fc42afc')), ctx);
  assert.equal(zk.sourceResult, 'SL');
  assert.equal(zk.sourceR, -1);
  assert.equal(zk.evaluation, undefined); // evaluasi ditulis terpisah oleh evaluator
  assert.equal(zk.rawData.bm.h, 'TP'); // bm/bi disimpan utuh, belum ditafsirkan
  assert.equal(zk.riskReward, 2); // (0.01707-0.015894)/(0.017658-0.01707) = 2.0, dihitung dari level
});

test('Mesin 2: rasio dihitung dari level dan cocok dengan R sumber (2R)', () => {
  const link = buildRecord(parseJournalEntry(journal[0]), ctx);
  assert.equal(link.riskReward, 2);
});

test('normalisasi ticker dan arah', () => {
  assert.deepEqual(normalizeTicker('SUIUSDT'), { ticker: 'SUI', symbol: 'SUIUSDT' });
  assert.deepEqual(normalizeTicker('NVDABUSDT'), { ticker: 'NVDAB', symbol: 'NVDABUSDT' });
  assert.equal(normalizeTicker('ETH-USDC').symbol, null);
  assert.equal(normalizeDirection('Short'), 'SHORT');
  assert.equal(normalizeDirection('Long'), 'LONG');
  assert.equal(normalizeDirection('??'), null);
});
