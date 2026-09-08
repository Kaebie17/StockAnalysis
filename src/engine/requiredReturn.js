/**
 * src/engine/requiredReturn.js — the ONE shared "what return should an
 * investor require from this stock" computation (CAPM), and the shared
 * terminal-growth constant that a fade-to-terminal model settles on.
 *
 * Before this existed, three different files computed this independently and
 * silently disagreed: justifiedMultiple.js used a live-fetched risk-free rate
 * with a 6.5% ERP; valuation.js's DCF used a hardcoded 7% risk-free rate with
 * a 5.5% ERP; marketExpectation.js used a flat 4-bucket stage table (12-18%)
 * that wasn't CAPM at all and ignored the company's own beta entirely. Same
 * company, same moment, three different "required return" answers feeding
 * three different valuation lenses.
 */

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

// Damodaran-style equity risk premium. Hand-updated periodically, not
// live-fetched — there's no free reliable feed for this, and even
// professional terminals typically show a curated/quarterly-updated figure
// rather than a truly live one. Keyed by market so a US ticker's ERP doesn't
// silently borrow India's assumption.
export const ERP_BY_MARKET = { IN: 0.065, US: 0.065 }

// Fallback ONLY — used when no live risk-free rate is available (no AI key
// configured, or the fetch failed). Never presented as live data; callers
// that always need a usable number (DCF's WACC) fall back to this so Fair
// Value — a core, always-on feature — never goes blank for lack of a key.
export const DEFAULT_RISK_FREE_BY_MARKET = { IN: 0.07, US: 0.045 }

// Terminal growth cannot exceed the economy forever — a company growing
// faster than nominal GDP in perpetuity eventually becomes the economy.
// Split by market, not flat: India's long-run nominal GDP growth (real
// growth + inflation) runs meaningfully higher than the US's, so one shared
// rate either overstates a mature US company's terminal value or understates
// an Indian one's. Not live-fetched like Rf/ERP — there's no market that
// prices "the long-run perpetual growth rate"; it's a modeling assumption
// bounded by a constraint, not an observable quote. Shared by DCF's terminal
// value, Justified Multiple's two-stage fade, and Market Expectation's
// reverse-DCF variant.
export const TERMINAL_GROWTH_BY_MARKET = { IN: 0.05, US: 0.025 }

export const marketOf = (currency) => (currency === 'INR' ? 'IN' : 'US')

// Blume adjustment (Blume, 1971/1975 — standard CFA-curriculum practice,
// historically used by Bloomberg and Merrill Lynch): a raw regression beta
// empirically mean-reverts toward 1 over time as a business matures and
// diversifies, so using it unadjusted as a FORWARD-looking CAPM input
// systematically overstates how extreme future risk will really be.
// Replaces an earlier hard rule ("if beta > 3, just assume beta = 1") that
// had no citable basis for exactly 3, and produced a cliff — a raw beta of
// 2.99 was used as-is, 3.01 was discarded entirely for a flat 1 — instead of
// a smooth, defensible transformation.
const BLUME_WEIGHT = 2 / 3   // adjusted = (2/3) x raw + (1/3) x 1.0

// A raw beta at or above this is statistically implausible for a liquid
// single stock (beta = correlation x (stock volatility / market volatility),
// and correlation is capped at 1, so clearing ~5x market volatility AND
// near-perfect correlation at once essentially never happens for a real,
// liquid name). That used to be grounds for silently discarding the reading
// and substituting a flat 1.0 — but the app has no way to actually verify
// WHY a given reading is extreme (corrupted data vs. a genuinely thin,
// erratic small-cap that really does carry that much measured risk), so
// deciding FOR the user which is true and substituting a different number
// they never asked for is the same "the model prefers a different number
// than reality gave it" mistake this codebase removes everywhere else. The
// real beta is used regardless; this threshold now only controls an
// informational flag telling the user to verify it — it never changes what
// gets fed into the formula.
const MAX_PLAUSIBLE_RAW_BETA = 5
// Same reasoning, other direction, at the same distance from 1 the high
// threshold sits (5x average → 1/5 of average). A near-zero beta is real for
// some genuinely uncorrelated names, but for a large, heavily-traded stock
// — the exact case a thin r-g gap inflates every Gordon-growth-style
// multiple the worst for — it deserves the same "verify this" nudge the
// high side already gets, not silent trust just because it happens to sit
// below the surprising side people usually check. Purely informational,
// like MAX_PLAUSIBLE_RAW_BETA above: never substitutes a different number.
const MIN_PLAUSIBLE_RAW_BETA = 1 / MAX_PLAUSIBLE_RAW_BETA

/**
 * Required return on equity — CAPM, with a Blume-adjusted beta.
 *   r = risk-free + adjustedBeta x equity risk premium
 * Beta is Yahoo's own reported figure (ratios.beta); the equity risk premium
 * is the one genuine assumption here and is surfaced rather than buried.
 * The real reported beta is always used — see MAX_PLAUSIBLE_RAW_BETA above,
 * this never substitutes a different number. When beta itself is missing
 * (not merely unusual — genuinely absent), there is nothing to Blume-adjust,
 * so 1.0 (average market risk) is used as a stated absence-of-data default,
 * not a correction of a real reading.
 * Returns null iff riskFreeRate isn't a usable positive number — this
 * function ships no fallback of its own; each caller decides its own policy
 * (justifiedMultiple.js declines gracefully, valuation.js falls back to
 * DEFAULT_RISK_FREE_BY_MARKET so it never goes blank).
 */
export function capmCostOfEquity({ riskFreeRate, beta, erp = null, market = 'IN' } = {}) {
  if (!(riskFreeRate > 0)) return null
  const premium = erp ?? ERP_BY_MARKET[market] ?? ERP_BY_MARKET.IN
  const hasBeta = beta > 0
  const b = hasBeta ? (BLUME_WEIGHT * beta + (1 - BLUME_WEIGHT)) : 1
  const r = riskFreeRate + b * premium
  const betaFlag = (hasBeta && beta >= MAX_PLAUSIBLE_RAW_BETA)
    ? `Reported beta of ${round(beta, 2)} is statistically unusual for a liquid single stock — verify against another source before trusting this cost of equity.`
    : (hasBeta && beta <= MIN_PLAUSIBLE_RAW_BETA)
    ? `Reported beta of ${round(beta, 2)} is unusually low — verify against another source; a low beta thins the required return, which inflates every multiple that divides by (r - g).`
    : null
  return {
    r, beta: b, rawBeta: hasBeta ? beta : null, betaFlag,
    // betaAssumed: true only when beta was genuinely absent, not when a real
    // reading was merely unusual — estimate.js's "Beta unavailable" note
    // means the former; it would previously fire on the latter too, which
    // was a different, misleading claim (a present-but-extreme beta isn't
    // "unavailable").
    betaAssumed: !hasBeta,
    riskFreeRate, equityRiskPremium: premium, market,
    label: hasBeta
      ? `${round(riskFreeRate * 100, 1)}% risk-free + ${round(b, 2)} beta (Blume-adjusted from ${round(beta, 2)}) x ${round(premium * 100, 1)}% premium`
      : `${round(riskFreeRate * 100, 1)}% risk-free + 1.00 beta (assumed — no reported beta) x ${round(premium * 100, 1)}% premium`,
  }
}
