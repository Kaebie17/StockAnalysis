/**
 * src/engine/valuation.js
 * Stage + sector aware. All models calculated from raw scalars in ratioResult.
 *
 * KEY FIXES:
 * 1. sectorPe uses SECTOR MEDIAN not stock's own PE (using own PE is circular —
 *    EPS × own_PE always returns current price)
 * 2. sectorEvEb uses stock's actual EV/EBITDA as baseline (clamped), not generic 12×
 * 3. DCF uses opCF×0.7 as fallback when FCF null/negative
 */
import { getApplicableModels } from './stage.js'

// Sector median P/E multiples — target for PE-based valuation
const SECTOR_PE_MAP = {
  'energy': 15, 'oil': 15, 'petroleum': 15, 'refineries': 15, 'gas': 15,
  'insurance': 18, 'life insurance': 18, 'general insurance': 18,
  'bank': 16, 'banking': 16, 'nbfc': 16, 'finance': 16, 'financial services': 16,
  'technology': 25, 'software': 25, 'information technology': 25,
  'automobile': 20, 'auto': 20, 'automotive': 20,
  'mining': 12, 'metals': 12, 'steel': 10, 'iron': 10, 'aluminium': 12,
  'fmcg': 45, 'consumer': 35, 'beverages': 40, 'food': 35,
  'pharma': 28, 'healthcare': 28, 'hospitals': 30,
  'real estate': 30, 'realty': 30,
  'power': 18, 'utilities': 18, 'infrastructure': 20,
  'chemicals': 22, 'cement': 20,
  'telecom': 20,
  'default': 20
}

function getSectorPe(data) {
  const combined = [data?.meta?.sector, data?.meta?.industry, data?.name]
    .filter(Boolean).join(' ').toLowerCase()
  for (const [key, pe] of Object.entries(SECTOR_PE_MAP)) {
    if (combined.includes(key)) return pe
  }
  return SECTOR_PE_MAP.default
}

export function runValuation(data, r, stage, sectorType, assumptions = {}) {
  const modelMeta = getApplicableModels(stage, sectorType)

  // sectorPe: sector median (NOT stock's own PE — that's circular)
  const sectorPeDefault = getSectorPe(data)
  // sectorEvEb: stock's actual EV/EBITDA clamped to 5-20× (NOT generic 12×)
  const actualEvEb = r.ratios?.evEbitda?.value
  const sectorEvEbDefault = actualEvEb != null ? clamp(actualEvEb, 5, 20) : 12

  const {
    wacc       = 0.10,
    termGrowth = 0.03,
    projYears  = 10,
    sectorPe   = sectorPeDefault,
    sectorEvEb = sectorEvEbDefault,
    growthRate = estimateGrowth(r)
  } = assumptions

  const results = {}

  // ── DCF ──────────────────────────────────────────────────────────────────────
  // Use FCF if positive. Fall back to operatingCF×0.7 (conservative haircut).
  if (isApplicable('dcf', modelMeta) && r.shares) {
    const cfBase = (r.fcf != null && r.fcf > 0) ? r.fcf
                 : (r.opCF != null && r.opCF > 0) ? r.opCF * 0.7 : null
    if (cfBase) {
      let pv = 0, cf = cfBase
      for (let i = 1; i <= projYears; i++) {
        cf *= (1 + Math.max(growthRate * Math.pow(0.85, i - 1), termGrowth))
        pv += cf / Math.pow(1 + wacc, i)
      }
      const tv   = (cf * (1 + termGrowth)) / (wacc - termGrowth)
      const pvTv = tv / Math.pow(1 + wacc, projYears)
      const eq   = pv + pvTv + (r.cash || 0) - (r.totalDebt || 0)
      const perShare = eq / r.shares
      if (perShare > 0) {
        results.dcf = { value: perShare, note: r.fcf > 0 ? 'FCF-based' : 'Operating CF proxy (×0.7)' }
      }
    }
  }

  // ── P/E ── uses sector median PE, not stock's own PE ─────────────────────────
  if (isApplicable('pe', modelMeta) && r.eps > 0) {
    results.pe = { value: r.eps * sectorPe, note: `EPS × sector median ${sectorPe}× P/E` }
  }

  // ── EV/EBITDA ── uses stock's actual multiple as anchor ───────────────────────
  if (isApplicable('evEbitda', modelMeta) && r.ebitda > 0 && r.shares) {
    const impliedEV = r.ebitda * sectorEvEb
    const impliedEq = impliedEV + (r.cash || 0) - (r.totalDebt || 0)
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
  if (isApplicable('pb', modelMeta) && r.bookPerShare > 0 && !pbDistorted) {
    const roe = r.ratios?.roe?.value
    const targetPb = ['insurance','bank','nbfc'].includes(sectorType)
      ? 2.0   // industry median PB for financials (not stock's own — that's circular)
      : clamp((roe || 12) / 8, 0.5, 5)
    results.pb = { value: r.bookPerShare * targetPb, note: `Book x ${targetPb.toFixed(1)}x (${['insurance','bank','nbfc'].includes(sectorType) ? 'sector median PB' : 'ROE-derived'})` }
  }

  // ── P/S ──────────────────────────────────────────────────────────────────────
  if (isApplicable('ps', modelMeta) && r.revenue > 0 && r.shares) {
    const netM     = r.ratios?.netMargin?.value
    const targetPs = clamp((netM || 5) / 8, 0.3, 6)
    results.ps = { value: (r.revenue / r.shares) * targetPs, note: `Revenue/Share × ${targetPs.toFixed(1)}× (margin-derived)` }
  }

  // ── Graham Number ─────────────────────────────────────────────────────────────
  // Skip Graham for asset-light/high-PB companies — distorted book value breaks it
  if (isApplicable('graham', modelMeta) && r.grahamNumber > 0 && !pbDistorted) {
    results.graham = { value: r.grahamNumber, note: 'sqrt(22.5 x EPS x Book Value per Share)' }
  }

  // ── EV / Operating Profit ─────────────────────────────────────────────────────
  if (isApplicable('evGrossProfit', modelMeta) && r.opProfit > 0 && r.shares) {
    const impliedEV = r.opProfit * 8
    const perShare  = (impliedEV + (r.cash || 0) - (r.totalDebt || 0)) / r.shares
    if (perShare > 0) results.evGrossProfit = { value: perShare, note: 'Op.Profit × 8×' }
  }

  // ── Weighted consensus ────────────────────────────────────────────────────────
  const weights   = { dcf: 3, pe: 2, evEbitda: 2, pb: 1.5, ps: 1, graham: 1, evGrossProfit: 1 }
  const validKeys = modelMeta.applicable.filter(m => results[m]?.value > 0)
  const totalW    = validKeys.reduce((s, m) => s + (weights[m] || 1), 0)
  const fairValue = totalW > 0
    ? validKeys.reduce((s, m) => s + results[m].value * (weights[m] || 1), 0) / totalW
    : null

  const modelValues = validKeys.map(m => results[m].value)
  const rangeLow    = modelValues.length > 1 ? Math.min(...modelValues) : fairValue
  const rangeHigh   = modelValues.length > 1 ? Math.max(...modelValues) : fairValue

  const upside = fairValue != null && r.price > 0
    ? ((fairValue - r.price) / r.price) * 100 : null

  const signal = upside == null ? 'UNKNOWN'
    : upside > 15  ? 'UNDERVALUED'
    : upside < -15 ? 'OVERVALUED'
    : 'FAIRLY_VALUED'

  // ── Reverse DCF ───────────────────────────────────────────────────────────────
  let impliedGrowth = null
  const cfForRev = r.fcf > 0 ? r.fcf : r.opCF > 0 ? r.opCF * 0.7 : null
  if (cfForRev && r.price > 0 && r.shares) {
    const targetEV = r.price * r.shares + (r.totalDebt || 0) - (r.cash || 0)
    impliedGrowth  = solveGrowth(cfForRev, targetEV, wacc, termGrowth, projYears)
  }

  return {
    models: results,
    modelMeta,
    fairValue,
    rangeLow,
    rangeHigh,
    upside,
    signal,
    impliedGrowth,
    assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb },
    // Store defaults so UI can show them and reset to them
    defaults: { wacc: 0.10, termGrowth: 0.03, projYears: 10, growthRate: estimateGrowth(r), sectorPe: sectorPeDefault, sectorEvEb: sectorEvEbDefault }
  }
}

function isApplicable(m, meta) { return meta.applicable.includes(m) || meta.caution.includes(m) }

function estimateGrowth(r) {
  const g = r.ratios?.revCagr?.value != null      ? r.ratios.revCagr.value / 100
    : r.ratios?.revGrowthYoY?.value != null ? r.ratios.revGrowthYoY.value / 100
    : 0.08
  return Math.max(Math.min(g, 0.35), 0.02)
}

function clamp(v, min, max) { return v == null ? null : Math.max(min, Math.min(max, v)) }

function solveGrowth(fcf0, tEV, wacc, tg, yrs) {
  let lo = -0.2, hi = 0.6
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const ev  = dcfEV(fcf0, mid, wacc, tg, yrs)
    if (Math.abs(ev - tEV) < 1e5) break
    ev > tEV ? (hi = mid) : (lo = mid)
  }
  return ((lo + hi) / 2) * 100
}

function dcfEV(f, g, w, tg, yrs) {
  let pv = 0, cf = f
  for (let i = 1; i <= yrs; i++) {
    cf *= (1 + Math.max(g * Math.pow(0.85, i - 1), tg))
    pv += cf / Math.pow(1 + w, i)
  }
  return pv + (cf * (1 + tg)) / (w - tg) / Math.pow(1 + w, yrs)
}
