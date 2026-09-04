/**
 * src/engine/valuation.js
 * Stage + sector aware. All models calculated from raw scalars in ratioResult.
 *
 * KEY FIXES:
 * 1. sectorPe uses SECTOR MEDIAN not stock's own PE (using own PE is circular —
 *    EPS × own_PE always returns current price)
 * 2. sectorEvEb uses stock's actual EV/EBITDA as baseline (clamped), not generic 12×
 * 3. DCF runs on real FCF only — no opCF proxy, no invented CapEx
 */
import { getApplicableModels } from './stage.js'
import { computePeg } from './peg.js'
import { capmCostOfEquity, DEFAULT_RISK_FREE_BY_MARKET, TERMINAL_GROWTH_RATE } from './requiredReturn.js'
import { sectorPe as getSectorPe } from './sectorMultiples.js'

export function runValuation(data, r, stage, sectorType, assumptions = {}) {
  const modelMeta = getApplicableModels(stage, sectorType)

  // sectorPe: sector median (NOT stock's own PE — that's circular)
  const sectorPeDefault = getSectorPe(data)
  // sectorEvEb: stock's actual EV/EBITDA clamped to 5-20× (NOT generic 12×)
  const actualEvEb = r.ratios?.evEbitda?.value
  const sectorEvEbDefault = actualEvEb != null ? clamp(actualEvEb, 5, 20) : 12

  // liveRiskFree/market: threaded from AppContext's shared fetch (Phase 8) —
  // null until that resolves, which is fine, computeWacc() always falls back
  // to a usable default rather than going blank.
  const market = assumptions.market ?? 'IN'
  // WACC default is computed per company (CAPM), not a flat rate — see computeWacc.
  const waccDefault = computeWacc(r, { liveRiskFree: assumptions.liveRiskFree ?? null, market })

  const {
    wacc       = waccDefault,
    termGrowth = TERMINAL_GROWTH_RATE,
    projYears  = 10,
    sectorPe   = sectorPeDefault,
    sectorEvEb = sectorEvEbDefault,
    growthRate = estimateGrowth(r),
    // Optional near-term (guidance) window: grow at nearTermGrowth for
    // nearTermYears, then fade toward terminal. Drives the FORWARD DCF only;
    // the reverse-DCF (market-implied) stays independent so the comparison holds.
    nearTermGrowth = null,
    nearTermYears  = 0
  } = assumptions
  const ntG = nearTermGrowth != null ? nearTermGrowth : null
  const ntY = ntG != null ? (nearTermYears || 5) : 0

  const results = {}

  // ── DCF ──────────────────────────────────────────────────────────────────────
  // FCF only. The old fallback was operatingCF x 0.7 — a made-up 30%-of-OCF
  // capex assumption feeding a fair value. ratios.js now derives real FCF from
  // real capex (opCF - capex); if that isn't available, the DCF doesn't run.
  // A skipped model is honest. A model built on an invented capex figure is not.
  const cfBaseDcf = (r.fcf != null && r.fcf > 0 && !r.fcfMaintenanceOnly) ? r.fcf : null
  if (isApplicable('dcf', modelMeta) && r.shares && cfBaseDcf) {
    const perShare = dcfPerShare(cfBaseDcf, growthRate, wacc, termGrowth, projYears, r.cash, r.totalDebt, r.shares, ntG, ntY)
    if (perShare != null) {
      const caveats = [
        r.fcfEstimated && 'FCF estimated (CapEx ≈ Depreciation) — no CapEx reported',
        r.cashEstimated && 'Cash not reported — assumed nil, fair value understated',
        r.debtEstimated && 'Debt estimated from Equity × D/E',
      ].filter(Boolean)
      results.dcf = {
        value: perShare,
        note: caveats.length ? caveats.join('; ') : 'FCF-based',
        estimated: caveats.length > 0,
      }
    }
  }

  // ── P/E ── uses sector median PE, not stock's own PE ─────────────────────────
  if (isApplicable('pe', modelMeta) && r.eps > 0) {
    results.pe = { value: r.eps * sectorPe, note: `EPS × sector median ${sectorPe}× P/E` }
  }

  // ── EV/EBITDA ── uses stock's actual multiple as anchor ───────────────────────
  if (isApplicable('evEbitda', modelMeta) && r.ebitda > 0 && r.shares && r.totalDebt != null) {
    const impliedEV = r.ebitda * sectorEvEb
    const impliedEq = impliedEV + r.cash - r.totalDebt
    const perShare  = impliedEq / r.shares
    if (perShare > 0) {
      results.evEbitda = { value: perShare, note: `EBITDA × ${sectorEvEb.toFixed(1)}× (actual EV/EBITDA)` }
    }
  }

  // ── P/B ── ROE-derived target multiple ────────────────────────────────────────
  // Skip PB for asset-light companies where actual PB > 10x (e.g. Apple, high-buyback cos)
  // book value is meaningless for them — distorts consensus
  const actualPb = r.ratios?.pb?.value
  const pbDistorted = actualPb != null && actualPb > 10
  const isFinancialSector = ['insurance', 'bank', 'nbfc'].includes(sectorType)
  const roe = r.ratios?.roe?.value
  // No fabricated 12%-ROE stand-in: a target multiple built on a number
  // nobody measured isn't "conservative," it's a guess wearing this
  // company's row. Financials use a sector-median multiple (not circular,
  // since it isn't derived from the stock's own price); everyone else needs
  // a REAL measured ROE or the row simply doesn't exist.
  if (isApplicable('pb', modelMeta) && r.bookPerShare > 0 && !pbDistorted &&
      (isFinancialSector || roe > 0)) {
    const targetPb = isFinancialSector ? 2.0 : clamp(roe / 8, 0.5, 5)
    results.pb = { value: r.bookPerShare * targetPb, note: `Book x ${targetPb.toFixed(1)}x (${isFinancialSector ? 'sector median PB' : 'ROE-derived'})` }
  }

  // ── P/S ──────────────────────────────────────────────────────────────────────
  // Same principle: a target multiple needs this company's own net margin.
  // A flat 5%-margin stand-in isn't this company's margin, and DCF/P&L
  // already gets its own consistency from ratios.js never assuming one.
  const netM = r.ratios?.netMargin?.value
  if (isApplicable('ps', modelMeta) && r.revenue > 0 && r.shares && netM > 0) {
    const targetPs = clamp(netM / 8, 0.3, 6)
    results.ps = { value: (r.revenue / r.shares) * targetPs, note: `Revenue/Share × ${targetPs.toFixed(1)}× (margin-derived)` }
  }

  // ── Graham Number ─────────────────────────────────────────────────────────────
  // Skip Graham for asset-light/high-PB companies — distorted book value breaks it
  if (isApplicable('graham', modelMeta) && r.grahamNumber > 0 && !pbDistorted) {
    results.graham = { value: r.grahamNumber, note: 'sqrt(22.5 x EPS x Book Value per Share)' }
  }

  // ── EV / Operating Profit ─────────────────────────────────────────────────────
  if (isApplicable('evGrossProfit', modelMeta) && r.opProfit > 0 && r.shares && r.totalDebt != null) {
    const impliedEV = r.opProfit * 8
    const perShare  = (impliedEV + r.cash - r.totalDebt) / r.shares
    if (perShare > 0) results.evGrossProfit = { value: perShare, note: 'Op.Profit × 8×' }
  }

  // ── PEG (growth-stage only; gated by stage.js applicable list) ──────────────
  if (isApplicable('peg', modelMeta) && r.eps > 0) {
    const peg = computePeg(r, {
      forwardGrowthPct: assumptions.forwardGrowthPct ?? null,
      mode: assumptions.pegMode || 'blend',
    })
    if (peg.applicable && peg.fairValue > 0) {
      results.peg = { value: peg.fairValue, note: peg.note, meta: peg }
    }
  }

    // ── Applicable models & primary selection ─────────────────────────────────────
  // No weighted blend: averaging models that disagree by era (a turnaround's
  // EV/EBITDA vs its pre-turnaround revenue multiples) produces a number no model
  // supports. Fair value is the PRIMARY model — the highest-weighted one for this
  // stage/sector among those with valid inputs (see byWeightDesc below) — with the
  // other models shown as a range for context. A reliability gate drops models
  // whose inputs are meaningless for this stock.
  const netMargin = r?.ratios?.netMargin?.value
  const inputValid = (m) => {
    if ((m === 'pe' || m === 'graham' || m === 'peg') && !(netMargin > 0)) return false
    // Financial-sector P/B uses a fixed sector-median multiple, not an
    // ROE-derived one (see the P/B block above), so it isn't gated on ROE.
    if (m === 'pb' && !isFinancialSector && !(roe > 0)) return false
    return true
  }
  const validKeys = modelMeta.applicable.filter(m => results[m]?.value > 0 && inputValid(m))

  const MODEL_NAMES = {
    dcf: 'DCF', pe: 'P/E', evEbitda: 'EV/EBITDA', pb: 'P/B',
    ps: 'P/S', graham: 'Graham', evGrossProfit: 'EV/Gross Profit', peg: 'PEG',
  }

  // Primary = the highest-WEIGHTED model among the ones that actually have
  // valid inputs for this ticker — modelMeta.weights is the stage/sector
  // domain judgement of which model to trust most (e.g. DCF=3, EV/EBITDA=2.5,
  // P/E=2 for an established company); ranking by it, rather than by array
  // position in `applicable`, is what makes this "the most appropriate model
  // for the ticker" rather than an accident of how the list happened to be
  // typed. That accident was real: GROWTH and TRANSITION both list `ps`
  // (weight 1) before `peg` (weight 1.5) in `applicable`, so array-order
  // selection picked the LOWER-weighted model whenever both were valid.
  // Filtering to validKeys first, then ranking, is also the cascade for a
  // missing result: if the top-weighted model's inputs aren't there, it's
  // simply not in validKeys, and the next-highest-weighted valid one wins —
  // never a hole where the highest-weighted model failed to compute.
  const byWeightDesc = (a, b) => (modelMeta.weights?.[b] ?? 0) - (modelMeta.weights?.[a] ?? 0)
  const rankedKeys   = [...validKeys].sort(byWeightDesc)
  const primaryKey   = rankedKeys[0] || null
  const primaryModel = primaryKey
    ? { key: primaryKey, name: MODEL_NAMES[primaryKey] || primaryKey, value: results[primaryKey].value }
    : null
  const fairValue = primaryModel?.value ?? null

  // Range across all valid models — context only, shown in details.
  const modelValues = validKeys.map(m => results[m].value)
  const rangeLow    = modelValues.length > 1 ? Math.min(...modelValues) : fairValue
  const rangeHigh   = modelValues.length > 1 ? Math.max(...modelValues) : fairValue

  // ── Sensitivity + scenarios (DCF is the growth/WACC-sensitive model) ──────────
  // Both axes need REAL base values — a sensitivity grid built by sweeping
  // around a fabricated 8%/flat-WACC centre is a grid of guesses, not a
  // range around this company's own numbers.
  const sensitivity = (isApplicable('dcf', modelMeta) && r.shares && cfBaseDcf && growthRate != null && wacc != null)
    ? dcfSensitivity(cfBaseDcf, growthRate, wacc, termGrowth, projYears, r.cash, r.totalDebt, r.shares, ntY)
    : null

  // Both the scenario cards and the sensitivity grid need REAL base values —
  // without them, scenarioAssumptions() correctly returns null growth/wacc,
  // but the panel would still render a card and format `null * 100` as a
  // (wrong-looking, still misleading) "0%" rather than not showing the card
  // at all. Gating the whole block here means "no scenarios" instead.
  let scenarios = null
  const scenGrowthDefault = estimateGrowth(r)
  if (cfBaseDcf && r.shares && scenGrowthDefault != null && waccDefault != null) {
    const scenBase = { growthRate: scenGrowthDefault, wacc: waccDefault, termGrowth: 0.03, projYears }
    scenarios = {}
    for (const key of ['bear', 'base', 'bull']) {
      const sa    = scenarioAssumptions(key, scenBase)
      const dcfPs = dcfPerShare(cfBaseDcf, sa.growthRate, sa.wacc, sa.termGrowth, sa.projYears, r.cash, r.totalDebt, r.shares)
      scenarios[key] = {
        label: SCENARIO_PRESETS[key].label,
        assumptions: sa,
        dcf: dcfPs,
        fairValue: dcfPs,
      }
    }
  }

  // Signal from the primary model's value vs CMP.
  const upside = fairValue != null && r.price > 0 ? ((fairValue - r.price) / r.price) * 100 : null
  const signal = (fairValue == null || r.price <= 0) ? 'UNKNOWN'
    : r.price < fairValue * 0.98 ? 'UNDERVALUED'
    : r.price > fairValue * 1.02 ? 'OVERVALUED'
    : 'FAIRLY_VALUED'

  // ── Reverse DCF ───────────────────────────────────────────────────────────────
  let impliedGrowth = null
  const cfForRev = (r.fcf > 0 && !r.fcfMaintenanceOnly) ? r.fcf : null   // same rule as the DCF above
  // wacc discounts every cash flow in the solve below — a null wacc silently
  // coerces to 0 in arithmetic (no discounting at all), which would return a
  // confidently wrong implied growth rather than none. Requires a real WACC.
  if (cfForRev && r.price > 0 && r.shares && r.totalDebt != null && wacc != null) {
    const targetEV = r.price * r.shares + r.totalDebt - r.cash
    impliedGrowth  = solveGrowth(cfForRev, targetEV, wacc, termGrowth, projYears)
  }

    return {
    models: results,
    modelMeta,
    fairValue,
    primaryModel,
    rangeLow,
    rangeHigh,
    upside,
    signal,
    impliedGrowth,
    sensitivity,
    scenarios,
    assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb },
    defaults: { wacc: waccDefault, termGrowth: TERMINAL_GROWTH_RATE, projYears: 10, growthRate: estimateGrowth(r), sectorPe: sectorPeDefault, sectorEvEb: sectorEvEbDefault }
  }
}

function isApplicable(m, meta) { return meta.applicable.includes(m) || meta.caution.includes(m) }

// Company-specific WACC via CAPM, the professional standard (vs a flat rate):
//   Cost of equity  Ke = riskFree + beta × equityRiskPremium   (see requiredReturn.js)
//   Cost of debt    Kd = interest / totalDebt  (after-tax: × (1 − taxRate))
//   WACC = E/(E+D)·Ke + D/(E+D)·Kd·(1−tax)      with E = market cap, D = total debt
//
// riskFree resolves through THREE tiers, always landing on a usable number —
// Fair Value is a core, always-on feature and must never go blank for lack of
// a configured AI key: liveRiskFree (shared with justifiedMultiple.js, when
// Phase 8's plumbing supplies it) → DEFAULT_RISK_FREE_BY_MARKET → 0.07. ERP
// comes from the same shared ERP_BY_MARKET justifiedMultiple.js now uses —
// this used to be a second, independently-hardcoded 5.5% here vs 6.5% there,
// silently disagreeing for no stated reason.
// Result is clamped to a sane 8–16% band so a freak beta can't produce nonsense.
function computeWacc(r, { liveRiskFree = null, market = 'IN', erp = null, taxRate = 0.25 } = {}) {
  const riskFree = liveRiskFree ?? DEFAULT_RISK_FREE_BY_MARKET[market] ?? DEFAULT_RISK_FREE_BY_MARKET.IN
  const beta = (r?.ratios?.beta?.value != null && r.ratios.beta.value > 0) ? r.ratios.beta.value : 1.0
  const E = r?.marketCap > 0 ? r.marketCap : null
  const D = r?.totalDebt > 0 ? r.totalDebt : 0
  const ke = capmCostOfEquity({ riskFreeRate: riskFree, beta, erp, market }).r
  if (E == null) return clamp(ke, 0.08, 0.16)          // no market cap → all-equity proxy
  // Cost of debt has to be MEASURED (interest / debt) — a flat 9% dressed up
  // as this company's WACC was the same "invented figure feeding a fair
  // value" problem the DCF section below already refuses for FCF/CapEx.
  // D == 0 means debt carries no weight in WACC at all, so kd is moot there.
  let kd = 0
  if (D > 0) {
    if (!(r?.interest > 0)) return null      // real debt, no way to measure its cost
    kd = clamp(r.interest / D, 0.04, 0.18)
  }
  const V = E + D
  const wacc = (E / V) * ke + (D / V) * kd * (1 - taxRate)
  return clamp(wacc, 0.08, 0.16)
}


// Build the "market implies X% vs your view Y%" insight for the combined verdict.
// Prefers the real reverse-DCF (valuation.impliedGrowth). If that can't resolve
// (e.g. no positive cash flow), falls back to the stage-appropriate Market
// Expectation variant (earnings-based, else sales-based) and LABELS the basis.
// "Your view" = user guidance if given, else the growth the DCF is currently
// using (scenario/model). Returns null when nothing resolves → caller hides it.
// Shared "which market-expectation variant is primary" — used by BOTH the pillar
// and the boilerplate insight so they always show the SAME number. Stage-ordered:
// growth/pre-revenue → sales first; else earnings first.
export function primaryExpectation(marketExpectation, stage) {
  const V = marketExpectation?.variants
  if (!V) return null
  const order = (stage === 'GROWTH' || stage === 'PRE_REVENUE')
    ? ['sales', 'fcf', 'earnings'] : ['earnings', 'fcf', 'sales']
  const key = order.find(k => V[k]?.applicable && V[k].impliedGrowth != null)
  return key ? { key, ...V[key] } : null
}

export function expectationInsight(valuation, marketExpectation, ratioResult = null, stage = null, guidedGrowthPct = null) {
  if (!valuation) return null
  const rdcf   = valuation.impliedGrowth
  const price  = ratioResult?.price
  const g      = ratioResult?.ratios || {}

  // Headline number = the SAME variant the Market Expectation pillar shows.
  const prim = primaryExpectation(marketExpectation, stage)
  let implied = null, basis = null
  if (prim) { implied = prim.impliedGrowth; basis = prim.key }        // 'sales' | 'earnings' | 'fcf'
  else if (rdcf != null) { implied = rdcf; basis = 'reverse-DCF' }
  if (implied == null) return null

  // Recent actual growth to compare against (basis-appropriate). npCagr, not
  // npGrowthYoY — the latter is a single year's change and was rendering as
  // "Historical earnings CAGR" even though it wasn't a CAGR and didn't move
  // when the growth-window slider did.
  const recent = (basis === 'earnings') ? g.npCagr?.value
                                        : (g.revCagr?.value)
  const recentLabel = (basis === 'earnings') ? 'earnings' : 'sales'
  const basisLabel  = basis === 'reverse-DCF' ? ' (reverse-DCF)' : ` (${basis}-based)`

  let story = ''
  if (implied < 0) {
    story = ` — the price implies the business will shrink about ${Math.abs(implied).toFixed(0)}% a year, so the market is pricing in decline`
      + (recent != null ? `, far more pessimistic than its recent ~${recent.toFixed(0)}% ${recentLabel} growth` : '')
  } else if (recent != null) {
    const d = implied - recent
    story = d >= 3
      ? ` — well above the company's recent ~${recent.toFixed(0)}% ${recentLabel} growth, so the market expects growth to accelerate`
      : d <= -3
      ? ` — below the company's recent ~${recent.toFixed(0)}% ${recentLabel} growth, so the market expects growth to slow from the recent pace`
      : ` — roughly in line with its recent ~${recent.toFixed(0)}% ${recentLabel} growth, so growth expectations look fairly priced`
  }
  let text = `The market is pricing in ~${implied.toFixed(1)}% growth${basisLabel}${story}.`

  const gap = (guidedGrowthPct != null ? guidedGrowthPct : recent) != null
    ? (guidedGrowthPct != null ? guidedGrowthPct : recent) - implied : null
  if (guidedGrowthPct != null) {
    const gd = guidedGrowthPct - implied
    const rel = Math.abs(gd) < 1 ? 'in line with' : gd > 0 ? `${gd.toFixed(0)} pts above` : `${Math.abs(gd).toFixed(0)} pts below`
    text += ` Your guided view of ~${guidedGrowthPct.toFixed(0)}% is ${rel} that.`
  }
  const yourView = guidedGrowthPct != null ? guidedGrowthPct : recent
  const viewLabel = guidedGrowthPct != null ? 'your view' : `recent ${recentLabel} growth`

  // Secondary: note the cash-flow (reverse-DCF) reading when it differs and is
  // available — neutral, no interpretation. Omitted if it didn't resolve.
  let bases = null
  if (basis !== 'reverse-DCF' && rdcf != null && Math.abs(rdcf - implied) >= 10) {
    bases = `On a cash-flow (reverse-DCF) basis the implied figure is ~${rdcf.toFixed(0)}%, versus ~${implied.toFixed(0)}% on ${basis === 'earnings' ? 'earnings' : 'sales'} — the two methods differ.`
  }

  return { implied, basis, yourView, viewLabel, gap, text, bases }
}

function estimateGrowth(r) {
  // The single dynamic windowed CAGR — same figure every consumer uses, so the
  // user's window now reaches the DCF. Clamp is a sanity bound on a REAL
  // measured rate, not a source: no revCagr means no growth rate, not a flat
  // 8% dressed up as one. Callers (DCF, scenarios, reverse-DCF) decline
  // rather than substitute when this comes back null.
  const cagr = r.ratios?.revCagr?.value
  if (cagr == null) return null
  return clamp(cagr / 100, 0.02, 0.20)
}

// Enterprise PV → equity value per share, with a growth fade toward terminal.
function dcfPerShare(cfBase, g, wacc, tg, yrs, cash, debt, shares, ntGrowth = null, ntYears = 0) {
  // cash/debt are never null now — ratios.js assumes nil cash and flags it, so the
  // bridge always runs. The flag rides along on r.bsEstimated and the note below.
  if (!(cfBase > 0) || !(shares > 0)) return null
  if (wacc == null || wacc <= tg) return null
  if (cash == null || debt == null) return null
  // No measured base growth rate AND no user-set near-term (guidance) window
  // to fade from instead — there's nothing real to project the cash flow on.
  if (ntYears === 0 && g == null) return null
  const ev = dcfEV(cfBase, g, wacc, tg, yrs, ntGrowth, ntYears)
  const ps = (ev + cash - debt) / shares
  return ps > 0 ? ps : null
}

// DCF fair value across a growth × WACC grid (the two inputs a DCF is sensitive
// to). When a near-term (guidance) window is set, the growth axis sweeps that
// near-term rate so the centre cell matches the applied DCF.
function dcfSensitivity(cfBase, gBase, wBase, tg, yrs, cash, debt, shares, ntYears = 0) {
  if (!(cfBase > 0) || !(shares > 0)) return null
  const growthAxis = [-0.04, -0.02, 0, 0.02, 0.04].map(d => clamp(gBase + d, 0, 0.30))
  const waccAxis   = [-0.02, -0.01, 0, 0.01, 0.02].map(d => clamp(wBase + d, tg + 0.01, 0.30))
  const grid = growthAxis.map(g =>
    waccAxis.map(w => ntYears > 0
      ? dcfPerShare(cfBase, g, w, tg, yrs, cash, debt, shares, g, ntYears)
      : dcfPerShare(cfBase, g, w, tg, yrs, cash, debt, shares)))
  return { growthAxis, waccAxis, grid }
}

// Scenario presets shift the SAME growth / WACC / terminal the sliders drive —
// no parallel model. Bear = lower growth + higher discount; Bull = the opposite.
export const SCENARIO_PRESETS = {
  base: { label: 'Base', growthMul: 1.00, waccAdd:  0.000, termAdd:  0.000 },
  bear: { label: 'Bear', growthMul: 0.50, waccAdd:  0.020, termAdd: -0.005 },
  bull: { label: 'Bull', growthMul: 1.40, waccAdd: -0.015, termAdd:  0.005 },
}

// Given a base assumptions set, return the assumptions for a named scenario.
// The UI applies this via the existing recalc(assumptions) path.
export function scenarioAssumptions(preset, base) {
  const p = SCENARIO_PRESETS[preset] || SCENARIO_PRESETS.base
  const termGrowth = clamp((base.termGrowth ?? 0.03) + p.termAdd, 0.0, 0.06)
  return {
    // null base growth/wacc (no measured CAGR, no computable WACC) stays
    // null through every scenario rather than falling back to a flat
    // 8%/10% — dcfPerShare declines cleanly on a null input; it must NOT
    // receive a number nobody measured just because a scenario multiplier
    // was applied to it.
    growthRate: base.growthRate != null ? clamp(base.growthRate * p.growthMul, 0.02, 0.30) : null,
    wacc:       base.wacc != null ? clamp(base.wacc + p.waccAdd, termGrowth + 0.01, 0.30) : null,
    termGrowth,
    projYears:  base.projYears ?? 10,
  }
}

function clamp(v, min, max) { return v == null ? null : Math.max(min, Math.min(max, v)) }

function solveGrowth(fcf0, tEV, wacc, tg, yrs) {
  const LO = -0.9, HI = 3.0        // wide bounds: let the maths return the real rate
  let lo = LO, hi = HI
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const ev  = dcfEV(fcf0, mid, wacc, tg, yrs)
    if (Math.abs(ev - tEV) < 1e5) break
    ev > tEV ? (hi = mid) : (lo = mid)
  }
  const g = (lo + hi) / 2
  // If it pins to a bound it didn't really converge — inputs are degenerate
  // (e.g. FCF too thin to justify the price at any sane rate). Return null so the
  // packager simply omits it rather than reporting a floored/absurd number.
  if (g <= LO + 0.01 || g >= HI - 0.01) return null
  return g * 100
}

function dcfEV(f, g, w, tg, yrs, ntGrowth = null, ntYears = 0) {
  let pv = 0, cf = f
  for (let i = 1; i <= yrs; i++) {
    let gi
    if (ntYears > 0 && i <= ntYears) {
      gi = ntGrowth                                   // explicit near-term (guidance) window
    } else {
      const fadeStart = ntYears > 0 ? ntGrowth : g    // fade from the near-term rate, else base
      const step      = ntYears > 0 ? (i - ntYears) : (i - 1)
      gi = Math.max(fadeStart * Math.pow(0.85, step), tg)
    }
    cf *= (1 + gi)
    pv += cf / Math.pow(1 + w, i)
  }
  return pv + (cf * (1 + tg)) / (w - tg) / Math.pow(1 + w, yrs)
}
