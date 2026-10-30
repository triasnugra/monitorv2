// Sumber candle: Binance Spot REST /api/v3/klines (dokumentasi publik Binance).
// tnv2, tn dan dashboard /view/ menyatakan memakai data Binance, jadi sumber ini konsisten.
// CATATAN: runner GitHub berbasis AS; api.binance.com dapat menolak (HTTP 451). Endpoint
// data-api.binance.vision (khusus market data) dicoba lebih dulu, lalu fallback. Verifikasi dari runner (docs/VERIFIED.md).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBinanceProvider({ bases = ['https://data-api.binance.vision', 'https://api.binance.com'],
  fetchImpl = globalThis.fetch, retries = 3, backoffMs = 800 } = {}) {
  const memo = new Map();

  async function getJson(path) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      for (const base of bases) {
        try {
          const res = await fetchImpl(base + path, { headers: { accept: 'application/json' } });
          const body = await res.json().catch(() => null);
          if (res.ok) return body;
          if (res.status === 400 && body?.code === -1121) {
            const e = new Error(`Simbol tidak dikenal oleh Binance: ${path}`); e.code = 'INVALID_SYMBOL'; throw e;
          }
          lastErr = new Error(`HTTP ${res.status} dari ${base}`);
        } catch (e) { if (e.code === 'INVALID_SYMBOL') throw e; lastErr = e; }
      }
      await sleep(backoffMs * 2 ** attempt);
    }
    throw lastErr;
  }

  /** Candle dengan openTime di [startMs, endMs). Urut naik, tanpa duplikat. */
  async function getCandles(symbol, interval, startMs, endMs) {
    const key = `${symbol}|${interval}|${startMs}|${endMs}`;
    if (memo.has(key)) return memo.get(key);
    const out = [];
    let cursor = startMs;
    while (cursor < endMs) {
      const q = `/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs - 1}&limit=1000`;
      const rows = await getJson(q);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], closeT: r[6] });
      const next = rows[rows.length - 1][0] + 1;
      if (next <= cursor) break;
      cursor = next;
      if (rows.length < 1000) break;
      await sleep(120);
    }
    const uniq = [...new Map(out.map((c) => [c.t, c])).values()].sort((a, b) => a.t - b.t);
    memo.set(key, uniq);
    return uniq;
  }
  return { getCandles, name: 'binance-spot-klines' };
}
