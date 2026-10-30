import { parseNumber } from '../util/num.js';

/*
 * Mesin 1 (/crypto/). Struktur DOM diverifikasi dari data/discovery/crypto/rendered.html:
 *   div#setups > article.c[data-s]
 *     .t > h3 (koin), .t > span > span.ch.L|.ch.S (arah), chip ke-2 (timeframe, gaya), chip ke-3 (status)
 *     .g4 > div > span (label) + teks (nilai): "Entry limit", "SL x%", "TP1|TP2", "Rasio ke target akhir"
 *     div.m (catatan: alasan + "Harga ...", lalu "Konfirmasi: ...")
 *     .sz ("Risiko $10: qty 18.5 AVAX, nilai posisi $214")
 *   div#st berisi "Selesai: N koin punya setup, ..." (dipakai sebagai cek konsistensi).
 *
 * extractCryptoCards dijalankan di dalam browser (page.evaluate) DAN di test (linkedom),
 * karena itu harus mandiri: tidak boleh memakai variabel di luar fungsinya.
 */
export function extractCryptoCards(doc = globalThis.document) {
  const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());
  const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
  const summaryText = clean(doc.querySelector('#st')?.textContent);
  const m = summaryText ? summaryText.match(/Selesai:\s*(\d+)\s+koin punya setup/) : null;
  const summaryCount = m ? Number(m[1]) : null;
  const items = [...doc.querySelectorAll('#setups > article.c')].map((art) => ({
    ticker: clean(art.querySelector('h3')?.textContent) || art.getAttribute('data-s'),
    direction: clean(art.querySelector('.t > span > span.ch.L, .t > span > span.ch.S')?.textContent),
    chips: [...art.querySelectorAll('.t > span > span')].map((c) => clean(c.textContent)),
    rows: [...art.querySelectorAll('.g4 > div')].map((d) => ({
      label: clean(d.querySelector('span')?.textContent),
      value: ownText(d),
    })),
    notes: [...art.children].filter((c) => c.classList.contains('m')).map((c) => clean(c.textContent)),
    size: clean(art.querySelector('.sz')?.textContent),
    rawText: clean(art.textContent),
  }));
  return { items, meta: { summaryText, summaryCount, confirmedEmpty: summaryCount === 0 } };
}

/** Ubah satu kartu hasil extractCryptoCards menjadi input untuk buildRecord. */
export function parseCryptoCard(card) {
  const row = (re) => card.rows.find((r) => r.label && re.test(r.label));
  const entryRow = row(/^Entry\b/i);
  const slRow = row(/^SL\b/i);
  const tpRow = row(/^TP\d?$/i);
  const rrRow = row(/^Rasio ke target akhir$/i);

  const rng = entryRow?.value?.match(/^([\d.,]+)\s*(?:-|–|sampai)\s*([\d.,]+)$/);
  const entryRange = rng ? [parseNumber(rng[1]), parseNumber(rng[2])] : null;
  const entryPrice = entryRange ? null : parseNumber(entryRow?.value);
  const entryType = /limit/i.test(entryRow?.label ?? '') ? 'limit'
    : /market/i.test(entryRow?.label ?? '') ? 'market' : null;

  const stopLoss = parseNumber(slRow?.value);
  const slDistancePct = parseNumber(slRow?.label?.match(/([\d.,]+)%/)?.[1]);
  const takeProfit = parseNumber(tpRow?.value);

  const reasonNote = card.notes[0] ?? '';
  const reason = reasonNote.split(/\.\s+Harga\s/)[0] || null;
  const price = parseNumber(reasonNote.match(/Harga\s+([\d.,]+)/)?.[1]);
  const confirmation = card.notes[1]?.replace(/^Konfirmasi:\s*/, '') ?? null;

  const [, tfChip, statusChip] = card.chips;
  const timeframe = tfChip?.match(/^(\d+[HDW])\b/)?.[1] ?? null;
  const style = tfChip?.includes(',') ? tfChip.split(',').slice(1).join(',').trim() : null;

  const riskAmountUsd = parseNumber(card.size?.match(/Risiko \$([\d.,]+)/)?.[1]);
  const quantity = parseNumber(card.size?.match(/qty ([\d.,]+)/)?.[1]);
  const positionValueUsd = parseNumber(card.size?.match(/nilai posisi \$([\d.,]+)/)?.[1]);

  const levelKey = entryRange ? entryRange.join('-') : entryPrice;
  return {
    engine: 'crypto',
    ticker: card.ticker,
    direction: card.direction,
    entryType,
    entryPrice, entryRange,
    takeProfit: takeProfit != null ? [takeProfit] : [],
    stopLoss,
    entryReason: reason,
    originalStatus: statusChip ?? null,
    timeframe,
    riskAmountUsd, quantity,
    analysisTimeMs: null,      // Mesin 1 tidak menampilkan waktu analisis; diisi di buildRecord
    idKey: `crypto|${card.ticker}|${card.direction}|${entryType}|${levelKey}|${takeProfit}|${stopLoss}`,
    rawData: {
      tpLabel: tpRow?.label ?? null,
      slLabel: slRow?.label ?? null,
      slDistancePct,
      rrToFinalTarget: parseNumber(rrRow?.value?.replace(/R$/, '')),
      price, confirmation, style, positionValueUsd,
      chips: card.chips, rawText: card.rawText,
    },
    warnings: [],
  };
}
