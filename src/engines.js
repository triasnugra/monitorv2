/*
 * Daftar mesin yang dimonitor. `kind`:
 *   cards         DOM kartu setup (Mesin /crypto/), dibaca dengan Playwright
 *   journal-json  data/journal.json diambil langsung (tn, histori lama; ID dari hash rantai `h`)
 *   journal-web   halaman dibuka di browser; JURNAL yang tampil di halaman (tabel) + JSON jurnal yang
 *                 dimuat halaman itulah sumber data. Kartu "Sinyal setup" hanya diagnostik.
 */
export const ENGINES = [
  { id: 'crypto',  label: 'crypto',  kind: 'cards' },
  { id: 'tn',      label: 'tn',      kind: 'journal-json' },
  { id: 'tnv2',    label: 'tnv2',    kind: 'journal-web', timeframe: '1D' },
  { id: 'tnv2c2',  label: 'tnv2c2',  kind: 'journal-web', timeframe: '1D' },
  { id: 'dseek',   label: 'dseek',   kind: 'journal-web', timeframe: '1D' },
  { id: 'grox',    label: 'grox',    kind: 'journal-web', timeframe: null },
  { id: 'chatgpt', label: 'chatgpt', kind: 'journal-web', timeframe: '1D' },
];
export const ENGINE_IDS = ENGINES.map((e) => e.id);
export const engineById = (id) => ENGINES.find((e) => e.id === id);
