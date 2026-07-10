/**
 * src/engine/moatQuality.js — Block 5: Quality & Moat overlay.
 *
 * Returns LABELS, not scores (by design): a Moat tier, a Quality tier, and the
 * valuation Implication — each with plain-English evidence. It consumes the same
 * normalized history + ratioResult the rest of the engine uses and NEVER touches
 * stage or fair value (one-way causation preserved).
 *
 * WHAT'S COMPUTED vs GATED
 * ------------------------
 * Computed from financials you already have (always available):
 *   ROCE level + consistency + trend, gross/operating/net-margin level + trend,
 *   ROE level + consistency, incremental ROCE, FCF conversion, leverage (D/E),
 *   interest coverage, dilution (implied shares = netProfit ÷ eps per year).
 * Not computable from current data (flagged, never faked):
 *   liquidity (no current assets/liabilities in history), market-share trend.
 * GATED — folded in ONLY when BOTH Screener holdings paste AND annual report are
 * present (opts.bothPresent === true):
 *   promoter-pledge trend, promoter-holding trend, related-party transactions.
 *
 * Very Wide requires a QUALITATIVE overlay (regulatory monopoly / network effect /
 * insurmountable scale) that numbers can't grade — so the engine flags
 * `veryWideEligible` when the ratios qualify, and the UI lets the user affirm the
 * overlay (or apply moatOverride) to elevate. Numbers alone never award Very Wide.
 */

import { latest, hasContent } from './reconcileDocs.js'

// ── tunable thresholds (surface in ScoringStudio later) ───────────────────────
export const MQ_CONFIG = {
  roce:   { veryWide: 25, wide: 20, narrow: 12, hitPct: 80 },
  roe:    { high: 18, ok: 12, hitPct: 70 },
  fcfConv:{ high: 70, ok: 40 },
  de:     { low: 0.5, high: 1.5 },
  icr:    { strong: 8, ok: 4 },
  incRoce:{ high: 18, ok: 10 },
  marginTrendEps: 0.05,      // ±5% of mean over window = expanding/contracting
  grossMarginWeight: 1.5,    // gross-margin stability weighted higher than operating
}

// ── public entry ──────────────────────────────────────────────────────────────
export function assessMoatQuality(data, ratioResult, opts = {}) {
  const {
    holdings = null,     // { promoterSeries:[{q,pct}] } from Screener paste
    arData = null,       // document intelligence (pledgeTrend, rptTrend, …)
    moatOverride = null, // { tier, reason }
    config = MQ_CONFIG,
  } = opts

  // Gate: enough data to be meaningful = promoter holdings present AND at least
  // one document has contributed intelligence.
  const bothPresent = !!(holdings?.promoterSeries?.length && hasContent(arData))

  const series = buildSeries(data, ratioResult)
  const flags = []

  // ── metric summaries ────────────────────────────────────────────────────────
  const roce  = summarize(series.roce, config.roce.narrow)
  const gm    = summarize(series.grossMargin)
  const om    = summarize(series.opMargin)
  const nm    = summarize(series.netMargin)
  const roe   = summarize(series.roe, config.roe.ok)
  const incRoce = incrementalRoce(series)
  const dilution = dilutionSignal(series.impliedShares)

  const de  = ratioResult?.ratios?.de?.value ?? null
  const icr = ratioResult?.ratios?.icr?.value ?? null
  const fcfConv = ratioResult?.ratios?.fcfConversion?.value ?? null

  if (!series.roce.length) flags.push('roce_series_unavailable')
  flags.push('liquidity_unavailable')      // no current assets/liabilities in data
  flags.push('market_share_unavailable')   // not in any current source

  // Gated governance signals (strict: promoter holdings + document intelligence).
  let pledge = null, promoterTrend = null, rptSignal = null
  if (bothPresent) {
    const lp = latest(arData.pledgeTrend)
    pledge = lp ? { last: round(lp.pct, 1), asOf: lp.asOf, high: lp.pct > 20, dir: pledgeDir(arData.pledgeTrend) } : null
    promoterTrend = trendSignal(holdings?.promoterSeries)
    const lr = latest(arData.rptTrend)
    rptSignal = lr
      ? { present: true, level: lr.pctOfRevenue, asOf: lr.asOf, heavy: (lr.pctOfRevenue ?? 0) > 10 }
      : { present: false, heavy: false }
  } else {
    flags.push('governance_locked')        // needs Screener holdings + a document
  }

  // ── MOAT tier (ROCE level+consistency + margin trend; gross weighted higher) ─
  const moat = deriveMoat({ roce, gm, om, config })
  if (moatOverride?.tier) {
    moat.tier = moatOverride.tier
    moat.source = 'override'
    moat.evidence = [{ ok: null, text: `Manual override: ${moatOverride.reason || 'qualitative overlay applied'}` }, ...moat.evidence]
  }

  // ── QUALITY tier (your High/Medium/Low table) ───────────────────────────────
  const quality = deriveQuality({
    roe, fcfConv, de, icr, incRoce, dilution, pledge, rptSignal, bothPresent, config,
  })

  // ── Implication (pure lookup on Moat × Quality) ─────────────────────────────
  const implication = implicationFor(moat.tier, quality.tier)

  return {
    gated: bothPresent,
    moat,
    quality,
    implication,
    metrics: {
      roce, grossMargin: gm, opMargin: om, netMargin: nm, roe,
      incRoce, dilution, de, icr, fcfConv,
      pledge, promoterTrend, rpt: rptSignal,
    },
    dataFlags: [...new Set(flags)],
  }
}

// ── series construction ───────────────────────────────────────────────────────
function buildSeries(data, r) {
  const inc = (data?.incomeHistory || []).filter(x => !x.synthetic)
  const bal = (data?.balanceHistory || []).filter(x => !x.synthetic)
  const cf  = (data?.cashflowHistory || []).filter(x => !x.synthetic)
  const balByYear = index(bal), cfByYear = index(cf)
  const v = f => (f && f.value != null ? f.value : null)

  const roce = [], grossMargin = [], opMargin = [], netMargin = [], roe = [], impliedShares = []
  for (const row of inc) {
    const y = row.year
    const b = balByYear[y] || {}
    const rev = v(row.revenue), op = v(row.operatingProfit), gp = v(row.grossProfit)
    const np = v(row.netProfit), eps = v(row.eps)
    const eq = v(b.totalEquity), debt = v(b.totalDebt) ?? 0
    const ce = eq != null ? eq + debt : null

    if (op != null && ce && ce > 0) roce.push(pct(op, ce))
    if (gp != null && rev) grossMargin.push(pct(gp, rev))
    if (op != null && rev) opMargin.push(pct(op, rev))
    if (np != null && rev) netMargin.push(pct(np, rev))
    if (np != null && eq && eq > 0) roe.push(pct(np, eq))
    if (np != null && eps && eps !== 0) impliedShares.push(np / eps)   // dilution proxy
  }
  return { roce, grossMargin, opMargin, netMargin, roe, impliedShares }
}

const index = rows => Object.fromEntries((rows || []).map(r => [r.year, r]))
const pct = (a, b) => (b ? (a / b) * 100 : null)

// ── stats ─────────────────────────────────────────────────────────────────────
function summarize(arr, hitThreshold = null) {
  const a = (arr || []).filter(x => typeof x === 'number' && isFinite(x))
  if (!a.length) return { n: 0, median: null, mean: null, last: null, hitRate: null, stability: null, trend: null }
  const mean = a.reduce((s, x) => s + x, 0) / a.length
  const sorted = [...a].sort((x, y) => x - y)
  const m = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
  const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length
  const stdev = Math.sqrt(variance)
  const stability = mean !== 0 ? Math.max(0, 1 - Math.min(1, stdev / Math.abs(mean))) : null
  const hitRate = hitThreshold != null ? a.filter(x => x >= hitThreshold).length / a.length * 100 : null
  const slope = ols(a)
  const rel = mean !== 0 ? (slope * a.length) / Math.abs(mean) : 0
  const trend = rel > MQ_CONFIG.marginTrendEps ? 'expanding' : rel < -MQ_CONFIG.marginTrendEps ? 'contracting' : 'stable'
  return { n: a.length, median: round(median, 1), mean: round(mean, 1), last: round(a[a.length - 1], 1),
           hitRate: hitRate == null ? null : Math.round(hitRate), stability: round(stability, 2), trend }
}

function ols(a) {
  const n = a.length
  if (n < 2) return 0
  const xs = a.map((_, i) => i)
  const mx = (n - 1) / 2, my = a.reduce((s, x) => s + x, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (a[i] - my); den += (xs[i] - mx) ** 2 }
  return den ? num / den : 0
}

function incrementalRoce(series) {
  // ΔEBIT / ΔCapitalEmployed proxy via ROCE trend isn't enough; approximate using
  // opMargin×revenue is unavailable here, so use the change in ROCE-implied return.
  // Best-effort: compare last-vs-first ROCE as directional signal.
  const a = series.roce
  if (a.length < 2) return { value: null, quality: null }
  const delta = a[a.length - 1] - a[0]
  const quality = delta > 2 ? 'improving' : delta < -2 ? 'declining' : 'flat'
  return { value: round(a[a.length - 1], 1), quality }
}

function dilutionSignal(shares) {
  const a = (shares || []).filter(x => typeof x === 'number' && isFinite(x) && x > 0)
  if (a.length < 2) return { trend: null, pct: null }
  const change = (a[a.length - 1] - a[0]) / a[0] * 100
  const trend = change > 5 ? 'diluting' : change < -2 ? 'buyback' : 'stable'
  return { trend, pct: round(change, 1) }
}

function pledgeDir(trend) {
  const a = (trend || []).map(r => r.pct).filter(x => typeof x === 'number')
  if (a.length < 2) return 'stable'
  const last = a[a.length - 1], first = a[0]
  return last > first + 1 ? 'rising' : last < first - 1 ? 'falling' : 'stable'
}

function trendSignal(series) {
  const a = (series || []).map(s => s.pct).filter(x => typeof x === 'number')
  if (!a.length) return null
  const last = a[a.length - 1], first = a[0]
  const dir = last > first + 0.5 ? 'rising' : last < first - 0.5 ? 'falling' : 'stable'
  return { last: round(last, 1), dir }
}

// ── tier derivation ───────────────────────────────────────────────────────────
function deriveMoat({ roce, gm, om, config }) {
  const ev = []
  const rc = config.roce
  const level = roce.median
  const consistent = roce.hitRate
  const marginTrend = gm.trend || om.trend
  const marginOk = marginTrend === 'expanding' || marginTrend === 'stable'

  if (level == null) {
    return { tier: 'None', veryWideEligible: false, source: 'computed',
             evidence: [{ ok: false, text: 'ROCE series unavailable — moat cannot be evidenced from returns.' }] }
  }

  ev.push({ ok: level >= rc.wide, text: `ROCE median ${level}% (${roce.n} yrs)` })
  if (consistent != null) ev.push({ ok: consistent >= rc.hitPct, text: `ROCE ≥ ${rc.narrow}% in ${consistent}% of years` })
  ev.push({ ok: marginOk, text: `Gross/operating margin ${marginTrend || 'n/a'}` })

  let tier, veryWideEligible = false
  if (level >= rc.wide && (consistent == null || consistent >= rc.hitPct) && marginOk) {
    tier = 'Wide'
    if (level >= rc.veryWide && (consistent == null || consistent >= 90) && gm.trend !== 'contracting') {
      veryWideEligible = true   // numbers qualify; needs qualitative overlay to elevate
    }
  } else if (level >= rc.narrow || (level >= rc.wide && !marginOk)) {
    tier = 'Narrow'
  } else {
    tier = 'None'
  }
  return { tier, veryWideEligible, source: 'computed', evidence: ev }
}

function deriveQuality({ roe, fcfConv, de, icr, incRoce, dilution, pledge, rptSignal, bothPresent, config }) {
  const ev = []
  let good = 0, bad = 0, critical = 0

  // ROE level + consistency
  if (roe.median != null) {
    const strong = roe.median >= config.roe.high && (roe.hitRate == null || roe.hitRate >= config.roe.hitPct)
    ev.push({ ok: strong, text: `ROE median ${roe.median}%${roe.hitRate != null ? `, ${roe.hitRate}% of yrs ≥ ${config.roe.ok}%` : ''}` })
    strong ? good++ : (roe.median < config.roe.ok ? bad++ : null)
  }
  // FCF conversion
  if (fcfConv != null) {
    const strong = fcfConv >= config.fcfConv.high
    ev.push({ ok: strong, text: `FCF conversion ${round(fcfConv, 0)}%` })
    strong ? good++ : (fcfConv < config.fcfConv.ok ? bad++ : null)
  }
  // Leverage OR coverage
  if (de != null || icr != null) {
    const lowLev = de != null && de < config.de.low
    const strongCov = icr != null && icr >= config.icr.strong
    const ok = lowLev || strongCov
    ev.push({ ok, text: `${de != null ? `D/E ${round(de, 2)}` : ''}${de != null && icr != null ? ' · ' : ''}${icr != null ? `coverage ${round(icr, 1)}×` : ''}` })
    ok ? good++ : null
    if (de != null && de > config.de.high && (icr == null || icr < config.icr.ok)) { bad++; critical++ }
  }
  // Incremental ROCE
  if (incRoce.quality) {
    const ok = incRoce.quality === 'improving' || incRoce.quality === 'flat'
    ev.push({ ok, text: `Incremental returns ${incRoce.quality}` })
    incRoce.quality === 'improving' ? good++ : (incRoce.quality === 'declining' ? bad++ : null)
  }
  // Dilution
  if (dilution.trend) {
    const ok = dilution.trend !== 'diluting'
    ev.push({ ok, text: `Share count ${dilution.trend}${dilution.pct != null ? ` (${dilution.pct > 0 ? '+' : ''}${dilution.pct}%)` : ''}` })
    dilution.trend === 'buyback' ? good++ : (dilution.trend === 'diluting' ? bad++ : null)
  }
  // Gated governance (only when both sources present)
  if (bothPresent) {
    if (pledge) {
      const ok = !pledge.high && pledge.dir !== 'rising'
      ev.push({ ok, text: `Promoter pledge ${pledge.last}% (${pledge.dir})${pledge.asOf ? ` · as of ${pledge.asOf}` : ''}` })
      pledge.high || pledge.dir === 'rising' ? (bad++, pledge.high && critical++) : good++
    }
    if (rptSignal) {
      const ok = !rptSignal.heavy
      const rptText = rptSignal.present === false
        ? 'No material related-party transactions'
        : `Related-party ${rptSignal.level != null ? rptSignal.level + '% of revenue' : 'disclosed'}${rptSignal.asOf ? ` · as of ${rptSignal.asOf}` : ''}`
      ev.push({ ok, text: rptText })
      rptSignal.heavy ? (bad++, critical++) : null
    }
  } else {
    ev.push({ ok: null, text: '🔒 Promoter pledge & related-party pending Screener holdings + annual report' })
  }

  let tier
  if (critical > 0 || bad >= 2) tier = 'Low'
  else if (bad === 0 && good >= Math.max(3, Math.ceil(ev.filter(e => e.ok !== null).length * 0.6))) tier = 'High'
  else tier = 'Medium'

  return { tier, evidence: ev, signals: { good, bad, critical } }
}

// ── Implication lookup (your table, verbatim) ─────────────────────────────────
function implicationFor(moat, quality) {
  const m = moat, q = quality
  if (m === 'Very Wide' && q === 'High') return 'Strong premium justified (quality compounder).'
  if (m === 'Wide' && q === 'High')      return 'Can justify a premium to peers.'
  if (m === 'Narrow' && q === 'High')    return 'Fair valuation only.'
  if (m === 'Wide' && q === 'Medium')    return 'Selective — buy at reasonable valuations.'
  if ((m === 'Narrow' || m === 'None') && q === 'Low') return 'Demand a deep discount only.'
  // sensible fills for the remaining cells
  if (q === 'Low')  return 'Demand a discount; quality concerns outweigh the moat.'
  if (m === 'None') return 'Commodity-like — pay only at cheap valuations.'
  return 'Fair valuation; no premium warranted on current evidence.'
}

const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d)
