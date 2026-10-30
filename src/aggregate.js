import { TN_TIMEFRAME } from './parsers/tn.js';
import { ENGINE_IDS, engineById } from './engines.js';
import { sourceEvaluation, withSourceEvaluation } from './sourceEval.js';
import { toWib } from './util/time.js';
import { summarize, groupBy, periodStats, markClusters, compareEngines, pairSetups } from './statistics/stats.js';

const tfOf = (s) => s.timeframe ?? (s.engine === 'tn' ? TN_TIMEFRAME : (engineById(s.engine)?.timeframe ?? null));

/**
 * Status "terpakai" sebuah analisis dari hasilnya:
 *   TERPAKAI        entry tersentuh dan trade selesai (TP atau SL)
 *   BERJALAN        entry tersentuh, belum selesai (hanya diketahui dari verifikasi candle)
 *   MENUNGGU        belum ada konfirmasi entry tersentuh
 *   TIDAK_TERPAKAI  tidak pernah tereksekusi (kedaluwarsa / tidak terisi / batal)
 *   TAK_TERNILAI    data tidak cukup (INVALID / AMBIGUOUS)
 * Akurasi hanya bermakna untuk yang TERPAKAI: TP = AKURAT, SL = MELESET.
 */
export const execState = (result, entryTimeUtc) => {
  if (result === 'TP' || result === 'SL') return 'TERPAKAI';
  if (result === 'PENDING' || result == null) return entryTimeUtc ? 'BERJALAN' : 'MENUNGGU';
  if (result === 'EXPIRED' || result === 'CANCELLED') return 'TIDAK_TERPAKAI';
  return 'TAK_TERNILAI';
};
export const accOf = (result) => (result === 'TP' ? 'AKURAT' : result === 'SL' ? 'MELESET' : null);

const view = (s, cl) => {
  const se = sourceEvaluation(s);
  return {
    readyEver: !!s.readyEver, readyFirstWib: toWib(s.readyFirstSeenUtc), readyLastWib: toWib(s.readyLastSeenUtc),
    exec: execState(s.evaluation?.result ?? 'PENDING', s.evaluation?.entryTimeUtc), acc: accOf(s.evaluation?.result),
    execSrc: execState(se.result, se.entryTimeUtc), accSrc: accOf(se.result),
    id: s.setupId, engine: s.engine, analysisWib: s.analysisTimeWib, analysisUtc: s.analysisTimeUtc, ticker: s.ticker,
    direction: s.direction, entryType: s.entryType, entry: s.entryPrice, entryRange: s.entryRange, tp: s.takeProfit,
    sl: s.stopLoss, rr: s.riskReward, riskPct: s.riskPercent, reason: s.entryReason, timeframe: tfOf(s),
    originalStatus: s.originalStatus, latestOriginalStatus: s.latestOriginalStatus,
    // Hasil "menurut mesin" (apa yang tertampil di website) dan hasil verifikasi candle Binance.
    result: s.evaluation?.result ?? 'PENDING', resultWib: toWib(s.evaluation?.resultTimeUtc), resultTimeSource: s.evaluation?.resultTimeSource ?? null,
    resultSrc: se.result, rSrc: se.rMultiple ?? null, sourceHasil: s.sourceResult ?? null, resultSrcWib: toWib(se.resultTimeUtc),
    hasSource: s.sourceResult != null,
    entryWib: toWib(s.evaluation?.entryTimeUtc), r: s.evaluation?.rMultiple ?? null, notes: s.evaluation?.notes ?? [],
    reasonCode: s.evaluation?.reasonCode ?? null, warnings: s.warnings ?? [], clusterId: cl?.clusterId, isPrimary: cl?.isPrimary ?? true,
    analysisTimeSource: s.analysisTimeSource, sourceResult: s.sourceResult ?? null, sourceR: s.sourceR ?? null,
    priceDataError: s.evaluation?.priceDataError ?? null,
  };
};

export const BASES = ['source', 'candle'];

/** Rekap JURNAL per mesin: berapa analisis dihasilkan, berapa yang terpakai, dan seberapa akurat. */
export function jurnalScore(list) {
  const c = { generated: list.length, terpakai: 0, berjalan: 0, menunggu: 0, tidakTerpakai: 0, takTernilai: 0, tp: 0, sl: 0 };
  for (const s of list) {
    const e = s.evaluation ?? { result: 'PENDING' };
    const x = execState(e.result, e.entryTimeUtc);
    if (x === 'TERPAKAI') { c.terpakai++; if (e.result === 'TP') c.tp++; else c.sl++; }
    else if (x === 'BERJALAN') c.berjalan++; else if (x === 'MENUNGGU') c.menunggu++;
    else if (x === 'TIDAK_TERPAKAI') c.tidakTerpakai++; else c.takTernilai++;
  }
  const done = c.terpakai + c.tidakTerpakai;
  return { ...c,
    akurasi: c.terpakai ? c.tp / c.terpakai : null,                // TP / (TP + SL)
    tingkatEksekusi: done ? c.terpakai / done : null };             // terpakai / (terpakai + tidak terpakai), hanya yang sudah final
}

export function buildDashboard({ jurnal, setups, live = null, diagnostics, cfg, nowIso }) {
  setups = jurnal ?? setups ?? [];
  const clusters = markClusters(setups, cfg.cluster);
  const rows = setups.map((s) => view(s, clusters.get(s.setupId)))
    .sort((a, b) => (a.analysisUtc < b.analysisUtc ? 1 : -1));
  const sets = { candle: setups, source: setups.map(withSourceEvaluation) };
  const by = (basis, e, primaryOnly) => sets[basis].filter((s) => s.engine === e && (!primaryOnly || clusters.get(s.setupId).isPrimary));

  const engines = {}, comparison = {};
  const copts = { minSample: cfg.minSamplePerEngine, iterations: cfg.bootstrapIterations };
  for (const basis of BASES) {
    engines[basis] = {}; comparison[basis] = {};
    for (const scope of ['independent', 'all']) {
      const po = scope === 'independent';
      engines[basis][scope] = {}; comparison[basis][scope] = {};
      for (const e of ENGINE_IDS) {
        const l = by(basis, e, po);
        const summary = summarize(l);
        // Mesin tidak memberi waktu entry; rata-rata menit ke entry hanya bermakna untuk basis candle.
        if (basis === 'source' && l.some((s) => s.evaluation?.basis === 'source')) summary.avgMinutesToEntry = null;
        engines[basis][scope][e] = { summary, byTicker: groupBy(l, (s) => s.ticker), byDirection: groupBy(l, (s) => s.direction),
          byTimeframe: groupBy(l, (s) => tfOf(s)), byReason: groupBy(l, (s) => s.entryReason),
          daily: periodStats(l, 'daily'), weekly: periodStats(l, 'weekly'), monthly: periodStats(l, 'monthly') };
      }
      for (let i = 0; i < ENGINE_IDS.length; i++) for (let j = i + 1; j < ENGINE_IDS.length; j++) {
        const a = ENGINE_IDS[i], b = ENGINE_IDS[j];
        comparison[basis][scope][`${a}|${b}`] = compareEngines(by(basis, a, po), by(basis, b, po), copts);
      }
    }
  }

  // Pasangan setup lintas mesin (simbol sama, waktu berdekatan). Hasil = menurut mesin bila ada, selain itu candle.
  const pairs = {};
  let conflicts = [];
  for (let i = 0; i < ENGINE_IDS.length; i++) for (let j = i + 1; j < ENGINE_IDS.length; j++) {
    const a = ENGINE_IDS[i], b = ENGINE_IDS[j];
    const ps = pairSetups(by('source', a, false), by('source', b, false), cfg.pairWindowMinutes);
    pairs[`${a}|${b}`] = ps.slice(-150).map((p) => ({ symbol: p.symbol, minutesApart: p.minutesApart, relation: p.relation,
      a: p[a], b: p[b], entryDiffPct: p.entryDiffPct, tpDiffPct: p.tpDiffPct, slDiffPct: p.slDiffPct }));
    conflicts.push(...ps.filter((p) => p.relation === 'CONFLICT').map((p) => ({ symbol: p.symbol, engines: [a, b], a: p[a].direction, b: p[b].direction })));
  }
  conflicts = conflicts.slice(-300);

  // JURNAL: rekap terpakai/akurat per mesin; dipisah antara analisis yang pernah tampil di tab Setup dan yang tidak.
  const jurnalStats = {};
  for (const basis of BASES) {
    jurnalStats[basis] = {};
    for (const e of ENGINE_IDS) {
      const l = sets[basis].filter((s) => s.engine === e);
      jurnalStats[basis][e] = { semua: jurnalScore(l), pernahSetup: jurnalScore(l.filter((s) => s.readyEver)), tidakPernahSetup: jurnalScore(l.filter((s) => !s.readyEver)) };
    }
  }

  // SETUP: daftar siap eksekusi saat ini (data/setup.json), tiap item dipasangkan dengan hasilnya di jurnal bila sudah ada.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const liveOut = { updatedUtc: live?.updatedUtc ?? null, updatedWib: toWib(live?.updatedUtc), engines: {} };
  let setupSiap = 0;
  for (const e of ENGINE_IDS) {
    const st = live?.engines?.[e] ?? null;
    const items = (st?.items ?? []).map((x) => {
      const j = x.journalId ? byId.get(x.journalId) : null;
      return { id: x.liveId, engine: x.engine, ticker: x.ticker, direction: x.direction, entryType: x.entryType, entry: x.entryPrice, entryRange: x.entryRange,
        tp: x.takeProfit, sl: x.stopLoss, rr: x.riskReward, riskUsd: x.riskAmountUsd, qty: x.quantity, timeframe: x.timeframe, cardStatus: x.cardStatus,
        reason: x.reason, price: x.price, distToEntryPct: x.distToEntryPct, confirmation: x.confirmation,
        firstSeenWib: toWib(x.firstSeenUtc), lastSeenWib: toWib(x.lastSeenUtc), seenCount: x.seenCount,
        inJurnal: !!j, jurnalId: x.journalId ?? null, jurnalWib: j?.analysisWib ?? null,
        jResultSrc: j ? (j.hasSource ? j.resultSrc : j.result) : null, jResult: j?.result ?? null };
    });
    setupSiap += items.length;
    liveOut.engines[e] = { tracked: !!st, scanWib: toWib(st?.scanUtc), lastAttemptWib: toWib(st?.lastAttemptUtc), scanStatus: st?.scanStatus ?? null, stale: st?.stale ?? null,
      rejected: st?.rejected ?? null, errors: st?.errors ?? [], count: items.length, items };
  }

  const lastRun = diagnostics.runs.at(-1) ?? null;
  const quality = {
    invalid: rows.filter((r) => r.result === 'INVALID'), ambiguous: rows.filter((r) => r.result === 'AMBIGUOUS'),
    unverified: rows.filter((r) => r.priceDataError),
    withWarnings: rows.filter((r) => r.warnings.length), nearDuplicates: rows.filter((r) => !r.isPrimary),
    conflicts,
    // Hasil mesin (website) berbeda dari verifikasi candle: TP/SL berlawanan, atau salah satunya sudah final dan yang lain belum.
    sourceDisagreements: rows.filter((r) => r.hasSource && ['TP', 'SL'].includes(r.resultSrc) && ['TP', 'SL'].includes(r.result) && r.resultSrc !== r.result),
    unknownAnalysisTime: rows.filter((r) => r.analysisTimeSource === 'unknown_before_tracking'),
  };
  return { generatedAtUtc: nowIso, generatedAtWib: toWib(nowIso), counts: { jurnal: rows.length, setupSiap },
    engineIds: ENGINE_IDS, bases: BASES, engines, comparison, pairs, jurnal: rows, jurnalStats, live: liveOut, quality,
    diagnostics: { lastRun, runs: diagnostics.runs.slice(-50) },
    methodology: { source: 'Binance Spot klines', note: 'Basis "menurut mesin" = hasil yang tertampil di website tiap mesin. Basis "candle" = verifikasi ulang dari candle Binance (teoretis, tanpa fee/slippage).' } };
}
