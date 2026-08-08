/**
 * src/engine/estimate.js — the app's OWN estimate.
 *
 * Different from fair value, and the difference is the point. Fair value is a
 * live derived output: feed it today's numbers and it recomputes from scratch.
 * It's never wrong because it never claimed anything. An estimate is a dated
 * claim — "as of this date, on this basis, this can reach X–Y" — frozen, stored,
 * and later checked against what actually happened. It CAN be wrong, and a model
 * that can't be wrong can't be corrected either.
 *
 * The chain, in plain terms:
 *   revenue × growth         → next year's revenue
 *   × margin                 → next year's profit
 *   ÷ shares (incl dilution) → next year's EPS
 *   × what buyers pay        → price range
 *
 * Every one of those inputs has a LADDER: best available basis, then weaker
 * fallbacks. The estimate always produces a number while the arithmetic is
 * possible, and always reports which rung each input stood on. It never silently
 * degrades — a figure that quietly switches to a weaker basis while looking
 * identical is how someone trusts a number they'd otherwise have questioned.
 */

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const val = t => (t && typeof t === 'object' ? t.value : t)

const PE_FLOOR = 5
const PE_CAP   = 60
const FALLBACK_SPREAD = 0.25     // current P/E ±25% when there's no usable band

// Dilution is real but bounded: one historic 40% share-count jump (a merger, a
// big QIP) must not be projected forward as if it recurs every year.
const MAX_DILUTION = 0.10

const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

/**
 * What buyers have paid for a year of FORWARD earnings.
 *
 * This fixes a real error in the first version, which measured a TRAILING
 * multiple (price ÷ the same year's EPS) and then applied it to NEXT year's EPS.
 * Those are different animals: if the market pays 28× trailing and the company
 * grows 20%, quoting "28× next year's earnings" overstates the price by exactly
 * that 20% — and overstates most for the fastest growers, precisely where an
 * optimistic bias does the most damage. Analysts say "forward P/E" for this
 * reason.
 *
 * So for each fiscal year, divide that year's daily closes by the EPS of the
 * FOLLOWING year: what buyers were paying, at the time, for earnings that hadn't
 * arrived yet. That is the multiple a forward EPS can legitimately be multiplied
 * by.
 */
export function forwardPeBand(priceHistory = [], incomeHistory = [], opts = {}) {
  const { fyEndMonth = 3 } = opts

  const closes = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  if (closes.length === 0) return null

  const epsByYear = new Map()
  for (const row of incomeHistory || []) {
    const y = yearOf(row), e = val(row?.eps)
    if (y != null && e > 0) epsByYear.set(y, e)
  }

  const ratios = []
  for (const [y] of epsByYear) {
    const nextEps = epsByYear.get(y + 1)
    if (!(nextEps > 0)) continue                  // no forward year to price against
    const end   = Date.UTC(y, fyEndMonth, 0)
    const start = Date.UTC(y - 1, fyEndMonth, 1)
    for (const c of closes) {
      if (c.t < start || c.t > end) continue
      const pe = c.close / nextEps
      if (pe >= PE_FLOOR && pe <= PE_CAP) ratios.push(pe)
    }
  }
  if (ratios.length < 20) return null

  ratios.sort((a, b) => a - b)
  const q = p => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]
  // Percentiles, not min/max: one panic day or one melt-up shouldn't define the
  // band the whole projection hangs off.
  return { low: round(q(0.15), 1), median: round(q(0.50), 1), high: round(q(0.85), 1),
           samples: ratios.length }
}

/** Growth ladder: guidance → 5y CAGR → recent median → any CAGR → nothing. */
export function resolveGrowthBasis(ratioResult, opts = {}) {
  const { guidedGrowth = null, guidanceFiscalYear = null, guidanceExpired = false } = opts
  if (guidedGrowth != null && isFinite(guidedGrowth)) {
    return { growth: guidedGrowth, source: 'guidance', rung: 'best',
             label: `guidance${guidanceFiscalYear ? ` (${guidanceFiscalYear})` : ''}` }
  }
  const r = ratioResult?.ratios || {}
  const candidates = [
    [r.revCagr5y?.value,        '5-yr revenue CAGR'],
    [r.revGrowthRecent?.value,  'recent revenue growth (median)'],
    [r.revCagr?.value,          'revenue CAGR'],
    [r.revGrowthLongRun?.value, '10-yr revenue CAGR'],
  ]
  for (const [pct, label] of candidates) {
    if (pct != null && isFinite(pct)) {
      return { growth: pct / 100, source: 'cagr', rung: 'fallback', label,
               expiredGuidance: guidanceExpired }
    }
  }
  return { growth: null, source: 'none', rung: 'none', label: 'no growth basis' }
}

/**
 * Margin ladder: guided → 3-yr average → last reported.
 *
 * The first version skipped this and grew EPS by the REVENUE growth rate, which
 * silently assumes margins never move. They do — and a company quietly losing
 * margin for three years projected as if it weren't. The average is the default
 * rather than last year's because one year can be distorted by a one-off, and
 * the whole projection hangs off this number.
 */
export function resolveMarginBasis(incomeHistory = [], opts = {}) {
  const { guidedMargin = null } = opts
  if (guidedMargin != null && isFinite(guidedMargin)) {
    return { margin: guidedMargin, source: 'guidance', rung: 'best', label: 'guided margin' }
  }
  const margins = []
  for (const row of incomeHistory || []) {
    const rev = val(row?.revenue), np = val(row?.netProfit)
    if (rev > 0 && np != null) margins.push(np / rev)
  }
  if (margins.length === 0) {
    return { margin: null, source: 'none', rung: 'none', label: 'no margin history' }
  }
  const recent = margins.slice(-3)
  if (recent.length >= 3) {
    const avg = recent.reduce((s, m) => s + m, 0) / recent.length
    // Trend is reported alongside so the UI can say "and it's been falling"
    // without the projection silently extrapolating a trend line of its own.
    const trend = recent[recent.length - 1] - recent[0]
    return { margin: avg, source: 'average', rung: 'good', label: '3-yr average margin',
             trendPct: round(trend * 100, 1) }
  }
  return { margin: margins[margins.length - 1], source: 'last', rung: 'fallback',
           label: 'last reported margin' }
}

/**
 * Dilution ladder: observed share-count growth → flat.
 * EPS is profit ÷ shares, and share counts drift up (ESOPs, QIPs). A frozen
 * count overstates EPS for anyone funding growth with equity — lenders
 * especially, since growing the book needs capital.
 */
export function resolveDilution(incomeHistory = [], balanceHistory = []) {
  const counts = []
  for (const row of (balanceHistory || [])) {
    const s = val(row?.shares) ?? val(row?.sharesOutstanding)
    if (s > 0) counts.push(s)
  }
  // Derive the count from profit ÷ eps when it isn't reported directly.
  if (counts.length < 2) {
    counts.length = 0
    for (const row of (incomeHistory || [])) {
      const np = val(row?.netProfit), eps = val(row?.eps)
      if (np > 0 && eps > 0) counts.push(np / eps)
    }
  }
  if (counts.length < 2) {
    return { rate: 0, source: 'assumed-flat', rung: 'fallback', label: 'no share-count history' }
  }
  const first = counts[0], last = counts[counts.length - 1]
  if (!(first > 0) || !(last > 0)) {
    return { rate: 0, source: 'assumed-flat', rung: 'fallback', label: 'no share-count history' }
  }
  let rate = Math.pow(last / first, 1 / (counts.length - 1)) - 1
  if (!isFinite(rate)) rate = 0
  rate = Math.max(0, Math.min(MAX_DILUTION, rate))   // buybacks aren't projected forward either
  return { rate, source: 'observed', rung: 'good',
           label: rate > 0.001 ? `${round(rate * 100, 1)}%/yr dilution` : 'no material dilution' }
}

/**
 * Sanity check, lenders especially: growth needs capital. A business can only
 * self-fund g ≈ ROE × retention. Guiding well above that isn't impossible — it
 * means raising equity or leverage — but it should be SAID rather than absorbed
 * silently into a price target.
 */
export function financeabilityNote(ratioResult, growth) {
  const roe = ratioResult?.ratios?.roe?.value
  if (roe == null || growth == null) return null
  const payout = ratioResult?.ratios?.dividendPayout?.value
  const retention = (payout != null && payout >= 0 && payout <= 100) ? 1 - payout / 100 : 1
  const sustainable = (roe / 100) * retention
  if (!(sustainable > 0)) return null
  if (growth <= sustainable * 1.15) return null      // comfortably financeable
  return {
    sustainablePct: round(sustainable * 100, 1),
    growthPct: round(growth * 100, 1),
    note: `${round(growth * 100, 1)}% growth is more than ${round(roe, 1)}% ROE can self-fund `
        + `(~${round(sustainable * 100, 1)}%) — it implies raising capital or more leverage.`,
  }
}

/**
 * Build the estimate.
 *
 * @param opts.guidedGrowth  decimal (0.18) — guidance or ScoringStudio
 * @param opts.guidedMargin  decimal (0.22) — margin guidance, when given
 * @param opts.years         horizon (default 1: a near-term claim is checkable
 *                           within a year; a 5-year one can't be corrected until
 *                           it's far too late to matter)
 * @param opts.peerBand      { low, median, high } — optional second multiple
 *                           anchor; own history is blind to a sector re-rating
 */
export function buildEstimate(ratioResult, opts = {}) {
  const {
    guidedGrowth = null, guidedMargin = null, guidanceFiscalYear = null,
    guidanceExpired = false, growthOverride = null, marginOverride = null,
    multipleOverride = null,
    priceHistory = [], incomeHistory = [], balanceHistory = [],
    peerBand = null, years = 1,
  } = opts

  const price     = ratioResult?.price
  const eps       = ratioResult?.eps
  const revenue   = ratioResult?.revenue
  const netProfit = ratioResult?.netProfit
  const currentPe = ratioResult?.ratios?.pe?.value ?? (price && eps ? price / eps : null)

  if (!(eps > 0)) {
    return blank('No positive EPS — a multiple needs earnings to apply to.', { price })
  }

  // ── growth ────────────────────────────────────────────────────────────────
  const growthBasis = growthOverride != null
    ? { growth: growthOverride, source: 'revision', rung: 'best', label: 'your revision' }
    : resolveGrowthBasis(ratioResult, { guidedGrowth, guidanceFiscalYear, guidanceExpired })
  if (growthBasis.growth == null) {
    return blank('No guidance and no usable growth history — nothing to project from.', { price })
  }

  // ── margin ────────────────────────────────────────────────────────────────
  const marginBasis = marginOverride != null
    ? { margin: marginOverride, source: 'revision', rung: 'best', label: 'your revision' }
    : resolveMarginBasis(incomeHistory, { guidedMargin })

  // ── dilution ──────────────────────────────────────────────────────────────
  const dilution = resolveDilution(incomeHistory, balanceHistory)

  // ── forward EPS ───────────────────────────────────────────────────────────
  // Preferred: revenue → margin → profit → per-share, which exposes the margin
  // as an input you can see and argue with. If revenue or margin isn't
  // available, fall back to compounding EPS directly — the old margins-frozen
  // behaviour — and flag it rather than passing it off as equivalent.
  const g   = growthBasis.growth
  const dil = Math.pow(1 + dilution.rate, years)
  let forwardEps = null, epsPath, projRevenue = null, projProfit = null

  if (revenue > 0 && marginBasis.margin != null) {
    const sharesNow = (netProfit > 0 && eps > 0) ? netProfit / eps : (ratioResult?.shares || null)
    if (sharesNow > 0) {
      projRevenue = revenue * Math.pow(1 + g, years)
      projProfit  = projRevenue * marginBasis.margin
      forwardEps  = projProfit / (sharesNow * dil)
      epsPath = 'revenue × margin ÷ shares'
    }
  }
  if (forwardEps == null || !(forwardEps > 0)) {
    forwardEps = (eps * Math.pow(1 + g, years)) / dil
    epsPath = 'EPS compounded (margins assumed flat)'
    projRevenue = null; projProfit = null
  }

  // ── multiple ──────────────────────────────────────────────────────────────
  // A re-rating is the one thing in this chain nothing mechanical can detect.
  // Growth and margin changes eventually show up in reported numbers; a
  // permanent shift in what buyers will PAY does not — the observed band keeps
  // describing the old regime, so the estimate would go on calling a stock cheap
  // while it de-rated. Only a human reading the reason (a rule change, a lost
  // advantage) can say so, which is why this override outranks every measured
  // basis below it rather than being blended with them.
  const own = forwardPeBand(priceHistory, incomeHistory)
  let multiples, multipleBasis, multipleLabel
  if (multipleOverride != null && multipleOverride > 0) {
    const c = clamp(multipleOverride, PE_FLOOR, PE_CAP)
    // Keep whatever spread the measured band had, so a re-rating moves the
    // CENTRE of the range without also pretending the future got more certain.
    const spread = own && own.median > 0
      ? { lo: own.low / own.median, hi: own.high / own.median }
      : { lo: 1 - FALLBACK_SPREAD, hi: 1 + FALLBACK_SPREAD }
    multiples = { low: round(c * spread.lo, 1), base: round(c, 1), high: round(c * spread.hi, 1) }
    multipleBasis = 'revision'
    multipleLabel = `your re-rating (${round(c, 1)}×)`
  } else if (own) {
    multiples = { low: own.low, base: own.median, high: own.high }
    multipleBasis = 'observed'
    multipleLabel = `its own forward P/E range (${own.samples} days)`
  } else if (peerBand?.median > 0) {
    multiples = { low: peerBand.low, base: peerBand.median, high: peerBand.high }
    multipleBasis = 'peer'
    multipleLabel = 'peer multiples (no usable history for this stock)'
  } else if (currentPe > 0) {
    const c = clamp(currentPe, PE_FLOOR, PE_CAP)
    multiples = { low: round(c * (1 - FALLBACK_SPREAD), 1), base: round(c, 1),
                  high: round(c * (1 + FALLBACK_SPREAD), 1) }
    multipleBasis = 'current'
    multipleLabel = "today's P/E ±25% (no usable history)"
  } else {
    return blank('No usable P/E — nothing to anchor a multiple on.', { price })
  }

  const target = {
    low:  round(forwardEps * multiples.low),
    base: round(forwardEps * multiples.base),
    high: round(forwardEps * multiples.high),
  }
  const upside = price > 0 ? {
    low:  round(((target.low  - price) / price) * 100, 1),
    base: round(((target.base - price) / price) * 100, 1),
    high: round(((target.high - price) / price) * 100, 1),
  } : null

  // Which inputs are NOT on their best rung. The dashboard shows one small dot
  // when this is non-empty and nothing at all when it's empty — a warning that
  // shows constantly gets ignored, so silence has to be the normal state.
  const degraded = []
  if (growthBasis.rung !== 'best') degraded.push(`Growth from ${growthBasis.label}, not guidance`)
  if (marginBasis.rung === 'fallback' || marginBasis.rung === 'none')
    degraded.push(`Margin from ${marginBasis.label}`)
  if (multipleBasis !== 'observed' && multipleBasis !== 'revision')
    degraded.push(`Multiple from ${multipleLabel}`)
  if (epsPath.startsWith('EPS compounded')) degraded.push('Margins assumed flat')
  if (growthBasis.expiredGuidance) degraded.push('Your guidance has expired')

  return {
    ok: true,
    createdAt: Date.now(),
    horizonYears: years,
    priceAtEstimate: round(price),

    eps: round(eps),
    forwardEps: round(forwardEps),
    epsPath,
    projRevenue: round(projRevenue),
    projProfit: round(projProfit),

    growth: g,
    growthPct: round(g * 100, 1),
    growthSource: growthBasis.source,
    growthLabel: growthBasis.label,

    marginPct: marginBasis.margin != null ? round(marginBasis.margin * 100, 1) : null,
    marginSource: marginBasis.source,
    marginLabel: marginBasis.label,
    marginTrendPct: marginBasis.trendPct ?? null,

    dilutionPct: round(dilution.rate * 100, 1),
    dilutionLabel: dilution.label,

    multiples, multipleBasis, multipleLabel,
    target, upside,

    financeability: financeabilityNote(ratioResult, g),
    degraded,                     // [] when everything is on its best basis
    basisSummary: `Growth: ${growthBasis.label} · Margin: ${marginBasis.label} · Multiple: ${multipleLabel}`,
  }
}

/**
 * Compare a stored estimate against where the price actually went. The whole
 * reason estimates are frozen: without a dated prior claim there is nothing to
 * be right or wrong about.
 */
export function scoreEstimate(estimate, currentPrice) {
  if (!estimate?.ok || !(currentPrice > 0)) return null
  const { target, priceAtEstimate, createdAt, horizonYears = 1 } = estimate
  const elapsedDays = Math.floor((Date.now() - createdAt) / 86400000)
  const horizonDays = Math.round(horizonYears * 365)
  let outcome
  if (currentPrice >= target.high) outcome = 'above-range'
  else if (currentPrice >= target.low) outcome = 'in-range'
  else outcome = 'below-range'
  return {
    outcome, elapsedDays, horizonDays,
    matured: elapsedDays >= horizonDays,
    priceMovePct: round(((currentPrice - priceAtEstimate) / priceAtEstimate) * 100, 1),
    vsBasePct: round(((currentPrice - target.base) / target.base) * 100, 1),
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

function blank(note, extra = {}) {
  return {
    ok: false, note, target: null, upside: null, multiples: null,
    growth: null, growthPct: null, growthSource: 'none',
    degraded: [], basisSummary: null,
    priceAtEstimate: extra.price != null ? round(extra.price) : null,
  }
}
