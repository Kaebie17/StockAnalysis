/**
 * src/engine/valuation.js
 * Stage + sector aware. All models calculated from raw scalars in ratioResult.
 *
 * KEY FIXES:
 * 1. sectorPe uses SECTOR MEDIAN not stock's own PE (using own PE is circular —
 *    EPS × own_PE always returns current price)
 * 2. sectorEvEb uses SECTOR MEDIAN EV/EBITDA (src/engine/sectorMultiples.js),
 *    not the stock's own multiple — that was the same circularity as (1), and
 *    the specific bug that triggered this file's valuation audit.
 * 3. DCF runs on real FCF only — no opCF proxy, no invented CapEx
 */
import { getApplicableModels } from './stage.js'
import { computePeg } from './peg.js'
import { capmCostOfEquity, DEFAULT_RISK_FREE_BY_MARKET, TERMINAL_GROWTH_RATE } from './requiredReturn.js'
import { sectorPe as getSectorPe, sectorEvEbitda as getSectorEvEbitda, sectorEvSales as getSectorEvSales, financialPb } from './sectorMultiples.js'
import { peerBand } from './peerBands.js'
import { justifiedMultiples } from './justifiedMultiple.js'

export function runValuation(data, r, stage, sectorType, assumptions = {}) {
  // Every call site guards on state.data being truthy, not state.ratioResult
  // specifically — the two are set together in practice, but "in practice"
  // isn't a guarantee, and every field access below already assumes r is at
  // least an object. Guarding here means a genuinely missing ratioResult
  // declines cleanly (fairValue: null, signal: 'UNKNOWN') like any other
  // missing-data case, instead of throwing.
  r = r || {}
  const modelMeta = getApplicableModels(stage, sectorType)

  // sectorPe: sector median (NOT stock's own PE — that's circular)
  const sectorPeDefault = getSectorPe(data)
  // sectorEvEb: sector median EV/EBITDA (NOT the stock's own multiple — that
  // was circular: EBITDA x its own current multiple always reproduces close
  // to today's price, clamped or not, and can never independently say the
  // stock is over/undervalued. This was the exact mechanism that made Dixon
  // Technologies' "Fair Value via EV/EBITDA" read as cheap-relative-to-nothing
  // and triggered this whole valuation audit. Peer EV/EBITDA data isn't
  // fetched (needs a per-peer quoteSummary() call the free batched quote()
  // doesn't carry — confirmed, deferred) so the sector table is the anchor.
  const sectorEvEbDefault = getSectorEvEbitda(data)
  // sectorPs: sector median EV/Sales (NOT the stock's own net margin ÷ 8 —
  // that was a heuristic with no peer/sector anchor at all, despite P/S being
  // conceptually a relative-multiple model. It also required netM > 0 to
  // compute anything, which disqualified exactly the loss-making companies
  // P/S exists to serve — PRE_REVENUE and GROWTH stages weight this model
  // specifically because their earnings aren't usable yet. Same sector table
  // (sectorMultiples.js) valuation.js's EV/EBITDA model and Market
  // Expectation's Sales variant already use.
  const sectorPsDefault = getSectorEvSales(data)

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
    sectorPs   = sectorPsDefault,
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

  // ── P/E ── real peer data preferred, sector table as fallback ────────────────
  // Before real peer data existed, "sector median" here meant a static,
  // hand-set table — a genuine peer group's ACTUAL current multiple is a
  // strictly better anchor when there are enough peers to trust (see
  // peerBands.js). Forward P/E tried first (a market-implied peer band
  // already prices in near-term earnings changes the same way this model
  // is trying to); trailing P/E as a second peer-based attempt; the sector
  // table only when peer data isn't available at all.
  const peers = assumptions.peers || []
  if (isApplicable('pe', modelMeta) && r.eps > 0) {
    const peBand = peerBand(peers, 'forwardPe') || peerBand(peers, 'pe')
    const targetPe = peBand?.median ?? sectorPe
    const note = peBand
      ? `EPS × peer median ${targetPe}× P/E (${peBand.count} peers)`
      : `EPS × sector median ${targetPe}× P/E`
    results.pe = { value: r.eps * targetPe, note }
  }

  // ── EV/EBITDA ── sector-median multiple as anchor (peer EV/EBITDA data
  // isn't fetched — see sectorEvEbDefault above) ────────────────────────────
  if (isApplicable('evEbitda', modelMeta) && r.ebitda > 0 && r.shares && r.totalDebt != null) {
    const impliedEV = r.ebitda * sectorEvEb
    const impliedEq = impliedEV + r.cash - r.totalDebt
    const perShare  = impliedEq / r.shares
    if (perShare > 0) {
      results.evEbitda = { value: perShare, note: `EBITDA × ${sectorEvEb.toFixed(1)}× sector median EV/EBITDA` }
    }
  }

  // ── P/B ── ROE-derived target multiple ────────────────────────────────────────
  const actualPb = r.ratios?.pb?.value
  const pbDistorted = detectBookValueDistortion(data, actualPb)
  const isFinancialSector = ['insurance', 'bank', 'nbfc'].includes(sectorType)
  const roe = r.ratios?.roe?.value
  // No fabricated 12%-ROE stand-in: a target multiple built on a number
  // nobody measured isn't "conservative," it's a guess wearing this
  // company's row. Financials use a sector-median multiple (not circular,
  // since it isn't derived from the stock's own price); everyone else needs
  // a REAL measured ROE or the row simply doesn't exist.
  if (isApplicable('pb', modelMeta) && r.bookPerShare > 0 && !pbDistorted &&
      (isFinancialSector || roe > 0)) {
    const pbBand = peerBand(peers, 'pb')
    let targetPb = null, pbNote = null
    if (pbBand) {
      targetPb = pbBand.median
      pbNote = `Book x ${targetPb.toFixed(1)}x (peer median PB, ${pbBand.count} peers)`
    } else if (isFinancialSector) {
      targetPb = financialPb(sectorType)
      pbNote = `Book x ${targetPb.toFixed(1)}x (sector median PB)`
    } else {
      // Last resort — no peer P/B data and no non-financial sector-PB table.
      // Reuses justifiedMultiple.js's own P/B form (already two-stage-fixed)
      // rather than a second, divergent implementation of the same formula.
      // Labeled distinctly so a coincidental match with the Justified
      // Multiples tab's own number is never mistaken for something else —
      // it's the SAME calculation here on purpose, not a coincidence.
      const jm = justifiedMultiples(r, {
        riskFreeRate: assumptions.liveRiskFree ?? DEFAULT_RISK_FREE_BY_MARKET[market] ?? DEFAULT_RISK_FREE_BY_MARKET.IN,
        beta: r?.ratios?.beta?.value, market,
      })
      // Same instability guard as estimate.js's buildJustifiedEstimate — this
      // reuses the SAME single-stage formula, so it has the SAME blow-up
      // condition (required return - growth going thin relative to required
      // return) and had no protection against it at all here, unlike the
      // sibling call site. Found by tracing where else justifiedMultiples()
      // is consumed after fixing that one: a non-financial stock with no
      // peer/sector P/B data and growth close to its required return
      // produced "Book x 111.7x" (₹5,586 fair value on a ₹1,000 stock) with
      // nothing to catch it.
      const jmGapFraction = (jm?.requiredReturn?.r > 0)
        ? (jm.requiredReturn.r - jm.growth.g) / jm.requiredReturn.r : null
      const jmStable = jm?.twoStage || jmGapFraction == null || jmGapFraction >= 0.1
      targetPb = jmStable ? (jm?.forms?.pb?.multiple ?? null) : null
      if (targetPb != null) {
        pbNote = `Book x ${targetPb.toFixed(1)}x (no peer/sector P/B data — the fundamentals-based Justified form, used as a last resort)`
      }
    }
    if (targetPb != null) {
      results.pb = { value: r.bookPerShare * targetPb, note: pbNote }
    }
  }

  // ── P/S ── sector-median EV/Sales as anchor (peer EV/Sales data isn't
  // fetched — same reasoning as EV/EBITDA above) ────────────────────────────
  // No netMargin gate: P/S is weighted specifically for PRE_REVENUE/GROWTH
  // stages (stage.js) precisely because those companies' earnings aren't
  // usable yet — gating this model on positive margin would disqualify the
  // exact companies it exists to serve.
  if (isApplicable('ps', modelMeta) && r.revenue > 0 && r.shares && r.totalDebt != null) {
    const impliedEV = r.revenue * sectorPs
    const impliedEq = impliedEV + r.cash - r.totalDebt
    const perShare  = impliedEq / r.shares
    if (perShare > 0) {
      results.ps = { value: perShare, note: `Revenue × ${sectorPs.toFixed(1)}× sector median EV/Sales` }
    }
  }

  // ── Graham Number ─────────────────────────────────────────────────────────────
  // Skip Graham for asset-light/high-PB companies — distorted book value breaks it
  if (isApplicable('graham', modelMeta) && r.grahamNumber > 0 && !pbDistorted) {
    results.graham = { value: r.grahamNumber, note: 'sqrt(22.5 x EPS x Book Value per Share)' }
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
  // Fair Value now means one specific thing: relative valuation against peers/
  // sector — P/E, P/B, EV/EBITDA, P/S. DCF and Graham are genuinely different
  // methods (cash-flow discounting; a fixed heuristic ceiling) that used to
  // compete in the SAME weighted race and could silently win it — for an
  // ESTABLISHED company DCF (weight 3) usually beat every peer/sector model,
  // so "Fair Value" was frequently just DCF wearing a different label, and the
  // two were impossible to tell apart from the headline number alone. They're
  // surfaced as their own separate headline figures instead (intrinsicValue,
  // secondaryChecks below) — never blended into this number or its range.
  const EXTRINSIC_MODELS = ['pe', 'pb', 'evEbitda', 'ps']
  // No weighted blend even within the extrinsic group: averaging models that
  // disagree by era (a turnaround's EV/EBITDA vs its pre-turnaround revenue
  // multiples) produces a number no model supports. Fair value is the
  // PRIMARY model — the highest-weighted extrinsic one for this stage/sector
  // among those with valid inputs (see byWeightDesc below) — with the others
  // shown as a range for context. A reliability gate drops models whose
  // inputs are meaningless for this stock.
  const netMargin = r?.ratios?.netMargin?.value
  const inputValid = (m) => {
    if ((m === 'pe' || m === 'graham' || m === 'peg') && !(netMargin > 0)) return false
    // Financial-sector P/B uses a fixed sector-median multiple, not an
    // ROE-derived one (see the P/B block above), so it isn't gated on ROE.
    if (m === 'pb' && !isFinancialSector && !(roe > 0)) return false
    return true
  }
  const validKeys = modelMeta.applicable.filter(m =>
    EXTRINSIC_MODELS.includes(m) && results[m]?.value > 0 && inputValid(m))

  const MODEL_NAMES = {
    dcf: 'DCF', pe: 'P/E', evEbitda: 'EV/EBITDA', pb: 'P/B',
    ps: 'P/S', graham: 'Graham', peg: 'PEG',
  }

  // Primary = the highest-WEIGHTED extrinsic model among the ones that
  // actually have valid inputs for this ticker — modelMeta.weights is the
  // stage/sector domain judgement of which model to trust most; ranking by
  // it, rather than by array position in `applicable`, is what makes this
  // "the most appropriate PEER/SECTOR model for the ticker" rather than an
  // accident of how the list happened to be typed. That accident was real:
  // GROWTH and TRANSITION both list `ps` (weight 1) before `peg` (weight 1.5)
  // in `applicable`, so array-order selection once picked the LOWER-weighted
  // model whenever both were valid — weighting fixed that, and restricting
  // the pool to EXTRINSIC_MODELS here is the separate, later fix that stops
  // an intrinsic model (peg, or previously dcf) from winning this race at all.
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

  // Range across valid EXTRINSIC models only — context only, shown in
  // details. Was previously across every applicable model including DCF/
  // Graham, which meant "Fair Value's range" silently mixed a cash-flow
  // model and a heuristic ceiling into what was supposed to be a peer/sector
  // comparison range.
  const modelValues = validKeys.map(m => results[m].value)
  const rangeLow    = modelValues.length > 1 ? Math.min(...modelValues) : fairValue
  const rangeHigh   = modelValues.length > 1 ? Math.max(...modelValues) : fairValue

  // ── Intrinsic Value (DCF) & secondary heuristic checks (Graham, PEG) ──────────
  // Own headline figures, never folded into Fair Value's primary/range above.
  // DCF is the rigorous cash-flow-discounting method; Graham/PEG are simple,
  // no-required-return heuristic formulas (a fixed sanity ceiling; "fair P/E
  // = growth rate") — shown as supporting checks, not peers of DCF's rigor.
  const intrinsicValue = results.dcf
    ? { key: 'dcf', name: 'DCF', value: results.dcf.value, note: results.dcf.note }
    : null
  const secondaryChecks = {
    graham: results.graham ? { value: results.graham.value, note: results.graham.note } : null,
    peg:    results.peg    ? { value: results.peg.value,    note: results.peg.note }    : null,
  }

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
    // termGrowth: the RESOLVED value (respects a user-adjusted slider), not a
    // separate hardcoded 3% — this was a second, independent copy of the
    // constant Phase 1 unified, missed on the first pass and caught by
    // actually rendering the scenario cards (they kept showing "term 3%"
    // after the shared default moved to 4%).
    const scenBase = { growthRate: scenGrowthDefault, wacc: waccDefault, termGrowth, projYears }
    scenarios = {}
    for (const key of ['bear', 'base', 'bull']) {
      const sa    = scenarioAssumptions(key, scenBase, data)
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
  const impliedGrowth = reverseDcfGrowth(r, { wacc, termGrowth, projYears })

    return {
    models: results,
    modelMeta,
    fairValue,
    primaryModel,
    rangeLow,
    rangeHigh,
    upside,
    signal,
    intrinsicValue,
    secondaryChecks,
    impliedGrowth,
    sensitivity,
    scenarios,
    assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb, sectorPs },
    defaults: { wacc: waccDefault, termGrowth: TERMINAL_GROWTH_RATE, projYears: 10, growthRate: estimateGrowth(r), sectorPe: sectorPeDefault, sectorEvEb: sectorEvEbDefault, sectorPs: sectorPsDefault }
  }
}

function isApplicable(m, meta) { return meta.applicable.includes(m) || meta.caution.includes(m) }

// Book value going "meaningless" (the reason P/B and Graham get skipped) is a
// real, specific mechanism — heavy buybacks or dividends returning more to
// shareholders than the business retains, so book shrinks even while the
// business earns well. This tests that mechanism directly: has the company
// been profitable in every year of available history while book-per-share
// still failed to grow? A snapshot "P/B > 10" (the previous check) can't
// tell a stock the market richly (but legitimately) prices from one whose
// book value has actually been hollowed out by capital returns — it would
// exclude a genuine high-ROE, high-growth compounder for the same reason it
// correctly excludes an Apple-style buyback story, just because both trade
// above 10x book.
//
// Falls back to the old snapshot threshold only when there isn't enough
// balance-sheet history (fewer than 3 usable years) to measure the real
// trend — a weaker signal, but better than skipping the check outright.
function detectBookValueDistortion(data, actualPb) {
  const yearOf = row => {
    const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
    return m ? Number(m[0]) : null
  }
  const bal = (data?.balanceHistory || []).filter(row => !row?.synthetic)
  const inc = (data?.incomeHistory  || []).filter(row => !row?.synthetic)

  const points = []
  for (const bRow of bal) {
    const y = yearOf(bRow)
    const eq = bRow?.totalEquity?.value
    if (y == null || !(eq > 0)) continue
    const iRow = inc.find(row => yearOf(row) === y)
    const np  = iRow?.netProfit?.value
    const eps = iRow?.eps?.value
    const shares = (np > 0 && eps > 0) ? np / eps : null
    if (!(shares > 0)) continue
    points.push({ year: y, bps: eq / shares, netProfit: np })
  }
  points.sort((a, b) => a.year - b.year)

  const FALLBACK_PB_THRESHOLD = 10
  if (points.length < 3) return actualPb != null && actualPb > FALLBACK_PB_THRESHOLD

  const allProfitable = points.every(p => p.netProfit > 0)
  const bookShrank = points[points.length - 1].bps < points[0].bps
  return allProfitable && bookShrank
}

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
//
// taxRate: statutory corporate rate by market, not a flat guess applied to
// both alike. India: 22% base + 10% surcharge + 4% cess = 25.17% effective
// under Section 115BAA, the regime most large listed companies have adopted.
// US: 21% flat federal rate (Tax Cuts and Jobs Act, 2017) — state tax varies
// 0-11% and isn't modelled, a documented simplification rather than a silent
// one.
const TAX_RATE_BY_MARKET = { IN: 0.2517, US: 0.21 }

// Result is clamped to a wide sanity band, NOT a "typical range" — CAPM's own
// beta handling (requiredReturn.js: raw beta outside (0, 5) is treated as
// unusable data rather than used; a usable one is Blume-adjusted toward 1,
// adjusted = (2/3) x raw + 1/3) already bounds Ke to roughly [riskFree +
// 0.33×ERP, riskFree + 3.67×ERP] — about 9-31% for India, 7-28% for the US
// at the DEFAULT risk-free rates (a live rate shifts this slightly, not
// structurally). A genuinely high-beta company's real cost of equity sitting
// near that upper end is legitimate, not "nonsense" — a tight clamp that cut
// it down would systematically understate required return (and so OVERVALUE)
// exactly the volatile, small-cap names where getting this right matters
// most. This band only catches truly broken inputs (a data glitch, not a
// real high-beta stock), sitting outside that natural range on both ends.
function computeWacc(r, { liveRiskFree = null, market = 'IN', erp = null, taxRate = null } = {}) {
  const riskFree = liveRiskFree ?? DEFAULT_RISK_FREE_BY_MARKET[market] ?? DEFAULT_RISK_FREE_BY_MARKET.IN
  const tax = taxRate ?? TAX_RATE_BY_MARKET[market] ?? TAX_RATE_BY_MARKET.IN
  const beta = (r?.ratios?.beta?.value != null && r.ratios.beta.value > 0) ? r.ratios.beta.value : 1.0
  const E = r?.marketCap > 0 ? r.marketCap : null
  const D = r?.totalDebt > 0 ? r.totalDebt : 0
  const ke = capmCostOfEquity({ riskFreeRate: riskFree, beta, erp, market }).r
  if (E == null) return clamp(ke, 0.04, 0.34)          // no market cap → all-equity proxy
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
  const wacc = (E / V) * ke + (D / V) * kd * (1 - tax)
  return clamp(wacc, 0.04, 0.34)
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
  // user's window now reaches the DCF. No revCagr means no growth rate, not a
  // flat 8% dressed up as one. Callers (DCF, scenarios, reverse-DCF) decline
  // rather than substitute when this comes back null.
  //
  // Declines (null) rather than substituting when the rate itself is outside
  // a plausible range to project forward — same -30%/+60% bound seriesCagr
  // already uses elsewhere in this codebase (estimate.js), chosen there
  // because a CAGR beyond it is a recovery from a collapsed base or a
  // one-off, not a real sustainable rate. This used to be clamp(g, 0.02,
  // 0.20) — a FLOOR that substituted +2% for any decline, including a real,
  // measured one: a company with an actual -8%/yr revenue CAGR had its DCF
  // forced to assume +2% growth instead. That's the "dangerous direction"
  // (silently more optimistic) this codebase explicitly tries to avoid
  // elsewhere, and it directly contradicted this function's own comment
  // above ("decline rather than substitute").
  const cagr = r.ratios?.revCagr?.value
  if (cagr == null) return null
  const g = cagr / 100
  if (g < -0.3 || g > 0.6) return null
  // A ceiling only, not a floor: caps how high a temporary growth burst is
  // treated as DCF's sustainable BASE rate over its full horizon, which errs
  // conservative (lower fair value) — the safe direction. Unlike a floor,
  // this never overrides a company's real, measured decline.
  return Math.min(g, 0.20)
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
  const waccAxis   = [-0.02, -0.01, 0, 0.01, 0.02].map(d => clamp(wBase + d, tg + 0.01, 0.34))
  const grid = growthAxis.map(g =>
    waccAxis.map(w => ntYears > 0
      ? dcfPerShare(cfBase, g, w, tg, yrs, cash, debt, shares, g, ntYears)
      : dcfPerShare(cfBase, g, w, tg, yrs, cash, debt, shares)))
  return { growthAxis, waccAxis, grid }
}

// Scenario presets shift the SAME growth / WACC / terminal the sliders drive —
// no parallel model. Bear = lower growth + higher discount; Bull = the opposite.
// WACC and terminal-growth shifts are a narrative risk adjustment ("how much
// riskier does the market feel in a downturn"), not something with a natural
// per-company measurement the way growth volatility has one below — these
// stay a disclosed, undented convention rather than a spurious "measurement"
// invented to look more rigorous than they are.
export const SCENARIO_PRESETS = {
  base: { label: 'Base', growthMul: 1.00, waccAdd:  0.000, termAdd:  0.000 },
  bear: { label: 'Bear', growthMul: 0.50, waccAdd:  0.020, termAdd: -0.005 },
  bull: { label: 'Bull', growthMul: 1.40, waccAdd: -0.015, termAdd:  0.005 },
}

// Bear/Bull growth spread, measured from this company's OWN year-over-year
// revenue growth history — same "measure it from the company's own
// distribution" principle already used for OUTLIER_MULTIPLE, priceDispersion
// and targetMultiple's spreadLow/spreadHigh, rather than one flat 50%/140%
// multiplier applied to every company alike (a steady, predictable business
// gets an unrealistically wide Bear/Bull range under a flat multiplier; a
// genuinely volatile one gets an unrealistically narrow one). Returns null
// when there's too little revenue history to measure real volatility, in
// which case the caller falls back to the fixed multiplier.
function growthScenarioSpread(data) {
  const yearOf = row => {
    const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
    return m ? Number(m[0]) : null
  }
  const series = (data?.incomeHistory || [])
    .filter(row => !row?.synthetic)
    .map(row => ({ year: yearOf(row), value: row?.revenue?.value }))
    .filter(p => p.year != null && p.value > 0)
    .sort((a, b) => a.year - b.year)

  const yoy = []
  for (let i = 1; i < series.length; i++) yoy.push(series[i].value / series[i - 1].value - 1)
  if (yoy.length < 4) return null   // too little history for a real spread

  yoy.sort((a, b) => a - b)
  const q = p => yoy[Math.min(yoy.length - 1, Math.floor(p * yoy.length))]
  const spread = (q(0.85) - q(0.15)) / 2
  return (spread > 0 && isFinite(spread)) ? spread : null
}

// Given a base assumptions set, return the assumptions for a named scenario.
// The UI applies this via the existing recalc(assumptions) path. `data`
// (optional) enables the measured growth spread above; omitted, this falls
// back to the fixed multiplier exactly as before.
export function scenarioAssumptions(preset, base, data = null) {
  const p = SCENARIO_PRESETS[preset] || SCENARIO_PRESETS.base
  const termGrowth = clamp((base.termGrowth ?? TERMINAL_GROWTH_RATE) + p.termAdd, 0.0, 0.06)
  const measuredSpread = preset !== 'base' ? growthScenarioSpread(data) : null
  let growthRate = null
  if (base.growthRate != null) {
    // null base growth/wacc (no measured CAGR, no computable WACC) stays
    // null through every scenario rather than falling back to a flat
    // 8%/10% — dcfPerShare declines cleanly on a null input; it must NOT
    // receive a number nobody measured just because a scenario multiplier
    // was applied to it.
    growthRate = measuredSpread != null
      ? clamp(base.growthRate + (preset === 'bear' ? -measuredSpread : measuredSpread), 0.02, 0.30)
      : clamp(base.growthRate * p.growthMul, 0.02, 0.30)
  }
  return {
    growthRate,
    wacc:       base.wacc != null ? clamp(base.wacc + p.waccAdd, termGrowth + 0.01, 0.34) : null,
    termGrowth,
    projYears:  base.projYears ?? 10,
  }
}

function clamp(v, min, max) { return v == null ? null : Math.max(min, Math.min(max, v)) }

/**
 * What growth rate would the DCF need to assume for its output to land
 * exactly on today's market price? Exported so marketExpectation.js can
 * present this as its own fourth variant (the DCF fade-to-terminal-growth
 * convention, alongside its other three variants' flat-growth-then-exit-
 * multiple convention) — runValuation()'s own impliedGrowth is just a call
 * to this, same output as before.
 */
export function reverseDcfGrowth(r, { wacc, termGrowth, projYears = 10 } = {}) {
  const cfForRev = (r.fcf > 0 && !r.fcfMaintenanceOnly) ? r.fcf : null   // same rule as the forward DCF
  // wacc discounts every cash flow in the solve below — a null wacc silently
  // coerces to 0 in arithmetic (no discounting at all), which would return a
  // confidently wrong implied growth rather than none. Requires a real WACC.
  if (!(cfForRev && r.price > 0 && r.shares && r.totalDebt != null && wacc != null)) return null
  const targetEV = r.price * r.shares + r.totalDebt - r.cash
  return solveGrowth(cfForRev, targetEV, wacc, termGrowth, projYears)
}

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

// H-model linear fade (Fuller & Hsia, 1984, Financial Analysts Journal —
// standard CFA-curriculum practice): growth declines by a constant AMOUNT
// each year from the starting rate to the terminal rate, reaching it exactly
// by the last projection year — not an arbitrary geometric decay. This
// replaces a bare `Math.pow(0.85, step)` (15%/yr compounding decay) that had
// no stated derivation anywhere and, being geometric rather than linear,
// asymptotically approached the terminal rate rather than reaching it
// smoothly by design, relying on a floor (Math.max(..., tg)) to force the
// last mile rather than arriving there on its own.
function dcfEV(f, g, w, tg, yrs, ntGrowth = null, ntYears = 0) {
  let pv = 0, cf = f
  for (let i = 1; i <= yrs; i++) {
    let gi
    if (ntYears > 0 && i <= ntYears) {
      gi = ntGrowth                                   // explicit near-term (guidance) window
    } else {
      const fadeStart     = ntYears > 0 ? ntGrowth : g    // fade from the near-term rate, else base
      const step          = ntYears > 0 ? (i - ntYears) : (i - 1)
      const totalFadeYears = yrs - ntYears
      // step runs 0..totalFadeYears-1; linearly interpolate so the LAST
      // projection year lands exactly on tg, matching the terminal-value
      // formula's own assumption that growth is tg from year yrs+1 onward —
      // a smooth handoff instead of a floor forcing a late, sudden jump.
      gi = totalFadeYears > 1
        ? fadeStart - (fadeStart - tg) * (step / (totalFadeYears - 1))
        : tg
    }
    cf *= (1 + gi)
    pv += cf / Math.pow(1 + w, i)
  }
  return pv + (cf * (1 + tg)) / (w - tg) / Math.pow(1 + w, yrs)
}
