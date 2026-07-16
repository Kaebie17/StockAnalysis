/**
 * src/engine/metrics.js — THE metric dictionary.
 *
 * One entry per metric. Every source's vocabulary for that metric lives on the
 * entry, so anything that needs to look a metric up in ANY source reads it from
 * here. Previously this knowledge was spread across six lists that didn't know
 * about each other:
 *
 *   pasteParser ALIASES      (Screener row labels)
 *   api/screener.js x3       (duplicate Screener labels + column positions)
 *   normalize.js pick(...)   (Yahoo field names, inline, not even a list)
 *   api/sec.js CONCEPTS      (us-gaap tags)
 *   arExtract SECTION_CONFIG (annual-report phrasings)
 *   csv.js col(...)          (CSV headers)
 *
 * Because none of them could see each other, nothing could answer "cash is
 * missing — what does each source call it?". That is why the AR reader only ever
 * hunted for material cost: no list could tell it what else to hunt for.
 *
 * FIELD GUIDE
 *   table      which statement it belongs to
 *   label      human name, used in gap prompts
 *   base       true = an irreducible input. false = the engine derives it.
 *   yahoo      fundamentalsTimeSeries keys, in preference order
 *   sec        us-gaap tags, in preference order
 *   screener   Screener row labels (normalized: lowercase, alphanumeric only)
 *   expandFrom Screener row you must click "+" on to reveal this. null = visible.
 *   ar         annual-report phrasings for the document reader
 *   csv        accepted CSV headers
 *   needs      what breaks without it — shown in the gap prompt
 */

export const METRICS = {
  // ── Income ────────────────────────────────────────────────────────────────
  revenue: {
    table: 'income', label: 'Revenue', base: true,
    yahoo: ['totalRevenue', 'operatingRevenue'],
    sec: ['RevenueFromContractWithCustomerExcludingAssessedTax',
          'RevenueFromContractWithCustomerIncludingAssessedTax',
          'Revenues', 'SalesRevenueNet', 'SalesRevenueGoodsNet',
          'RevenuesNetOfInterestExpense', 'InterestAndDividendIncomeOperating'],
    screener: ['sales', 'revenue', 'totalrevenue', 'netsales', 'incomefromoperations',
               'revenuefromoperations', 'premiumearned', 'interestearned', 'totalinterestearned'],
    expandFrom: null,
    ar: [/revenue from operations/i, /\btotal (?:revenue|income)\b/i, /\bnet sales\b/i],
    csv: ['revenue', 'sales', 'totalRevenue'],
    needs: 'every margin, growth rate and multiple',
  },
  cogs: {
    table: 'income', label: 'Cost of materials / COGS', base: true,
    yahoo: ['costOfRevenue', 'reconciledCostOfRevenue'],
    sec: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'],
    // Screener may print this EITHER as "Material Cost %" (percent of sales) OR
    // as an absolute figure. `pctOf` says what it's a percent OF when the label
    // carries a %. The parser decides from the LABEL, never from the magnitude:
    // "is it under 100?" would read a company with Rs45cr of material cost on
    // Rs1000cr revenue as 45% -> Rs450cr. Ten times wrong, silently.
    screener: ['materialcost', 'costofmaterialsconsumed', 'rawmaterialcost'],
    pctOf: 'revenue',
    expandFrom: 'Expenses',
    ar: [/cost of materials? consumed/i, /raw materials? consumed/i,
         /cost of goods sold/i, /\bCOGS\b/i, /material cost/i],
    csv: ['cogs', 'costOfRevenue', 'costOfGoodsSold', 'materialCost'],
    needs: 'gross margin',
  },
  grossProfit: {
    table: 'income', label: 'Gross Profit', base: true,
    yahoo: ['grossProfit'],
    sec: ['GrossProfit'],
    screener: [],              // Indian P&L has no gross-profit line, ever
    expandFrom: null,
    ar: [/gross profit/i],
    csv: ['grossProfit', 'gross_profit'],
    needs: 'gross margin',
  },
  operatingProfit: {
    table: 'income', label: 'Operating Profit', base: true,
    yahoo: ['operatingIncome', 'totalOperatingIncomeAsReported', 'EBIT'],
    sec: ['OperatingIncomeLoss', 'OperatingIncomeLossIncludingNoncontrollingInterest'],
    screener: ['operatingprofit', 'ebit', 'operatingincome', 'profitfromoperations', 'pbdit'],
    expandFrom: null,
    ar: [/operating profit/i, /profit from operations/i, /\bEBIT\b/],
    csv: ['operatingProfit', 'operatingIncome', 'ebit'],
    needs: 'operating margin, ROCE, EBITDA',
  },
  ebitda: {
    table: 'income', label: 'EBITDA', base: false,   // = operatingProfit + depreciation
    yahoo: ['EBITDA', 'normalizedEBITDA'],
    sec: [],
    screener: [],
    expandFrom: null,
    ar: [/\bEBITDA\b/],
    csv: ['ebitda', 'EBITDA'],
    needs: 'EV/EBITDA, interest coverage',
  },
  depreciation: {
    table: 'income', label: 'Depreciation', base: true,
    yahoo: ['reconciledDepreciation', 'depreciationAndAmortizationInIncomeStatement',
            'depreciationAmortizationDepletionIncomeStatement', 'depreciationIncomeStatement'],
    sec: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'Depreciation'],
    screener: ['depreciation', 'depreciationandamortisation', 'da'],
    expandFrom: null,
    ar: [/depreciation and amorti[sz]ation/i, /\bdepreciation\b/i],
    csv: ['depreciation', 'da'],
    needs: 'EBITDA, ROCE',
  },
  interest: {
    table: 'income', label: 'Interest', base: true,
    yahoo: ['interestExpense', 'interestExpenseNonOperating', 'netNonOperatingInterestIncomeExpense'],
    // InterestIncomeExpenseNet deliberately absent: on a bank it is net interest
    // INCOME, and using it as interest expense inverts interest coverage.
    sec: ['InterestExpense', 'InterestExpenseDebt', 'InterestExpenseNonoperating',
          'InterestExpenseBorrowings', 'InterestAndDebtExpense'],
    screener: ['interest', 'interestexpense', 'financecosts', 'financecost'],
    expandFrom: null,
    ar: [/finance costs?/i, /interest expense/i],
    csv: ['interest', 'financeCost'],
    needs: 'interest coverage',
  },
  netProfit: {
    table: 'income', label: 'Net Profit', base: true,
    yahoo: ['netIncome', 'netIncomeCommonStockholders'],
    sec: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
    screener: ['netprofit', 'profitaftertax', 'pat', 'netincome', 'netearnings'],
    expandFrom: null,
    ar: [/profit (?:for the (?:year|period)|after tax)/i, /net profit/i],
    csv: ['netProfit', 'netIncome', 'pat'],
    needs: 'net margin, ROE, ROA, EPS, P/E',
  },
  eps: {
    table: 'income', label: 'EPS', base: false,      // = netProfit / shares
    yahoo: ['dilutedEPS', 'basicEPS'],
    sec: ['EarningsPerShareDiluted', 'EarningsPerShareBasic'],
    screener: ['epsinrs', 'eps', 'earningspershare', 'basiceps', 'dilutedeps'],
    expandFrom: null,
    ar: [/earnings per share/i, /\bEPS\b/],
    csv: ['eps', 'EPS'],
    needs: 'P/E, Graham number',
  },

  // ── Balance ───────────────────────────────────────────────────────────────
  totalEquity: {
    table: 'balance', label: 'Total Equity', base: true,   // or equityCapital + reserves
    yahoo: ['stockholdersEquity', 'totalEquityGrossMinorityInterest', 'commonStockEquity'],
    sec: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    screener: ['totalequity', 'networth', 'shareholdersfunds', 'shareholdersfund', 'totalshareholdersfunds'],
    expandFrom: null,
    ar: [/total equity/i, /shareholders'? funds/i, /net worth/i],
    csv: ['totalEquity', 'equity', 'netWorth'],
    needs: 'ROE, ROCE, P/B, D/E',
  },
  equityCapital: {
    table: 'balance', label: 'Equity Capital', base: true,
    yahoo: [], sec: [],
    screener: ['equitycapital', 'sharecapital', 'paidupcapital'],
    expandFrom: null,
    ar: [/share capital/i, /equity capital/i],
    csv: ['equityCapital', 'shareCapital'],
    needs: 'total equity (with reserves)',
  },
  reserves: {
    table: 'balance', label: 'Reserves', base: true,
    yahoo: [], sec: [],
    screener: ['reserves', 'reservesandsurplus', 'retainedearnings'],
    expandFrom: null,
    ar: [/reserves and surplus/i, /retained earnings/i],
    csv: ['reserves', 'retainedEarnings'],
    needs: 'total equity (with equity capital)',
  },
  totalDebt: {
    table: 'balance', label: 'Total Debt', base: true,
    yahoo: ['totalDebt', 'longTermDebt', 'longTermDebtAndCapitalLeaseObligation'],
    sec: ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
    screener: ['borrowings', 'totaldebt', 'longtermborrowing', 'debt', 'loans'],
    expandFrom: null,
    ar: [/total borrowings/i, /\bborrowings\b/i],
    csv: ['totalDebt', 'debt', 'borrowings'],
    needs: 'D/E, net debt, EV, ROCE',
    estimable: true,     // equity x D/E
  },
  totalAssets: {
    table: 'balance', label: 'Total Assets', base: true,
    yahoo: ['totalAssets'],
    sec: ['Assets'],
    // Screener labels the balance-sheet total simply "Total" — it appears twice
    // (liabilities+equity, then assets) and both equal total assets.
    screener: ['totalassets', 'total', 'totalequityandliabilities',
               'totalliabilities', 'totalliabilitiesandequity'],
    expandFrom: null,
    ar: [/total assets/i],
    csv: ['totalAssets', 'assets'],
    needs: 'ROA',
  },
  fixedAssets: {
    table: 'balance', label: 'Fixed Assets', base: true,
    yahoo: ['netPPE', 'grossPPE'],
    sec: ['PropertyPlantAndEquipmentNet'],
    // A plain visible row on Screener — no "+" needed.
    screener: ['fixedassets', 'netblock', 'propertyplantandequipment'],
    expandFrom: null,
    ar: [/property,? plant and equipment/i, /fixed assets/i, /net block/i],
    csv: ['fixedAssets', 'netPPE'],
    needs: 'CapEx estimate (Δ Fixed Assets + Depreciation)',
  },
  cash: {
    table: 'balance', label: 'Cash & Equivalents', base: true,
    yahoo: ['cashAndCashEquivalents', 'cashCashEquivalentsAndShortTermInvestments',
            'endCashPosition', 'cashAndCashEquivalentsAtCarryingValue'],
    sec: ['CashAndCashEquivalentsAtCarryingValue',
          'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    // Screener buries cash inside the Other Assets breakup — not a top-level row.
    screener: ['cashequivalents', 'cashandcashequivalents', 'cashandbankbalances'],
    expandFrom: 'Other Assets',
    ar: [/cash and cash equivalents/i, /cash and bank balances/i],
    csv: ['cash', 'cashAndEquivalents'],
    needs: 'net debt, EV, EV/EBITDA, EV/Revenue',
  },

  // ── Cash flow ─────────────────────────────────────────────────────────────
  operatingCF: {
    table: 'cashflow', label: 'Operating Cash Flow', base: true,
    yahoo: ['operatingCashFlow', 'cashFlowFromContinuingOperatingActivities'],
    sec: ['NetCashProvidedByUsedInOperatingActivities',
          'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    screener: ['cashfromoperatingactivity', 'netcashfromoperatingactivities', 'operatingactivities'],
    expandFrom: null,
    ar: [/cash (?:generated )?from operating activities/i, /net cash from operations/i],
    csv: ['operatingCF', 'operatingCashFlow'],
    needs: 'free cash flow, FCF conversion',
  },
  capex: {
    table: 'cashflow', label: 'CapEx (fixed assets purchased)', base: true,
    // Yahoo files this NEGATIVE (an outflow); SEC files it positive. normalize.js
    // stores the absolute magnitude so every source agrees on sign.
    yahoo: ['capitalExpenditure', 'netPPEPurchaseAndSale', 'purchaseOfPPE'],
    sec: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    // Screener hides this inside the Cash from Investing Activity breakup.
    screener: ['fixedassetspurchased', 'purchaseoffixedassets', 'capitalexpenditure'],
    expandFrom: 'Cash from Investing Activity',
    ar: [/purchase of (?:property|fixed assets|plant)/i, /capital expenditure/i, /\bcapex\b/i],
    csv: ['capex', 'capitalExpenditure'],
    needs: 'free cash flow, FCF yield, DCF, reverse-DCF',
    // An estimate exists downstream (see ratios.js), so a missing capex is a SOFT
    // gap — mentioned, not shouted. Real capex still beats the estimate.
    estimable: true,
  },
  freeCashFlow: {
    table: 'cashflow', label: 'Free Cash Flow', base: false,   // = operatingCF - capex
    yahoo: ['freeCashFlow'],
    sec: [],
    screener: ['freecashflow', 'fcf'],
    expandFrom: null,
    ar: [/free cash flow/i],
    csv: ['freeCashFlow', 'fcf'],
    needs: 'FCF yield, FCF conversion, DCF',
    estimable: true,     // opCF - capex, or opCF - depreciation
  },
  investingCF: {
    table: 'cashflow', label: 'Investing Cash Flow', base: true,
    yahoo: [], sec: [],
    screener: ['cashfrominvestingactivity', 'netcashfrominvestingactivities', 'investingactivities'],
    expandFrom: null,
    ar: [/cash (?:used )?(?:in|from) investing activities/i],
    csv: ['investingCF'],
    needs: 'cash roll-forward',
  },
  financingCF: {
    table: 'cashflow', label: 'Financing Cash Flow', base: true,
    yahoo: [], sec: [],
    screener: ['cashfromfinancingactivity', 'netcashfromfinancingactivities', 'financingactivities'],
    expandFrom: null,
    ar: [/cash (?:used )?(?:in|from) financing activities/i],
    csv: ['financingCF'],
    needs: 'cash roll-forward',
  },
}

/**
 * Rows that identify a statement. A paste is checked against these to catch the
 * balance sheet going into the P&L box — the failure a structural check CAN see.
 * We no longer compare pasted numbers against Yahoo: Screener replaces Yahoo, so
 * making Yahoo the arbiter of truth had it backwards. And any row we fail to read
 * is now just a reported gap, not an invented number — so the paste no longer
 * needs a numeric gatekeeper.
 */
export const TABLE_SHAPE = {
  income:   { label: 'Profit & Loss', annual: true,
              signature: ['revenue', 'operatingProfit', 'netProfit', 'interest', 'depreciation', 'eps'] },
  balance:  { label: 'Balance Sheet', annual: true,
              signature: ['totalEquity', 'equityCapital', 'reserves', 'totalDebt', 'totalAssets'] },
  cashflow: { label: 'Cash Flow', annual: true,
              signature: ['operatingCF', 'investingCF', 'financingCF'] },
  // Shareholding is quarterly BY NATURE — exempt from the annual check.
  shareholding: { label: 'Shareholding', annual: false, signature: [] },
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Screener row aliases for one statement, in the shape the parser wants. */
export function screenerAliases(table) {
  const out = {}
  for (const [key, m] of Object.entries(METRICS)) {
    if (m.table === table && m.screener?.length) out[key] = m.screener
  }
  return out
}

/** Yahoo fts key candidates, in preference order. */
export const yahooKeys = key => METRICS[key]?.yahoo ?? []

/** us-gaap tag chain, in preference order. */
export const secTags = key => METRICS[key]?.sec ?? []

/** Accepted CSV headers. */
export const csvHeaders = key => METRICS[key]?.csv ?? []

/**
 * Which Screener "+" rows must be expanded to reveal these metrics.
 * Returns [{ expand, table, metrics:[label], needs:[...] }] — one per "+".
 * Drives the paste-area hint: name the exact rows, and only the ones missing.
 */
export function expandHints(missingKeys, table = null) {
  const byParent = {}
  for (const key of missingKeys) {
    const m = METRICS[key]
    if (!m?.expandFrom) continue
    if (table && m.table !== table) continue
    const id = `${m.table}|${m.expandFrom}`
    if (!byParent[id]) byParent[id] = { expand: m.expandFrom, table: m.table, metrics: [], needs: [] }
    byParent[id].metrics.push(m.label)
    byParent[id].needs.push(m.needs)
  }
  return Object.values(byParent)
}

/**
 * AR/QR keyword config for the metrics still missing after every automatic
 * source has run. This is the residue — NOT a first-load list. The document
 * reader hunts for exactly these instead of only ever looking for material cost.
 */
export function arTargets(missingKeys) {
  return missingKeys
    .filter(k => METRICS[k]?.ar?.length)
    .map(k => ({
      field: k,
      label: METRICS[k].label,
      input: 'number',
      keywords: METRICS[k].ar,
      needs: METRICS[k].needs,
    }))
}

/** The irreducible inputs — the ones no formula can recover. */
export const baseMetrics = () =>
  Object.entries(METRICS).filter(([, m]) => m.base).map(([k]) => k)
