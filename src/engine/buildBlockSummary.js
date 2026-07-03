/**
 * buildBlockSummary(state) — packages the figures the AI verdict needs.
 * Scope is deliberately narrow: VALUATION and MARKET EXPECTATION are the grey
 * areas that need reasoning; fundamentals and technicals are handled by the
 * boilerplate, so only their SCORES are passed as context. No interpretation or
 * opinion flags — just the numbers shown on the dashboard, plus recent actual
 * growth as context for the implied-growth figures.
 */
export function buildBlockSummary(state) {
  if (!state?.valuation || !state?.ratioResult) return null
  const { valuation: v, quality: q, technicals: t, marketExpectation: me, ratioResult: r, data } = state
  const num = x => (x == null || isNaN(x) ? null : +(+x).toFixed(2))

  const models = (v.topModels || []).map(m => ({
    model: m.name, fairValue: num(m.value),
    vsCmpPct: r.price ? num(((m.value - r.price) / r.price) * 100) : null,
  }))
  const allModels = Object.entries(v.models || {})
    .filter(([, x]) => x?.value != null)
    .map(([k, x]) => ({ model: k, fairValue: num(x.value) }))

  const meVar = k => {
    const x = me?.variants?.[k]
    return x?.applicable && x.impliedGrowth != null ? num(x.impliedGrowth) : null
  }

  return {
    company: {
      name: data?.name || state.ticker, ticker: state.ticker, sector: data?.meta?.sector,
      stage: state.stage, currency: data?.currency,
    },
    price: num(r.price),
    marketCap: num(r.marketCap),

    valuation: {
      signal: v.signal,
      fairValueRange: [num(v.fvRangeLow), num(v.fvRangeHigh)],
      basedOnModels: models,     // the two most relevant models + fair value + %vs CMP
      allModelFairValues: allModels,
      upsidePct: num(v.upside),
    },

    // Growth rates the CURRENT PRICE implies, by method (null = not resolved/omitted).
    marketExpectation: {
      reverseDcfImpliedGrowthPct: num(v.impliedGrowth),
      salesBasedImpliedGrowthPct: meVar('sales'),
      earningsBasedImpliedGrowthPct: meVar('earnings'),
      fcfBasedImpliedGrowthPct: meVar('fcf'),
    },

    // Context for the implied numbers above.
    recentActualGrowth: {
      revenueRecentPct: num(r.ratios?.revGrowthRecent?.value),
      revenue5yCagrPct: num(r.ratios?.revCagr5y?.value),
      earningsYoYPct: num(r.ratios?.npGrowthYoY?.value),
    },

    // Other blocks — SCORES only (handled elsewhere; here just as context).
    fundamentalsScore: q ? { score: q.score, label: q.label } : null,
    technicalsScore: t?.available ? { score: t.score, label: t.label } : null,

    guidance: v.assumptions?.nearTermGrowth != null ? {
      guidedGrowthPct: num(v.assumptions.nearTermGrowth * 100),
      years: v.assumptions.nearTermYears,
    } : null,
  }
}
