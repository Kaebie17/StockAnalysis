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
 * Ordinary least squares on (x, y), returning slope, intercept and R².
 * Small enough to keep here rather than take a dependency for one regression.
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
  return { slope, intercept, r2: r * r, n, meanX: mx, meanY: my }
}

/**
 * The multiple this stock actually traded at in each fiscal year, paired with
 * the fundamentals it was earning at the time.
 *
 * Uses the MEDIAN close within the year rather than a point reading, so one
 * spike doesn't define the year, and pairs it with that year's reported figures
 * — which is what the market could see while paying that price.
 */
export function yearlyObservations({ priceHistory = [], incomeHistory = [], balanceHistory = [],
                                     basis = 'pe', fyEndMonth = 3 } = {}) {
  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
  if (closes.length === 0) return []

  const out = []
  for (const row of incomeHistory || []) {
    const y = yearOf(row)
    if (y == null) continue

    const eps = val(row.eps)
    const revenue = val(row.revenue)
    const netProfit = val(row.netProfit)
    const bRow = (balanceHistory || []).find(b => yearOf(b) === y)
    const equity = val(bRow?.totalEquity)
    const shares = (netProfit > 0 && eps > 0) ? netProfit / eps : null
    const bps = (equity > 0 && shares > 0) ? equity / shares : null

    const denom = basis === 'pb' ? bps : eps
    if (!(denom > 0)) continue

    const start = Date.UTC(y - 1, fyEndMonth, 1)
    const end = Date.UTC(y, fyEndMonth, 0)
    const inYear = closes.filter(c => c.t >= start && c.t <= end).map(c => c.close).sort((a, b) => a - b)
    if (inYear.length === 0) continue
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
  return out
}

/**
 * The multiple to apply, and why.
 *
 * @param opts.basis         'pe' | 'pb'
 * @param opts.forwardRoe    expected ROE for the projection year
 * @param opts.forwardGrowth expected growth, %
 * @param opts.peerBand      { low, median, high } — the sanity anchor
 */
export function targetMultiple(opts = {}) {
  const { basis = 'pe', forwardRoe = null, forwardGrowth = null, peerBand = null } = opts
  const obs = yearlyObservations(opts)

  // A median needs a distribution behind it. Two annual observations give a
  // midpoint between two numbers, and a 15th/85th percentile band over two
  // points is just those two points — which is how a "59–171×" band reached a
  // Trent estimate of 4,441–12,886 against a fair value near 887. Three years is
  // the minimum that can describe a range at all.
  const MIN_YEARS_FOR_BAND = 3
  if (obs.length < MIN_YEARS_FOR_BAND) {
    // DERIVED — real peer data plus a percentile formula, same standing as
    // the primary anchor below, not a weaker fallback in provenance terms.
    return peerBand?.median > 0
      ? { multiple: peerBand.median, low: peerBand.low, high: peerBand.high,
          basis, source: 'peers', observations: obs.length, tier: TIER.DERIVED,
          steps: [`Only ${obs.length} year${obs.length === 1 ? '' : 's'} of multiple history — ` +
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
  const spreadLow = ps.low / anchor
  const spreadHigh = ps.high / anchor

  const steps = [`Anchor: ${round(anchor)}× — this stock's median over ${obs.length} year${obs.length > 1 ? 's' : ''}`]
  // A thin year (fewer than 30 trading days — a listing year, a data gap) is
  // still a real median, just a noisier one, so it's included, not dropped —
  // but disclosed, since a thin year counting toward the 3-year minimum above
  // is not the same guarantee as three fully-traded years.
  const thinYears = obs.filter(o => o.thin).length
  if (thinYears > 0) {
    steps.push(`${thinYears} of ${obs.length} year${obs.length > 1 ? 's' : ''} used ha${thinYears === 1 ? 's' : 've'} a thin trading record`)
  }
  let adjusted = anchor
  const fits = []

  // ── Fitted adjustments ────────────────────────────────────────────────────
  // Each asks the same question of this company's own record: when this
  // fundamental was higher, did the market pay more, and how much more? A slope
  // that the data doesn't support is not used at all.
  const applyFit = (key, forward, label, unit = '%') => {
    const pts = obs.filter(o => o[key] != null).map(o => ({ x: o[key], y: o.multiple }))
    if (pts.length < MIN_OBSERVATIONS || forward == null) return
    const fit = fitLine(pts)
    if (!fit || fit.r2 < MIN_R2) {
      steps.push(`${label}: no reliable relationship in this stock's history (R²${fit ? ' ' + round(fit.r2) : ' —'}) — no adjustment`)
      return
    }
    // Extrapolation guard. A slope fitted over a narrow range of observed values
    // says nothing about what happens far outside that range: a growth series
    // that only ever sat between 19% and 21% produced a steep slope, and feeding
    // it a 5% forward value multiplied that slope by a 15-point gap into a +41×
    // adjustment. The fit is only trusted across the span it was measured over.
    const xs = pts.map(p => p.x)
    const spanLo = Math.min(...xs), spanHi = Math.max(...xs)
    const span = spanHi - spanLo
    const clamped = Math.max(spanLo - span * 0.5, Math.min(spanHi + span * 0.5, forward))
    if (clamped !== forward) {
      steps.push(`${label}: ${round(forward, 1)}${unit} is far outside the ${round(spanLo, 1)}–${round(spanHi, 1)}${unit} this stock has actually shown — capped at ${round(clamped, 1)}${unit} rather than extrapolated`)
    }

    const gap = clamped - fit.meanX
    const delta = fit.slope * gap

    if (!isFinite(delta) || Math.abs(delta) < 0.01) return
    adjusted += delta
    fits.push({ key, slope: fit.slope, r2: fit.r2, gap, delta })
    steps.push(
      `${label}: ${round(forward, 1)}${unit} expected vs ${round(fit.meanX, 1)}${unit} average → ` +
      `${delta >= 0 ? '+' : ''}${round(delta)}× (fitted, R² ${round(fit.r2)})`)
  }

  applyFit('roe', forwardRoe, 'Returns')
  applyFit('growth', forwardGrowth, 'Growth')

  if (fits.length === 0) {
    steps.push('No fitted adjustment — using the plain historical median.')
  }

  // ── Peer cross-check ──────────────────────────────────────────────────────
  // Peers are the check on "this company's own history has stopped being
  // representative". Pulled halfway rather than overridden: the stock's own
  // record still carries information about how the market treats it.
  let peerPulled = false
  if (peerBand?.low > 0 && peerBand?.high > 0) {
    if (adjusted > peerBand.high * 1.5) {
      const before = adjusted
      adjusted = (adjusted + peerBand.high) / 2
      peerPulled = true
      steps.push(`Peers trade at ${peerBand.low}–${peerBand.high}× — ${round(before)}× pulled to ${round(adjusted)}×`)
    } else if (adjusted < peerBand.low * 0.5) {
      const before = adjusted
      adjusted = (adjusted + peerBand.low) / 2
      peerPulled = true
      steps.push(`Peers trade at ${peerBand.low}–${peerBand.high}× — ${round(before)}× pulled to ${round(adjusted)}×`)
    }
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

  return {
    multiple: round(finalMultiple),
    // The band keeps the shape of the stock's own observed spread, so a
    // consistently tight-trading stock gets a tight range and a volatile one a
    // wide one, rather than a fixed percentage for everything.
    low:  round(finalMultiple * (spreadLow > 0 ? spreadLow : 0.85)),
    high: round(finalMultiple * (spreadHigh > 0 ? spreadHigh : 1.15)),
    basis, anchor: round(anchor), observations: obs.length,
    fits, peerPulled,
    source: fits.length > 0 ? 'fitted' : 'historical-median',
    thin: thinYears > 0,
    // DERIVED in effectively every case here: the anchor is this stock's
    // own real historical multiple, any adjustment is a disclosed
    // regression bounded to its own measured range, and a peer pull only
    // ever moves it toward other real market data — no branch produces an
    // unanchored number.
    tier: TIER.DERIVED,
    steps,
  }
}
