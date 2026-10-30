import { toIso } from './util/time.js';

/*
 * Evaluasi "menurut mesin": memetakan `hasil` yang ditampilkan website mesin ke status monitor,
 * tanpa menghitung ulang dari candle. Dipakai agar angka monitor sama dengan yang tertampil di website.
 *   TP / SL            -> TP / SL (R dari kolom R mesin; fallback R dari level)
 *   menunggu / kosong  -> PENDING
 *   kedaluwarsa        -> EXPIRED
 *   tidak terisi       -> EXPIRED (entry tidak pernah terisi)
 *   batal / cancel     -> CANCELLED
 *   lainnya            -> AMBIGUOUS (teks tidak dikenal, tidak ditebak)
 * Mesin tanpa hasil sumber (crypto) memakai evaluasi candle apa adanya.
 */
export function mapSourceResult(raw) {
  const h = String(raw ?? '').trim().toLowerCase();
  if (h === 'tp') return { result: 'TP' };
  if (h === 'sl') return { result: 'SL' };
  if (h === '' || /^menunggu|^pending|^aktif/.test(h)) return { result: 'PENDING' };
  if (/tidak\s*terisi/.test(h)) return { result: 'EXPIRED', reasonCode: 'NOT_FILLED_SOURCE' };
  if (/kedaluwarsa|kadaluarsa|expired/.test(h)) return { result: 'EXPIRED', reasonCode: 'SOURCE_EXPIRED' };
  if (/batal|cancel/.test(h)) return { result: 'CANCELLED', reasonCode: 'SOURCE_CANCELLED' };
  return { result: 'AMBIGUOUS', reasonCode: 'UNKNOWN_SOURCE_RESULT' };
}

const hasSource = (s) => s.sourceResult != null || s.rawData?.hasil != null;

export function sourceEvaluation(s) {
  const base = s.evaluation ?? { result: 'PENDING' };
  if (!hasSource(s)) return base;
  const m = mapSourceResult(s.sourceResult ?? s.rawData?.hasil);
  const levelR = s.entryPrice != null && s.takeProfit?.[0] != null && s.stopLoss != null && s.entryPrice !== s.stopLoss
    ? Math.abs(s.takeProfit[0] - s.entryPrice) / Math.abs(s.entryPrice - s.stopLoss) : null;
  let rMultiple = null;
  if (m.result === 'TP') rMultiple = Number.isFinite(s.sourceR) && s.sourceR > 0 ? s.sourceR : levelR;
  if (m.result === 'SL') rMultiple = Number.isFinite(s.sourceR) && s.sourceR < 0 ? s.sourceR : -1;
  const tx = Number(s.rawData?.tx);
  const resolved = m.result === 'TP' || m.result === 'SL';
  return {
    result: m.result, reasonCode: m.reasonCode ?? null, rMultiple,
    // Mesin tidak memberi waktu entry; untuk TP/SL dianggap terpicu. Waktu hasil: `tx` jurnal bila ada.
    entryTimeUtc: resolved ? s.analysisTimeUtc : null,
    resultTimeUtc: resolved ? (Number.isFinite(tx) && tx > 0 ? toIso(tx) : s.analysisTimeUtc) : null,
    resultTimeSource: resolved ? (Number.isFinite(tx) && tx > 0 ? 'mesin (tx)' : 'mesin (perkiraan)') : null,
    notes: [`Hasil menurut mesin: "${s.sourceResult ?? s.rawData?.hasil}"`],
    basis: 'source',
  };
}

/** Salinan setup dengan evaluasi diganti hasil mesin (untuk statistik basis "mesin"). */
export const withSourceEvaluation = (s) => ({ ...s, evaluation: sourceEvaluation(s) });
