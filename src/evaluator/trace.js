// Jejak keputusan evaluator untuk audit manual: candle 1 menit setelah analisis, dengan tanda sentuhan entry/TP/SL.
// Murni: tidak memanggil jaringan. Dipakai oleh scripts/audit-setup.mjs.
export function traceCandles(setup, candles1m) {
  const long = setup.direction === 'LONG';
  const tp = setup.takeProfit?.[0], sl = setup.stopLoss;
  const lo = setup.entryRange ? Math.min(...setup.entryRange) : setup.entryPrice;
  const hi = setup.entryRange ? Math.max(...setup.entryRange) : setup.entryPrice;
  const a = Date.parse(setup.analysisTimeUtc);
  return candles1m.filter((c) => c.t >= a).map((c) => {
    const touchEntry = long ? c.l <= hi : c.h >= lo;
    const touchTP = long ? c.h >= tp : c.l <= tp;
    const touchSL = long ? c.l <= sl : c.h >= sl;
    const flags = [touchEntry && 'ENTRY', touchTP && 'TP', touchSL && 'SL'].filter(Boolean).join(' ');
    return { t: new Date(c.t).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, touches: flags || '-' };
  });
}

/** Pilih setup untuk diaudit. filters: { id, ticker, engine, result, max } -- terbaru dulu. */
export function selectSetups(all, { id, ticker, engine, result, max = 3 } = {}) {
  let l = all;
  if (id) l = l.filter((s) => s.setupId === id);
  if (ticker) l = l.filter((s) => s.ticker === String(ticker).toUpperCase());
  if (engine && engine !== 'any') l = l.filter((s) => s.engine === engine);
  if (result && result !== 'any') l = l.filter((s) => (s.evaluation?.result ?? 'PENDING') === result);
  return [...l].sort((a, b) => (a.analysisTimeUtc < b.analysisTimeUtc ? 1 : -1)).slice(0, Math.max(1, Number(max) || 3));
}

/** Ringkasan isi data, untuk menjelaskan MENGAPA pencarian audit kosong. */
export function describeCoverage(all, { engine, ticker } = {}) {
  const count = (l, f) => l.reduce((a, s) => { const k = f(s); a[k] = (a[k] || 0) + 1; return a; }, {});
  const scoped = engine && engine !== 'any' ? all.filter((s) => s.engine === engine) : all;
  return {
    total: all.length,
    engines: count(all, (s) => s.engine),
    engineKnown: !engine || engine === 'any' ? null : all.some((s) => s.engine === engine),
    byResult: count(scoped, (s) => s.evaluation?.result ?? 'PENDING'),
    tickers: [...new Set(scoped.map((s) => s.ticker))].sort(),
    tickerKnown: ticker ? scoped.some((s) => s.ticker === String(ticker).toUpperCase()) : null,
  };
}
