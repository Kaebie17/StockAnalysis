
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
    // 'financingprofit' — Screener's own label for this line on bank/NBFC P&Ls
    // (Revenue − Interest − Expenses). It's the direct analog of Operating
    // Profit there; "Operating Profit"/"EBIT"/"PBDIT" simply never appear on a
    // financial company's statement.
    screener: ['operatingprofit', 'ebit', 'operatingincome', 'profitfromoperations', 'pbdit', 'financingprofit'],
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
  // otherIncome and the two exceptional-items lines exist to feed the
  // per-year normalization derivation (dataQuality.js's normaliseIncome) —
  // NOT flagged as missing base data (base: false) when absent, because
  // most years genuinely have none; a blank year here is the normal case,
  // not a gap.
  otherIncome: {
    table: 'income', label: 'Other Income', base: false,
    yahoo: ['totalOtherIncomeExpenseNet', 'otherIncomeExpense'],
    sec: [],
    screener: ['otherincome'],
    expandFrom: null,          // visible on Screener's default P&L, no expansion needed
    ar: [/other income/i],
    csv: ['otherIncome'],
    needs: 'exceptional-items normalization',
  },
  // Not itself part of the normalization math, but without it dataQuality.js's
  // effective-tax-rate estimate (used to convert a PRE-tax exceptional figure
  // to its after-tax impact) has nothing to work from and falls back to
  // removing the item gross — overstating the correction by the tax on it.
  // A plain visible Screener row, no expansion needed.
  profitBeforeTax: {
    table: 'income', label: 'Profit Before Tax', base: false,
    yahoo: ['pretaxIncome'], sec: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest'],
    screener: ['profitbeforetax', 'pbt'],
    expandFrom: null,
    ar: [/profit before tax/i, /\bPBT\b/],
    csv: ['profitBeforeTax', 'pbt'],
    needs: 'accurate after-tax normalization of a pre-tax exceptional item',
  },
  // Screener's own P&L row is "Tax %" (a percent of profitBeforeTax, per
  // pctOf below — same handling as cogs's "Material Cost %"), not an
  // absolute figure. Wasn't tracked as its own field before — a plain "Tax %"
  // paste went unmatched — even though NormalizeModal's manual-correction
  // tool already had a 'tax' line to set (reconstructRow). Added now mainly
  // as a normalization target (the historical-normalization restatement
  // tool needs it), which also happens to close that pre-existing gap.
  tax: {
    table: 'income', label: 'Tax', base: false,
    yahoo: ['taxProvision'], sec: ['IncomeTaxExpenseBenefit'],
    screener: ['tax', 'taxpercent'],
    pctOf: 'profitBeforeTax',
    expandFrom: null,
    ar: [/\btax\b/i, /provision for tax/i],
    csv: ['tax', 'taxExpense'],
    needs: 'net profit reconciliation, normalized tax rate',
  },
  exceptionalItems: {
    table: 'income', label: 'Exceptional Items', base: false,
    yahoo: [], sec: [],
    screener: ['exceptionalitems', 'exceptionalitem'],
    // Pre-tax figure, revealed by expanding OTHER INCOME (not Profit before
    // tax — corrected per confirmed Screener layout). exceptionalItemsAT and
    // profitExclExceptional (below) are preferred over deriving from this
    // when present, since both sidestep this app's own tax-rate estimate.
    expandFrom: 'Other Income',
    ar: [/exceptional items?/i, /extraordinary items?/i],
    csv: ['exceptionalItems'],
    needs: 'per-year normalization (pre-tax; see exceptionalItemsAT)',
  },
  // The rest of this group is revealed by expanding NET PROFIT, not Other
  // Income — Screener's full waterfall from consolidated profit down to
  // what EPS is actually based on. A company with associates/minority
  // interests (e.g. Airtel) needs this whole chain, not just the
  // exceptional-item figure, because Net Profit − exceptionalItemsAT alone
  // silently assumes minority interest's share of the exceptional item is
  // zero — an assumption dataQuality.js has no way to check. Where Screener
  // directly discloses "excluding exceptional items," that number has
  // already resolved this correctly whatever Airtel's actual waterfall
  // order is; deriving it ourselves via subtraction does not need to.
  exceptionalItemsAT: {
    table: 'income', label: 'Exceptional Items (After Tax)', base: false,
    yahoo: [], sec: [],
    screener: ['exceptionalitemsat', 'exceptionalitemat', 'exceptionalitemsaftertax'],
    expandFrom: 'Net Profit',
    ar: [/exceptional items?.*after tax/i, /exceptional items?.*\(at\)/i],
    csv: ['exceptionalItemsAT'],
    needs: 'per-year normalization fallback when profitExclExceptional is absent',
  },
  profitExclExceptional: {
    table: 'income', label: 'Profit excl. Exceptional Items', base: false,
    yahoo: [], sec: [],
    screener: ['profitexclexcep', 'profitexcludingexceptionalitems', 'profitexclexceptional'],
    expandFrom: 'Net Profit',
    ar: [/profit excl(?:uding)?\.? exceptional/i],
    csv: ['profitExclExceptional'],
    // Primary source for the normalized netProfit: Screener has already
    // resolved the associates/minority-interest ordering correctly, whatever
    // it is for this specific company — see the group comment above.
    needs: 'per-year normalization (preferred over deriving via subtraction)',
  },
  profitForEPS: {
    table: 'income', label: 'Profit for EPS', base: false,
    yahoo: [], sec: [],
    screener: ['profitforeps'],
    expandFrom: 'Net Profit',
    ar: [/profit for eps/i],
    csv: ['profitForEPS'],
    needs: 'confirms which profit figure EPS is actually based on',
  },
  profitForPE: {
    table: 'income', label: 'Profit for PE', base: false,
    yahoo: [], sec: [],
    screener: ['profitforpe'],
    expandFrom: 'Net Profit',
    ar: [/profit for pe/i],
    csv: ['profitForPE'],
    needs: 'confirms which profit figure the P/E ratio is actually based on',
  },
  profitFromAssociates: {
    table: 'income', label: 'Profit from Associates', base: false,
    yahoo: [], sec: [],
    screener: ['profitfromassociates', 'shareofprofitofassociates'],
    expandFrom: 'Net Profit',
    ar: [/profit from associates/i, /share of profit of associates/i],
    csv: ['profitFromAssociates'],
    needs: 'context for the Net Profit waterfall on a company with associates',
  },
  minorityInterest: {
    table: 'income', label: 'Minority Share', base: false,
    yahoo: ['minorityInterest'], sec: ['MinorityInterest'],
    screener: ['minorityshare', 'minorityinterest', 'noncontrollinginterest'],
    expandFrom: 'Net Profit',
    ar: [/minority (?:share|interest)/i, /non-?controlling interest/i],
    csv: ['minorityInterest'],
    needs: 'context for the Net Profit waterfall on a company with non-wholly-owned subsidiaries',
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

  dividendPayout: {
    table: 'income', label: 'Dividend Payout %', base: false,
    yahoo: ['payoutRatio'],
    sec: [],
    // Screener prints this as a percent ("Dividend Payout %"). It's already a
    // ratio, not an absolute — captured as-is, no pctOf conversion.
    screener: ['dividendpayout', 'dividendpayout%', 'payoutratio', 'payout'],
    expandFrom: null,
    ar: [/dividend payout/i, /payout ratio/i],
    csv: ['dividendPayout', 'payoutRatio'],
    needs: 'justified dividend multiple',
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
  // Screener has no current/non-current split to supply these from — Indian
  // Schedule III disclosure doesn't present one the way US GAAP does — so
  // this stays a Yahoo/SEC-only field permanently, same standing grossProfit
  // has for an Indian ticker (no source line ever, not a gap to chase). Not
  // currently read by any calculation, but tracked in the one dictionary
  // like everything else so it's visible in the data table whenever a
  // source does supply it, rather than existing only as an ad-hoc field a
  // couple of ingestion functions happened to write.
  currentAssets: {
    table: 'balance', label: 'Current Assets', base: false,
    yahoo: ['currentAssets', 'totalCurrentAssets'],
    sec: ['AssetsCurrent'],
    screener: [],
    expandFrom: null,
    ar: [/total current assets/i],
    csv: ['currentAssets'],
    needs: 'a rough liquidity check when the granular working-capital breakdown isn\'t available',
  },
  currentLiabilities: {
    table: 'balance', label: 'Current Liabilities', base: false,
    yahoo: ['currentLiabilities', 'totalCurrentLiabilities'],
    sec: ['LiabilitiesCurrent'],
    screener: [],
    expandFrom: null,
    ar: [/total current liabilities/i],
    csv: ['currentLiabilities'],
    needs: 'a rough liquidity check when the granular working-capital breakdown isn\'t available',
  },

  // Operating net working capital group — same "Other Assets +"/"Other
  // Liabilities +" expansions as cash above, confirmed against a real
  // Screener pull (Bharti Airtel, consolidated). These four are unambiguous
  // operating items — netWorkingCapital = tradeReceivables + inventories −
  // tradePayables − advanceFromCustomers, no review needed.
  //
  // Screener's OTHER sub-items in the same two expansions — Loans n
  // Advances, Other asset items, Other liability items — are deliberately
  // NOT tracked here. They looked like a review-once-per-ticker problem at
  // first (operating vs. non-operating, ambiguous by label), but checking
  // against a real AR turned up something worse: Screener's own total for
  // that catch-all doesn't reconcile with what the company actually
  // discloses at all — one non-operating item alone (an indemnification
  // asset) was multiple times larger than Screener's entire bucket. That's
  // a coverage gap, not a classification question, and no include/exclude
  // toggle fixes a number that was never captured in the first place.
  // Getting that right needs the actual AR note pasted through the
  // restatement tool, not a field tracked here.
  tradeReceivables: {
    table: 'balance', label: 'Trade Receivables', base: false,
    yahoo: ['receivables', 'accountsReceivable'], sec: ['AccountsReceivableNetCurrent'],
    screener: ['tradereceivables', 'receivables', 'sundrydebtors'],
    expandFrom: 'Other Assets',
    ar: [/trade receivables/i, /sundry debtors/i],
    csv: ['tradeReceivables', 'receivables'],
    needs: 'operating net working capital',
  },
  inventories: {
    table: 'balance', label: 'Inventories', base: false,
    yahoo: ['inventory'], sec: ['InventoryNet'],
    screener: ['inventories', 'inventory', 'stockintrade'],
    expandFrom: 'Other Assets',
    ar: [/inventories/i, /stock.?in.?trade/i],
    csv: ['inventories', 'inventory'],
    needs: 'operating net working capital',
  },
  tradePayables: {
    table: 'balance', label: 'Trade Payables', base: false,
    yahoo: ['accountsPayable'], sec: ['AccountsPayableCurrent'],
    screener: ['tradepayables', 'payables', 'sundrycreditors'],
    expandFrom: 'Other Liabilities',
    ar: [/trade payables/i, /sundry creditors/i],
    csv: ['tradePayables', 'payables'],
    needs: 'operating net working capital',
  },
  advanceFromCustomers: {
    table: 'balance', label: 'Advance from Customers', base: false,
    yahoo: [], sec: ['ContractWithCustomerLiabilityCurrent'],
    // 'deferredrevenue' added after checking a real AR against Screener:
    // Screener's own advance-from-customers figure read as 0 every year for
    // a company whose AR disclosed a large, genuinely operating deferred-
    // revenue balance — same Ind AS 115 contract-liability concept, just a
    // different label the original alias list didn't cover.
    screener: ['advancefromcustomers', 'contractliabilities', 'deferredrevenue'],
    expandFrom: 'Other Liabilities',
    ar: [/advance(?:s)? from customers?/i, /contract liabilit(?:y|ies)/i, /deferred revenue/i],
    csv: ['advanceFromCustomers'],
    needs: 'operating net working capital',
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
  // Screener's own "Working capital changes" line, under the SAME "+" as
  // operatingCF. Deliberately a SEPARATE field from the balance-sheet-
  // derived netWorkingCapital above, not a substitute for it — this is the
  // actual historical cash-flow impact of working-capital movement in a
  // given year (real cash, not something to normalize away), useful for
  // explaining CFO and flagging unusual years. The forward change-in-working-
  // capital assumption is built from netWorkingCapital's year-over-year
  // level instead, never from this line — see the historical-normalization
  // plan.
  changeInWC: {
    table: 'cashflow', label: 'Working Capital Changes', base: false,
    yahoo: ['changeInWorkingCapital'], sec: [],
    screener: ['workingcapitalchanges'],
    expandFrom: 'Cash from Operating Activity',
    ar: [/working capital changes?/i, /change(?:s)? in working capital/i],
    csv: ['changeInWC'],
    needs: 'historical CFO reconciliation, unusual-year detection',
  },
  capex: {
    table: 'cashflow', label: 'CapEx (fixed assets purchased)', base: true,
    // Yahoo files this NEGATIVE (an outflow); SEC files it positive; Screener's
    // own cash-flow-statement row is negative too (an outflow, same convention
    // as the rest of that statement). The app's own convention is different
    // from all three sources AND from otherIncome-style fields: capex is a
    // spend MAGNITUDE, not a signed economic quantity — unlike otherIncome,
    // where negative genuinely means a loss, a negative capex has no
    // sensible meaning here. It's always stored positive so
    // freeCashFlow = operatingCF - capex works regardless of source; a
    // negative value reaching that subtraction would ADD the spend back
    // instead of removing it, overstating FCF (and everything downstream:
    // FCF yield/conversion, DCF, reverse-DCF, justified multiples).
    // alwaysPositive: true drives every ingestion path (paste, auto-scrape,
    // direct cell edit in the data table) to enforce this the same way the
    // Yahoo path already did on its own, inline, below.
    alwaysPositive: true,
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
  // Quarterly P&L — the same rows as `income`, but one column per quarter. Read
  // through the income aliases (see ALIASES in pasteParser) rather than getting
  // its own metric definitions, because the rows genuinely are the same rows.
  // annual:false exempts it from the "this looks quarterly" rejection, which is
  // the whole point: here quarterly IS the expected shape.
  quarterly: { label: 'Quarterly Results', annual: false,
              signature: ['revenue', 'operatingProfit', 'netProfit', 'interest', 'depreciation', 'eps'] },
  // Shareholding is quarterly BY NATURE — exempt from the annual check.
  shareholding: { label: 'Shareholding', annual: false, signature: [] },
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Screener row aliases for one statement, in the shape the parser wants. */
export function screenerAliases(table) {
  // Quarterly Results IS the P&L, just sliced by quarter — it has no metric
  // definitions of its own, and shouldn't: duplicating them would mean two
  // places to update every time a Screener row label changes.
  const t = table === 'quarterly' ? 'income' : table
  const out = {}
  for (const [key, m] of Object.entries(METRICS)) {
    if (m.table === t && m.screener?.length) out[key] = m.screener
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



