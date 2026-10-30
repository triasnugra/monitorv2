// Parser teks-kartu generik berbasis label "Label: nilai" atau "Label\nnilai".
// PENTING: kosakata label di bawah adalah ASUMSI (belum diverifikasi terhadap DOM kedua mesin).
// Setelah data/discovery tersedia, sesuaikan LABELS di parsers/crypto.js dan parsers/tn.js.
export const DEFAULT_LABELS = {
  ticker: ['koin', 'coin', 'ticker', 'pair', 'simbol', 'symbol'],
  direction: ['arah', 'direction', 'side', 'posisi'],
  entryType: ['tipe entry', 'jenis entry', 'entry type', 'order'],
  entry: ['entry', 'masuk', 'harga masuk'],
  takeProfit: ['tp', 'take profit', 'target'],
  stopLoss: ['sl', 'stop loss', 'stop'],
  riskReward: ['r:r', 'rr', 'risk reward', 'risk/reward', 'r'],
  riskPercent: ['risiko %', 'risk %', 'risiko', 'risk'],
  riskAmountUsd: ['risiko $', 'risk $', 'risk usd', 'risiko usd', 'nominal risiko'],
  quantity: ['qty', 'quantity', 'jumlah', 'ukuran', 'size'],
  entryReason: ['alasan', 'alasan entry', 'reason', 'konfirmasi', 'catatan'],
  originalStatus: ['status'],
  timeframe: ['tf', 'timeframe'],
  time: ['waktu', 'time', 'tanggal', 'dibuat'],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** @returns {{fields: Record<string,string>, lines: string[]}} */
export function extractLabelled(text, labels = DEFAULT_LABELS) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fields = {};
  const table = Object.entries(labels).flatMap(([k, arr]) => arr.map((a) => [k, a]))
    .sort((a, b) => b[1].length - a[1].length);               // label terpanjang dicocokkan dulu
  for (let i = 0; i < lines.length; i++) {
    for (const [key, alias] of table) {
      const m = lines[i].match(new RegExp(`^${esc(alias)}\\s*[:：]\\s*(.+)$`, 'i'));
      if (m) { if (!(key in fields)) fields[key] = m[1].trim(); break; }
      if (lines[i].toLowerCase() === alias && lines[i + 1] && !(key in fields)) { fields[key] = lines[i + 1]; i++; break; }
    }
  }
  return { fields, lines };
}

/** Parse rentang "1.10 - 1.12" atau satu angka. */
export function splitRange(str) {
  if (str == null) return [];
  return String(str).split(/\s+(?:-|–|—|to|sampai|s\/d)\s+|\s*[–—]\s*/i).map((x) => x.trim()).filter(Boolean);
}

export function parseCardWith(labels, engine) {
  return (card) => {
    const { fields } = extractLabelled(card.text, labels);
    return { engine, fields, rawText: card.text, rawHtml: card.html ?? null };
  };
}
