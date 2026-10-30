import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapHeaders, isJournalMap, rowsToEntries, num, entryKey, parseWebJournalEntry } from '../src/parsers/journal.js';
import { mergeJournal, pickJournalArray } from '../src/scrapers/journalWeb.js';
import { mapSourceResult, sourceEvaluation } from '../src/sourceEval.js';
import { buildRecord } from '../src/normalize.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-jw-'));
process.env.DATA_DIR = path.join(tmp, 'data');
const { collect, build, TO_RECORD } = await import('../src/index.js');
const store = await import('../src/storage/store.js');

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
// Data nyata dari jurnal tnv2 tanggal 29 Okt 2026 (22 sinyal: 8 TP, 9 SL, 5 menunggu), hasil scraper di Chromium.
const xlsx = read('tnv2-journal-20261029.json');
const viaJson = read('tnv2-journal-items.json');
const viaDom = read('tnv2-journal-items-domonly.json');
const settings = { cancelPatterns: ['batal'], rawRetentionPerEngine: 3, entryTtlHours: 72, maxHoldDays: 30, sanityMaxDeviation: 0.5,
  minSamplePerEngine: 30, bootstrapIterations: 100, pairWindowMinutes: 120, cluster: { windowHours: 24, entryTolerance: 0.01 }, binanceBaseUrls: [] };
const T1 = Date.parse('2026-10-29T03:00:00Z');
const okDiag = { errors: [], warnings: [], httpStatus: null, durationMs: 1, meta: { summaryCount: null } };

test('angka: notasi ilmiah dan desimal kecil dibaca tepat', () => {
  assert.equal(num('5.03e-06'), 0.00000503);
  assert.equal(num('0.00000503'), 0.00000503);
  assert.equal(num('1,214.3'), 1214.3);
  assert.equal(num(''), null);
});

test('header tabel jurnal dipetakan dari nama kolom, bukan urutan', () => {
  const m = mapHeaders(['hasil', 'waktu', 'Aset', 'arah', 'tp', 'sl', 'entry', 'R']);
  assert.ok(isJournalMap(m));
  assert.equal(m.hasil, 0); assert.equal(m.waktu, 1); assert.equal(m.tp, 4);
  assert.equal(isJournalMap(mapHeaders(['koin', 'harga'])), false);
});

test('baris tabel -> entri: nilai persis seperti yang tampil di jurnal', () => {
  const e = rowsToEntries({ headers: ['waktu', 'aset', 'arah', 'entry', 'sl', 'tp', 'hasil', 'R', 'alasan'],
    rows: [['2026-10-29 01:19 UTC', 'PEPE', 'SHORT', '0.00000503', '0.0000051809', '0.0000047282', 'SL', '-1', 'x'],
      ['2026-10-29 01:19 UTC', 'WLD', 'SHORT', '0.4529', '0.48702', '0.38465', 'menunggu', '', '']] })[1];
  assert.equal(e.aset, 'WLD'); assert.equal(e.hasil, 'menunggu'); assert.equal(e.R, '');
  assert.equal(e.t, Date.parse('2026-10-29T01:19:00Z'));
});

test('hasil mesin dipetakan ke status monitor (TP/SL/menunggu/kedaluwarsa/tidak terisi)', () => {
  const m = (x) => mapSourceResult(x).result;
  assert.deepEqual(['TP', 'SL', 'menunggu', '', 'kedaluwarsa', 'tidak terisi', 'dibatalkan', 'aneh'].map(m),
    ['TP', 'SL', 'PENDING', 'PENDING', 'EXPIRED', 'EXPIRED', 'CANCELLED', 'AMBIGUOUS']);
});

test('merge: tabel menimpa hasil JSON, baris hanya-di-tabel ikut, ID tidak berganda', () => {
  const json = [{ waktu: '2026-10-29 01:19 UTC', aset: 'TRX', arah: 'LONG', entry: 0.3294, hasil: 'menunggu', R: '' },
    { waktu: '2026-10-29 01:19 UTC', aset: 'ETH', arah: 'LONG', entry: 2318, hasil: 'SL', R: -1 }];
  const dom = [{ waktu: '2026-10-29 01:19 UTC', aset: 'TRX', arah: 'LONG', entry: 0.3294, hasil: 'TP', R: 2 },
    { waktu: '2026-10-29 01:19 UTC', aset: 'ETH', arah: 'LONG', entry: 2318, hasil: 'SL', R: -1 },
    { waktu: '2026-10-29 01:19 UTC', aset: 'ARB', arah: 'SHORT', entry: 0.1737, hasil: 'TP', R: 2 }];
  const { items, stats } = mergeJournal(json, dom);
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.aset === 'TRX').hasil, 'TP');
  assert.deepEqual([stats.hasilOverridden, stats.domOnly, stats.jsonOnly], [1, 1, 0]);
  assert.equal(entryKey(json[0]), entryKey({ ...dom[0], t: 1 }));
});

test('JSON jurnal dikenali walau dibungkus objek; objek lain diabaikan', () => {
  assert.equal(pickJournalArray({ ready: true, counts: {} }), null);
  assert.equal(pickJournalArray({ journal: [{ aset: 'A', arah: 'LONG', entry: 1 }] }).length, 1);
});

test('sumber JSON dan sumber tabel menghasilkan setupId yang SAMA (tidak ada duplikat saat sumber berganti)', () => {
  const ctx = { scanTimeMs: T1, firstRun: false, sourceUrl: 'u' };
  const a = viaJson.map((x) => TO_RECORD.tnv2(x, ctx).setupId).sort();
  const b = viaDom.map((x) => TO_RECORD.tnv2(x, ctx).setupId).sort();
  assert.equal(a.length, 22);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 22);
});

test('data nyata 29 Okt: monitor menampilkan 22 setup, 8 TP, 9 SL, 5 pending (sama dengan jurnal website)', async () => {
  const meta = { trackingStartedUtc: {} };
  const fake = async () => ({ status: 'OK', items: viaJson.map((x) => structuredClone(x)), diagnostics: structuredClone(okDiag) });
  const rep = await collect({ engines: ['tnv2'], sources: { tnv2: { url: 'u' } }, settings, now: T1, scrapeEngine: fake, meta });
  assert.equal(rep.tnv2.added, 22);
  // putaran kedua: idempoten, tidak menggandakan
  const rep2 = await collect({ engines: ['tnv2'], sources: { tnv2: { url: 'u' } }, settings, now: T1 + 1800e3, scrapeEngine: async () => ({ status: 'OK', items: viaDom.map((x) => structuredClone(x)), diagnostics: structuredClone(okDiag) }), meta });
  assert.equal(rep2.tnv2.added, 0);
  assert.equal(store.loadSetups().filter((s) => s.engine === 'tnv2').length, 22);

  const d = build({ settings, now: T1, siteDataDir: path.join(tmp, 'site') });
  const sum = d.engines.source.all.tnv2.summary;
  assert.equal(sum.published, 22);
  assert.equal(sum.counts.TP, 8);
  assert.equal(sum.counts.SL, 9);
  assert.equal(sum.counts.PENDING, 5);
  assert.equal(sum.triggered, 17);
  // hasil per koin persis seperti jurnal
  const byT = Object.fromEntries(d.jurnal.filter((r) => r.engine === 'tnv2').map((r) => [r.ticker, r.resultSrc]));
  for (const e of xlsx) assert.equal(byT[e.aset], { TP: 'TP', SL: 'SL', menunggu: 'PENDING' }[e.hasil], e.aset);
});

test('hasil mesin berubah di scan berikutnya (menunggu -> TP) diperbarui, nilai awal tersimpan', async () => {
  const meta = { trackingStartedUtc: {} };
  const first = structuredClone(viaJson).map((x) => (x.aset === 'TRX' ? { ...x, hasil: 'menunggu', R: '' } : x));
  const src = { tnv2: { url: 'u' } };
  await collect({ engines: ['tnv2'], sources: src, settings, now: T1 + 3600e3, scrapeEngine: async () => ({ status: 'OK', items: first, diagnostics: structuredClone(okDiag) }), meta });
  await collect({ engines: ['tnv2'], sources: src, settings, now: T1 + 7200e3, scrapeEngine: async () => ({ status: 'OK', items: structuredClone(viaJson), diagnostics: structuredClone(okDiag) }), meta });
  const trx = store.loadSetups().find((s) => s.engine === 'tnv2' && s.ticker === 'TRX');
  assert.equal(trx.sourceResult, 'TP');
  assert.equal(sourceEvaluation(trx).result, 'TP');
});

test('record kartu tnv2 lama (gerbang kartu) dibuang saat migrasi ke jurnal', async () => {
  const legacy = buildRecord({ engine: 'tnv2', ticker: 'OLD', direction: 'LONG', entryPrice: 1, takeProfit: [2], stopLoss: 0.5, idKey: 'legacy', rawData: { gate: 'PASSED_V2' } }, { scanTimeMs: T1, firstRun: false, sourceUrl: 'u' });
  store.saveSetups([...store.loadSetups(), { ...legacy, firstSeenUtc: 'x', lastSeenUtc: 'x', seenCount: 1, evaluation: { result: 'PENDING' } }]);
  await collect({ engines: ['tnv2'], sources: { tnv2: { url: 'u' } }, settings, now: T1 + 9000e3, scrapeEngine: async () => ({ status: 'OK', items: structuredClone(viaJson), diagnostics: structuredClone(okDiag) }), meta: { trackingStartedUtc: {} } });
  assert.ok(!store.loadSetups().some((s) => s.ticker === 'OLD'));
});
