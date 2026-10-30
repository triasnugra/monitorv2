import { createHash } from 'node:crypto';
import { buildRecord } from './normalize.js';
import { parseCryptoCard } from './parsers/crypto.js';
import { parseTnv2Card } from './parsers/tnv2.js';

/*
 * SETUP (siap dieksekusi): kartu "Sinyal setup" yang LOLOS filter/gerbang tiap mesin, dibaca dari halaman mesin.
 * Dicatat TERPISAH dari Jurnal (data/setup.json). Ini snapshot kondisi terakhir per mesin, bukan riwayat:
 * riwayat lengkap (dan hasil TP/SL) ada di Jurnal. Hubungan keduanya ditandai lewat `journalId` dan
 * `readyEver` pada record jurnal.
 */

const hash = (x) => createHash('sha1').update(String(x)).digest('hex').slice(0, 12);

/** Kartu mentah -> record setup siap. Mesin `crypto` memakai parser kartunya; keluarga tn memakai parser kartu tn. */
export function buildLiveRecord(engine, card, ctx) {
  const parsed = engine === 'crypto' ? parseCryptoCard(card) : { ...parseTnv2Card(card), engine };
  const rec = buildRecord(parsed, ctx);
  const raw = rec.rawData ?? {};
  const tp = rec.takeProfit?.[0] ?? null;
  return {
    liveId: `${engine}-live-${hash(`${engine}|${rec.ticker}|${rec.direction}|${rec.entryRange ? rec.entryRange.join('-') : rec.entryPrice}|${tp}|${rec.stopLoss}`)}`,
    engine, ticker: rec.ticker, symbol: rec.symbol, direction: rec.direction, entryType: rec.entryType,
    entryPrice: rec.entryPrice, entryRange: rec.entryRange, takeProfit: rec.takeProfit, stopLoss: rec.stopLoss,
    riskReward: rec.riskReward, riskAmountUsd: rec.riskAmountUsd, quantity: rec.quantity, timeframe: rec.timeframe,
    cardStatus: rec.originalStatus, reason: rec.entryReason,
    price: raw.price ?? null, distToEntryPct: raw.distToEntryPct ?? null, confirmation: raw.confirmation ?? null,
    slDistancePct: raw.slDistancePct ?? null, tpLabel: raw.tpLabel ?? null,
    // Hanya mesin crypto yang ID kartunya identik dengan ID jurnal (sama-sama dari buildRecord).
    journalId: engine === 'crypto' ? rec.setupId : null,
  };
}

const sameLevel = (a, b, tol = 0.0005) => a != null && b != null && (a === b || Math.abs(a - b) <= Math.abs(a) * tol);

/**
 * Cari record jurnal yang cocok dengan satu setup siap (mesin keluarga tn: ticker + arah + entry).
 * Dipilih yang analisisnya paling baru. Mengembalikan null bila belum ada di jurnal.
 */
export function findJournalMatch(jurnal, live) {
  if (live.journalId) return jurnal.find((j) => j.setupId === live.journalId) ?? null;
  let best = null;
  for (const j of jurnal) {
    if (j.engine !== live.engine || j.ticker !== live.ticker || j.direction !== live.direction) continue;
    if (!sameLevel(j.entryPrice, live.entryPrice)) continue;
    if (!best || (j.analysisTimeUtc ?? '') > (best.analysisTimeUtc ?? '')) best = j;
  }
  return best;
}

/**
 * Terapkan hasil satu scan ke snapshot setup satu mesin.
 *  - cards: array kartu mentah yang lolos filter, atau undefined bila pembacaan kartu gagal/tidak terkonfirmasi.
 *  - confirmed: true bila daftar (termasuk daftar kosong) terbukti benar. Bila false, daftar lama DIPERTAHANKAN dan ditandai stale.
 * Mengembalikan state mesin baru; juga menandai record jurnal (`readyEver`, `readyFirstSeenUtc`, `readyLastSeenUtc`).
 */
export function applyLiveScan({ prev, engine, cards, confirmed, scanStatus, nowIso, ctx, jurnal, rejected = null, errors = [] }) {
  const base = { scanUtc: nowIso, scanStatus, rejected, errors: errors.slice(0, 3) };
  if (!confirmed || !Array.isArray(cards)) {
    return { ...(prev ?? { items: [] }), ...base, items: prev?.items ?? [], stale: true, scanUtc: prev?.scanUtc ?? null, lastAttemptUtc: nowIso };
  }
  const before = new Map((prev?.items ?? []).map((x) => [x.liveId, x]));
  const items = [];
  for (const card of cards) {
    let rec;
    try { rec = buildLiveRecord(engine, card, ctx); } catch (e) { base.errors.push(`LIVE_PARSE_ERROR: ${e.message}`.slice(0, 160)); continue; }
    if (items.some((x) => x.liveId === rec.liveId)) continue; // kartu kembar dalam satu scan
    const old = before.get(rec.liveId);
    const match = findJournalMatch(jurnal, rec);
    if (match) {
      match.readyEver = true;
      match.readyFirstSeenUtc = match.readyFirstSeenUtc ?? old?.firstSeenUtc ?? nowIso;
      match.readyLastSeenUtc = nowIso;
    }
    items.push({ ...rec, journalId: match?.setupId ?? null, firstSeenUtc: old?.firstSeenUtc ?? nowIso, lastSeenUtc: nowIso, seenCount: (old?.seenCount ?? 0) + 1 });
  }
  return { ...base, items, stale: false, lastAttemptUtc: nowIso };
}
