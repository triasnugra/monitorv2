/*
 * Hasil mesin LANGSUNG (tanpa menunggu run terjadwal GitHub Actions).
 *
 * Dashboard dibangun oleh workflow terjadwal, dan jadwal GitHub sering tertunda berjam-jam. Akibatnya baris yang
 * sudah TP/SL di website mesin masih tampil "menunggu" di sini. File ini, saat dashboard dibuka, membaca jurnal
 * publik tiap mesin (CORS GitHub Pages terbuka) dan memperbarui HANYA kolom "Hasil mesin" (beserta Terpakai?/Akurat?)
 * pada baris yang masih PENDING. Baris yang sudah final tidak pernah ditimpa. Hasil candle, statistik, dan Overview
 * tetap dari scan terjadwal berikutnya.
 *
 * Aturan pencocokan dan lineage sama dengan src/parsers/journal.js dan src/lineage.js:
 *   kunci = menit + aset + arah + entry; hanya baris MILIK mesin itu (bukan salinan v1) yang dipakai.
 * Fungsi murni (applyLive) diuji di test/live-overlay.test.js. Waktu tetap WIB seperti dashboard lainnya.
 */
(function (root) {
  'use strict';
  const num = (x) => { const v = typeof x === 'number' ? x : parseFloat(String(x ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };
  const WIB = 7 * 36e5;
  const wib = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms + WIB).toISOString().slice(0, 16).replace('T', ' '));

  // Menit (epoch) entri; sama dengan minuteOf di parsers/journal.js (waktu bila ada zona eksplisit, jika tidak t).
  function minuteOf(e) {
    const m = String(e.waktu ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(WIB|UTC)$/i);
    let ms = null;
    if (m) { ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)); if (m[7].toUpperCase() === 'WIB') ms -= WIB; }
    else if (typeof e.t === 'number' && Number.isFinite(e.t)) ms = e.t;
    return ms == null ? null : Math.floor(ms / 6e4);
  }
  const keyOf = (min, aset, arah, entry) => `${min}|${String(aset).toUpperCase()}|${String(arah).toUpperCase()}|${Number(entry).toPrecision(8)}`;

  // Sama dengan mapSourceResult di src/sourceEval.js.
  function mapResult(raw) {
    const h = String(raw ?? '').trim().toLowerCase();
    if (h === 'tp') return 'TP';
    if (h === 'sl') return 'SL';
    if (h === '' || /^menunggu|^pending|^aktif/.test(h)) return 'PENDING';
    if (/tidak\s*terisi|kedaluwarsa|kadaluarsa|expired/.test(h)) return 'EXPIRED';
    if (/^no[_\s-]?trade/.test(h) || /batal|cancel/.test(h)) return 'CANCELLED';
    return 'AMBIGUOUS';
  }
  // Sama dengan execState di src/aggregate.js (untuk hasil sumber, tanpa waktu entry).
  const execOf = (res) => (res === 'TP' || res === 'SL' ? 'TERPAKAI' : res === 'PENDING' ? 'MENUNGGU' : res === 'EXPIRED' || res === 'CANCELLED' ? 'TIDAK_TERPAKAI' : 'TAK_TERNILAI');
  const accOf = (res) => (res === 'TP' ? 'AKURAT' : res === 'SL' ? 'MELESET' : null);

  // Sama dengan classifyItem (sumber JSON) di src/lineage.js: true = sinyal milik mesin ini.
  function isOwn(e, cfg) {
    const ids = cfg?.inheritedEngineIds;
    if (!Array.isArray(ids) || !ids.length) return true;
    if (e?.engine) return !ids.includes(String(e.engine));
    return cfg.legacyWithoutEngine === 'own';
  }

  const emptyScore = () => ({ generated: 0, terpakai: 0, berjalan: 0, menunggu: 0, tidakTerpakai: 0, takTernilai: 0, tp: 0, sl: 0 });
  function finish(c) {
    const done = c.terpakai + c.tidakTerpakai;
    return { ...c, akurasi: c.terpakai ? c.tp / c.terpakai : null, tingkatEksekusi: done ? c.terpakai / done : null };
  }
  function addRow(c, r) {
    c.generated++;
    const x = r.execSrc;
    if (x === 'TERPAKAI') { c.terpakai++; if (r.accSrc === 'AKURAT') c.tp++; else c.sl++; }
    else if (x === 'BERJALAN') c.berjalan++; else if (x === 'MENUNGGU') c.menunggu++;
    else if (x === 'TIDAK_TERPAKAI') c.tidakTerpakai++; else c.takTernilai++;
  }

  /**
   * D: isi dashboard.json (diubah di tempat). journals: { [engineId]: array entri jurnal mentah dari website mesin }.
   * Mengembalikan { changed, perEngine, ids } (ids = setupId yang diperbarui).
   */
  function applyLive(D, journals) {
    const out = { changed: 0, perEngine: {}, ids: [] };
    const src = D.liveSources ?? {};
    const rowsBy = {};
    for (const r of D.jurnal ?? []) (rowsBy[r.engine] ??= []).push(r);
    for (const [eng, arr] of Object.entries(journals ?? {})) {
      if (!Array.isArray(arr)) continue;
      const cfg = src[eng] ?? {};
      const map = new Map();
      for (const e of arr) {
        if (!e || !isOwn(e, cfg)) continue;
        const min = minuteOf(e), en = num(e.entry);
        if (min == null || en == null) continue;
        map.set(keyOf(min, e.aset, e.arah, en), e);
      }
      let n = 0;
      for (const r of rowsBy[eng] ?? []) {
        // Hanya yang masih menunggu; hasil final tidak pernah ditimpa.
        if (!r.hasSource || r.resultSrc !== 'PENDING' || r.entry == null || !r.analysisUtc) continue;
        const min = Math.floor(Date.parse(r.analysisUtc) / 6e4);
        const e = map.get(keyOf(min, r.ticker, r.direction, r.entry)) ?? map.get(keyOf(min - 1, r.ticker, r.direction, r.entry)) ?? map.get(keyOf(min + 1, r.ticker, r.direction, r.entry));
        if (!e) continue;
        const res = mapResult(e.hasil);
        if (res === 'PENDING') continue;
        const R = num(e.R), tp0 = Array.isArray(r.tp) ? r.tp[0] : r.tp;
        const levelR = tp0 != null && r.sl != null && r.entry !== r.sl ? Math.abs(tp0 - r.entry) / Math.abs(r.entry - r.sl) : null;
        const tx = num(e.tx), resolved = res === 'TP' || res === 'SL';
        r.resultSrc = res; r.sourceHasil = e.hasil; r.sourceResult = e.hasil; r.sourceR = R;
        r.rSrc = res === 'TP' ? (R != null && R > 0 ? R : levelR) : res === 'SL' ? (R != null && R < 0 ? R : -1) : null;
        r.execSrc = execOf(res); r.accSrc = accOf(res);
        r.resultSrcWib = resolved ? wib(tx != null && tx > 0 ? tx : Date.parse(r.analysisUtc)) : null;
        r.liveUpdated = true;
        n++; out.ids.push(r.id);
      }
      out.perEngine[eng] = n; out.changed += n;
    }
    if (out.changed) {
      // Rekap Jurnal (basis "menurut mesin") dihitung ulang dari baris yang sama dengan yang tampil.
      if (D.jurnalStats?.source) {
        for (const eng of D.engineIds ?? []) {
          const all = emptyScore(), ready = emptyScore(), not = emptyScore();
          for (const r of rowsBy[eng] ?? []) { addRow(all, r); addRow(r.readyEver ? ready : not, r); }
          D.jurnalStats.source[eng] = { semua: finish(all), pernahSetup: finish(ready), tidakPernahSetup: finish(not) };
        }
      }
      // Tab Setup: hasil jurnal tiap setup siap ikut diperbarui.
      const byId = new Map((D.jurnal ?? []).map((r) => [r.id, r]));
      for (const st of Object.values(D.live?.engines ?? {})) for (const it of st.items ?? []) {
        const j = it.jurnalId ? byId.get(it.jurnalId) : null;
        if (j?.liveUpdated) it.jResultSrc = j.resultSrc;
      }
    }
    return out;
  }

  async function fetchJournal(url, fetchFn, timeoutMs) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, { cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error('bukan array');
      return j;
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Ambil jurnal semua mesin secara paralel, lalu terapkan. Kegagalan satu mesin tidak mengganggu yang lain. */
  async function loadLive(D, fetchFn = root.fetch?.bind(root), timeoutMs = 12000) {
    const src = D.liveSources ?? {};
    const journals = {}, failed = [];
    await Promise.all(Object.entries(src).map(async ([eng, c]) => {
      try { journals[eng] = await fetchJournal(c.url, fetchFn, timeoutMs); } catch (e) { failed.push(eng); }
    }));
    const r = applyLive(D, journals);
    return { ...r, failed, checked: Object.keys(journals).length };
  }

  const api = { applyLive, loadLive, mapResult, minuteOf };
  root.LiveOverlay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
