// FIXTURE SINTETIS: candle 1m dibangkitkan dari daftar "waypoint" harga. Bukan data pasar nyata.
const MIN = 60000;
export function makeProvider(oneMin) {
  const agg = (arr, ms, n) => { const out = [];
    for (let i = 0; i < arr.length; i += n) { const g = arr.slice(i, i + n);
      if (g.length === n && g[0].t % ms === 0) out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g.at(-1).c, closeT: g[0].t + ms - 1 }); }
    return out; };
  const m15 = agg(oneMin, 15 * MIN, 15);
  return { getCandles: async (sym, interval, s, e) => (interval === '1m' ? oneMin : m15).filter((c) => c.t >= s && c.t < e) };
}
/** waypoints: [[minuteOffsetFrom start, price], ...]; start harus kelipatan 15 menit. Interpolasi linear. */
export function series(startMs, minutes, waypoints, wick = 0.0005) {
  const out = [];
  for (let i = 0; i < minutes; i++) {
    const at = (m) => { let k = 0; while (k < waypoints.length - 2 && waypoints[k + 1][0] <= m) k++;
      const [a, pa] = waypoints[k], [b, pb] = waypoints[k + 1]; return pa + ((pb - pa) * Math.min(Math.max(m - a, 0), b - a)) / (b - a || 1); };
    const o = at(i), c = at(i + 1);
    out.push({ t: startMs + i * MIN, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, closeT: startMs + (i + 1) * MIN - 1 });
  }
  return out;
}
export const T0 = Date.UTC(2026, 9, 8, 1, 45); // 2026-10-08 08:45 WIB
export const suiShort = () => ({ engine: 'crypto', symbol: 'SUIUSDT', direction: 'SHORT', entryType: 'limit',
  entryPrice: 1.144, entryRange: null, takeProfit: [1.029], stopLoss: 1.201, analysisTimeUtc: '2026-10-08T01:47:00.000Z' });
