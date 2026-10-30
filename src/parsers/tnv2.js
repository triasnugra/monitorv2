import { parseNumber } from '../util/num.js';

/*
 * tnv2 (https://triasnugra.github.io/tnv2/): fork /tn/ dengan gerbang v2 (gate.mjs).
 * Sinyal dihitung di browser, jadi sumbernya adalah DOM halaman (bukan file statis).
 *
 * Struktur kartu (mengikuti /tn/, diverifikasi dari data/discovery/tn/rendered.html; DOM tnv2 sendiri
 * HARUS diverifikasi dengan workflow "Discover", lihat docs/VERIFIED.md):
 *   #out > div.c
 *     .t > b (koin), .bd.L|.bd.S (arah), span.ch (status: AKTIF / ...)
 *     .g4 > div > span (label) + teks (nilai): "Entry limit", "SL x%", "TP 2R", "Target range"
 *     div.m (Harga ... · jarak ke entry ... · gaya), div.m ("4H/12H: ..."), div.m (konteks tren)
 *     .sz ("Risiko $10: qty 609 TRX (≈$200)")
 *
 * ATURAN GERBANG: hanya kartu yang LOLOS gerbang v2 yang dikembalikan sebagai `items`.
 * Kartu yang ditolak gerbang dihitung (meta.rejectedCount) untuk diagnostik, tetapi TIDAK dicatat.
 * Deteksi tolak (salah satu cukup):
 *   - kartu atau leluhurnya punya id/class yang cocok `rejectPattern` (default: tolak|reject|ditolak)
 *   - teks kartu cocok `rejectTextPattern` (default: ditolak|tolak gerbang|rejected)
 *   - kartu berada di bawah heading/summary terdekat yang teksnya cocok `rejectTextPattern`
 * Opsional `requirePassText`: jika diisi, kartu HARUS memuat teks itu untuk dianggap lolos (mode ketat).
 *
 * extractTnv2Cards dijalankan di dalam browser (page.evaluate) DAN di test (linkedom), sehingga
 * harus mandiri: tidak boleh memakai variabel di luar fungsinya.
 */
export function extractTnv2Cards(opts = {}, doc = globalThis.document) {
  const {
    cardSelector = '#out .c, #out article.c, #setups > article.c',
    rejectPattern = 'tolak|reject',
    rejectTextPattern = 'ditolak|tolak gerbang|gerbang v2 menolak|rejected',
    requirePassText = null,
  } = opts;
  const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());
  const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''));
  const reAttr = new RegExp(rejectPattern, 'i');
  const reText = new RegExp(rejectTextPattern, 'i');
  const rePass = requirePassText ? new RegExp(requirePassText, 'i') : null;

  const attrOf = (el) => `${el.id || ''} ${typeof el.className === 'string' ? el.className : (el.getAttribute?.('class') || '')}`;
  const nearestHeadingText = (el) => {
    // heading/summary terdekat di atas kartu, dalam kontainer yang sama atau induknya
    for (let p = el; p && p !== doc.body; p = p.parentElement) {
      for (let s = p.previousElementSibling; s; s = s.previousElementSibling) {
        if (/^(H1|H2|H3|H4|SUMMARY)$/.test(String(s.tagName).toUpperCase())) return clean(s.textContent);
      }
      const d = p.parentElement;
      if (d && String(d.tagName).toUpperCase() === 'DETAILS') { const sm = [...d.children].find((x) => String(x.tagName).toUpperCase() === 'SUMMARY'); if (sm) return clean(sm.textContent); }
    }
    return null;
  };

  const seen = new Set();
  const cards = [...doc.querySelectorAll(cardSelector)].filter((c) => {
    if (seen.has(c) || !c.querySelector('.g4')) return false;
    seen.add(c); return true;
  });

  const items = [];
  const rejected = [];
  for (const art of cards) {
    const rawText = clean(art.textContent);
    const chips = [...art.querySelectorAll('.t span.ch, .t span.bd, .t .ch')].map((c) => clean(c.textContent));
    const reasons = [];
    for (let e = art; e && e !== doc.body; e = e.parentElement) {
      if (reAttr.test(attrOf(e))) { reasons.push(`attr:${clean(attrOf(e)).slice(0, 60)}`); break; }
    }
    if (reText.test(rawText || '')) reasons.push('text');
    const hd = nearestHeadingText(art);
    if (hd && reText.test(hd)) reasons.push(`heading:${hd.slice(0, 60)}`);
    if (rePass && !rePass.test(rawText || '')) reasons.push('missing-pass-text');

    const ticker = clean(art.querySelector('.t > b, .t > h3, h3')?.textContent) || art.getAttribute('data-s');
    if (reasons.length) { rejected.push({ ticker, reasons }); continue; }

    items.push({
      ticker,
      direction: clean(art.querySelector('.bd.L, .bd.S, .t span.ch.L, .t span.ch.S')?.textContent),
      chips,
      rows: [...art.querySelectorAll('.g4 > div')].map((d) => ({ label: clean(d.querySelector('span')?.textContent), value: ownText(d) })),
      notes: [...art.children].filter((c) => c.classList.contains('m')).map((c) => clean(c.textContent)),
      size: clean(art.querySelector('.sz')?.textContent),
      rawText,
    });
  }

  const summaryText = clean(doc.querySelector('#st')?.textContent);
  const pageText = clean(doc.body?.textContent) || '';
  const m = summaryText ? summaryText.match(/Selesai:\s*(\d+)/i) : null;
  return {
    items,
    meta: {
      summaryText,
      summaryCount: m ? Number(m[1]) : null,
      totalCards: cards.length,
      passedCount: items.length,
      rejectedCount: rejected.length,
      rejected: rejected.slice(0, 40),
      // Ada kata "ditolak" di halaman tetapi tak ada kartu yang terdeteksi ditolak: penanda mungkin belum cocok.
      rejectMarkerUnmatched: rejected.length === 0 && new RegExp(rejectTextPattern, 'i').test(pageText),
      confirmedEmpty: cards.length === 0 && /Selesai:/i.test(summaryText || ''),
    },
  };
}

/** Ubah satu kartu hasil extractTnv2Cards menjadi input untuk buildRecord. */
export function parseTnv2Card(card) {
  const row = (re) => card.rows.find((r) => r.label && re.test(r.label));
  const entryRow = row(/^Entry\b/i);
  const slRow = row(/^SL\b/i);
  const tpRow = row(/^TP\b/i);
  const rangeRow = row(/^Target range\b/i);

  const entryPrice = parseNumber(entryRow?.value);
  const entryType = /limit/i.test(entryRow?.label ?? '') ? 'limit' : /market/i.test(entryRow?.label ?? '') ? 'market' : null;
  const stopLoss = parseNumber(slRow?.value);
  const slDistancePct = parseNumber(slRow?.label?.match(/([\d.,]+)%/)?.[1]);
  const takeProfit = parseNumber(tpRow?.value);
  const tpMultiple = parseNumber(tpRow?.label?.match(/TP\s*([\d.,]+)\s*R/i)?.[1]);

  const priceNote = card.notes.find((n) => /^Harga\s/i.test(n)) ?? '';
  const price = parseNumber(priceNote.match(/Harga\s+([\d.,]+)/)?.[1]);
  const distToEntryPct = parseNumber(priceNote.match(/jarak ke entry\s+([\d.,]+)%/i)?.[1]);
  const style = priceNote.split('·').map((x) => x.trim()).filter(Boolean).slice(2).join(' · ') || null;
  const confirmation = card.notes.find((n) => /^4H\/12H:/i.test(n))?.replace(/^4H\/12H:\s*/i, '') ?? null;
  const trendNote = card.notes.find((n) => /Tren\s/i.test(n)) ?? null;

  const statusChip = card.chips.find((c) => /^(AKTIF|MENUNGGU|JAUH|BATAL)/i.test(c || '')) ?? card.chips[1] ?? null;

  const riskAmountUsd = parseNumber(card.size?.match(/Risiko \$([\d.,]+)/)?.[1]);
  const quantity = parseNumber(card.size?.match(/qty ([\d.,]+)/)?.[1]);

  return {
    engine: 'tnv2',
    ticker: card.ticker,
    direction: card.direction,
    entryType: entryType ?? 'limit',
    entryPrice, entryRange: null,
    takeProfit: takeProfit != null ? [takeProfit] : [],
    stopLoss,
    entryReason: trendNote,
    originalStatus: statusChip,
    timeframe: TNV2_TIMEFRAME,
    riskAmountUsd, quantity,
    analysisTimeMs: card.analysisTimeMs ?? null,
    analysisTimeSource: card.analysisTimeMs != null ? 'source' : undefined,
    sourceResult: card.sourceResult ?? null,
    sourceR: card.sourceR ?? null,
    idKey: `tnv2|${card.ticker}|${card.direction}|${entryPrice}|${takeProfit}|${stopLoss}`,
    rawData: {
      gate: 'PASSED_V2',
      slLabel: slRow?.label ?? null, slDistancePct, tpLabel: tpRow?.label ?? null, tpMultiple,
      targetRange: parseNumber(rangeRow?.value),
      price, distToEntryPct, style, confirmation,
      journalId: card.journalId ?? null,
      chips: card.chips, rawText: card.rawText,
    },
    warnings: card.warnings ?? [],
  };
}

// Sama dengan Mesin tn: sinyal dari candle harian (konfirmasi 4H/12H hanya filter tambahan).
// Turunan dari kode tn, bukan data sumber. Ubah bila tnv2 berbeda.
export const TNV2_TIMEFRAME = '1D';
