/**
 * buildBlockSummary(state) — packages the dashboard HIGHLIGHTS for the AI verdict.
 *
 * Scope: every figure shown in the SummaryStrip for each pillar (valuation,
 * fundamentals, technicals, market expectation), PLUS the full inner qualitative
 * read from Block 5 (Moat & Quality) — tiers, implication, evidence, and any
 * document/guidance context. Analyst targets are deliberately excluded (they
 * aren't derived from our models). No opinion flags — just what the user sees —
 * so the AI can weigh the signals and reconcile agreements/disagreements itself.
 */
import { assessMoatQuality } from './moatQuality.js'

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

    // ── VALUATION highlight ──
    valuation: {
      signal: v.signal,
      fairValueRange: [num(v.fvRangeLow), num(v.fvRangeHigh)],
      basedOnModels: models,          // two most relevant + fair value + %vs CMP
      allModelFairValues: allModels,
      upsidePct: num(v.upside),
      peRatio: num(r.ratios?.pe?.value),
      evEbitda: num(r.ratios?.evEbitda?.value),
    },

    // ── FUNDAMENTALS highlight ──
    fundamentals: q ? {
      score: q.score, label: q.label,
      roePct: num(r.ratios?.roe?.value),
      netMarginPct: num(r.ratios?.netMargin?.value),
      freeCashFlow: r.fcf != null ? (r.fcf > 0 ? 'positive' : 'negative') : null,
    } : null,

    // ── TECHNICALS highlight ──
    technicals: t?.available ? {
      score: t.score, label: t.label,
      rsi: t.indicators?.rsi ?? null,
      goldenCross: !!t.signals?.goldenCross,
      deathCross: !!t.signals?.deathCross,
      volume: t.indicators?.volume?.ratio > 1.2 ? 'above avg'
            : t.indicators?.volume?.ratio < 0.8 ? 'below avg' : 'avg',
    } : null,

    // ── MARKET EXPECTATION highlight ── growth the CURRENT PRICE implies, by method.
    marketExpectation: {
      primaryImpliedGrowthPct: num(me?.primary?.impliedGrowth),
      primaryMethod: me?.primary?.label ?? null,
      band: me?.primary?.impliedGrowth != null
        ? (me.primary.impliedGrowth > 25 ? 'aggressive' : me.primary.impliedGrowth > 15 ? 'moderate' : 'conservative')
        : null,
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

    // ── MOAT & QUALITY (Block 5) — full qualitative read, recomputed from state ──
    moatQuality: moatQualityPayload(state, r),

    guidance: v.assumptions?.nearTermGrowth != null ? {
      guidedGrowthPct: num(v.assumptions.nearTermGrowth * 100),
      years: v.assumptions.nearTermYears,
    } : null,
  }
}

function moatQualityPayload(state, r) {
  try {
    const mq = assessMoatQuality(state.data, r, { holdings: state.holdingsData, arData: state.arData })
    const n = x => (x == null || isNaN(x) ? null : +(+x).toFixed(2))
    const m = mq.metrics
    return {
      moatTier: mq.moat.tier,
      qualityTier: mq.quality.tier,
      implicationForValuation: mq.implication,
      governanceIncluded: mq.gated,          // false → pledge/related-party not factored
      evidence: {
        moat: mq.moat.evidence.map(e => e.text),
        quality: mq.quality.evidence.map(e => e.text),
      },
      keyMetrics: {
        roceMedianPct: n(m.roce.median),
        roceConsistencyPct: m.roce.hitRate,
        marginTrend: m.grossMargin.median != null ? m.grossMargin.trend : m.opMargin.trend,
        roeMedianPct: n(m.roe.median),
        fcfConversionPct: n(m.fcfConv),
        deRatio: n(m.de),
        interestCoverage: n(m.icr),
        incrementalReturns: m.incRoce.quality,
        dilution: m.dilution.trend,
        pledge: m.pledge ? { pct: m.pledge.last, direction: m.pledge.dir, asOf: m.pledge.asOf } : null,
        relatedParty: m.rpt?.present ? { pctOfRevenue: m.rpt.level, asOf: m.rpt.asOf } : null,
      },
      qualitativeContext: qualContext(state.arData),
      notAvailable: mq.dataFlags.filter(f => f !== 'governance_locked'),
    }
  } catch { return null }
}

function qualContext(arData) {
  if (!arData) return null
  const pick = k => (arData[k]?.text ? { text: String(arData[k].text).slice(0, 300), asOf: arData[k].asOf || null } : null)
  const ctx = {
    outlook: pick('outlook'), pli: pick('pli'), initiatives: pick('initiatives'), runway: pick('runway'),
    pledgeTrend: (arData.pledgeTrend || []).map(x => ({ asOf: x.asOf, pct: x.pct })),
    rptTrend: (arData.rptTrend || []).map(x => ({ asOf: x.asOf, pctOfRevenue: x.pctOfRevenue })),
  }
  const any = ctx.outlook || ctx.pli || ctx.initiatives || ctx.runway || ctx.pledgeTrend.length || ctx.rptTrend.length
  return any ? ctx : null
}
