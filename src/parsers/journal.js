import { parseTime } from '../util/time.js';
import { parseNumber } from '../util/num.js';

/*
 * Jurnal mesin keluarga tn (tn, tnv2, tnv2c2, dseek, chatgpt, grox).
 * Bentuk entri jurnal (sama dengan journal.json dan tabel jurnal di halaman):
 *   { waktu: '2026-10-29 01:19 UTC', t?, aset, arah, entry, sl, tp, hasil, R, alasan, h?, tx?, ... }
 * hasil (versi mesin): TP | SL | menunggu | kedaluwarsa | tidak terisi.
 *
 * Fungsi `readJournalTable` dijalankan DI DALAM browser (page.evaluate) dan DI test, jadi harus mandiri.
 */
const ALIAS = {
  waktu: ['waktu', 'time', 'tanggal', 'dibuat'],
  aset: ['aset', 'koin', 'coin', 'ticker', 'pair', 'simbol', 'symbol'],
  arah: ['arah', 'side', 'direction', 'posisi'],
  entry: ['entry', 'harga masuk'],
  sl: ['sl', 'stop loss', 'stop'],
  tp: ['tp', 'take profit', 'target'],
  hasil: ['hasil', 'status', 'result'],
  R: ['r', 'rr', 'r:r'],
  alasan: ['alasan', 'reason', 'catatan', 'alasan entry'],
};

/** Peta kolom dari baris header. Dipakai di browser dan di Node (fungsi murni). */
export function mapHeaders(headers) {
  const norm = headers.map((h) => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(ALIAS)) {
    const i = norm.findIndex((h) => aliases.includes(h));
    if (i >= 0) map[key] = i;
  }
  return map;
}
export const isJournalMap = (m) => ['aset', 'arah', 'entry', 'sl', 'tp'].every((k) => k in m);

/** Dijalankan di browser: temukan tabel jurnal (header berisi aset/arah/entry/sl/tp) dan kembalikan baris mentah. */
export function readJournalTable() {
  const A = { aset: ['aset', 'koin', 'coin', 'ticker', 'pair', 'simbol', 'symbol'], arah: ['arah', 'side', 'direction', 'posisi'], entry: ['entry', 'harga masuk'], sl: ['sl', 'stop loss', 'stop'], tp: ['tp', 'take profit', 'target'] };
  const txt = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const table of document.querySelectorAll('table')) {
    const trs = [...table.querySelectorAll('tr')];
    if (!trs.length) continue;
    const hdrRow = trs.find((tr) => tr.querySelector('th')) || trs[0];
    const headers = [...hdrRow.children].map(txt);
    const norm = headers.map((h) => h.toLowerCase());
    if (!Object.values(A).every((al) => norm.some((h) => al.includes(h)))) continue;
    const rows = trs.filter((tr) => tr !== hdrRow && !tr.querySelector('th')).map((tr) => [...tr.children].map(txt));
    out.push({ id: table.id || null, headers, rows });
  }
  return out;
}

const SCI = /^[-+]?\d+(?:\.\d+)?[eE][-+]?\d+$/;
export function num(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (x == null) return null;
  const s = String(x).trim();
  if (SCI.test(s)) { const v = Number(s); return Number.isFinite(v) ? v : null; }
  return parseNumber(s);
}

/** Baris tabel -> entri jurnal (angka diparse, teks hasil dipertahankan apa adanya). */
export function rowsToEntries({ headers, rows }) {
  const m = mapHeaders(headers);
  if (!isJournalMap(m)) return [];
  const cell = (r, k) => (k in m ? (r[m[k]] ?? '') : '');
  return rows.filter((r) => r.length && cell(r, 'aset')).map((r) => {
    const waktu = cell(r, 'waktu') || null;
    const Rraw = cell(r, 'R');
    return {
      waktu, t: parseTime(waktu ?? ''),
      aset: cell(r, 'aset'), arah: cell(r, 'arah'),
      entry: num(cell(r, 'entry')), sl: num(cell(r, 'sl')), tp: num(cell(r, 'tp')),
      hasil: cell(r, 'hasil') || null, R: Rraw === '' ? '' : num(Rraw),
      alasan: cell(r, 'alasan') || null, h: null,
    };
  });
}

/** Menit (epoch) entri: dari teks `waktu` bila bisa diparse, jika tidak dari `t`. Sama untuk JSON dan tabel. */
export const minuteOf = (e) => {
  const ms = parseTime(e.waktu ?? '') ?? (typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : null);
  return ms == null ? String(e.waktu ?? '').trim() : Math.floor(ms / 60_000);
};
/** Kunci identitas entri lintas sumber (JSON vs tabel): menit + aset + arah + entry. */
export const entryKey = (e) => `${minuteOf(e)}|${String(e.aset).toUpperCase()}|${String(e.arah).toUpperCase()}|${num(e.entry)}`;

/** Entri jurnal -> input buildRecord untuk mesin `engine` (journal-web). */
export function parseWebJournalEntry(e, engine, timeframe = null) {
  const warnings = [];
  const tMs = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : parseTime(e.waktu ?? '');
  const wMs = parseTime(e.waktu ?? '');
  if (tMs != null && wMs != null && Math.abs(tMs - wMs) > 60_000) warnings.push(`TIME_MISMATCH: t=${tMs} waktu=${e.waktu}`);
  const R = num(e.R);
  return {
    engine,
    ticker: e.aset,
    direction: e.arah,
    entryType: 'limit',
    entryPrice: num(e.entry),
    entryRange: null,
    takeProfit: [num(e.tp)],
    stopLoss: num(e.sl),
    entryReason: e.alasan || null,
    timeframe,
    originalStatus: e.hasil || null,
    sourceResult: e.hasil || null,
    sourceR: R,
    analysisTimeMs: tMs,
    analysisTimeSource: tMs != null ? 'source' : undefined,
    // Waktu (menit) + aset + arah + entry: sama persis di JSON dan di tabel, sehingga ID stabil walau sumbernya berganti.
    idKey: `${engine}|${entryKey(e)}`,
    rawData: { ...e, journalSource: e._src ?? null },
    warnings,
  };
}
