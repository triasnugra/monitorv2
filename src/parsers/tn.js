import { parseTime } from '../util/time.js';

/*
 * tn (/tn/). Sumber: data/journal.json (file yang juga dimuat halaman /tn/).
 * Field yang dipakai: id, waktu, t, aset, arah, entry, sl, tp, alasan, hasil, R, h.
 * Field lain (harga_awal, due, engine, fwd, seq, prev, tx, bm, bi, alert, keyakinan)
 * disimpan utuh di rawData dan TIDAK ditafsirkan. Arti bm/bi belum diverifikasi.
 * Entry tercatat "Entry limit" pada kartu DOM /tn/ (24 kemunculan di rendered.html).
 */
// journal.json TIDAK memuat field timeframe. Nilai ini diturunkan dari kode tn (core.mjs):
// sinyal dihitung dari candle harian Binance (interval=1d), horizon 7 hari (due = t + 7 hari).
// Konfirmasi 4H/12H di halaman /tn hanya filter tambahan, bukan timeframe sinyal.
// Ini turunan dari kode, bukan data sumber; ubah konstanta ini bila definisinya berbeda.
export const TN_TIMEFRAME = '1D';

export function parseJournalEntry(e) {
  const warnings = [];
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const tMs = num(e.t);
  const wMs = parseTime(e.waktu);
  if (tMs != null && wMs != null && Math.abs(tMs - wMs) > 60_000) {
    warnings.push(`TIME_MISMATCH: t=${tMs} waktu=${e.waktu}`);
  }
  return {
    engine: 'tn',
    ticker: e.aset,
    direction: e.arah,
    entryType: 'limit',
    entryPrice: num(e.entry),
    entryRange: null,
    takeProfit: [num(e.tp)],
    stopLoss: num(e.sl),
    entryReason: e.alasan || null,
    timeframe: TN_TIMEFRAME,
    originalStatus: e.hasil || null,
    sourceResult: e.hasil || null,
    sourceR: num(e.R),
    analysisTimeMs: tMs ?? wMs,
    analysisTimeSource: 'source',
    // h = hash rantai per entri (unik). Tidak memakai level harga: BTC SHORT 86620 muncul di dua hari.
    idKey: `tn|${e.h ?? e.id}`,
    rawData: e,
    warnings,
  };
}
