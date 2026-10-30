import { MIN, toIso } from '../util/time.js';

export const STATUS = Object.freeze({
  PENDING: 'PENDING', TP: 'TP', SL: 'SL', CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED', INVALID: 'INVALID', AMBIGUOUS: 'AMBIGUOUS',
});
export const FINAL = new Set(['TP', 'SL', 'CANCELLED', 'EXPIRED', 'INVALID', 'AMBIGUOUS']);
const BASE_MS = 15 * MIN;
const DEFAULTS = { entryTtlHours: 72, maxHoldDays: 30, sanityMaxDeviation: 0.5 };

/** Validasi level & arah. Hanya TP pertama dipakai sebagai target evaluasi (lihat README). */
export function validateSetup(s) {
  const dir = s.direction;
  if (dir !== 'LONG' && dir !== 'SHORT') return { ok: false, reason: 'BAD_DIRECTION' };
  const tp = Array.isArray(s.takeProfit) ? s.takeProfit[0] : s.takeProfit;
  const sl = s.stopLoss;
  if (!Number.isFinite(tp) || !Number.isFinite(sl)) return { ok: false, reason: 'MISSING_TP_OR_SL' };
  const market = s.entryType === 'market';
  let lo = null, hi = null;
  if (Array.isArray(s.entryRange) && s.entryRange.length === 2) {
    lo = Math.min(...s.entryRange); hi = Math.max(...s.entryRange);
  } else if (Number.isFinite(s.entryPrice)) lo = hi = s.entryPrice;
  if (!market) {
    if (lo == null) return { ok: false, reason: 'MISSING_ENTRY' };
    const good = dir === 'LONG' ? sl < lo && hi < tp : tp < lo && hi < sl;
    if (!good) return { ok: false, reason: `LEVELS_INCONSISTENT_WITH_${dir}` };
  } else if (dir === 'LONG' ? !(sl < tp) : !(tp < sl)) {
    return { ok: false, reason: `LEVELS_INCONSISTENT_WITH_${dir}` };
  }
  return { ok: true, tp, sl, lo, hi, market };
}

/** Satu langkah state-machine pada satu candle. Tidak menebak urutan intra-candle. */
function step(c, st, v, long) {
  const hitTP = long ? c.h >= v.tp : c.l <= v.tp;
  const hitSL = long ? c.l <= v.sl : c.h >= v.sl;
  if (st.phase === 'waiting') {
    if (v.market) st = { phase: 'open', fill: c.o, entryT: c.t };
    else {
      const touch = long ? c.l <= v.hi : c.h >= v.lo;
      if (!touch) return hitTP ? { st, ev: { type: 'EXPIRED', reason: 'TP_REACHED_BEFORE_ENTRY', t: c.t } } : { st };
      if (hitTP) return { st, ev: { type: 'AMBIGUOUS', reason: 'ENTRY_AND_TP_ORDER_UNKNOWN', t: c.t } };
      st = { phase: 'open', fill: long ? v.hi : v.lo, entryT: c.t };
      return hitSL ? { st, ev: { type: 'SL', t: c.t, price: v.sl } } : { st };
    }
  }
  if (hitTP && hitSL) return { st, ev: { type: 'AMBIGUOUS', reason: 'TP_AND_SL_SAME_CANDLE', t: c.t } };
  if (hitTP) return { st, ev: { type: 'TP', t: c.t, price: v.tp } };
  if (hitSL) return { st, ev: { type: 'SL', t: c.t, price: v.sl } };
  return { st };
}

export async function evaluateSetup(setup, provider, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
  const now = opts.now ?? Date.now();
  const base = { evaluatedAtUtc: toIso(now), entryTimeUtc: null, entryFill: null, resultTimeUtc: null,
    resultPrice: null, rMultiple: null, resultTimeSource: null, interval: null, candlesUsed: 0,
    gaps: 0, notes: [], reasonCode: null };
  const done = (result, extra = {}) => ({ ...base, result, ...extra });

  if (setup.analysisTimeSource === 'unknown_before_tracking')
    return done('INVALID', { reasonCode: 'ANALYSIS_TIME_UNKNOWN', notes: ['Setup sudah ada sebelum pelacakan dimulai; waktu analisis tidak diketahui, jadi tidak dievaluasi.'] });
  const v = validateSetup(setup);
  if (!v.ok) return done('INVALID', { reasonCode: v.reason, notes: [`Setup tidak valid: ${v.reason}`] });
  const long = setup.direction === 'LONG';
  const aMs = Date.parse(setup.analysisTimeUtc);
  if (Number.isNaN(aMs)) return done('INVALID', { reasonCode: 'BAD_ANALYSIS_TIME', notes: ['analysisTimeUtc tidak valid'] });
  if (!setup.symbol) return done('INVALID', { reasonCode: 'MISSING_SYMBOL', notes: ['symbol kosong'] });

  const cancelMs = setup.engineCancelledAtUtc ? Date.parse(setup.engineCancelledAtUtc) : Infinity;
  const startMs = Math.ceil(aMs / MIN) * MIN;               // candle yang sudah berjalan saat analisis dibuang
  const boundary = Math.ceil(startMs / BASE_MS) * BASE_MS;  // 1m sampai batas 15m, lalu 15m
  const closed = (c, ms) => c.t + ms <= now;
  const prefix = (await provider.getCandles(setup.symbol, '1m', startMs, Math.min(boundary, now)))
    .filter((c) => closed(c, MIN)).map((c) => ({ ...c, ms: MIN }));
  const coarse = boundary < now
    ? (await provider.getCandles(setup.symbol, '15m', boundary, now)).filter((c) => closed(c, BASE_MS)).map((c) => ({ ...c, ms: BASE_MS }))
    : [];
  const all = [...prefix, ...coarse];
  base.interval = '1m (sampai batas 15m) + 15m, dipertajam ke 1m saat ada kejadian';
  base.candlesUsed = all.length;

  if (all.length === 0) {
    if (Number.isFinite(cancelMs) && cancelMs <= now)
      return done('CANCELLED', { resultTimeUtc: toIso(cancelMs), resultTimeSource: 'scraper', notes: ['Dibatalkan mesin sebelum ada candle tertutup.'] });
    return done('PENDING', { reasonCode: 'NO_CLOSED_CANDLES_YET', notes: ['Belum ada candle tertutup setelah waktu analisis.'] });
  }
  const dev = Math.abs(all[0].o - (v.lo ?? v.tp)) / all[0].o;
  if (dev > cfg.sanityMaxDeviation)
    return done('INVALID', { reasonCode: 'PRICE_SANITY', notes: [`Level menyimpang ${(dev * 100).toFixed(0)}% dari harga pasar; kemungkinan salah parse format angka.`] });
  for (let i = 1; i < all.length; i++) if (all[i].t > all[i - 1].t + all[i - 1].ms) base.gaps++;

  const ttlMs = cfg.entryTtlHours * 3600_000, holdMs = cfg.maxHoldDays * 86400_000;
  let st = { phase: 'waiting' };
  const R = (type, fill, price) => (type === 'TP' ? Math.abs(price - fill) / Math.abs(fill - v.sl) : -1);

  const finish = (ev, st2, fineUsed) => {
    const common = { entryTimeUtc: st2.entryT != null ? toIso(st2.entryT) : null, entryFill: st2.fill ?? null,
      resultTimeUtc: toIso(ev.t), resultTimeSource: 'candle', resultPrice: ev.price ?? null,
      reasonCode: ev.reason ?? null, interval: fineUsed ? '1m' : base.interval };
    if (ev.type === 'TP' || ev.type === 'SL') {
      const r = R(ev.type, st2.fill, ev.price);
      return done(ev.type, { ...common, rMultiple: r,
        notes: [ev.type === 'TP'
          ? 'TP tersentuh setelah entry terpicu; waktu dan harga diverifikasi menggunakan data candle.'
          : 'SL tersentuh setelah entry terpicu; waktu dan harga diverifikasi menggunakan data candle.',
          'Waktu = awal candle 1m tempat level pertama kali tersentuh. Harga eksekusi teoretis = level TP/SL; tanpa fee/slippage.'] });
    }
    return done(ev.type, { ...common, notes: [`${ev.type}: ${ev.reason}`] });
  };

  for (const c of all) {
    if (st.phase === 'waiting' && c.t >= cancelMs)
      return done('CANCELLED', { resultTimeUtc: toIso(cancelMs), resultTimeSource: 'scraper',
        notes: ['Dibatalkan mesin sebelum entry terpicu (waktu = deteksi scraper, bukan bukti harga).'] });
    if (st.phase === 'waiting' && c.t - aMs > ttlMs)
      return gapAware(done, base, 'EXPIRED', 'ENTRY_TTL', aMs + ttlMs, 'Entry tidak tersentuh dalam batas waktu evaluasi.');
    if (st.phase === 'open' && c.t - aMs > holdMs)
      return gapAware(done, base, 'EXPIRED', 'MAX_HOLD_EXCEEDED', aMs + holdMs, 'Entry terpicu tetapi TP/SL belum tercapai dalam batas waktu; tidak dihitung sebagai menang/kalah.', st);

    const r = step(c, st, v, long);
    if (c.ms === MIN) { st = r.st; if (r.ev) return finish(r.ev, st, true); continue; }
    if (!r.ev && r.st.phase === st.phase) continue;           // tidak ada kejadian di candle ini

    // Ada kejadian di candle 15m -> pertajam dengan candle 1m (tidak menebak urutan).
    const fine = await provider.getCandles(setup.symbol, '1m', c.t, c.t + c.ms);
    if (fine.length < c.ms / MIN)
      return finish({ type: 'AMBIGUOUS', reason: 'FINE_DATA_MISSING', t: c.t }, st, false);
    let cur = st, fev = null;
    for (const f of fine) {
      const rr = step({ ...f, ms: MIN }, cur, v, long);
      cur = rr.st; if (rr.ev) { fev = rr.ev; break; }
    }
    if (fev) return finish(fev, cur, true);
    if (r.ev) return finish({ type: 'AMBIGUOUS', reason: 'FINE_COARSE_MISMATCH', t: c.t }, st, false);
    st = cur;
  }
  if (st.phase === 'waiting' && Number.isFinite(cancelMs) && cancelMs <= now)
    return done('CANCELLED', { resultTimeUtc: toIso(cancelMs), resultTimeSource: 'scraper', notes: ['Dibatalkan mesin sebelum entry terpicu.'] });
  const open = st.phase === 'open';
  return done('PENDING', { entryTimeUtc: open ? toIso(st.entryT) : null, entryFill: open ? st.fill : null,
    reasonCode: open ? 'IN_TRADE' : 'WAITING_ENTRY', notes: [open ? 'Entry terpicu; menunggu TP/SL.' : 'Menunggu entry tersentuh.'] });
}

function gapAware(done, base, type, reason, tMs, note, st) {
  const extra = { resultTimeUtc: toIso(tMs), resultTimeSource: 'timeout', reasonCode: reason,
    entryTimeUtc: st?.entryT != null ? toIso(st.entryT) : null, entryFill: st?.fill ?? null };
  if (base.gaps > 0)
    return done('AMBIGUOUS', { ...extra, reasonCode: 'DATA_GAP_BLOCKS_EXPIRY', notes: [`Ada ${base.gaps} celah data candle; kedaluwarsa tidak dapat dipastikan.`] });
  return done(type, { ...extra, notes: [note] });
}
