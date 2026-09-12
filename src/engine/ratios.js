

/**
 * src/engine/ratios.js
 *
 * ALL ratios computed from raw normalized data.
 * No ratio is ever taken from a source — sources provide only raw numbers.
 *
 * Each output ratio carries resolution metadata:
 *   { value, status, formula }
 *   status: 'calculated' | 'unavailable'
 *
 * Derivation hierarchy for each ratio:
 *   1. Calculate from historical statement data
 *   2. Mark unavailable — never silently return null, never substitute a
 *      weaker snapshot figure for a genuine gap
 */

/**
 * THE gross-profit formula. One definition, used by calcRatios (latest year) and
 * by moatQuality (the full series). {revenue, cogs, grossProfit} is a group: any
 * two give the third. Sources emit raw fields; this is the only place that knows
 * how they combine.
 */
import { detectSectorType, SECTOR_TYPES } from './stage.js'
import { activeValue } from './dataQuality.js'
import { computeDerivedFormulaForRow } from './formulas.js'

export function grossProfitOf(row, basis) {
  const gp  = row?.grossProfit?.value
  if (gp != null) return gp
  // grossProfit/cogs are never normalization targets themselves, but
  // revenue (the fallback input when grossProfit isn't directly reported)
  // is — same activeValue resolution as everywhere else, so gross margin
  // doesn't silently stay on unrestated revenue while every other margin
  // reflects the current basis.
  const rev = activeValue(row, 'revenue', basis)?.value, cogs = row?.cogs?.value
  return (rev != null && cogs != null) ? rev - cogs : null
}

/**
 * Operating net working capital, for one balance-sheet row — current
 * operating assets minus current operating liabilities, per the "nwc"
 * formula's OWN bucket assignments (formulas.js), not a hardcoded field
 * list. tradeReceivables/inventories/tradePayables/advanceFromCustomers are
 * seeded as its defaults (seedFormulaDefaults) the moment a ticker has
 * balance-sheet data, so this behaves exactly as before for any ticker that
 * hasn't touched the Formulas tab — but a user who's added another current
 * asset/liability row there (or removed a default that didn't apply) is
 * reflected here too, rather than this function silently working off a
 * stale, separate copy of what NWC means.
 * Returns null if either bucket ends up with nothing assigned/valued for
 * this row — no partial sum.
 */
export function netWorkingCapitalOf(data, row) {
  return computeDerivedFormulaForRow(data, 'nwc', row)?.output ?? null
}

export function calcRatios(data, opts = {}) {
  const { price, marketCap: marketCapRaw, shares: sharesRaw,
          reportedIncomeHistory: incomeHistory,
          balanceHistory, cashflowHistory, meta, basis } = data

  // Which ratios even apply is sector-dependent — see NIM below.
  const sectorType = detectSectorType(data)

  // ── Latest-year snapshot (gap-filled across real rows) ──────────────────────
  // The snapshot is anchored on the most recent row; any field still missing
  // there is back-filled from older rows. Two things get filtered out before
  // that "most recent" pick: `synthetic` guards against a fabricated stub row
  // shadowing a real one (normalize.js no longer produces one — the old
  // TTM-only stub was removed — but the guard costs nothing to keep for any
  // row a future source flags the same way); the year-shape check guards
  // against a DIFFERENT source's TTM row that was never flagged synthetic at
  // all — Screener's own page always trails its real fiscal-year columns with
  // one more, literally headed "TTM", and api/screener.js scraped it as an
  // ordinary row (real revenue/netProfit figures, tagged 'source' like any
  // other). Sorted alongside real years, "TTM" lands last no matter how
  // recent the true latest year is ("TTM".localeCompare("2025") > 0, since
  // 'T' > '2'), so it silently became "the latest year" for every ratio here
  // — revenue, netProfit, EPS, every margin — reading a trailing-12-month
  // figure instead of the actual latest fiscal year's.
  const isFiscalYear = r => /^\d{4}$/.test(String(r?.year ?? '').trim())
  const realRows = arr => {
    const real = (arr || []).filter(r => !r.synthetic && isFiscalYear(r))
    return real.length ? real : (arr || []).filter(r => !r.synthetic)
  }
  const coalesceLatest = (arr) => {
    const rows = arr || []
    if (rows.length === 0) return {}
    const real = realRows(rows)
    const base = { ...real[real.length - 1] }                 // most recent real row
    const fill = (row) => {
      for (const k in row) {
        if (k === 'year' || k === 'synthetic') continue
        if (base[k]?.value == null && row[k]?.value != null) base[k] = row[k]
      }
    }
    for (let i = real.length - 2; i >= 0; i--) fill(real[i])   // back-fill from older real rows
    for (const r of rows) if (r.synthetic) fill(r)             // last resort: any flagged stub row
    return base
  }

  const incomeReal  = realRows(incomeHistory)
  const balanceReal = realRows(balanceHistory)

  // Unwrap tagged values from latest year
  const latestI  = coalesceLatest(incomeHistory)
  const prevI    = incomeReal[incomeReal.length - 2]   || {}
  const oldestI  = incomeReal[0]                        || {}
  const latestB  = coalesceLatest(balanceHistory)
  const latestCF = coalesceLatest(cashflowHistory)
  const n        = incomeReal.length - 1

  // Helper: unwrap .value from tagged field
  const val = f => f?.value ?? null
  const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
    return m ? Number(m[0]) : null
  }
  // ── Core raw values ────────────────────────────────────────────────────────
  // revenue/opProfit/depreciation/interest/tax/netProfit/eps/capex are ALL
  // normalization targets (normalizationTargets.js) — the restatement tool
  // can and does write a {field}Normalized sibling for any of them, so every
  // one of them is read through activeValue, not just netProfit/eps. Fields
  // that are never restatement targets (otherIncome, profitBeforeTax,
  // totalEquity, totalDebt, cash, totalAssets, fixedAssets, ...) are read
  // directly, as before — there is no Normalized sibling for those to miss.
  const revenue     = val(activeValue(latestI, 'revenue', basis))
  const opProfit    = val(activeValue(latestI, 'operatingProfit', basis))
  const depreciation= val(activeValue(latestI, 'depreciation', basis))
  const interest    = val(activeValue(latestI, 'interest', basis))
  const netProfit   = val(activeValue(latestI, 'netProfit', basis))
  const otherIncome = val(latestI.otherIncome)
  let pbt = val(latestI.profitBeforeTax) ?? val(latestI.pbt)
  let tax = val(activeValue(latestI, 'tax', basis))
  // Derive-if-missing via the P&L identity — only when absent, never over source.
  if (pbt == null && opProfit != null) {
    pbt = opProfit + (otherIncome || 0) - (interest || 0) - (depreciation || 0)
  }
  if (tax == null && pbt != null && netProfit != null) {
    tax = pbt - netProfit
  }
  // totalEquity: statement only. This used to also derive equity from a TTM
  // D/E ratio or TTM ROE when the statement had no equity line — but both
  // inputs to that derivation came from the same shaky post-migration Yahoo
  // snapshot as everything else TTM touches, so it wasn't a more reliable
  // number, just a more indirect one. Removed rather than kept as the one
  // exception.
  const rawEquity = val(latestB.totalEquity)
  const totalEquity = rawEquity
  // Debt: statement only. `debtEstimated` stays available as general
  // disclosure scaffolding (surfaced in valuation.js/marketExpectation.js)
  // for any future real source of an estimated-debt figure; nothing sets it
  // true anymore now that the TTM-based Equity × D/E derivation is gone —
  // unlike the old `?? 0` this replaced, a genuinely missing debt figure
  // stays missing rather than being fabricated as zero or estimated from a
  // weak source.
  let totalDebt      = val(latestB.totalDebt) ?? null
  let debtEstimated  = false
  // Cash: statement only. No assumed zero.
  //
  // There is no honest estimate for a cash LEVEL. The roll-forward (last year's
  // cash + the three cash flows) is exact but needs a cash balance to start from
  // — and if we had one, cash wouldn't be missing. Nothing else in the statements
  // pins down a level. Assuming nil would silently overstate EV and net debt and
  // understate DCF fair value, which is a wrong valuation, not a cautious one.
  const cash          = val(latestB.cash) ?? null
  const cashEstimated = false
  const opCF        = val(latestCF.operatingCF)

  // CapEx, in order of how much we actually know:
  //   1. reported
  //   2. (Fixed Assets this year − last year) + Depreciation   <- catches GROWTH
  //   3. Depreciation alone                                    <- MAINTENANCE only
  //
  // Rung 3 is owner earnings: what the business throws off if it stops expanding.
  // For a company mid-expansion it OVERSTATES FCF, which overstates fair value
  // and makes the stock look cheap — the dangerous direction. Rung 2 fixes that,
  // because an expanding company's asset base grows and depreciation alone can't
  // see it. Fixed Assets is a plain visible row on Screener, no "+" needed. It
  // misses disposals and revaluations, so it's still an estimate — but of TOTAL
  // capex, not just the maintenance slice.
  //
  // None of these is the old `opCF x 0.7`: that was a constant, identical for
  // every company, measuring nothing.
  const _bRows      = realRows(balanceHistory)
  const prevB       = _bRows[_bRows.length - 2] || {}
  const fixedNow    = val(latestB.fixedAssets)
  const fixedPrev   = val(prevB.fixedAssets)

  let capex      = val(activeValue(latestCF, 'capex', basis))
  let capexBasis = capex != null ? 'reported' : null
  if (capex == null && fixedNow != null && fixedPrev != null && depreciation != null) {
    const c = (fixedNow - fixedPrev) + depreciation
    // negative = net disposals outran additions; don't claim a capex from that
    if (c >= 0) { capex = c; capexBasis = 'delta-fixed-assets' }
  }
  if (capex == null && depreciation != null) { capex = depreciation; capexBasis = 'depreciation' }

  // FCF = Operating CF − CapEx, at whatever rung the CapEx came from. The rung is
  // carried through, because the three are NOT equally trustworthy.
  let fcf = val(latestCF.freeCashFlow)
  let fcfBasis = fcf != null ? 'reported' : null
  if (fcf == null && opCF != null && capex != null) {
    fcf = opCF - capex
    fcfBasis = capexBasis === 'reported'           ? 'derived'
             : capexBasis === 'delta-fixed-assets' ? 'estimated-total'
             : 'estimated-maintenance'
  }
  const fcfEstimated       = fcfBasis === 'estimated-total' || fcfBasis === 'estimated-maintenance'
  const fcfMaintenanceOnly = fcfBasis === 'estimated-maintenance'
  const fcfNote = fcfBasis === 'reported' ? 'Reported Free Cash Flow'
    : fcfBasis === 'derived' ? 'Operating CF − CapEx'
    : fcfBasis === 'estimated-total' ? 'Operating CF − CapEx (CapEx ≈ Δ Fixed Assets + Depreciation)'
    : fcfBasis === 'estimated-maintenance' ? 'Operating CF − Depreciation (maintenance CapEx only — growth CapEx excluded, so FCF is overstated)'
    : null
  FCF_BASIS = { estimated: fcfEstimated, note: fcfNote || 'FCF unavailable' }
  BS_BASIS  = {
    estimated: debtEstimated,
    note: debtEstimated ? 'Debt not reported — estimated from Equity × D/E' : '',
  }
  const totalAssets = val(latestB.totalAssets)
  const fixedAssets = val(latestB.fixedAssets)

  // Shares <-> Market Cap: price x shares = marketCap. Any two give the third.
  //
  // Derived from the RAW inputs, not from each other. The previous version had
  // `shares` read `marketCap` on the line above its own declaration — a const is
  // hoisted but unusable until its line executes, so that threw
  // "Cannot access 'marketCap' before initialization" whenever sharesRaw was
  // absent. It never surfaced because `??` short-circuits when shares ARE
  // present, which is the common case, so the crash waited for a ticker whose
  // share count the source didn't supply.
  const shares    = sharesRaw ?? ((marketCapRaw && price) ? marketCapRaw / price : null)
  const marketCap = marketCapRaw ?? ((price != null && shares != null) ? price * shares : null)

  // EPS: statement → derive
  const epsRaw = val(activeValue(latestI, 'eps', basis))
  const eps = epsRaw ?? calc('Net Profit ÷ Shares', netProfit, shares, (n, s) => n / s)

  // ── EBITDA ─────────────────────────────────────────────────────────────────
  // Priority: direct from source → Op.Profit + Dep → Op.Profit alone
  const ebitdaDirect = val(latestI.ebitda)
  const ebitdaCalc   = opProfit != null && depreciation != null ? opProfit + depreciation : null
  const ebitda       = ebitdaDirect ?? ebitdaCalc ?? opProfit

  const ebitdaStatus = ebitdaDirect  != null ? 'source'
    : ebitdaCalc   != null ? 'calculated'
    : opProfit     != null ? 'proxy'  // using op profit as proxy
    : 'unavailable'
  const ebitdaFormula = ebitdaCalc  != null ? 'Operating Profit + Depreciation'
    : opProfit     != null ? 'Operating Profit (Depreciation unavailable)'
    : null

  // ── Revenue CAGR (single, window-driven) ─────────────────────────────────────
  // ONE growth figure, read by every consumer. Window defaults to 5y, fully
  // settable; supports an optional start-year to exclude a structural break.
  const revSeries = incomeReal
    .map(r => ({ year: yearOf(r), value: val(r.revenue) }))
    .filter(p => p.year != null && p.value > 0)
    .sort((a, b) => a.year - b.year)
  const { cagr: revCagr, windowYears: revCagrWindowYears } = windowedCagr(revSeries, opts)

  // Net-profit CAGR, same window. The "historical earnings CAGR" figure shown
  // in the market-expectation comparison used to actually be npGrowthYoY — a
  // single year's YoY change — labeled "CAGR" even though it wasn't one and
  // never respected the growth-window slider. This is the real multi-year,
  // window-respecting figure.
  const npSeries = incomeReal
    .map(r => ({ year: yearOf(r), value: val(activeValue(r, 'netProfit', basis)) }))
    .filter(p => p.year != null && p.value > 0)
    .sort((a, b) => a.year - b.year)
  const { cagr: npCagr, windowYears: npCagrWindowYears } = windowedCagr(npSeries, opts)

  // ── EV ─────────────────────────────────────────────────────────────────────
  const ev = (marketCap != null && totalDebt != null && cash != null)
    ? marketCap + totalDebt - cash : null

  // ── Margins ────────────────────────────────────────────────────────────────
  // Note: Indian P&L has no "Gross Profit" line — Operating Profit IS the first
  // meaningful margin. We flag grossMargin as "Operating Margin (Indian P&L format)"
  const operatingMargin = pct(opProfit, revenue)
  const ebitdaMargin    = pct(ebitda, revenue)
  const netMargin       = pct(netProfit, revenue)
  // Gross margin — ONE formula, switching on what is available. {revenue, cogs,
  // grossProfit} is a group: any two give the third. Sources emit raw fields only;
  // the derivation lives here, not in api/sec.js or the parser.
  //   1. grossProfit reported      -> calculated
  //   2. revenue - cogs            -> calculated
  //   3. operating-margin proxy    -> ONLY where there is genuinely no COGS line
  //      (Indian P&L). Never on a US filer that simply failed a tag lookup.
  const gpHist          = grossProfitOf(latestI, basis)
  const gpFormula       = val(latestI.grossProfit) != null
    ? 'Gross Profit ÷ Revenue × 100'
    : 'Gross Profit (Revenue − COGS) ÷ Revenue × 100'
  const indianPL        = data.deepSource === 'screener' || data.source === 'screener'
  const grossMargin     = (gpHist != null && revenue)
    ? { value: pct(gpHist, revenue), status: 'calculated', formula: gpFormula }
    : (indianPL && operatingMargin != null)
    ? { value: operatingMargin, status: 'proxy', formula: 'Operating Margin (Indian P&L — no separate Gross Profit line)' }
    : { value: null, status: 'unavailable', formula: null }

  // ── Returns ────────────────────────────────────────────────────────────────
  // ROE = Net Profit / Average Equity × 100
  const prevEquity = val(balanceReal[balanceReal.length - 2]?.totalEquity)
  const avgEquity  = totalEquity != null && prevEquity != null
    ? (totalEquity + prevEquity) / 2 : totalEquity
  const roe  = pct(netProfit, avgEquity)

  // ROCE = EBIT / Capital Employed × 100
  // Capital Employed = Total Assets - Current Liabilities
  // We approximate: Capital Employed = Total Equity + Total Debt (= long-term capital)
  // ROCE = EBIT / Capital Employed × 100  (EBIT = operating profit, i.e. after
  // depreciation — NOT EBITDA, which overstates the return). Prefer reported
  // operating income; else derive EBIT = EBITDA − Depreciation.
  const capitalEmployed = (totalEquity != null && totalDebt != null) ? totalEquity + totalDebt : null

  // ── NIM (Net Interest Margin) — banks / NBFCs only ─────────────────────────
  // The lender's answer to gross margin: what's earned on the SPREAD between
  // lending yield and cost of funds, rather than on a markup over materials.
  // Deliberately gated to financial companies — for a manufacturer this number
  // is meaningless (interest is a financing cost, not a cost of revenue), and
  // showing it anyway would invite reading it as a margin it isn't.
  //
  //   NIM ≈ (interest income − interest expense) / average total assets × 100
  //
  // Two honest approximations, both flagged in the formula string rather than
  // hidden. First, for a financial company Screener's "Revenue" row IS interest
  // income, so `revenue` stands in for it. Second, the textbook denominator is
  // average interest-EARNING assets — a narrower base than total assets, which
  // isn't separable from anything the app currently parses. Total assets is
  // wider, so this reads slightly LOW versus a company's own reported NIM. It's
  // consistent period-over-period, which is what makes the trend readable —
  // it just shouldn't be compared against an investor-deck figure verbatim.
  const isLender   = sectorType === SECTOR_TYPES.BANK || sectorType === SECTOR_TYPES.NBFC
  const prevAssets = val(balanceReal[balanceReal.length - 2]?.totalAssets)
  const avgAssets  = totalAssets != null && prevAssets != null
    ? (totalAssets + prevAssets) / 2 : totalAssets
  const nim = (isLender && revenue != null && interest != null)
    ? pct(revenue - interest, avgAssets) : null
  const ebit = opProfit != null ? opProfit
    : (ebitda != null && depreciation != null) ? ebitda - depreciation
    : ebitda
  const roce = pct(ebit, capitalEmployed)

  // ROA = Net Profit / Total Assets × 100
  const roa  = pct(netProfit, totalAssets)

  // ── Leverage ───────────────────────────────────────────────────────────────
  const netDebt = (totalDebt != null && cash != null) ? totalDebt - cash : null
  const de      = div(totalDebt, totalEquity)           // D/E ratio
  const icr     = div(ebitda, interest)                 // Interest coverage

  // ── Valuation multiples ────────────────────────────────────────────────────
  // All calculated from raw numbers — never from source
  const bookPerShare = div(totalEquity, shares)
  const pe           = div(price, eps)           ?? meta?.pe   // meta.pe = v7 quote (reference)
  const pb           = div(price, bookPerShare)  ?? meta?.pb
  const ps           = div(marketCap, revenue)
  const evEbitda     = div(ev, ebitda)
  const evRevenue    = div(ev, revenue)

  // Graham Number = √(22.5 × EPS × Book Value per Share)
  const grahamNumber = eps > 0 && bookPerShare > 0
    ? Math.sqrt(22.5 * eps * bookPerShare) : null

  // ── FCF metrics ────────────────────────────────────────────────────────────
  const fcfYield      = pct(fcf, marketCap)
  const fcfConversion = pct(fcf, netProfit)

  // ── Growth ─────────────────────────────────────────────────────────────────
  const prevRev    = val(activeValue(prevI, 'revenue', basis))
  const prevNP     = val(activeValue(prevI, 'netProfit', basis))
  const revGrowthYoY = pct(revenue - (prevRev || 0), prevRev)
  const npGrowthYoY  = pct(netProfit - (prevNP || 0), prevNP)

  return {
    // Scalars (used by valuation engine)
    price, marketCap, ev, shares,
    revenue, opProfit, ebitda, netProfit, interest, depreciation,
    totalEquity, totalDebt, cash, netDebt, capitalEmployed, totalAssets,
    opCF, fcf, fcfBasis, fcfEstimated, fcfMaintenanceOnly, capex, capexBasis,
    debtEstimated, cashEstimated,
    bsEstimated: cashEstimated || debtEstimated,
    eps, bookPerShare, grahamNumber,

    // Tagged ratios (used by UI for display + tooltips)
    ratios: {
      // Margins
      grossMargin,
      operatingMargin: tag(operatingMargin, 'calculated', 'Operating Profit ÷ Revenue × 100'),
      ebitdaMargin:    tag(ebitdaMargin,    ebitdaMargin != null ? 'calculated' : 'unavailable', 'EBITDA ÷ Revenue × 100'),
      netMargin:       tag(netMargin,       'calculated', 'Net Profit ÷ Revenue × 100'),
      // Returns
      roe:             tag(roe,             roe != null ? 'calculated' : 'unavailable', 'Net Profit ÷ Avg Equity × 100'),
      roce:            tag(roce,            'calculated', 'EBIT ÷ (Total Equity + Total Debt) × 100'),
      roa:             tag(roa,             'calculated', 'Net Profit ÷ Total Assets × 100'),
      nim:             isLender
        ? tag(nim, nim != null ? 'estimated' : 'unavailable',
              '(Interest income − Interest expense) ÷ Avg Total Assets × 100 — approximation: uses total assets, not interest-earning assets, so it reads slightly low vs a reported NIM')
        : tag(null, 'not-applicable', 'Only meaningful for banks and NBFCs'),
      // Leverage
      de:              tag(de,              'calculated', 'Total Debt ÷ Total Equity'),
      icr:             tag(icr,             'calculated', 'EBITDA ÷ Interest Expense'),
      netDebtRatio:    tagBs(div(netDebt, ebitda), 'calculated', 'Net Debt ÷ EBITDA'),
      // Valuation multiples
      pe:              tag(pe,              pe === meta?.pe ? 'source-reference' : 'calculated', 'Price ÷ EPS'),
      pb:              tag(pb,              pb === meta?.pb ? 'source-reference' : 'calculated', 'Price ÷ Book Value per Share'),
      ps:              tag(ps,              'calculated', 'Market Cap ÷ Revenue'),
      evEbitda:        tagBs(evEbitda,        'calculated', 'EV ÷ EBITDA'),
      evRevenue:       tagBs(evRevenue,       'calculated', 'EV ÷ Revenue'),
      grahamNumber:    tag(grahamNumber,    'calculated', '√(22.5 × EPS × Book Value per Share)'),
      // Growth
      revCagr:            tag(revCagr, 'calculated',
        revCagrWindowYears ? `Revenue CAGR over the last ${revCagrWindowYears} years` : 'Revenue CAGR'),
      revCagrWindowYears: tag(revCagrWindowYears, 'calculated', 'Years in the revenue-CAGR window'),
      npCagr:             tag(npCagr, 'calculated',
        npCagrWindowYears ? `Net Profit CAGR over the last ${npCagrWindowYears} years` : 'Net Profit CAGR'),
      npCagrWindowYears:  tag(npCagrWindowYears, 'calculated', 'Years in the net-profit-CAGR window'),
      revGrowthYoY:    tag(revGrowthYoY,    'calculated', 'Revenue YoY growth'),
      npGrowthYoY:     tag(npGrowthYoY,     'calculated', 'Net Profit YoY growth'),
      // FCF
      fcfYield:        tagFcf(fcfYield,        'calculated', 'FCF ÷ Market Cap × 100'),
      fcfConversion:   tagFcf(fcfConversion,   'calculated', 'FCF ÷ Net Profit × 100'),
      // EPS / Book
      eps:             tag(eps,             epsRaw != null ? 'source' : 'calculated', epsRaw ? null : 'Net Profit ÷ Shares Outstanding'),
      dividendPayout: tag(val(latestI.dividendPayout), 'source', 'Dividend payout % (from source)'),
      bookPerShare:    tag(bookPerShare,     'calculated', 'Total Equity ÷ Shares Outstanding'),
      // Meta (from v7 quote, for reference only)
      divYield:        tag(meta?.divYield,   'source-reference', 'From Yahoo v7 quote'),
      // Fallback ONLY — every CAPM consumer prefers assumptions.beta (this
      // app's own regression, src/engine/beta.js) and only falls back to
      // this reported figure when that regression hasn't resolved or
      // declined for lack of overlapping price history. See requiredReturn.js.
      beta:            tag(meta?.beta,       'source-reference', 'From Yahoo v7 quote'),
      high52:          tag(meta?.high52,     'source-reference', null),
      low52:           tag(meta?.low52,      'source-reference', null),
    },
    // EBITDA metadata for display
    ebitdaMeta: { status: ebitdaStatus, formula: ebitdaFormula }
  }
}

// ─── Pure math helpers ────────────────────────────────────────────────────────

// Windowed CAGR over a (year, value) series, respecting the same user-chosen
// window (opts.growthWindowYears) / structural-break start-year
// (opts.growthWindowFromYear) revCagr already used — factored out so a second
// series (net profit) doesn't duplicate the window logic and risk it drifting
// out of sync with revCagr's.
function windowedCagr(series, opts) {
  if (series.length < 2) return { cagr: null, windowYears: null }
  const nYrs = series.length - 1
  const requested = opts?.growthWindowYears > 0 ? opts.growthWindowYears : nYrs
  let win
  if (opts?.growthWindowFromYear != null) {
    const idx = series.findIndex(p => p.year >= opts.growthWindowFromYear)
    win = idx >= 0 ? Math.max(1, (series.length - 1) - idx) : Math.min(requested, nYrs)
  } else {
    win = Math.min(requested, nYrs)
  }
  const start = series[series.length - 1 - win].value
  const end   = series[series.length - 1].value
  // Net profit (unlike revenue) can cross zero — a CAGR through a loss year is
  // meaningless, so this declines rather than compounding through one.
  if (!(start > 0) || !(end > 0)) return { cagr: null, windowYears: null }
  return { cagr: (Math.pow(end / start, 1 / win) - 1) * 100, windowYears: win }
}

function div(a, b)    { return a != null && b != null && b !== 0 ? a / b : null }
function pct(a, b)    { const d = div(a, b); return d != null ? d * 100 : null }
function pct100(v)    { return v != null ? v * 100 : null }
function calc(formula, a, b, fn) {
  if (a == null || b == null) return null
  try { const r = fn(a, b); return isFinite(r) ? r : null } catch { return null }
}
/**
 * Tag an FCF-derived ratio with the basis of the FCF underneath it. If FCF is an
 * estimate, every ratio built on it says so — the estimate can't launder itself
 * into a clean-looking number one layer up. That is precisely what the old
 * `opCF x 0.7` did: untagged, it reached fcfYield, fcfConversion and the DCF
 * looking exactly like a reported figure.
 */
function tagFcf(value, status, formula = null) {
  if (value == null) return tag(null, 'unavailable', formula)
  if (FCF_BASIS.estimated) {
    return tag(value, 'estimated', `${formula} — ${FCF_BASIS.note}`)
  }
  return tag(value, status, `${formula} (${FCF_BASIS.note})`)
}

let FCF_BASIS = { estimated: false, note: '' }
let BS_BASIS  = { estimated: false, note: '' }

/**
 * Tag a ratio built on the balance sheet. If cash or debt was assumed rather than
 * read, every multiple standing on it says so — an assumption can't launder
 * itself into a clean number one layer up.
 */
function tagBs(value, status, formula = null) {
  if (value == null) return tag(null, 'unavailable', formula)
  if (BS_BASIS.estimated) return tag(value, 'estimated', `${formula} — ${BS_BASIS.note}`)
  return tag(value, status, formula)
}

function tag(value, status, formula = null) {
  return { value: value ?? null, status: value != null ? (status || 'calculated') : 'unavailable', formula }
}

