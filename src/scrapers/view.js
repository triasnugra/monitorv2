// /view/ tidak dipakai sebagai sumber candle. Teks halaman menyatakan data berasal dari Binance
// ("Memuat data Binance..."), jadi evaluator memakai Binance langsung (src/price-data/binance.js).
// Probe ini hanya memastikan halaman masih dapat diakses.
export async function probeView(url, fetchImpl = globalThis.fetch) {
  try { const r = await fetchImpl(url); return { reachable: r.ok, httpStatus: r.status, usedForCandles: false }; }
  catch (e) { return { reachable: false, httpStatus: null, error: String(e.message), usedForCandles: false }; }
}
