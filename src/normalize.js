import { createHash } from 'node:crypto';
import { toIso, toWib } from './util/time.js';

const round2 = (x) => Math.round(x * 100) / 100;

export function normalizeDirection(raw) {
  if (!raw) return null;
  const long = /\b(long|buy|naik|bull)/i.test(raw);
  const short = /\b(short|sell|turun|bear)/i.test(raw);
  return long && !short ? 'LONG' : short && !long ? 'SHORT' : null;
}

export function normalizeTicker(raw) {
  if (!raw) return { ticker: null, symbol: null };
  const t = String(raw).toUpperCase().trim().replace(/[-_ ]?PERP$/, '');
  const m = t.match(/^([A-Z0-9]{2,15}?)(?:[/\-_. ]?(USDT|USDC|BUSD|USD))?$/);
  if (!m) return { ticker: null, symbol: null };
  const [, base, quote] = m;
  // Simbol pasar hanya dibentuk untuk pasangan USDT (sumber harga Binance).
  return { ticker: base, symbol: !quote || quote === 'USDT' ? `${base}USDT` : null };
}

export function normalizeEntryType(raw) {
  if (!raw) return null;
  if (/limit/i.test(raw)) return 'limit';
  if (/market|pasar/i.test(raw)) return 'market';
  return null;
}

/**
 * Bentuk satu record bersama untuk kedua mesin.
 * input: hasil parser (lihat parsers/*.js). ctx: { scanTimeMs, firstRun, sourceUrl }.
 * - Jika sumber tidak memberi waktu analisis, waktu scan dipakai dan ditandai:
 *   'unknown_before_tracking' (setup sudah ada sebelum pelacakan dimulai) atau 'first_seen'.
 * - setupId dari input.idKey: stabil antar-scan, tanpa waktu scan.
 */
export function buildRecord(input, ctx) {
  const warnings = [...(input.warnings ?? [])];
  const missing = [];
  const { ticker, symbol } = normalizeTicker(input.ticker);
  const direction = normalizeDirection(input.direction);
  const entryRange = Array.isArray(input.entryRange) && input.entryRange.length === 2
    ? [...input.entryRange].sort((a, b) => a - b) : null;
  const entryPrice = input.entryPrice ?? (entryRange ? (entryRange[0] + entryRange[1]) / 2 : null);
  const takeProfit = (Array.isArray(input.takeProfit) ? input.takeProfit : [input.takeProfit])
    .filter((x) => Number.isFinite(x));
  const stopLoss = Number.isFinite(input.stopLoss) ? input.stopLoss : null;
  const tp1 = takeProfit[0] ?? null;
  const riskReward = entryPrice != null && tp1 != null && stopLoss != null && entryPrice !== stopLoss
    ? round2(Math.abs(tp1 - entryPrice) / Math.abs(entryPrice - stopLoss)) : null;

  let ms = input.analysisTimeMs ?? null;
  let src = input.analysisTimeSource ?? null;
  if (ms == null) {
    ms = ctx.scanTimeMs;
    src = ctx.firstRun ? 'unknown_before_tracking' : 'first_seen';
  }
  const hash = createHash('sha1').update(String(input.idKey)).digest('hex').slice(0, 12);

  const rec = {
    setupId: `${input.engine}-${hash}`,
    engine: input.engine,
    analysisTimeUtc: toIso(ms),
    analysisTimeWib: toWib(ms),
    analysisTimeSource: src,
    ticker, symbol, direction,
    entryType: input.entryType ?? null,
    entryPrice, entryRange,
    takeProfit: takeProfit.length ? takeProfit : null,
    stopLoss, riskReward,
    riskPercent: input.riskPercent ?? null,
    riskAmountUsd: input.riskAmountUsd ?? null,
    quantity: input.quantity ?? null,
    timeframe: input.timeframe ?? null,
    entryReason: input.entryReason ?? null,
    originalStatus: input.originalStatus ?? null,
    sourceResult: input.sourceResult ?? null,
    sourceR: input.sourceR ?? null,
    sourceUrl: ctx.sourceUrl ?? null,
    rawData: input.rawData ?? null,
    warnings,
    missingFields: missing,
  };
  for (const k of ['ticker', 'direction', 'entryType', 'entryPrice', 'takeProfit', 'stopLoss', 'riskReward', 'riskPercent', 'entryReason', 'timeframe']) {
    if (rec[k] == null) missing.push(k);
  }
  return rec;
}
