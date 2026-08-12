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
const MIN_R2 = 0.30

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
    if (inYear.length < 20) continue
    const medianClose = inYear[Math.floor(inYear.length / 2)]

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

  if (obs.length === 0) {
    return peerBand?.median > 0
      ? { multiple: peerBand.median, low: peerBand.low, high: peerBand.high,
          basis, source: 'peers', steps: ['No usable history for this stock — using the peer median.'] }
      : null
  }

  // Anchor: the stock's own median multiple across the observed years.
  const sorted = [...obs].map(o => o.multiple).sort((a, b) => a - b)
  const anchor = sorted[Math.floor(sorted.length / 2)]
  const spreadLow = sorted[Math.floor(sorted.length * 0.15)] / anchor
  const spreadHigh = sorted[Math.floor(sorted.length * 0.85)] / anchor

  const steps = [`Anchor: ${round(anchor)}× — this stock's median over ${obs.length} year${obs.length > 1 ? 's' : ''}`]
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
    let delta = fit.slope * gap

    // However good the fit, one factor should not move the multiple by more than
    // half the anchor — beyond that the adjustment, not the anchor, is doing the
    // valuing, and the anchor is the part with real evidence behind it.
    const limit = anchor * 0.5
    if (Math.abs(delta) > limit) {
      steps.push(`${label}: adjustment capped at ${delta > 0 ? '+' : '−'}${round(limit)}× — a single factor shouldn't outweigh the anchor`)
      delta = Math.sign(delta) * limit
    }
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

  // Never negative or absurd, whatever the fit produced.
  const floor = basis === 'pb' ? 0.2 : 4
  const cap = basis === 'pb' ? 15 : 80
  const finalMultiple = Math.min(cap, Math.max(floor, adjusted))
  if (finalMultiple !== adjusted) {
    steps.push(`Bounded to ${round(finalMultiple)}× — the fitted value fell outside what this kind of business trades at.`)
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
    steps,
  }
}
