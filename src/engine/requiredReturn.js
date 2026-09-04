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
// Shared by DCF's terminal value and Justified Multiple's two-stage fade.
export const TERMINAL_GROWTH_RATE = 0.04

export const marketOf = (currency) => (currency === 'INR' ? 'IN' : 'US')

/**
 * Required return on equity — CAPM.
 *   r = risk-free + beta x equity risk premium
 * Beta is Yahoo's own reported figure (ratios.beta); the equity risk premium
 * is the one genuine assumption here and is surfaced rather than buried.
 * Returns null iff riskFreeRate isn't a usable positive number — this
 * function ships no fallback of its own; each caller decides its own policy
 * (justifiedMultiple.js declines gracefully, valuation.js falls back to
 * DEFAULT_RISK_FREE_BY_MARKET so it never goes blank).
 */
export function capmCostOfEquity({ riskFreeRate, beta, erp = null, market = 'IN' } = {}) {
  if (!(riskFreeRate > 0)) return null
  const premium = erp ?? ERP_BY_MARKET[market] ?? ERP_BY_MARKET.IN
  const b = (beta > 0 && beta < 3) ? beta : 1     // an implausible beta is worse than none
  const r = riskFreeRate + b * premium
  return {
    r, beta: b, betaAssumed: !(beta > 0 && beta < 3),
    riskFreeRate, equityRiskPremium: premium, market,
    label: `${round(riskFreeRate * 100, 1)}% risk-free + ${round(b, 2)} beta x ${round(premium * 100, 1)}% premium`,
  }
}
