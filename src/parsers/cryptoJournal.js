import { parseJournalEntry } from './tn.js';

/*
 * crypto: sumber JURNAL = data/journal.json milik mesin crypto (file publik yang sama dipakai monitor lain).
 * Alasan: kartu DOM mencatat satu sinyal berkali-kali setiap SL/TP direvisi (503 sinyal asli tampil sebagai 1451 kartu),
 * dan waktunya adalah waktu pertama kali kartu terlihat, bukan waktu analisis. Jurnal memberi `t` (waktu analisis sebenarnya)
 * dan `h` (hash rantai unik per sinyal). Kartu DOM tetap dibaca untuk daftar SETUP siap eksekusi.
 */
export function parseCryptoJournalEntry(e) {
  const p = parseJournalEntry(e);
  return {
    ...p,
    engine: 'crypto',
    entryType: e.mode === 'market' ? 'market' : 'limit',
    timeframe: e.tf ?? null,
    idKey: `crypto|${e.h ?? e.id}`,
    originalStatus: null,
    sourceResult: null,   // crypto tidak punya hasil dari mesin: dinilai dari candle oleh evaluator
    sourceR: null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ambil journal.json crypto. Mengembalikan { ok, items, error }. Tidak pernah melempar. */
export async function fetchCryptoJournal(cfg, fetchImpl = globalThis.fetch) {
  let lastErr = 'tidak diketahui';
  for (let i = 0; i < (cfg.retries ?? 3); i++) {
    try {
      const sep = cfg.journalUrl.includes('?') ? '&' : '?';
      const res = await fetchImpl(`${cfg.journalUrl}${sep}_=${Date.now()}`, {
        signal: AbortSignal.timeout(cfg.fetchTimeoutMs ?? 30000), headers: { 'cache-control': 'no-cache' },
      });
      if (!res.ok) { lastErr = `HTTP_${res.status}`; }
      else {
        const j = await res.json();
        if (!Array.isArray(j)) return { ok: false, items: [], error: 'JOURNAL_NOT_ARRAY' };
        return { ok: true, items: j, error: null };
      }
    } catch (e) { lastErr = String(e.message).slice(0, 120); }
    await sleep(1000 * 2 ** i);
  }
  return { ok: false, items: [], error: lastErr };
}
