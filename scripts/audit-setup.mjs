// Audit setup: hasil evaluator + jejak candle 1 menit (Binance), untuk dicek manual di TradingView.
// Pemakaian:  node scripts/audit-setup.mjs <setupId>
//             node scripts/audit-setup.mjs --ticker=WLD --engine=tnv2 --result=EXPIRED --max=3
// Butuh akses Binance (jalankan lewat workflow "Audit setup"). Waktu di keluaran: UTC dan WIB.
import fs from 'node:fs';
import path from 'node:path';
import { createBinanceProvider } from '../src/price-data/binance.js';
import { evaluateSetup } from '../src/evaluator/evaluate.js';
import { traceCandles, selectSetups, describeCoverage } from '../src/evaluator/trace.js';
import { toWib } from '../src/util/time.js';

const args = process.argv.slice(2);
const flag = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || undefined;
const filters = { id: args.find((a) => !a.startsWith('--')), ticker: flag('ticker'), engine: flag('engine'), result: flag('result'), max: flag('max') };
if (!filters.id && !filters.ticker && !filters.result) { console.error('Beri setupId atau --ticker/--result.'); process.exit(2); }
const hours = Number(flag('hours') || 72);

// Membaca data: folder bulanan data/setups/*.json, atau berkas lama data/setups.json. Melaporkan sumbernya.
function loadAll() {
  const base = process.env.DATA_DIR || 'data', dir = path.join(base, 'setups'), legacy = path.join(base, 'jurnal.json'), old = path.join(base, 'setups.json');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    return { all: files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))), source: `${dir}/ (${files.length} berkas bulanan: ${files.join(', ') || '-'})` };
  }
  if (fs.existsSync(legacy)) return { all: JSON.parse(fs.readFileSync(legacy, 'utf8')), source: `${legacy} (jurnal, satu berkas)` };
  if (fs.existsSync(old)) return { all: JSON.parse(fs.readFileSync(old, 'utf8')), source: `${old} (nama lama, sebelum jurnal.json)` };
  return { all: [], source: `TIDAK DITEMUKAN: ${dir}/ maupun ${legacy}` };
}
const { all, source } = loadAll();
console.log(`Sumber data: ${source}`);
console.log(`Total setup terbaca: ${all.length}`);
const picked = selectSetups(all, filters);
if (!picked.length) {
  const c = describeCoverage(all, filters);
  console.log('\nTidak ada setup yang cocok dengan filter.');
  if (!c.total) console.log('PENYEBAB: tidak ada data setup yang terbaca (lihat "Sumber data" di atas).');
  else {
    console.log(`Mesin yang ada di data: ${JSON.stringify(c.engines)}  (nama yang valid: ${Object.keys(c.engines).join(', ')})`);
    if (c.engineKnown === false) console.log(`PENYEBAB: tidak ada mesin bernama "${filters.engine}". Mesin 1 = tnv2, Mesin 2 = tn.`);
    if (c.engineKnown !== false) console.log(`Hasil evaluator pada lingkup ini: ${JSON.stringify(c.byResult)}`);
    if (c.engineKnown === false) { /* nama mesin salah: baris koin tidak informatif */ }
    else if (c.tickerKnown === false) console.log(`PENYEBAB: koin ${String(filters.ticker).toUpperCase()} tidak ada pada lingkup ini. Koin yang ada: ${c.tickers.join(', ')}`);
    else if (filters.result && filters.result !== 'any') console.log(`Catatan: koin ada, tetapi tidak ada yang berstatus ${filters.result}. Coba hasil "any".`);
  }
  process.exit(0);
}

const settings = JSON.parse(fs.readFileSync(new URL('../config/settings.json', import.meta.url), 'utf8'));
const provider = createBinanceProvider({ bases: settings.binanceBaseUrls });
for (const s of picked) {
  const a = Date.parse(s.analysisTimeUtc), end = Math.min(Date.now(), a + hours * 3600e3);
  console.log(`\n## ${s.ticker} ${s.direction} (${s.engine}) id=${s.setupId}`);
  try {
    const candles = await provider.getCandles(s.symbol, '1m', Math.floor(a / 60e3) * 60e3, end);
    const ev = await evaluateSetup(s, provider, { now: Date.now(), cfg: settings });
    console.log(`Analisis : ${s.analysisTimeUtc} UTC = ${toWib(a)} WIB`);
    console.log(`Level    : entry ${s.entryPrice ?? JSON.stringify(s.entryRange)} | TP1 ${s.takeProfit?.[0]} | SL ${s.stopLoss}`);
    console.log(`Hasil    : ${ev.result} (${ev.reasonCode ?? '-'})  entry terpicu: ${ev.entryTimeUtc ?? '-'}  hasil: ${ev.resultTimeUtc ?? '-'}`);
    console.log(`Harga saat analisis (open candle 1m pertama): ${ev.priceAtAnalysis}`);
    console.log('Menit yang menyentuh level (UTC | WIB | O H L C | level):');
    const rows = traceCandles(s, candles).filter((r) => r.touches !== '-').slice(0, 25);
    for (const r of rows) console.log(`  ${r.t.slice(0, 16)}Z | ${toWib(r.t)} | ${r.o} ${r.h} ${r.l} ${r.c} | ${r.touches}`);
    if (!rows.length) console.log('  (tidak ada candle yang menyentuh entry/TP/SL dalam jendela ' + hours + ' jam)');
    console.log(`Cek di TradingView: BINANCE:${s.symbol}, timeframe 1m, zona waktu WIB atau UTC sesuai kolom di atas.`);
  } catch (e) { console.log('GAGAL mengambil data:', String(e.message).slice(0, 160)); }
}
