import { runScrape } from './base.js';
import { extractTnv2Cards } from '../parsers/tnv2.js';

/*
 * Hanya kartu "Sinyal setup" yang lolos gerbang (daftar SETUP siap eksekusi), tanpa membaca jurnal.
 * Dipakai untuk mesin yang jurnalnya diambil lewat file JSON (tn): halaman tetap dibuka di browser
 * agar kartu yang dihitung filter mesin itu bisa dibaca. Hasil: { status, liveCards, diagnostics }.
 */
export async function scrapeLiveCards(page, cfg) {
  const r = await runScrape(page, { scanButtonText: 'Scan ulang', gotoTimeoutMs: 45000, scanTimeoutMs: 90000, quietMs: 4000, ...cfg }, extractTnv2Cards, cfg.gate ?? {});
  const m = r.diagnostics.meta;
  const confirmed = r.items.length > 0 || (m?.totalCards ?? 0) > 0 || m?.confirmedEmpty === true;
  const ok = r.status === 'OK' || r.status === 'OK_NO_SETUPS' || (r.status === 'ZERO_CARDS_UNCONFIRMED' && confirmed);
  return {
    status: r.status,
    liveCards: ok ? { items: r.items, confirmed, rejected: m?.rejectedCount ?? null } : null,
    diagnostics: r.diagnostics,
  };
}
