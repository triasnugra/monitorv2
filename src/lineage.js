/*
 * Garis keturunan (lineage) entri jurnal: hanya sinyal MILIK sebuah mesin yang boleh dinilai sebagai analisis mesin itu.
 *
 * Latar belakang: tnv2, tnv2c2, dan chatgpt adalah turunan /tn/ dan memakai rantai jurnal yang sama. Halaman tnv2 menyatakan
 * sendiri bahwa panel "Jurnal sinyal" mencatat v1 (semua sinyal, tanpa gerbang). Jurnal tiap turunan berisi:
 *   - salinan sinyal v1: field `engine` = hash mesin v1 (sama dengan tn), atau entri lama tanpa field `engine`;
 *   - sinyal MILIK mesin itu: field `engine` berisi hash lain (mis. tnv2 = "Eliz v2", gerbang kualitas).
 * Tanpa pemisahan ini hasil tnv2 hanya salinan hasil tn.
 *
 * Konfigurasi per mesin (config/sources.json), semuanya opsional:
 *   inheritedEngineIds   hash engine v1 yang dikecualikan. Kosong/tidak ada = semua entri milik mesin ini.
 *   legacyWithoutEngine  entri JSON tanpa field `engine`: 'inherited' (default) atau 'own'.
 *   tableOnlyRows        entri yang hanya ada di tabel (engine tak bisa diperiksa): 'unverified' (default) atau 'own'.
 *
 * Hasil klasifikasi:
 *   own           milik mesin ini -> dicatat dan dinilai
 *   inherited_v1  salinan v1 -> tidak dicatat (data lama diberi tanda dan disembunyikan, tidak dihapus)
 *   unverified    asal tak bisa dipastikan -> tidak dicatat
 */
export const OWN = 'own', INHERITED = 'inherited_v1', UNVERIFIED = 'unverified';

/** item: entri jurnal mentah ({engine?, _src?}) atau rawData sebuah record ({engine?, journalSource?}). */
export function classifyItem(item, cfg) {
  const ids = cfg?.inheritedEngineIds;
  if (!Array.isArray(ids) || !ids.length) return OWN;
  const eng = item?.engine;
  if (eng) return ids.includes(String(eng)) ? INHERITED : OWN;
  const fromJson = /json/.test(String(item?._src ?? item?.journalSource ?? ''));
  if (!fromJson) return cfg.tableOnlyRows === 'own' ? OWN : UNVERIFIED;
  return cfg.legacyWithoutEngine === 'own' ? OWN : INHERITED;
}

export function splitItems(items, cfg) {
  const out = { own: [], inherited: [], unverified: [], ownEngineIds: [] };
  for (const it of items) {
    const c = classifyItem(it, cfg);
    out[c === OWN ? 'own' : c === INHERITED ? 'inherited' : 'unverified'].push(it);
    if (c === OWN && it?.engine && !out.ownEngineIds.includes(String(it.engine))) out.ownEngineIds.push(String(it.engine));
  }
  return out;
}

export const isHidden = (s) => s.lineage === INHERITED || s.lineage === UNVERIFIED;

/** Beri tanda lineage pada record lama (idempoten, tidak menghapus apa pun). Mengembalikan jumlah record yang diberi tanda baru. */
export function tagLineage(jurnal, sources) {
  let n = 0;
  for (const s of jurnal) {
    if (s.lineage !== undefined) continue;
    const cfg = sources?.[s.engine];
    if (!cfg?.inheritedEngineIds?.length) continue;
    s.lineage = classifyItem(s.rawData ?? {}, cfg);
    n++;
  }
  return n;
}
