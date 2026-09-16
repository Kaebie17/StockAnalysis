/**
 * src/engine/targetMultiple.js — the multiple to apply, measured not assumed.
 *
 * How analysts actually set a price target (Bradshaw 2002; Yin, Peasnell &
 * Hunt 2018): take the firm's OWN historical earnings multiple as the anchor,
 * then assign a premium where fundamentals are expected to be more attractive
 * than the past produced, or a discount where less, cross-checked against peers.
 * Around 94% of published targets are built this way rather than from DCF.
 *
 * The previous version took the historical median flat, with no adjustment for
 * changed prospects — so a company earning materially better returns than its
 * history still got its history's multiple.
 *
 * The adjustment is FITTED, not chosen. Over the years available, the stock's
 * own multiple is regressed against its own ROE and growth; the resulting
 * sensitivity says what a point of extra ROE has historically been worth for
 * THIS company. Where the data won't support a fit, no adjustment is applied —
 * a made-up scaling factor is worse than none, because it looks like analysis.
 */

import { percentileSpread } from './spread.js'
import { TIER } from './methodologyTier.js'
import { activeValue } from './dataQuality.js'

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)
const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

// Below this many complete observations a fitted slope is noise dressed as a
// finding. Four annual points is already thin; three is not a relationship.
const MIN_OBSERVATIONS = 4

// A fit that explains almost nothing shouldn't drive anything. Below this the
// multiple and the fundamental simply didn't move together for this company.
// Raised from 0.30: the adjustment used to also be capped at half the anchor
// regardless of fit quality, a second damper against a weak-but-passing fit
// swinging the result too far. That cap was removed (an asserted percentage
// with no derivation, doing the same job this threshold should do on its
// own) — with it gone, this bar carries the whole job of keeping a genuinely
// noisy fit from being trusted, so it needs to do more work than before.
const MIN_R2 = 0.4

/**
 * Ordinary least squares on (x, y), returning slope, intercept, R², and the
 * residual variance a genuine prediction interval needs (sxx, residualSE) —
 * small enough to keep here rather than take a dependency for one regression.
 */
export function fitLine(points = []) {
  const pts = points.filter(p => isFinite(p.x) && isFinite(p.y))
  const n = pts.length
  if (n < 3) return null
  const mx = pts.reduce((s, p) => s + p.x, 0) / n
  const my = pts.reduce((s, p) => s + p.y, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my)
    sxx += (p.x - mx) ** 2
    syy += (p.y - my) ** 2
  }
  if (sxx === 0 || syy === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r = sxy / Math.sqrt(sxx * syy)
  // SSE via the standard OLS identity (Syy - slope*Sxy) rather than a second
  // pass computing each residual directly — same result, one loop.
  const sse = Math.max(0, syy - slope * sxy)
  const residualSE = n > 2 ? Math.sqrt(sse / (n - 2)) : null
  return { slope, intercept, r2: r * r, n, meanX: mx, meanY: my, sxx, residualSE }
}

// Student's t two-tailed 80%-confidence critical values (one-tailed α=0.10),
// keyed by degrees of freedom — standard, published values (verifiable
// against any statistics reference), not fitted or chosen for this app. 80%
// is a common, recognized prediction-interval confidence level, distinct
// from this file's own 15th/85th percentile-spread convention used
// elsewhere (a plain percentile split, not a regression interval — the two
// answer different questions and have no reason to share a number).
const T_TABLE_80 = {
  1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476,
  6: 1.440, 7: 1.415, 8: 1.397, 9: 1.383, 10: 1.372,
  11: 1.363, 12: 1.356, 13: 1.350, 14: 1.345, 15: 1.341,
  16: 1.337, 17: 1.333, 18: 1.330, 19: 1.328, 20: 1.325,
  21: 1.323, 22: 1.321, 23: 1.319, 24: 1.318, 25: 1.316,
  26: 1.315, 27: 1.314, 28: 1.313, 29: 1.311, 30: 1.310,
}
const T_NORMAL_APPROX_80 = 1.282   // z-value the t-distribution converges to as df grows

function tCritical(df) {
  if (!(df > 0)) return T_NORMAL_APPROX_80
  const rounded = Math.max(1, Math.round(df))
  return T_TABLE_80[rounded] ?? T_NORMAL_APPROX_80
}

/**
 * The multiple this stock actually traded at in each fiscal year, paired with
 * the fundamentals it was earning at the time.
 *
 * Uses the MEDIAN close within the year rather than a point reading, so one
 * spike doesn't define the year, and pairs it with that year's reported figures
 * — which is what the market could see while paying that price.
 */
// normBasis: the reported/normalized toggle (not `basis` below, which picks
// P/E vs P/B) — resolved here, internally, so this function is safe to call
// directly with a ticker's raw stored history rather than requiring every
// caller to pre-correct it for restatements first.
export function yearlyObservations({ priceHistory = [], incomeHistory = [], balanceHistory = [],
                                     basis = 'pe', fyEndMonth = 3, normBasis = 'reported' } = {}) {
  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
  // A year with real, usable financial data that has no priced trading day
  // anywhere in it just vanishes from `out` below (the `continue` at the
  // price-overlap check) — same as any other excluded year, but for a
  // different reason: the financials are fine, only price coverage is
  // missing (fetched price history starting later than pasted statement
  // history is the usual cause). Tracked separately so a caller can tell
  // "not enough financial history" apart from "price data doesn't reach
  // back as far as the statements do" instead of both looking like the same
  // plain shortfall.
  const priceGapYears = []
  if (closes.length === 0) return Object.assign([], { priceGapYears })

  const out = []
  for (const row of incomeHistory || []) {
    const y = yearOf(row)
    if (y == null) continue

    const eps = val(activeValue(row, 'eps', normBasis))
    const revenue = val(activeValue(row, 'revenue', normBasis))
    const netProfit = val(activeValue(row, 'netProfit', normBasis))
    const bRow = (balanceHistory || []).find(b => yearOf(b) === y)
    const equity = val(activeValue(bRow, 'totalEquity', normBasis))
    const shares = (netProfit > 0 && eps > 0) ? netProfit / eps : null
    const bps = (equity > 0 && shares > 0) ? equity / shares : null

    const denom = basis === 'pb' ? bps : eps
    if (!(denom > 0)) continue

    const start = Date.UTC(y - 1, fyEndMonth, 1)
    const end = Date.UTC(y, fyEndMonth, 0)
    const inYear = closes.filter(c => c.t >= start && c.t <= end).map(c => c.close).sort((a, b) => a - b)
    if (inYear.length === 0) { priceGapYears.push(y); continue }
    const medianClose = inYear[Math.floor(inYear.length / 2)]
    // A median is the most sample-efficient statistic there is — real even from
    // a thin year (a listing year, a data gap) — so it's used and disclosed as
    // thin rather than the whole year being silently dropped.
    const thinYear = inYear.length < 30

    // Fundamentals as of that year, computed the same way every year so the
    // series is internally consistent even if it differs slightly from the
    // headline ratio elsewhere.
    const roe = (netProfit > 0 && equity > 0) ? (netProfit / equity) * 100 : null
    const margin = (netProfit != null && revenue > 0) ? (netProfit / revenue) * 100 : null

    out.push({
      year: y,
      multiple: medianClose / denom,
      roe, margin,
      eps, revenue, bps,
      price: medianClose,
      thin: thinYear,
    })
  }

  out.sort((a, b) => a.year - b.year)
  // Year-on-year growth, available only from the second observation.
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1], cur = out[i]
    const base = basis === 'pb' ? 'bps' : 'eps'
    if (prev[base] > 0 && cur[base] > 0) {
      out[i].growth = ((cur[base] / prev[base]) - 1) * 100
    }
  }
  return Object.assign(out, { priceGapYears })
}

/**
 * The multiple to apply, and why.
 *
 * @param opts.basis         'pe' | 'pb'
 * @param opts.forwardRoe    expected ROE for the projection year
 * @param opts.forwardGrowth expected growth, %
 * @param opts.peerBand      { low, median, high } — the peer cross-check
 * @param opts.peerWeight    0-1, how much peerBand pulls the own-history
 *                           fitted multiple — a disclosed judgment call the
 *                           caller sets explicitly, not inferred here. 0
 *                           (default) means peers have no effect at all.
 */
export function targetMultiple(opts = {}) {
  const { basis = 'pe', forwardRoe = null, forwardGrowth = null, peerBand = null } = opts
  const peerWeight = Math.max(0, Math.min(1, opts.peerWeight ?? 0))
  const obs = yearlyObservations(opts)

  // A median needs a distribution behind it. Two annual observations give a
  // midpoint between two numbers, and a 15th/85th percentile band over two
  // points is just those two points — which is how a "59–171×" band reached a
  // Trent estimate of 4,441–12,886 against a fair value near 887. Three years is
  // the minimum that can describe a range at all.
  const MIN_YEARS_FOR_BAND = 3
  if (obs.length < MIN_YEARS_FOR_BAND) {
    const gapNote = obs.priceGapYears?.length > 0
      ? ` (${obs.priceGapYears.length} more year${obs.priceGapYears.length === 1 ? '' : 's'} of financial data — ` +
        `${obs.priceGapYears.join(', ')} — exist but have no overlapping price history)`
      : ''
    // DERIVED — real peer data plus a percentile formula, same standing as
    // the primary anchor below, not a weaker fallback in provenance terms.
    return peerBand?.median > 0
      ? { multiple: peerBand.median, low: peerBand.low, high: peerBand.high,
          basis, source: 'peers', observations: obs.length, tier: TIER.DERIVED,
          steps: [`Only ${obs.length} year${obs.length === 1 ? '' : 's'} of multiple history${gapNote} — ` +
                  `too few to describe a range, so peers are used instead.`] }
      : null
  }

  // Anchor: the stock's own median multiple across the observed years. Uses
  // the shared percentileSpread() (src/engine/spread.js) rather than a fifth
  // inline reimplementation of "sort, take a percentile" — this was the one
  // spread.js's own docblock still missed when it unified the other four.
  // Safe here without a separate length guard: percentileSpread's own
  // minSamples:3 default is already satisfied by MIN_YEARS_FOR_BAND above.
  const ps = percentileSpread(obs.map(o => o.multiple), { lowP: 0.15, highP: 0.85 })
  const anchor = ps.median

  const steps = [`Anchor: ${round(anchor)}× — this stock's median over ${obs.length} year${obs.length > 1 ? 's' : ''}`]
  // A thin year (fewer than 30 trading days — a listing year, a data gap) is
  // still a real median, just a noisier one, so it's included, not dropped —
  // but disclosed, since a thin year counting toward the 3-year minimum above
  // is not the same guarantee as three fully-traded years.
  const thinYears = obs.filter(o => o.thin).length
  if (thinYears > 0) {
    steps.push(`${thinYears} of ${obs.length} year${obs.length > 1 ? 's' : ''} used ha${thinYears === 1 ? 's' : 've'} a thin trading record`)
  }
  // Years with real financial data that never made it into `obs` at all
  // because no priced trading day fell inside them — most often means the
  // fetched price history doesn't reach back as far as the pasted/reported
  // statement history does, not a fundamentals problem.
  if (obs.priceGapYears?.length > 0) {
    steps.push(`${obs.priceGapYears.length} year${obs.priceGapYears.length === 1 ? '' : 's'} of financial data ` +
      `(${obs.priceGapYears.join(', ')}) had no overlapping price history — excluded from both the anchor and the fit`)
  }
  let adjusted = anchor
  const fits = []
  // Sum of squared per-factor prediction-interval margins — root-sum-square
  // is the standard way to propagate independent uncertainty contributions
  // through a sum, matching how the point estimate itself already combines
  // two independent single-variable fits (additively) rather than a true
  // joint multi-variable regression. Not more sophisticated than the point
  // estimate it surrounds, just consistent with it.
  //
  // Kept additive rather than rebuilt as a joint (multi-variable) regression
  // — a real, considered decision, not a shortcut. A joint fit would make
  // the ROE/growth interaction and a genuine 2-D domain check meaningful,
  // but needs real degrees of freedom to do it safely: 3 fitted parameters
  // (intercept + 2 slopes) on the 4-6 paired years this app typically has
  // for an NSE ticker leaves as few as 1-3 residual degrees of freedom,
  // before even accounting for ROE/growth's usual real-world correlation
  // making that worse. A model that would rarely clear its own honesty
  // gates isn't a safer model, just a more complicated path to the same
  // fallback. The correlation/overlap safeguard below addresses the
  // specific risk a joint model would have fixed (double-counting one
  // underlying effect across both independent fits) without needing the
  // sample size a joint fit would require.
  let marginsSquaredSum = 0

  // How much a fitted adjustment is trusted, by how many paired years
  // support it — descriptive labels, not a statistical guarantee. Purely
  // for the derivation log; doesn't gate anything on its own (LOO_DEVIATION
  // /correlation-overlap below do that).
  const confidenceTier = n => n <= 5 ? 'fragile' : n <= 7 ? 'moderate' : 'stronger'

  // Governance thresholds — calibration choices, not derived statistical
  // constants (same standing as MIN_R2/MIN_OBSERVATIONS above). Documented
  // as such rather than presented as settled methodology.
  const LOO_DEVIATION_BAND = 0.40        // max allowed swing (as a fraction of the anchor) across leave-one-out refits
  const CORRELATION_OVERLAP_THRESHOLD = 0.70   // |r| at/above this = ROE and growth are treated as plausibly capturing the same effect
  const SMALL_SAMPLE_CAP_FRACTION = 0.15 // fragile-tier (≤5 years) adjustments are capped to this fraction of the anchor

  const pearsonR = (xs, ys) => {
    const n = xs.length
    if (n < 2) return null
    const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2 }
    if (sxx === 0 || syy === 0) return null
    return sxy / Math.sqrt(sxx * syy)
  }

  // ── Fitted adjustments ────────────────────────────────────────────────────
  // Each asks the same question of this company's own record: when this
  // fundamental was higher, did the market pay more, and how much more? A slope
  // that the data doesn't support is not used at all. Returns a candidate
  // rather than mutating `adjusted` directly — the correlation/overlap check
  // below needs to see BOTH candidates before either one is actually applied.
  const evaluateFit = (key, forward, label, unit = '%') => {
    const fail = (reason) => ({ applicable: false, key, label, steps: reason ? [reason] : [] })
    const pts = obs.filter(o => o[key] != null).map(o => ({ x: o[key], y: o.multiple }))
    // Both of these used to bail with no explanation at all — indistinguishable
    // from "never tried" once rendered, when they're actually two different,
    // real reasons: no forward figure to compare against, or not enough paired
    // years of this fundamental to trust a slope from.
    if (forward == null) return fail(`${label}: no forward figure to compare against — no adjustment`)
    if (pts.length < MIN_OBSERVATIONS) {
      return fail(`${label}: only ${pts.length} year${pts.length === 1 ? '' : 's'} with usable data (need ${MIN_OBSERVATIONS}+) — no adjustment`)
    }
    const fit = fitLine(pts)
    if (!fit || fit.r2 < MIN_R2) {
      return fail(`${label}: no reliable relationship in this stock's history (R²${fit ? ' ' + round(fit.r2) : ' —'}) — no adjustment`)
    }
    // Interpolation only — no clamp-and-continue. A slope fitted over a
    // narrow range of observed values says nothing about what happens
    // outside it (a growth series that only ever sat between 19% and 21%
    // produced a steep slope; feeding it a 5% forward value multiplied that
    // slope by a 15-point gap into a +41× adjustment). Rather than
    // substituting a nearby in-range value and computing an adjustment from
    // THAT instead, the forward assumption is trusted as given and the fit
    // simply declines to speak outside where it has evidence — the flag
    // belongs on the assumption being far from this stock's own history,
    // not hidden inside a quietly-substituted output.
    const xs = pts.map(p => p.x)
    const spanLo = Math.min(...xs), spanHi = Math.max(...xs)
    if (forward < spanLo || forward > spanHi) {
      return fail(`${label}: ${round(forward, 1)}${unit} is outside the ${round(spanLo, 1)}–${round(spanHi, 1)}${unit} this stock has actually shown — the fitted relationship has no support there, so no adjustment is applied`)
    }

    const gap = forward - fit.meanX
    const delta = fit.slope * gap
    if (!isFinite(delta) || Math.abs(delta) < 0.01) return fail(null)   // negligible, not a failure — nothing to disclose

    // Leave-one-out stability — is this a real pattern, or one year's leverage
    // dressed up as one? Refit with each observation removed in turn and see
    // whether the predicted multiple (same anchor, that sub-fit's own slope
    // and mean) holds direction and stays close to the full-sample prediction.
    // A refit that becomes invalid (too few points once one is removed) fails
    // the whole check — a missing LOO result is not evidence of stability.
    const fullPredicted = anchor + delta
    const signOff = Math.sign(fullPredicted - anchor)
    const looPredicted = []
    for (let i = 0; i < pts.length; i++) {
      const subFit = fitLine(pts.slice(0, i).concat(pts.slice(i + 1)))
      if (!subFit) return fail(`${label}: one or more leave-one-out refits were invalid (too few points once a year is removed) — no adjustment`)
      looPredicted.push(anchor + subFit.slope * (forward - subFit.meanX))
    }
    if (looPredicted.some(p => Math.sign(p - anchor) !== 0 && Math.sign(p - anchor) !== signOff)) {
      return fail(`${label}: the direction of the adjustment reverses when any single year is left out — not a reliable relationship, no adjustment`)
    }
    const maxDeviation = looPredicted.length
      ? Math.max(...looPredicted.map(p => Math.abs(p - anchor) / anchor))
      : 0
    if (maxDeviation > LOO_DEVIATION_BAND) {
      return fail(`${label}: leave-one-out testing shows this adjustment isn't stable (removing a single year swings the predicted multiple by ${round(maxDeviation * 100, 0)}%, over the ${round(LOO_DEVIATION_BAND * 100, 0)}% threshold) — no adjustment`)
    }

    const tier = confidenceTier(pts.length)
    let finalDelta = delta
    let cappedNote = ''
    if (tier === 'fragile') {
      const cap = Math.abs(anchor) * SMALL_SAMPLE_CAP_FRACTION
      if (Math.abs(finalDelta) > cap) {
        cappedNote = ` — capped at ±${round(cap, 1)}× (only ${pts.length} paired years, fragile evidence)`
        finalDelta = Math.sign(finalDelta) * cap
      }
    }
    const tierNote = tier === 'fragile' ? ' (fragile — only 4-5 paired years)'
      : tier === 'moderate' ? ' (moderate support)' : ''

    return {
      applicable: true, key, label, fit, delta: finalDelta, r2: fit.r2, n: pts.length, tier, maxDeviation, gap, forward,
      step: `${label}: ${round(forward, 1)}${unit} expected vs ${round(fit.meanX, 1)}${unit} average → ` +
        `${finalDelta >= 0 ? '+' : ''}${round(finalDelta)}× (fitted, R² ${round(fit.r2)})${tierNote}${cappedNote}`,
    }
  }

  const roeResult = evaluateFit('roe', forwardRoe, 'Returns')
  const growthResult = evaluateFit('growth', forwardGrowth, 'Growth')
  for (const r of [roeResult, growthResult]) steps.push(...(r.steps || []))

  // ── Overlap safeguard ───────────────────────────────────────────────────
  // Two independent single-variable fits can each look individually valid
  // while both capturing the SAME underlying effect twice — a genuinely
  // high-growth, high-ROE company gets +3× from the ROE fit and +4× from
  // the growth fit added together as +7×, when its actual historical P/E
  // relationship may never have supported a combined +7× move at all. This
  // doesn't PROVE double-counting (correlation is between the predictors,
  // not between "how much of the P/E effect overlaps") — it's a plausible-
  // overlap warning, treated as one: only acts when BOTH fits independently
  // passed every gate above, since a single applicable fit has nothing to
  // overlap with.
  let applied = [roeResult, growthResult].filter(r => r.applicable)
  if (roeResult.applicable && growthResult.applicable) {
    const paired = obs.filter(o => o.roe != null && o.growth != null)
    const r = pearsonR(paired.map(o => o.roe), paired.map(o => o.growth))
    if (r != null && Math.abs(r) >= CORRELATION_OVERLAP_THRESHOLD) {
      // Prefer whichever fit's leave-one-out predictions cluster tighter
      // (lower maxDeviation = more stable) — not whichever has the higher
      // R², which with a handful of observations can differ by chance. Only
      // switches on a clear gap (10 points of LOO deviation); too close to
      // call is treated as neither one clearly dominating.
      const gapPts = Math.abs(roeResult.maxDeviation - growthResult.maxDeviation) * 100
      if (gapPts >= 10) {
        const winner = roeResult.maxDeviation < growthResult.maxDeviation ? roeResult : growthResult
        const loser = winner === roeResult ? growthResult : roeResult
        applied = [winner]
        steps.push(`ROE/growth correlation: ${round(r, 2)} — high overlap detected; both regressions may capture the same effect. ` +
          `${winner.label} retained (more stable under leave-one-out testing), ${loser.label} suppressed.`)
      } else {
        applied = []
        steps.push(`ROE/growth correlation: ${round(r, 2)} — high overlap detected, and neither regression is clearly more stable than the other — using the historical median instead of arbitrarily combining or choosing between them.`)
      }
    } else if (r != null) {
      steps.push(`ROE/growth correlation: ${round(r, 2)} — no strong overlap detected; both regression adjustments applied.`)
    }
  }

  for (const result of applied) {
    adjusted += result.delta
    fits.push({ key: result.key, slope: result.fit.slope, r2: result.r2, gap: result.gap, delta: result.delta })
    steps.push(result.step)
    // Real prediction-interval margin for THIS factor at the value actually
    // used — the standard formula for a new observation's interval (not a
    // mean-response interval: we're predicting one new multiple, not
    // estimating the average one), using the same fit already vetted above.
    if (result.fit.residualSE != null && result.fit.sxx > 0) {
      const df = result.fit.n - 2
      const predSE = result.fit.residualSE * Math.sqrt(1 + 1 / result.fit.n + ((result.forward - result.fit.meanX) ** 2) / result.fit.sxx)
      const margin = tCritical(df) * predSE
      if (isFinite(margin)) marginsSquaredSum += margin * margin
    }
  }

  if (fits.length === 0) {
    steps.push('No fitted adjustment — using the plain historical median.')
  }

  // ── Peer weight ────────────────────────────────────────────────────────────
  // How much the peer band pulls this company's own fitted multiple — a
  // genuine judgment call (are these SPECIFIC peers actually comparable to
  // THIS company's business?) that no formula can make on its own. RELIANCE's
  // own NSE "Oil Gas & Consumable Fuels" peers, for instance, are real,
  // verified index-mates but don't capture Jio/Retail — applying their ~5×
  // EV/EBITDA to a conglomerate trading at 11× isn't a correction, it's a
  // mismatch. This used to trigger automatically past a hardcoded 1.5×/0.5×
  // divergence threshold and always pull exactly halfway when it did —
  // implementation choices with no real basis, presented as settled
  // methodology. Replaced with an explicit, disclosed weight the caller sets
  // (see PeerWeightSlider.jsx) — 0 (default) means peers have no effect at
  // all; 1 means the peer median fully replaces the own-history multiple.
  let peerBlended = false
  if (peerWeight > 0 && peerBand?.median > 0) {
    const before = adjusted
    adjusted = (1 - peerWeight) * adjusted + peerWeight * peerBand.median
    peerBlended = true
    steps.push(`Peer weight ${round(peerWeight * 100, 0)}%: ${round(before)}× blended with peers' ${round(peerBand.median)}× median → ${round(adjusted)}×`)
  }

  // Structural check only: a multiple can't be zero or negative — that isn't
  // "an unusual valuation," it's the fitted adjustment(s) producing something
  // that cannot be a real multiple. No plausibility ceiling either (a flat
  // 80x/15x cap here would still have clamped Trent's own real ~117x P/E,
  // the exact case that motivated widening this bound before it was removed
  // entirely — a real, observed anchor being overridden by an asserted
  // market-wide number was the actual bug, not a number that was merely
  // still too low). If the adjustment breaks the structural floor, discard
  // it and fall back to the anchor alone — the stock's own real historical
  // median is still valid on its own.
  let finalMultiple = adjusted
  if (!(finalMultiple > 0)) {
    steps.push(`The fitted adjustment produced a non-positive multiple — discarded, reverting to the ${round(anchor)}× anchor alone.`)
    finalMultiple = anchor
  }

  // The range is a genuine prediction interval from the same regression(s)
  // that produced finalMultiple's own-history component — not a spread
  // measured around a different (unadjusted) center and transplanted here.
  // When peerWeight blended the center, the same weight blends the spread
  // too (own regression margin vs. peers' own low-high dispersion), so the
  // range stays consistent with whatever mix of own-history and peer trust
  // the weight represents, rather than a peer-shifted center wearing a
  // purely own-history uncertainty band. When no fit was reliable enough to
  // use (finalMultiple === anchor) and peerWeight is 0, there's no
  // regression to build an interval from; the real, unadjusted historical
  // percentile band (ps.low/ps.high) is what's actually known in that case,
  // same as before.
  let ownMargin = null
  if (fits.length > 0 && marginsSquaredSum > 0) {
    ownMargin = Math.sqrt(marginsSquaredSum)
    steps.push(`Own-history range: ±${round(ownMargin)}× from the regression's own prediction interval ` +
      `(80% confidence, ${obs.length} year${obs.length > 1 ? 's' : ''} of data)`)
  }

  let low, high
  if (peerWeight > 0 && peerBand?.low > 0 && peerBand?.high > 0) {
    const peerMargin = (peerBand.high - peerBand.low) / 2
    const baseMargin = ownMargin != null ? ownMargin : (ps.high - ps.low) / 2
    const blendedMargin = (1 - peerWeight) * baseMargin + peerWeight * peerMargin
    low = finalMultiple - blendedMargin
    high = finalMultiple + blendedMargin
    if (!(low > 0)) low = Math.min(ps.low, finalMultiple * 0.5)   // structural floor, not a plausibility cap
    steps.push(`Range blended ${round(peerWeight * 100, 0)}% toward peers' own ${round(peerBand.low)}–${round(peerBand.high)}× spread`)
  } else if (ownMargin != null) {
    low = finalMultiple - ownMargin
    high = finalMultiple + ownMargin
    if (!(low > 0)) low = Math.min(ps.low, finalMultiple * 0.5)
  } else {
    low = ps.low
    high = ps.high
  }

  return {
    multiple: round(finalMultiple),
    low:  round(low),
    high: round(high),
    basis, anchor: round(anchor), observations: obs.length,
    fits, peerBlended, peerWeight,
    source: fits.length > 0 ? 'fitted' : 'historical-median',
    thin: thinYears > 0,
    // DERIVED in effectively every case here: the anchor is this stock's
    // own real historical multiple, any adjustment is a disclosed
    // regression bounded to its own measured range, and a peer blend only
    // ever moves it toward other real market data at a weight the caller
    // set explicitly — no branch produces an unanchored number.
    tier: TIER.DERIVED,
    steps,
  }
}
