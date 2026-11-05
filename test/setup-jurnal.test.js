import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Setup (siap eksekusi) dan Jurnal (riwayat lengkap) harus dicatat di berkas terpisah.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sj-'));
process.env.DATA_DIR = path.join(tmp, 'data');
const { collect, build, evaluateAll: evaluateAllImport } = await import('../src/index.js');
const store = await import('../src/storage/store.js');
const { execState, accOf, jurnalScore } = await import('../src/aggregate.js');
const { findJournalMatch } = await import('../src/live.js');

const read = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const journal = read('tnv2-journal-items.json');           // 22 baris: 8 TP, 9 SL, 5 menunggu
const settings = { cancelPatterns: ['batal'], rawRetentionPerEngine: 3, entryTtlHours: 72, maxHoldDays: 30, sanityMaxDeviation: 0.5,
  minSamplePerEngine: 30, bootstrapIterations: 50, pairWindowMinutes: 120, cluster: { windowHours: 24, entryTolerance: 0.01 }, binanceBaseUrls: [] };
const T1 = Date.parse('2026-10-29T03:00:00Z');
const okDiag = () => ({ errors: [], warnings: [], httpStatus: null, durationMs: 1, meta: { summaryCount: null } });

// Kartu "Sinyal setup" seperti keluaran extractTnv2Cards.
const tnCard = (ticker, direction, entry, sl, tp, status = 'AKTIF') => ({
  ticker, direction, chips: [direction, status],
  rows: [{ label: 'Entry limit', value: String(entry) }, { label: 'SL 3.0%', value: String(sl) }, { label: 'TP 2R', value: String(tp) }, { label: 'Target range', value: String(tp) }],
  notes: ['Harga 250 · jarak ke entry 1.1% · swing', '4H/12H: searah', 'Tren naik'], size: 'Risiko $10: qty 1.3', rawText: `${ticker} ${direction}`,
});
const tao = tnCard('TAO', 'LONG', 247.3, 239.88, 262.14);        // ADA di jurnal (SL)
const msb = tnCard('MSTRB', 'SHORT', 144.8, 149.14, 136.11);     // ADA di jurnal (TP)
const baru = tnCard('NEWCOIN', 'LONG', 1.5, 1.4, 1.7);           // belum ada di jurnal

const scan = (liveCards, items = journal) => async () => ({ status: 'OK', items: structuredClone(items), liveCards, diagnostics: okDiag() });
const run = (now, scrapeEngine, meta) => collect({ engines: ['tnv2'], sources: { tnv2: { url: 'u' } }, settings, now, scrapeEngine, meta });
const meta = { trackingStartedUtc: {} };

test('Setup dan Jurnal disimpan di dua berkas berbeda dengan isi berbeda', async () => {
  const rep = await run(T1, scan({ items: [tao, msb, baru], confirmed: true, rejected: 32 }), meta);
  assert.equal(rep.tnv2.added, 22);
  assert.deepEqual(rep.tnv2.setup, { count: 3, stale: false, rejected: 32 });
  const dir = process.env.DATA_DIR;
  assert.ok(fs.existsSync(path.join(dir, 'jurnal.json')) && fs.existsSync(path.join(dir, 'setup.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'setups.json')), 'tidak boleh menulis berkas lama');
  assert.equal(store.loadJurnal().length, 22);                       // jurnal = semua riwayat
  assert.equal(store.loadLive().engines.tnv2.items.length, 3);       // setup = hanya yang siap
  assert.ok(store.loadJurnal().every((j) => j.setupId && !j.liveId));
  assert.ok(store.loadLive().engines.tnv2.items.every((x) => x.liveId && !x.evaluation));
});

test('setup siap yang cocok ditautkan ke jurnal; jurnal menandai "pernah di Setup"', () => {
  const live = store.loadLive().engines.tnv2.items;
  const j = store.loadJurnal();
  assert.ok(live.find((x) => x.ticker === 'TAO').journalId);
  assert.equal(live.find((x) => x.ticker === 'NEWCOIN').journalId, null);
  const ready = j.filter((x) => x.readyEver).map((x) => x.ticker).sort();
  assert.deepEqual(ready, ['MSTRB', 'TAO']);
  assert.equal(j.find((x) => x.ticker === 'TAO').readyFirstSeenUtc, new Date(T1).toISOString());
});

test('scan berikutnya: firstSeen tetap, setup yang hilang dari filter keluar dari Setup tetapi tetap ada di Jurnal', async () => {
  await run(T1 + 1800e3, scan({ items: [tao], confirmed: true, rejected: 33 }), meta);
  const items = store.loadLive().engines.tnv2.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].seenCount, 2);
  assert.equal(items[0].firstSeenUtc, new Date(T1).toISOString());
  assert.equal(store.loadJurnal().length, 22);
  assert.ok(store.loadJurnal().find((x) => x.ticker === 'MSTRB').readyEver, 'jejak pernah-siap tidak hilang');
});

test('pembacaan kartu gagal / tidak terkonfirmasi: daftar Setup lama dipertahankan (stale), tidak dikosongkan', async () => {
  const rep = await run(T1 + 3600e3, scan(null), meta);
  const st = store.loadLive().engines.tnv2;
  assert.equal(st.stale, true);
  assert.equal(st.items.length, 1);
  assert.ok(rep.tnv2.warnings.some((w) => w.startsWith('SETUP_STALE')));
  const rep2 = await run(T1 + 5400e3, scan({ items: [], confirmed: false }), meta);
  assert.equal(store.loadLive().engines.tnv2.items.length, 1);
  assert.equal(rep2.tnv2.setup.stale, true);
});

test('daftar kosong yang TERKONFIRMASI mengosongkan Setup; jurnal tidak tersentuh', async () => {
  await run(T1 + 7200e3, scan({ items: [], confirmed: true, rejected: 33 }), meta);
  const st = store.loadLive().engines.tnv2;
  assert.equal(st.stale, false);
  assert.equal(st.items.length, 0);
  assert.equal(store.loadJurnal().length, 22);
});

test('crypto: kartu masuk Setup dan Jurnal dengan ID yang sama', async () => {
  const card = { ticker: 'AVAX', direction: 'LONG', chips: ['LONG', '1D, trend', 'Aktif'],
    rows: [{ label: 'Entry limit', value: '10.5' }, { label: 'SL 3.4%', value: '10.14' }, { label: 'TP1', value: '11.4' }, { label: 'Rasio ke target akhir', value: '2.5R' }],
    notes: ['Retest support. Harga 10.7', 'Konfirmasi: volume'], size: 'Risiko $10: qty 18.5 AVAX, nilai posisi $214', rawText: 'AVAX' };
  const rep = await collect({ engines: ['crypto'], sources: { crypto: { url: 'u' } }, settings, now: T1 + 9000e3, meta,
    scrapeEngine: async () => ({ status: 'OK', items: [structuredClone(card)], diagnostics: okDiag() }) });
  assert.equal(rep.crypto.setup.count, 1);
  const live = store.loadLive().engines.crypto.items[0];
  const jr = store.loadJurnal().find((x) => x.engine === 'crypto');
  assert.equal(live.journalId, jr.setupId);
  assert.equal(jr.readyEver, true);
  assert.equal(live.cardStatus, 'Aktif');
});

test('dashboard: tab Setup dan tab Jurnal punya data terpisah, jurnal memuat terpakai & akurasi', () => {
  const d = build({ settings, now: T1 + 9000e3, siteDataDir: path.join(tmp, 'site') });
  assert.equal(d.counts.jurnal, d.jurnal.length);
  assert.equal(d.counts.setupSiap, 1);                                // hanya AVAX crypto yang siap saat ini
  assert.equal(d.live.engines.tnv2.count, 0);
  assert.equal(d.live.engines.crypto.items[0].inJurnal, true);
  const s = d.jurnalStats.source.tnv2.semua;
  assert.deepEqual([s.generated, s.terpakai, s.tp, s.sl, s.menunggu], [22, 17, 8, 9, 5]);
  assert.equal(s.tidakTerpakai, 0);
  assert.ok(Math.abs(s.akurasi - 8 / 17) < 1e-9);
  assert.equal(d.jurnalStats.source.tnv2.pernahSetup.generated, 2);   // TAO + MSTRB pernah lolos ke Setup
  const row = d.jurnal.find((r) => r.engine === 'tnv2' && r.ticker === 'MSTRB');
  assert.deepEqual([row.execSrc, row.accSrc, row.readyEver], ['TERPAKAI', 'AKURAT', true]);
  const sl = d.jurnal.find((r) => r.engine === 'tnv2' && r.ticker === 'FET');
  assert.deepEqual([sl.execSrc, sl.accSrc, sl.readyEver], ['TERPAKAI', 'MELESET', false]);
});

test('status terpakai: TP/SL = terpakai; kedaluwarsa/batal = tidak terpakai; pending = menunggu/berjalan', () => {
  assert.equal(execState('TP'), 'TERPAKAI');
  assert.equal(execState('SL'), 'TERPAKAI');
  assert.equal(execState('EXPIRED'), 'TIDAK_TERPAKAI');
  assert.equal(execState('CANCELLED'), 'TIDAK_TERPAKAI');
  assert.equal(execState('PENDING', null), 'MENUNGGU');
  assert.equal(execState('PENDING', '2026-10-29T00:00:00Z'), 'BERJALAN');
  assert.equal(execState('AMBIGUOUS'), 'TAK_TERNILAI');
  assert.equal(accOf('TP'), 'AKURAT'); assert.equal(accOf('SL'), 'MELESET'); assert.equal(accOf('EXPIRED'), null);
  const sc = jurnalScore([{ evaluation: { result: 'TP' } }, { evaluation: { result: 'SL' } }, { evaluation: { result: 'EXPIRED' } }, { evaluation: { result: 'PENDING' } }]);
  assert.equal(sc.akurasi, 0.5);
  assert.ok(Math.abs(sc.tingkatEksekusi - 2 / 3) < 1e-9);             // hanya yang sudah final: 2 terpakai dari 3
});

test('pencocokan setup-jurnal tidak menyamakan arah/koin berbeda', () => {
  const j = [{ setupId: 'a', engine: 'tn', ticker: 'BTC', direction: 'LONG', entryPrice: 100, analysisTimeUtc: '2026-01-01T00:00:00Z' },
    { setupId: 'b', engine: 'tn', ticker: 'BTC', direction: 'SHORT', entryPrice: 100, analysisTimeUtc: '2026-01-02T00:00:00Z' },
    { setupId: 'c', engine: 'tn', ticker: 'BTC', direction: 'LONG', entryPrice: 100.01, analysisTimeUtc: '2026-01-03T00:00:00Z' }];
  assert.equal(findJournalMatch(j, { engine: 'tn', ticker: 'BTC', direction: 'LONG', entryPrice: 100, journalId: null }).setupId, 'c');
  assert.equal(findJournalMatch(j, { engine: 'tn', ticker: 'BTC', direction: 'LONG', entryPrice: 105, journalId: null }), null);
});

test('berkas lama data/setups.json tetap terbaca sebagai jurnal bila jurnal.json belum ada', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-legacy-'));
  fs.writeFileSync(path.join(dir, 'setups.json'), JSON.stringify([{ setupId: 'x' }]));
  const storeUrl = new URL('../src/storage/store.js', import.meta.url).href;
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-e', `const s = await import(${JSON.stringify(storeUrl)}); console.log(JSON.stringify([s.loadJurnal().map((x) => x.setupId), s.loadLive()]));`],
    { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run()), [['x'], { updatedUtc: null, engines: {} }]);
  fs.writeFileSync(path.join(dir, 'jurnal.json'), JSON.stringify([{ setupId: 'y' }]));   // jurnal.json menang atas berkas lama
  assert.deepEqual(JSON.parse(run())[0], ['y']);
});

// ---- Lineage: jurnal mesin turunan memuat salinan sinyal v1; hanya sinyal milik mesin yang dinilai ----
const V1 = '0537067ed55fc5be', V2 = 'cdaa11430a4b55e8';
const ent = (aset, arah, entry, engine, extra = {}) => ({ waktu: '2026-11-04 03:58 UTC', t: Date.parse('2026-11-04T03:58:10Z'), aset, arah, entry, sl: entry * (arah === 'LONG' ? 0.97 : 1.03), tp: entry * (arah === 'LONG' ? 1.06 : 0.94),
  hasil: 'TP', R: 2, alasan: 'x', h: `h-${aset}`, ...(engine ? { engine } : {}), _src: 'json+dom', ...extra });
const mix = [ent('WLDX', 'LONG', 0.3687, V1), ent('ADAX', 'LONG', 0.1875, V1), ent('TAOX', 'LONG', 221, V2), ent('LTCX', 'LONG', 53.6, V2),
  ent('OLDX', 'LONG', 5, null), ent('TBLX', 'LONG', 7, null, { _src: 'dom' })];
const lin = { tnv2: { url: 'u', inheritedEngineIds: [V1] }, tnv2c2: { url: 'u', inheritedEngineIds: [V1] } };

test('lineage: classifyItem memisahkan milik sendiri, salinan v1, dan yang tidak bisa dipastikan', async () => {
  const { classifyItem, splitItems } = await import('../src/lineage.js');
  assert.equal(classifyItem(ent('A', 'LONG', 1, V1), lin.tnv2), 'inherited_v1');
  assert.equal(classifyItem(ent('A', 'LONG', 1, V2), lin.tnv2), 'own');
  assert.equal(classifyItem(ent('A', 'LONG', 1, null), lin.tnv2), 'inherited_v1');                 // entri lama tanpa engine
  assert.equal(classifyItem(ent('A', 'LONG', 1, null, { _src: 'dom' }), lin.tnv2), 'unverified');  // hanya dari tabel
  assert.equal(classifyItem(ent('A', 'LONG', 1, V1), { url: 'u' }), 'own');                        // tn/crypto: tanpa konfigurasi
  const sp = splitItems(mix, lin.tnv2);
  assert.deepEqual([sp.own.length, sp.inherited.length, sp.unverified.length], [2, 3, 1]);
  assert.deepEqual(sp.ownEngineIds, [V2]);
});

test('lineage: collect hanya mencatat sinyal milik tnv2; salinan v1 tidak masuk jurnal', async () => {
  const meta2 = { trackingStartedUtc: {} };
  const rep = await collect({ engines: ['tnv2'], sources: lin, settings, now: T1 + 20000e3, meta: meta2,
    scrapeEngine: async () => ({ status: 'OK', items: structuredClone(mix), liveCards: null, diagnostics: okDiag() }) });
  assert.deepEqual(rep.tnv2.lineage, { own: 2, inherited: 3, unverified: 1, ownEngineIds: [V2] });
  assert.ok(rep.tnv2.warnings.some((w) => w.startsWith('JOURNAL_LINEAGE_UNVERIFIED')));
  const own = store.loadJurnal().filter((s) => s.engine === 'tnv2' && s.lineage === 'own');
  assert.deepEqual(own.map((s) => s.ticker).sort(), ['LTCX', 'TAOX']);
  assert.ok(!store.loadJurnal().some((s) => ['WLDX', 'ADAX', 'OLDX', 'TBLX'].includes(s.ticker)));
});

test('lineage: record lama salinan v1 diberi tanda, disembunyikan dari statistik, tidak dihapus, dan tidak dievaluasi ulang', async () => {
  const { tagLineage, isHidden } = await import('../src/lineage.js');
  const { buildRecord } = await import('../src/normalize.js');
  const old = buildRecord({ engine: 'tnv2c2', ticker: 'ZZZ', direction: 'LONG', entryPrice: 1, takeProfit: [1.2], stopLoss: 0.9, idKey: 'old-v1', sourceResult: 'TP', analysisTimeMs: T1, analysisTimeSource: 'source', rawData: { engine: V1, _src: 'json+dom', journalSource: 'json+dom' } }, { scanTimeMs: T1, firstRun: false, sourceUrl: 'u' });
  store.saveJurnal([...store.loadJurnal(), { ...old, firstSeenUtc: 'x', lastSeenUtc: 'x', seenCount: 1, evaluation: { result: 'PENDING' } }]);
  const list = store.loadJurnal();
  assert.equal(tagLineage(list, lin), 1);
  assert.ok(isHidden(list.find((s) => s.ticker === 'ZZZ')));
  assert.equal(tagLineage(list, lin), 0);                       // idempoten
  store.saveJurnal(list);
  let calls = 0;
  await evaluateAllImport({ provider: { getCandles: async () => { calls++; return []; } }, settings, sources: lin, now: T1 + 30000e3 });
  assert.equal(store.loadJurnal().find((s) => s.ticker === 'ZZZ').evaluation.result, 'PENDING');   // dilewati
  const d = build({ settings, sources: lin, now: T1 + 30000e3, siteDataDir: path.join(tmp, 'site') });
  assert.ok(!d.jurnal.some((r) => r.ticker === 'ZZZ'));
  assert.equal(d.counts.jurnalDisembunyikan.tnv2c2, 1);
  assert.ok(store.loadJurnal().some((s) => s.ticker === 'ZZZ'), 'data tetap tersimpan');
});

test('lineage: setup siap tidak ditautkan ke salinan v1 yang disembunyikan', async () => {
  const { findJournalMatch } = await import('../src/live.js');
  const j = [{ setupId: 'v1', engine: 'tnv2', ticker: 'WLD', direction: 'LONG', entryPrice: 0.3687, lineage: 'inherited_v1', analysisTimeUtc: '2026-11-04T00:00:00Z' },
    { setupId: 'own', engine: 'tnv2', ticker: 'WLD', direction: 'LONG', entryPrice: 0.3687, lineage: 'own', analysisTimeUtc: '2026-11-03T00:00:00Z' }];
  assert.equal(findJournalMatch(j, { engine: 'tnv2', ticker: 'WLD', direction: 'LONG', entryPrice: 0.3687, journalId: null }).setupId, 'own');
});

test('lineage: config/sources.json mendefinisikan inheritedEngineIds untuk ketujuh mesin', async () => {
  const { ENGINE_IDS } = await import('../src/engines.js');
  const { classifyItem } = await import('../src/lineage.js');
  const cfg = JSON.parse(fs.readFileSync(new URL('../config/sources.json', import.meta.url), 'utf8'));
  assert.deepEqual(ENGINE_IDS, ['crypto', 'tn', 'tnv2', 'tnv2c2', 'dseek', 'grox', 'chatgpt']);
  for (const e of ENGINE_IDS) assert.ok(Array.isArray(cfg[e].inheritedEngineIds), `${e}: inheritedEngineIds wajib ada`);
  // crypto dan tn = sumber v1: semuanya milik sendiri, termasuk entri v1 dan entri lama tanpa engine.
  for (const e of ['crypto', 'tn']) {
    assert.equal(classifyItem(ent('A', 'LONG', 1, V1), cfg[e]), 'own');
    assert.equal(classifyItem(ent('A', 'LONG', 1, null), cfg[e]), 'own');
  }
  // turunan terverifikasi: salinan v1 dan entri lama dikecualikan, engine lain milik sendiri, hanya-tabel tidak dipastikan.
  for (const e of ['tnv2', 'tnv2c2', 'chatgpt']) {
    assert.equal(classifyItem(ent('A', 'LONG', 1, V1), cfg[e]), 'inherited_v1', e);
    assert.equal(classifyItem(ent('A', 'LONG', 1, null), cfg[e]), 'inherited_v1', e);
    assert.equal(classifyItem(ent('A', 'LONG', 1, V2), cfg[e]), 'own', e);
    assert.equal(classifyItem(ent('A', 'LONG', 1, null, { _src: 'dom' }), cfg[e]), 'unverified', e);
  }
  // dseek: rantai bersih sejak awal -> entri tanpa engine dan hanya-tabel milik sendiri; hash v1 tetap dikecualikan.
  assert.equal(classifyItem(ent('A', 'LONG', 1, null), cfg.dseek), 'own');
  assert.equal(classifyItem(ent('A', 'LONG', 1, null, { _src: 'dom' }), cfg.dseek), 'own');
  assert.equal(classifyItem(ent('A', 'LONG', 1, V1), cfg.dseek), 'inherited_v1');
  // grox: struktur belum terverifikasi -> entri hanya-tabel tidak dicatat.
  assert.equal(classifyItem(ent('A', 'LONG', 1, null), cfg.grox), 'own');
  assert.equal(classifyItem(ent('A', 'LONG', 1, null, { _src: 'dom' }), cfg.grox), 'unverified');
});

test('NO_TRADE: ditolak filter mesin -> CANCELLED (tidak terpakai), tidak dievaluasi dari candle', async () => {
  const { mapSourceResult, sourceEvaluation } = await import('../src/sourceEval.js');
  assert.deepEqual(mapSourceResult('NO_TRADE'), { result: 'CANCELLED', reasonCode: 'SOURCE_NO_TRADE' });
  assert.equal(mapSourceResult('no trade').result, 'CANCELLED');
  const { buildRecord } = await import('../src/normalize.js');
  const rec = buildRecord({ engine: 'chatgpt', ticker: 'NTX', direction: 'LONG', entryPrice: 1, takeProfit: [1.2], stopLoss: 0.9, idKey: 'nt', sourceResult: 'NO_TRADE', originalStatus: 'NO_TRADE',
    analysisTimeMs: T1, analysisTimeSource: 'source', rawData: { alasan: 'x | FILTER: Target sudah tercapai sebelum entry; set', engine: V2, _src: 'json+dom' } }, { scanTimeMs: T1, firstRun: false, sourceUrl: 'u' });
  store.saveJurnal([...store.loadJurnal(), { ...rec, firstSeenUtc: 'x', lastSeenUtc: 'x', seenCount: 1, evaluation: { result: 'PENDING' } }]);
  let calls = 0;
  await evaluateAllImport({ provider: { getCandles: async () => { calls++; return []; } }, settings, now: T1 + 40000e3 });
  const s = store.loadJurnal().find((x) => x.ticker === 'NTX');
  assert.equal(s.evaluation.result, 'CANCELLED');
  assert.equal(s.evaluation.reasonCode, 'SOURCE_NO_TRADE');
  assert.match(s.evaluation.notes[0], /Target sudah tercapai sebelum entry/);
  assert.equal(sourceEvaluation(s).result, 'CANCELLED');
  const { execState } = await import('../src/aggregate.js');
  assert.equal(execState('CANCELLED'), 'TIDAK_TERPAKAI');
});
