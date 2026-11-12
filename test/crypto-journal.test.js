import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { extractCryptoCards } from '../src/parsers/crypto.js';
import { parseCryptoJournalEntry, fetchCryptoJournal } from '../src/parsers/cryptoJournal.js';
import { tagLineage, isHidden } from '../src/lineage.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cj-'));
process.env.DATA_DIR = path.join(tmp, 'data');
const { collect } = await import('../src/index.js');
const store = await import('../src/storage/store.js');

const T = Date.UTC(2026, 9, 23, 23, 34); // 2026-10-24 06:34 WIB, tetapi 23 Okt di UTC
const J = (o = {}) => ({ id: '2026-10-23|BTC|SHORT|4H|#1', waktu: '2026-10-23 23:34 UTC', t: T, due: T + 3e8, aset: 'BTC', arah: 'SHORT', tf: '4H', mode: 'limit',
  entry: 83158, sl: 85103.38, tp: 79800, alasan: 'Sweep Monday High', engine: 'a6aa2848cf79ffa1', h: 'h1', seq: 1, rev: [{ t: T + 1, entry: 83158, sl: 85090, tp: 79800 }], ...o });

test('parser jurnal crypto: waktu analisis = t asli, id dari h, tidak terpengaruh revisi SL/TP', () => {
  const a = parseCryptoJournalEntry(J()), b = parseCryptoJournalEntry(J({ sl: 85000, tp: 79000 })); // level direvisi, h sama
  assert.equal(a.analysisTimeMs, T); assert.equal(a.analysisTimeSource, 'source');
  assert.equal(a.idKey, 'crypto|h1'); assert.equal(a.idKey, b.idKey);
  assert.equal(a.engine, 'crypto'); assert.equal(a.timeframe, '4H'); assert.equal(a.sourceResult, null);
});

test('tagLineage: kartu DOM crypto dan baris mesin lain berlabel crypto disembunyikan hanya bila journalUrl dikonfigurasi', () => {
  const dom = () => ({ engine: 'crypto', setupId: 'crypto-x', rawData: { chips: [], rawText: 'x' } });
  const jr = { engine: 'crypto', setupId: 'crypto-y', rawData: J() };
  const a = [dom(), jr]; tagLineage(a, { crypto: { journalUrl: 'u', inheritedEngineIds: [] } });
  assert.equal(a[0].lineage, 'dom_lama'); assert.ok(isHidden(a[0])); assert.equal(a[1].lineage, undefined);
  const salah = { engine: 'crypto', lineage: 'own', rawData: { _src: 'json+dom', engine: 'dcfc', agen: 'Aturan Eliz' } };
  tagLineage([salah], { crypto: { journalUrl: 'u', inheritedEngineIds: [] } }); assert.equal(salah.lineage, 'dom_lama');
  const b = [dom()]; tagLineage(b, { crypto: { inheritedEngineIds: [] } });
  assert.equal(b[0].lineage, undefined);
});

test('tagLineage: record berhash engine v1 yang terlanjur berlabel own/unverified dikoreksi jadi inherited_v1', () => {
  const src = { tnv2: { inheritedEngineIds: ['V1'], legacyWithoutEngine: 'inherited', tableOnlyRows: 'unverified' } };
  const a = [{ engine: 'tnv2', lineage: 'own', rawData: { engine: 'V1' } }, { engine: 'tnv2', lineage: 'unverified', rawData: { engine: 'V1' } },
    { engine: 'tnv2', lineage: 'own', rawData: { engine: 'V2' } }];
  tagLineage(a, src);
  assert.deepEqual(a.map((x) => x.lineage), ['inherited_v1', 'inherited_v1', 'own']);
});

test('fetchCryptoJournal: gagal tidak melempar; sukses mengembalikan array', async () => {
  const bad = await fetchCryptoJournal({ journalUrl: 'https://x.invalid/j.json', retries: 1 }, async () => ({ ok: false, status: 503 }));
  assert.equal(bad.ok, false); assert.match(bad.error, /HTTP_503/);
  const good = await fetchCryptoJournal({ journalUrl: 'https://x.invalid/j.json', retries: 1 }, async () => ({ ok: true, json: async () => [J()] }));
  assert.equal(good.ok, true); assert.equal(good.items.length, 1);
});

test('collect crypto: 1 sinyal dengan 3 revisi = 1 record; record kartu lama disembunyikan; gagal fetch tidak menambah apa pun', async () => {
  const html = fs.readFileSync(new URL('./fixtures/crypto-setups.html', import.meta.url), 'utf8');
  const cards = extractCryptoCards(parseHTML(html).document).items;
  const settings = { cancelPatterns: ['batal'], rawRetentionPerEngine: 2 };
  const scrape = async () => ({ status: 'OK', items: cards.map((c) => structuredClone(c)), diagnostics: { errors: [], warnings: [], durationMs: 1, meta: { summaryCount: cards.length } } });
  const meta = { trackingStartedUtc: {} };
  // 1) cara lama (tanpa journalUrl): record dari kartu
  await collect({ engines: ['crypto'], sources: { crypto: { url: 'https://x.invalid/' } }, settings, now: T, scrapeEngine: scrape, meta });
  const lama = store.loadSetups().filter((s) => s.engine === 'crypto').length;
  assert.ok(lama > 1);
  // 2) cara baru: journalUrl + jurnal berisi 2 sinyal (satu direvisi 3x -> tetap h sama)
  const rows = [J(), J({ sl: 85000 }), J({ sl: 84900 }), J({ id: 'x2', h: 'h2', aset: 'ETH', entry: 2000, sl: 2100, tp: 1800, t: T + 6e4 })];
  const fetchJournal = async () => ({ ok: true, items: rows, error: null });
  const src = { crypto: { url: 'https://x.invalid/', journalUrl: 'https://x.invalid/j.json', inheritedEngineIds: [], fetchJournal } };
  await collect({ engines: ['crypto'], sources: src, settings, now: T + 1e6, scrapeEngine: scrape, meta });
  const all = store.loadSetups().filter((s) => s.engine === 'crypto');
  assert.equal(all.filter((s) => !isHidden(s)).length, 2);
  assert.equal(all.filter((s) => s.lineage === 'dom_lama').length, lama);
  assert.equal(all.find((s) => !isHidden(s) && s.ticker === 'BTC').analysisTimeUtc, new Date(T).toISOString());
  // 3) fetch gagal: tidak ada record baru, tidak melempar
  const before = store.loadSetups().length;
  const rep = await collect({ engines: ['crypto'], sources: { crypto: { ...src.crypto, fetchJournal: async () => ({ ok: false, items: [], error: 'HTTP_503' }) } }, settings, now: T + 2e6, scrapeEngine: scrape, meta });
  assert.equal(store.loadSetups().length, before);
  assert.ok(rep.crypto.warnings.some((w) => w.startsWith('CRYPTO_JOURNAL_UNAVAILABLE')));
});
