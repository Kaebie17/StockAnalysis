
/**
 * src/engine/stage.js
 *
 * Detects:
 *   1. Company stage: PRE_REVENUE / GROWTH / TRANSITION / ESTABLISHED
 *   2. Sector type: STANDARD / FINANCIAL / INSURANCE / BANK / NBFC
 *
 * Sector type determines which valuation models apply and
 * which field names to use for revenue (premium income for insurance,
 * net interest income for banks, etc.)
 */

export const STAGES = {
  PRE_REVENUE:  { label: 'Pre-Revenue',    emoji: '🌱', desc: 'Little or no revenue yet' },
  GROWTH:       { label: 'Growth/Scaling', emoji: '🚀', desc: 'Rapid revenue growth, margins expanding' },
  TRANSITION:   { label: 'Transition',     emoji: '🔄', desc: 'Moving from growth to profitability' },
  ESTABLISHED:  { label: 'Established',    emoji: '🏛️',  desc: 'Mature, stable cash flows' }
}

export const SECTOR_TYPES = {
  STANDARD:  'standard',
  BANK:      'bank',
  NBFC:      'nbfc',
  INSURANCE: 'insurance',
  // Businesses whose earnings or asset base make a P/E-on-current-earnings
  // valuation structurally wrong rather than merely imprecise.
  CYCLICAL:  'cyclical',    // commodity-linked: current EPS is a cycle position
  CAPITAL_INTENSIVE: 'capital-intensive',  // heavy D&A distorts net margin
  REALTY:    'realty',      // lumpy project revenue; value sits in the asset base
  HOLDING:   'holding',     // value is the sum of stakes, not consolidated EPS
  YIELD:     'yield',       // REITs/InvITs: valued on distributions
}

// Commodity and commodity-linked: earnings swing with a price the company
// doesn't set, so the latest year says where the cycle is, not what the business
// earns through one.
const CYCLICAL_KEYWORDS = [
  'metal', 'steel', 'aluminium', 'aluminum', 'copper', 'zinc', 'mining', 'iron ore',
  'cement', 'commodity chemical', 'fertiliser', 'fertilizer', 'sugar', 'paper',
  'shipping', 'petrochemical', 'refin', 'crude',
]

// Heavy depreciation makes net margin a poor guide; these are conventionally
// valued on EV/EBITDA.
const CAPITAL_INTENSIVE_KEYWORDS = [
  'telecom', 'telecommunication', 'wireless', 'tower', 'data center', 'data centre',
  'airline', 'airport', 'port', 'toll', 'highway', 'infrastructure', 'pipeline',
]

const REALTY_KEYWORDS = ['real estate', 'realty', 'property developer', 'housing development']
const HOLDING_KEYWORDS = ['holding compan', 'investment compan', 'conglomerate']
const YIELD_KEYWORDS = ['reit', 'invit', 'infrastructure trust', 'real estate investment trust']

// Known insurance tickers on NSE/Yahoo
const INSURANCE_TICKERS = new Set([
  'LICI', 'LICI.NS', 'LICI.BO',
  'SBILIFE', 'SBILIFE.NS', 'HDFCLIFE', 'HDFCLIFE.NS',
  'ICICIPRULI', 'ICICIPRULI.NS', 'STARHEALTH', 'STARHEALTH.NS',
  'NIACL', 'NIACL.NS', 'GICRE', 'GICRE.NS', 'ICICIGI', 'ICICIGI.NS',
  'POLICYBZR', 'POLICYBZR.NS'
])

const BANK_KEYWORDS   = ['bank', 'banking']
// 'credit services' is Yahoo's actual GICS-style industry label for most Indian
// NBFCs (confirmed for Bajaj Finance) — it doesn't contain "finance", so the
// original list never matched it. 'consumer finance' / 'specialty finance' cover
// the other common labels for this group.
const NBFC_KEYWORDS   = ['finance', 'financial', 'housing finance', 'microfinance',
                          'lending', 'credit services', 'consumer finance', 'specialty finance']
const INSURANCE_KEYWORDS = ['insurance', 'life insur', 'general insur', 'reinsur']

export function detectSectorType(data) {
  const ticker   = (data.ticker || '').toUpperCase()
  const sector   = (data.meta?.sector   || '').toLowerCase()
  const industry = (data.meta?.industry || '').toLowerCase()
  const name     = (data.name           || '').toLowerCase()

  if (INSURANCE_TICKERS.has(ticker)) return SECTOR_TYPES.INSURANCE
  if (INSURANCE_KEYWORDS.some(k => industry.includes(k) || name.includes(k))) return SECTOR_TYPES.INSURANCE
  if (BANK_KEYWORDS.some(k => industry.includes(k) || sector.includes(k)))    return SECTOR_TYPES.BANK
  // Also checked against `name`, not just `industry`: Yahoo's industry taxonomy
  // for Indian NBFCs is inconsistent (see 'credit services' above), but the
  // company's own name is a far more reliable tell — "Bajaj Finance Limited",
  // "Cholamandalam Investment and Finance", "Shriram Finance" etc. all say so
  // directly even when Yahoo's industry bucket doesn't.
  if (NBFC_KEYWORDS.some(k => industry.includes(k) || name.includes(k)))     return SECTOR_TYPES.NBFC

  // Checked after the financial types (a housing-finance company is an NBFC
  // first) and before STANDARD, since each needs a different valuation method.
  const hay = `${industry} ${sector} ${name}`
  if (YIELD_KEYWORDS.some(k => hay.includes(k)))   return SECTOR_TYPES.YIELD
  if (HOLDING_KEYWORDS.some(k => hay.includes(k))) return SECTOR_TYPES.HOLDING
  if (REALTY_KEYWORDS.some(k => hay.includes(k)))  return SECTOR_TYPES.REALTY
  if (CYCLICAL_KEYWORDS.some(k => hay.includes(k))) return SECTOR_TYPES.CYCLICAL
  if (CAPITAL_INTENSIVE_KEYWORDS.some(k => hay.includes(k))) return SECTOR_TYPES.CAPITAL_INTENSIVE

  return SECTOR_TYPES.STANDARD
}

export function detectStage(data, ratioResult) {
  const inc = data.incomeHistory || []
  const rev = ratioResult?.revenue

  if (!rev || rev <= 0) return 'PRE_REVENUE'

  // Use the recent 5-yr CAGR (stable), not the full-span one.
  const cagr = ratioResult?.ratios?.revCagr5y?.value ?? ratioResult?.ratios?.revCagr?.value
  const netMargin = ratioResult?.ratios?.netMargin?.value
  const roe = ratioResult?.ratios?.roe?.value

  // Is the company CONSISTENTLY profitable? A thin margin alone must NOT be read
  // as "not yet profitable" — a low-margin business (e.g. EMS/retail) can be very
  // profitable on capital (high ROE) and have a long record of positive profit.
  const npYears = inc.map(y => y?.netProfit?.value).filter(v => v != null)
  const recent  = npYears.slice(-4)
  const positiveCount = recent.filter(v => v > 0).length
  const consistentlyProfitable =
    (recent.length >= 3 && positiveCount >= recent.length - 1 && (recent[recent.length - 1] ?? 0) > 0) ||
    (netMargin != null && netMargin > 0 && roe != null && roe >= 12)

  // GROWTH = fast growth AND not yet consistently profitable (a genuine early-stage
  // scale-up burning toward profit). Multiples-on-revenue lens, no P/E.
  if (cagr != null && cagr > 25 && !consistentlyProfitable) return 'GROWTH'

  // TRANSITION = still growing FAST but PROFITABLE, just not at mature margins.
  // Requires genuinely high growth (Dixon ~40%), not merely above-average — a
  // mature low-margin business (Reliance ~12% growth, ~8% margin) is NOT
  // transitioning, it's established, so it must not trip this.
  if (cagr != null && cagr > 22 && consistentlyProfitable && (netMargin == null || netMargin < 10)) return 'TRANSITION'

  // ESTABLISHED = mature, stable business (default for profitable, non-hypergrowth
  // names regardless of margin level).
  return 'ESTABLISHED'
}

/**
 * Which valuation models are applicable for a given stage + sector type.
 * Returns: { applicable: [...], caution: [...], notApplicable: [...] }
 */
export function getApplicableModels(stage, sectorType) {
  if (sectorType === SECTOR_TYPES.INSURANCE) {
    return {
      applicable:    ['pe', 'pb'],
      caution:       ['ps'],
      notApplicable: ['dcf', 'evEbitda', 'graham', 'evGrossProfit'],
      note: 'Insurance companies use P/E and P/B as primary valuation metrics. DCF and EV/EBITDA are not applicable.'
    }
  }
  if (sectorType === SECTOR_TYPES.BANK || sectorType === SECTOR_TYPES.NBFC) {
    return {
      applicable:    ['pe', 'pb'],
      caution:       ['ps'],
      notApplicable: ['dcf', 'evEbitda', 'graham', 'evGrossProfit'],
      note: 'Banks and NBFCs are valued on P/E and P/B. EV-based models are not meaningful for leveraged financial institutions.'
    }
  }

  // Standard industrial/tech/consumer companies by stage
  switch (stage) {
    case 'PRE_REVENUE':
      return {
        applicable:    ['ps', 'evGrossProfit'],
        caution:       ['dcf'],
        notApplicable: ['pe', 'evEbitda', 'pb', 'graham'],
        note: 'Pre-revenue: P/S and EV/Gross Profit most relevant. DCF range is very wide.'
      }
    case 'GROWTH':
      return {
        applicable:    ['ps', 'evGrossProfit', 'evEbitda', 'peg'],
        caution:       ['dcf'],
        notApplicable: ['pe', 'graham', 'pb'],
        note: 'Growth stage: revenue-based multiples most relevant. P/E not meaningful yet.'
      }
    case 'TRANSITION':
      return {
        applicable:    ['evEbitda', 'ps', 'pe', 'dcf', 'peg'],
        caution:       ['graham'],
        notApplicable: ['evGrossProfit'],
        note: 'Transitioning to profitability: blend of revenue and earnings-based models.'
      }
    case 'ESTABLISHED':
    default:
      return {
        applicable:    ['dcf', 'pe', 'evEbitda', 'pb', 'graham'],
        caution:       ['ps'],
        notApplicable: ['evGrossProfit'],
        note: 'Established: full suite of valuation models applicable.'
      }
  }
}





