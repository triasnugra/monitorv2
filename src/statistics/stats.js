import { toWib, MIN } from '../util/time.js';

export const STATUSES = ['PENDING', 'TP', 'SL', 'CANCELLED', 'EXPIRED', 'INVALID', 'AMBIGUOUS'];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const ev = (s) => s.evaluation || { result: 'PENDING' };

export function wilson(w, n, z = 1.96) {
  if (!n) return null;
  const p = w / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function maxDrawdownR(rs) {
  let cum = 0, peak = 0, dd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

/** Statistik satu kelompok setup. Hanya TP/SL yang dihitung menang/kalah. */
export function summarize(list) {
  const counts = Object.fromEntries(STATUSES.map((k) => [k, 0]));
  list.forEach((s) => { counts[ev(s).result] = (counts[ev(s).result] || 0) + 1; });
  const resolved = list.filter((s) => ['TP', 'SL'].includes(ev(s).result))
    .sort((a, b) => Date.parse(ev(a).resultTimeUtc) - Date.parse(ev(b).resultTimeUtc));
  const rs = resolved.map((s) => ev(s).rMultiple);
  const n = resolved.length;
  const triggered = list.filter((s) => ev(s).entryTimeUtc);
  const total = rs.reduce((a, b) => a + b, 0);
  return {
    published: list.length, triggered: triggered.length, counts, resolved: n,
    winRate: n ? counts.TP / n : null, winRateCI95: wilson(counts.TP, n),
    expectancyR: n ? total / n : null, avgR: n ? total / n : null, totalR: n ? total : 0,
    maxDrawdownR: maxDrawdownR(rs),
    avgMinutesToEntry: mean(triggered.map((s) => (Date.parse(ev(s).entryTimeUtc) - Date.parse(s.analysisTimeUtc)) / MIN)),
    avgMinutesToResult: mean(resolved.map((s) => (Date.parse(ev(s).resultTimeUtc) - Date.parse(s.analysisTimeUtc)) / MIN)),
  };
}

export function groupBy(list, keyFn) {
  const g = new Map();
  for (const s of list) { const k = keyFn(s) ?? '(tidak tersedia)'; (g.get(k) || g.set(k, []).get(k)).push(s); }
  return Object.fromEntries([...g].sort().map(([k, v]) => [k, summarize(v)]));
}

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear(), w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
/** Periode berdasarkan tanggal HASIL dalam WIB. */
export function periodStats(list, kind) {
  const resolved = list.filter((s) => ['TP', 'SL'].includes(ev(s).result));
  const key = (s) => { const d = toWib(ev(s).resultTimeUtc).slice(0, 10);
    return kind === 'weekly' ? isoWeek(d) : kind === 'monthly' ? d.slice(0, 7) : d; };
  const g = new Map();
  for (const s of resolved) (g.get(key(s)) || g.set(key(s), []).get(key(s))).push(s);
  return [...g].sort(([a], [b]) => (a < b ? -1 : 1)).map(([period, l]) => {
    const m = summarize(l); return { period, resolved: m.resolved, tp: m.counts.TP, sl: m.counts.SL, totalR: m.totalR };
  });
}

/** Klaster near-duplicate: engine+simbol+arah sama, waktu dekat, entry berdekatan. Primary = yang pertama. */
export function markClusters(list, { windowHours = 24, entryTolerance = 0.01 } = {}) {
  const out = new Map(), open = [];
  const sorted = [...list].sort((a, b) => Date.parse(a.analysisTimeUtc) - Date.parse(b.analysisTimeUtc));
  for (const s of sorted) {
    const t = Date.parse(s.analysisTimeUtc);
    const head = open.find((h) => h.engine === s.engine && h.symbol === s.symbol && h.direction === s.direction
      && t - Date.parse(h.analysisTimeUtc) <= windowHours * 3600_000
      && h.entryPrice && s.entryPrice && Math.abs(s.entryPrice - h.entryPrice) / h.entryPrice <= entryTolerance);
    if (head) out.set(s.setupId, { clusterId: head.setupId, isPrimary: false });
    else { open.push(s); out.set(s.setupId, { clusterId: s.setupId, isPrimary: true }); }
  }
  return out;
}

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Bandingkan expectancy (R) dua mesin dengan bootstrap. Tidak menyatakan 'lebih baik' bila sampel kecil / CI mencakup 0. */
export function compareEngines(listA, listB, { minSample = 30, iterations = 5000, seed = 42 } = {}) {
  const rA = listA.filter((s) => ['TP', 'SL'].includes(ev(s).result)).map((s) => ev(s).rMultiple);
  const rB = listB.filter((s) => ['TP', 'SL'].includes(ev(s).result)).map((s) => ev(s).rMultiple);
  const res = { nA: rA.length, nB: rB.length, minSample, expectancyA: mean(rA), expectancyB: mean(rB),
    diff: null, ci95: null, verdict: 'INSUFFICIENT_SAMPLE',
    caveat: 'Setup berurutan dari satu mesin bisa berkorelasi; CI ini bersifat indikatif, bukan bukti kausal.' };
  if (!rA.length || !rB.length) return res;
  res.diff = res.expectancyA - res.expectancyB;
  if (rA.length < minSample || rB.length < minSample) return res;
  const rand = rng(seed), diffs = [];
  const boot = (a) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[Math.floor(rand() * a.length)]; return t / a.length; };
  for (let i = 0; i < iterations; i++) diffs.push(boot(rA) - boot(rB));
  diffs.sort((x, y) => x - y);
  res.ci95 = [diffs[Math.floor(0.025 * iterations)], diffs[Math.floor(0.975 * iterations)]];
  res.verdict = res.ci95[0] > 0 ? 'A_BETTER' : res.ci95[1] < 0 ? 'B_BETTER' : 'NO_SIGNIFICANT_DIFFERENCE';
  return res;
}

/** Pasangan setup lintas mesin: simbol sama + waktu berdekatan. Arah berbeda = CONFLICT, bukan setup yang sama. */
export function pairSetups(a, b, windowMinutes = 120) {
  const used = new Set(), pairs = [];
  const cand = [];
  for (const x of a) for (const y of b) {
    if (x.symbol && x.symbol === y.symbol) {
      const dt = Math.abs(Date.parse(x.analysisTimeUtc) - Date.parse(y.analysisTimeUtc)) / MIN;
      if (dt <= windowMinutes) cand.push({ x, y, dt });
    }
  }
  cand.sort((p, q) => p.dt - q.dt);
  for (const { x, y, dt } of cand) {
    if (used.has(x.setupId) || used.has(y.setupId)) continue;
    used.add(x.setupId); used.add(y.setupId);
    const pct = (u, v) => (u != null && v != null && v !== 0 ? (u - v) / v : null);
    pairs.push({ symbol: x.symbol, minutesApart: dt, sameDirection: x.direction === y.direction,
      relation: x.direction === y.direction ? 'COMPARABLE' : 'CONFLICT',
      [x.engine]: { id: x.setupId, direction: x.direction, entry: x.entryPrice, tp: x.takeProfit?.[0] ?? null, sl: x.stopLoss, result: ev(x).result, r: ev(x).rMultiple ?? null },
      [y.engine]: { id: y.setupId, direction: y.direction, entry: y.entryPrice, tp: y.takeProfit?.[0] ?? null, sl: y.stopLoss, result: ev(y).result, r: ev(y).rMultiple ?? null },
      engines: [x.engine, y.engine],
      entryDiffPct: pct(x.entryPrice, y.entryPrice), tpDiffPct: pct(x.takeProfit?.[0], y.takeProfit?.[0]), slDiffPct: pct(x.stopLoss, y.stopLoss) });
  }
  return pairs;
}
