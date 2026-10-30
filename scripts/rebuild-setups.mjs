#!/usr/bin/env node
/*
 * Bangun ulang data/jurnal.json (JURNAL; dulu setups.json) dari data/raw/<mesin>/*.json (hasil scan asli) dan, opsional,
 * gabungkan dengan setups.json dari repo lain (mis. monitor + ox).
 *
 * Kenapa perlu: setups.json adalah satu file yang dibaca-ditulis utuh tiap run. Bila file itu
 * tertimpa versi lama (konflik commit / unggahan manual), setup yang sudah tercatat ikut hilang,
 * padahal file mentah di raw/ tetap utuh. Skrip ini memulihkan setup yang hilang itu.
 *
 * Aturan (sengaja konservatif):
 *  - TIDAK menghapus apa pun. Hanya menambah setup yang ada di raw/ atau di file --merge.
 *  - Evaluasi yang sudah ada dipertahankan. Setup baru diberi evaluation PENDING; jalankan
 *    `node src/index.js evaluate` sesudahnya (butuh akses Binance).
 *  - Bila sebuah setup ada di beberapa sumber: evaluasi FINAL menang atas PENDING; sama-sama
 *    final -> yang evaluatedAtUtc lebih baru; firstSeen = paling awal, lastSeen = paling akhir.
 *  - Field sumber (sourceResult, sourceR, rawData, timeframe) diperbarui dari scan raw terbaru;
 *    nilai pertama disimpan di firstSourceResult.
 *  - Default DRY-RUN. Tambahkan --write untuk benar-benar menulis.
 *
 * Pemakaian:
 *   node scripts/rebuild-setups.mjs                                  # dry-run, repo ini saja
 *   node scripts/rebuild-setups.mjs --merge=../ox/data/setups.json   # gabung dengan repo lain
 *   node scripts/rebuild-setups.mjs --merge=a.json,b.json --write
 *   opsi: --data=data (folder data)  --out=path.json (tulis ke file lain, bukan data/jurnal.json)
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const DATA = path.resolve(args.data || 'data');
process.env.DATA_DIR = DATA; // harus di-set sebelum store.js dimuat
const WRITE = args.write === true;
const mergeFiles = typeof args.merge === 'string' ? args.merge.split(',').filter(Boolean) : [];

const store = await import('../src/storage/store.js');
const { TO_RECORD } = await import('../src/index.js');
const { ENGINE_IDS } = await import('../src/engines.js');
const settings = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const iso = (s) => (s ? Date.parse(s) : NaN);
const isFinal = (s) => s.evaluation && s.evaluation.result && s.evaluation.result !== 'PENDING';
const evalTs = (s) => iso(s.evaluation?.evaluatedAtUtc) || 0;

/** Nama file raw -> ISO UTC. Format: 2026-10-16T09-14-58-371Z */
const rawNameToIso = (f) => f.replace(/\.json$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z');

// ---------- 1) kumpulkan setups.json yang ada (repo ini + --merge) ----------
const sources = [{ name: 'repo ini', list: readJson(path.join(DATA, 'jurnal.json'), null) ?? readJson(path.join(DATA, 'setups.json'), []) }];
for (const f of mergeFiles) sources.push({ name: f, list: readJson(f, null) ?? (() => { throw new Error(`Tidak bisa membaca ${f}`); })() });

function mergeTwo(a, b) {
  const better = isFinal(a) !== isFinal(b) ? (isFinal(a) ? a : b) : (evalTs(a) >= evalTs(b) ? a : b);
  const other = better === a ? b : a;
  const out = { ...better };
  out.firstSeenUtc = [a.firstSeenUtc, b.firstSeenUtc].filter(Boolean).sort()[0] ?? null;
  out.lastSeenUtc = [a.lastSeenUtc, b.lastSeenUtc].filter(Boolean).sort().at(-1) ?? null;
  out.seenCount = Math.max(a.seenCount ?? 0, b.seenCount ?? 0);
  out.engineCancelledAtUtc = [a.engineCancelledAtUtc, b.engineCancelledAtUtc].filter(Boolean).sort()[0] ?? null;
  if (out.timeframe == null && other.timeframe != null) out.timeframe = other.timeframe;
  return out;
}

const byId = new Map();
const stats = { perSource: [], dupConflicts: 0 };
for (const src of sources) {
  let added = 0;
  for (const s of src.list) {
    const cur = byId.get(s.setupId);
    if (!cur) { byId.set(s.setupId, structuredClone(s)); added++; }
    else {
      if (cur.evaluation?.result !== s.evaluation?.result) stats.dupConflicts++;
      byId.set(s.setupId, mergeTwo(cur, s));
    }
  }
  stats.perSource.push({ name: src.name, total: src.list.length, newToUnion: added });
}

// ---------- 2) putar ulang raw/ (dari kosong) ----------
const meta = store.loadMeta();
const replay = [];
const replayPerDay = {};
for (const engine of ENGINE_IDS) {
  const dir = path.join(DATA, 'raw', engine);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const started = iso(meta.trackingStartedUtc?.[engine]) || (files.length ? iso(rawNameToIso(files[0])) : NaN);
  let state = [];
  for (const f of files) {
    const tsIso = rawNameToIso(f);
    const ts = Date.parse(tsIso);
    const payload = readJson(path.join(dir, f), null);
    if (!payload || !Array.isArray(payload.items)) continue;
    if (payload.status !== 'OK' && payload.status !== 'OK_NO_SETUPS') continue; // jangan percaya scan gagal
    const firstRun = ts <= started;
    const records = [];
    for (const item of payload.items) {
      try { records.push(TO_RECORD[engine](item, { scanTimeMs: ts, firstRun, sourceUrl: '' })); } catch { /* lewati kartu rusak */ }
    }
    const up = store.upsertSetups(state, records, tsIso, settings.cancelPatterns);
    state = up.setups;
    if (up.added) replayPerDay[`${engine} ${tsIso.slice(0, 10)}`] = (replayPerDay[`${engine} ${tsIso.slice(0, 10)}`] || 0) + up.added;
  }
  replay.push(...state);
}

// ---------- 3) rekonsiliasi ----------
let recovered = 0, refreshed = 0, tfFilled = 0;
const recoveredPerDay = {};
for (const r of replay) {
  const cur = byId.get(r.setupId);
  if (!cur) {
    byId.set(r.setupId, r); // evaluation sudah 'PENDING' dari upsertSetups
    recovered++;
    const k = `${r.engine} ${r.analysisTimeUtc.slice(0, 10)}`;
    recoveredPerDay[k] = (recoveredPerDay[k] || 0) + 1;
    continue;
  }
  // Setup sudah ada: perbarui field sumber hanya bila scan raw lebih baru dari yang tercatat.
  if (iso(r.lastSeenUtc) >= iso(cur.lastSeenUtc ?? cur.firstSeenUtc)) {
    if (cur.firstSourceResult === undefined) cur.firstSourceResult = cur.sourceResult ?? null;
    if (r.sourceResult != null || r.sourceR != null) {
      if (cur.sourceResult !== r.sourceResult) refreshed++;
      cur.sourceResult = r.sourceResult ?? null;
      cur.sourceR = r.sourceR ?? null;
      cur.rawData = r.rawData ?? cur.rawData;
    }
    cur.latestOriginalStatus = r.latestOriginalStatus ?? cur.latestOriginalStatus;
    cur.lastSeenUtc = r.lastSeenUtc;
  }
  if (cur.timeframe == null && r.timeframe != null) {
    cur.timeframe = r.timeframe;
    cur.missingFields = (cur.missingFields ?? []).filter((k) => k !== 'timeframe');
    tfFilled++;
  }
}

const result = [...byId.values()].sort((a, b) => (a.analysisTimeUtc < b.analysisTimeUtc ? -1 : a.analysisTimeUtc > b.analysisTimeUtc ? 1 : a.setupId.localeCompare(b.setupId)));
const countBy = (list, f) => list.reduce((m, s) => ((m[f(s)] = (m[f(s)] || 0) + 1), m), {});

// ---------- 4) laporan ----------
console.log(`Folder data : ${DATA}`);
for (const s of stats.perSource) console.log(`Sumber      : ${s.name} -> ${s.total} setup (${s.newToUnion} baru bagi gabungan)`);
console.log(`Konflik status antar sumber (dipilih otomatis): ${stats.dupConflicts}`);
console.log(`Hasil replay raw: ${replay.length} setup unik`);
console.log(`Dipulihkan dari raw (belum ada di mana pun): ${recovered}`);
console.log(`sourceResult diperbarui: ${refreshed} | timeframe diisi: ${tfFilled}`);
console.log('Per mesin (sebelum -> sesudah):');
for (const e of ENGINE_IDS) {
  console.log(`  ${e}: ${sources[0].list.filter((s) => s.engine === e).length} -> ${result.filter((s) => s.engine === e).length}`);
}
console.log('Status evaluasi sesudah:', JSON.stringify(countBy(result, (s) => `${s.engine}:${s.evaluation?.result ?? 'null'}`)));
if (Object.keys(recoveredPerDay).length) console.log('Dipulihkan per hari:', JSON.stringify(recoveredPerDay));
if (recovered) console.log('NOTE: setup yang dipulihkan berstatus PENDING; jalankan `node src/index.js evaluate`.');

if (!WRITE) { console.log('\nDRY-RUN: tidak ada file yang ditulis. Tambahkan --write untuk menyimpan.'); process.exit(0); }

const target = typeof args.out === 'string' ? path.resolve(args.out) : path.join(DATA, 'jurnal.json');
if (fs.existsSync(target)) {
  const bak = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(target, bak);
  console.log(`Cadangan: ${bak} (hapus sebelum commit bila tidak perlu)`);
}
store.writeJsonAtomic(target, result);
console.log(`Ditulis: ${target} (${result.length} setup)`);
