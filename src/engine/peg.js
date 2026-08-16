
/**
 * src/engine/peg.js
 *
 * PEG (Price/Earnings-to-Growth) — the growth-native valuation signal.
 * Kept deliberately simple and self-contained: it consumes the same ratioResult
 * (`r`) the rest of the engine already produces and returns BOTH
 *   (a) the PEG ratio + band (a displayed signal), and
 *   (b) a PEG-implied per-share fair value (Peter Lynch "fair P/E = growth rate"),
 *       which the caller may fold into the fair-value RANGE for growth-ish stages.
 *
 * DESIGN NOTES
 * ------------
 * • All ratio inputs on `r.ratios.*` are already in PERCENT (e.g. 15 = 15%), so
 *   growth here is handled in percent and only converted where needed.
 * • Growth input is a blend of trailing earnings growth and (optional) forward
 *   analyst growth, with a mode toggle. We prefer EARNINGS growth (PEG is a P/E
 *   construct); revenue growth is a last-resort proxy.
 * • Degenerate growth (≤ MIN_GROWTH or negative) makes PEG meaningless — we
 *   return applicable:false with peg:null rather than a garbage number.
 * • This module NEVER reads price targets or moves stage/fair-value on its own;
 *   the caller decides whether to include `fairValue` in the range.
 */

const MIN_GROWTH = 1        // percent; below this PEG is not meaningful
// Lynch's rule is that a fair P/E roughly equals the growth rate. It was clamped
// to 5-25x here, which silently rewrote the rule: a company growing 40% got a
// 25x fair P/E rather than 40x, and the "fair value" was then a third lower than
// the method actually says.
//
// The genuine risk the cap was aimed at is a freak growth year — a recovery off
// a collapsed base showing 300% — and that is better handled by refusing to
// apply the rule at all than by silently substituting a different number.
const MAX_MEANINGFUL_GROWTH = 60   // percent; beyond this the growth figure is a base effect

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

/**
 * @param {object} r  ratioResult (has r.eps, r.ratios.pe/npGrowthYoY/revCagr…)
 * @param {object} opts
 *   @param {number|null} opts.forwardGrowthPct  analyst forward growth in PERCENT (optional)
 *   @param {'blend'|'forward'|'trailing'} opts.mode  growth selection (default 'blend')
 *   @param {number|null} opts.growthOverridePct  hard override in PERCENT (optional)
 * @returns {{
 *   applicable: boolean, peg: number|null, band: string|null, rating: string|null,
 *   pe: number|null, growthPct: number|null, growthSource: string,
 *   fairPE: number|null, fairValue: number|null, note: string
 * }}
 */
export function computePeg(r, opts = {}) {
  const { forwardGrowthPct = null, mode = 'blend', growthOverridePct = null } = opts

  const eps = r?.eps
  const pe = r?.ratios?.pe?.value ?? (r?.price && eps ? r.price / eps : null)

  // Growth candidates (percent). Prefer earnings growth over revenue growth.
  const trailing =
    r?.ratios?.npGrowthYoY?.value ??
    r?.ratios?.epsGrowthYoY?.value ??
    r?.ratios?.revCagr?.value ??
    null
  const forward = forwardGrowthPct

  let growthPct = null
  let growthSource = 'none'
  if (growthOverridePct != null) {
    growthPct = growthOverridePct
    growthSource = 'override'
  } else if (mode === 'forward' && forward != null) {
    growthPct = forward; growthSource = 'forward'
  } else if (mode === 'trailing' && trailing != null) {
    growthPct = trailing; growthSource = 'trailing'
  } else if (forward != null && trailing != null) {
    growthPct = (forward + trailing) / 2; growthSource = 'blend'
  } else if (forward != null) {
    growthPct = forward; growthSource = 'forward'
  } else if (trailing != null) {
    growthPct = trailing; growthSource = 'trailing'
  }

  // Guards — no P/E (loss-making / no EPS) or degenerate growth ⇒ not meaningful.
  if (pe == null || pe <= 0 || eps == null || eps <= 0) {
    return blank('No positive P/E — PEG not meaningful for loss-making/no-EPS companies.')
  }
  if (growthPct == null) {
    return blank('No growth estimate available for PEG.')
  }
  if (growthPct <= MIN_GROWTH) {
    return blank(`Growth ${growthPct.toFixed(1)}% too low/negative — PEG not meaningful.`, { pe, growthPct, growthSource })
  }

  const peg = pe / growthPct

  // Bands. Note: PEG structurally penalises genuine quality compounders, so >1
  // is flagged, not condemned.
  let band, rating
  if (peg < 1) { band = 'cheap'; rating = 'Undervalued vs growth' }
  else if (peg <= 2) { band = 'fair'; rating = 'Fairly valued vs growth' }
  else { band = 'rich'; rating = 'Rich vs growth (common for quality compounders)' }

  // Peter Lynch fair value: fair P/E ~= the growth rate, applied as stated.
  // Beyond MAX_MEANINGFUL_GROWTH the growth figure is a base effect rather than
  // a rate anyone would capitalise, so the rule is withheld rather than bent.
  const fairPE = growthPct <= MAX_MEANINGFUL_GROWTH ? growthPct : null
  const fairValue = fairPE != null ? eps * fairPE : null

  return {
    applicable: true,
    peg: round(peg, 2),
    band,
    rating,
    pe: round(pe, 2),
    growthPct: round(growthPct, 1),
    growthSource,
    fairPE: round(fairPE, 1),
    fairValue: round(fairValue, 2),
    note: `PEG = P/E ${round(pe, 1)} ÷ growth ${round(growthPct, 1)}% (${growthSource})`,
  }
}

function blank(note, extra = {}) {
  return {
    applicable: false, peg: null, band: null, rating: null,
    pe: extra.pe ?? null, growthPct: extra.growthPct ?? null,
    growthSource: extra.growthSource ?? 'none',
    fairPE: null, fairValue: null, note,
  }
}

const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d)
