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
  INSURANCE: 'insurance'
}

// Known insurance tickers on NSE/Yahoo
const INSURANCE_TICKERS = new Set([
  'LICI', 'LICI.NS', 'LICI.BO',
  'SBILIFE', 'SBILIFE.NS', 'HDFCLIFE', 'HDFCLIFE.NS',
  'ICICIPRULI', 'ICICIPRULI.NS', 'STARHEALTH', 'STARHEALTH.NS',
  'NIACL', 'NIACL.NS', 'GICRE', 'GICRE.NS', 'ICICIGI', 'ICICIGI.NS',
  'POLICYBZR', 'POLICYBZR.NS'
])

const BANK_KEYWORDS   = ['bank', 'banking']
const NBFC_KEYWORDS   = ['finance', 'financial', 'housing finance', 'microfinance', 'lending']
const INSURANCE_KEYWORDS = ['insurance', 'life insur', 'general insur', 'reinsur']

export function detectSectorType(data) {
  const ticker   = (data.ticker || '').toUpperCase()
  const sector   = (data.meta?.sector   || '').toLowerCase()
  const industry = (data.meta?.industry || '').toLowerCase()
  const name     = (data.name           || '').toLowerCase()

  if (INSURANCE_TICKERS.has(ticker)) return SECTOR_TYPES.INSURANCE
  if (INSURANCE_KEYWORDS.some(k => industry.includes(k) || name.includes(k))) return SECTOR_TYPES.INSURANCE
  if (BANK_KEYWORDS.some(k => industry.includes(k) || sector.includes(k)))    return SECTOR_TYPES.BANK
  if (NBFC_KEYWORDS.some(k => industry.includes(k)))                           return SECTOR_TYPES.NBFC
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

  // TRANSITION = still growing quickly but PROFITABLE, just not at mature margins.
  // (Dixon-type: ~40% growth, thin ~3% margin, strong ROE, steady profits.) P/E
  // becomes usable again here, alongside revenue multiples.
  if (cagr != null && cagr > 12 && (netMargin == null || netMargin < 12)) return 'TRANSITION'

  // ESTABLISHED = mature, stable, healthy-margin business.
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
        applicable:    ['ps', 'evGrossProfit', 'evEbitda'],
        caution:       ['dcf'],
        notApplicable: ['pe', 'graham', 'pb'],
        note: 'Growth stage: revenue-based multiples most relevant. P/E not meaningful yet.'
      }
    case 'TRANSITION':
      return {
        applicable:    ['evEbitda', 'ps', 'pe', 'dcf'],
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


