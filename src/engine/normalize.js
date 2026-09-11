/**
 * src/engine/normalize.js
 *
 * Converts raw source data into a standard shape.
 * yahoo-finance2 returns clean JS objects — no {raw, fmt} wrappers.
 * Dates are JS Date objects. Values are direct numbers.
 *
 * ALL values stored with resolution metadata: { value, status, formula }
 */
import { computeNormalizedRow } from './dataQuality.js'

const val = t => (t && typeof t === 'object' ? t.value : t)

/**
 * Fill remaining holes in the LATEST year from figures the user pulled out of a
 * filing. Documents sit BEHIND Yahoo/Screener/SEC — they are the last resort, for
 * metrics no automatic source carried. Nothing here overwrites a real value.
 *
 * Before this, an AR number had nowhere to go: the only one wired up was material
 * cost, and even that only reached the Block 5 margin trend, never the dashboard.
 * The reader would ask you for cash, you'd give it, and it vanished.
 *
 * @param arData  state.arData — the reconciled slot store
 */
export function applyDocFacts(data, arData) {
  const slots = arData?.slots || arData
  if (!data || !slots) return data

  const scale = (data.currency === 'INR') ? 1e7 : 1   // AR figures are in Crore
  const TARGETS = {
    income:   ['cogs', 'grossProfit', 'revenue', 'operatingProfit', 'depreciation', 'interest', 'netProfit'],
    balance:  ['cash', 'totalDebt', 'totalEquity', 'totalAssets'],
    cashflow: ['capex', 'operatingCF', 'freeCashFlow'],
  }
  const HISTORY = { income: 'incomeHistory', balance: 'balanceHistory', cashflow: 'cashflowHistory' }

  // Land each figure on the year the DOCUMENT is for, not blindly on the latest
  // row. An FY23 annual report's cash belongs on FY23. Dropping it on FY25 was a
  // bug I introduced — silent, and exactly the class of thing this whole exercise
  // is about. No year in the slot, or no matching row, means we don't guess.
  const yearOf = (asOf) => {
    const m = String(asOf || '').match(/(?:FY)?\s*'?((?:19|20)?\d{2})/)
    if (!m) return null
    const n = parseInt(m[1], 10)
    return String(n < 100 ? 2000 + n : n)
  }

  const out = { ...data }
  let filled = 0
  for (const [table, fields] of Object.entries(TARGETS)) {
    const key  = HISTORY[table]
    const rows = out[key]
    if (!rows?.length) continue
    const next = rows.map(r => ({ ...r }))
    for (const f of fields) {
      const slot = slots[f]
      if (slot?.value == null) continue
      const yr  = yearOf(slot.asOf)
      const idx = yr ? next.findIndex(r => String(r.year) === yr) : -1
      if (idx === -1) continue                      // unknown period -> don't guess
      if (next[idx][f]?.value != null) continue     // a real source already has it
      next[idx][f] = {
        value: slot.value * scale,
        status: 'document',
        formula: `From filing (${slot.asOf})`,
      }
      filled++
    }
    out[key] = next
  }
  if (filled > 0) out.docFilled = filled
  return out
}

/**
 * Scrub fabrications out of a record saved by an older build.
 *
 * What gets stored is `state.data` — the PROCESSED object, not the raw paste. So
 * every invented value the old code produced is frozen inside every saved record:
 *
 *   freeCashFlow  = operatingCF x 0.7   (a 30%-of-OCF capex assumption)
 *   cash          = unavailable, then `?? 0` downstream
 *   totalDebt     = 0, tagged 'source', when the debt line wasn't read
 *
 * Left alone, the new code reads that stored FCF, sees a number, and reports it
 * as "Reported Free Cash Flow" — the fabrication survives AND gets a better
 * label than it had. So it has to be stripped on load.
 *
 * Identified by the formula text the old build wrote, which is exact and safe.
 * Once stripped, FCF re-derives properly: opCF - capex, or the labelled
 * CapEx ~ Depreciation estimate, or nothing.
 *
 * NOT scrubbed: totalDebt of 0 tagged 'source'. The old build wrote that both for
 * "no debt line found" and for "genuinely zero debt" — they're indistinguishable
 * after the fact. Rare, and a re-paste fixes it.
 *
 * Call this on anything read from cache or Supabase, before calcRatios.
 */
export function migrateStoredData(data) {
  data = migrateNormalizedTable(data)
  data = dropTTMRows(data)
  if (!data?.cashflowHistory) return data
  const STALE = /Operating CF\s*[x\u00d7*]\s*0\.7/i
  let scrubbed = 0
  const cashflowHistory = data.cashflowHistory.map(row => {
    const f = row?.freeCashFlow
    if (f?.formula && STALE.test(f.formula)) {
      scrubbed++
      return { ...row, freeCashFlow: unavailable() }
    }
    return row
  })
  if (!scrubbed) return data
  return { ...data, cashflowHistory, migrated: scrubbed }
}

/**
 * api/screener.js used to scrape Screener's page literally — including the
 * trailing "TTM" column every page has alongside its real fiscal years — into
 * a genuine `{ year: "TTM", revenue: {...}, ... }` row, never flagged
 * `synthetic` the way normalize.js's own (unrelated, already-fixed) stub row
 * was. Sorted alongside real years it lands last ("TTM".localeCompare("2025")
 * > 0), so it silently became "the latest year" everywhere that read the
 * array's own last element as a shortcut for that — ratios.js's snapshot and
 * dataGaps.js's missing-metrics check both had this exact bug, now guarded at
 * read time there too. The scraper itself is fixed (it no longer emits this
 * row for a fresh fetch), but a ticker fetched before that fix still has the
 * row sitting in storage — drop it here so nothing else that ever iterates
 * the full history (a CAGR window, a chart) has to keep working around it.
 */
function dropTTMRows(data) {
  const isTTM = row => /^ttm$/i.test(String(row?.year ?? '').trim())
  let changed = false
  const strip = (arr) => {
    if (!arr?.some(isTTM)) return arr
    changed = true
    return arr.filter(row => !isTTM(row))
  }
  const out = {
    ...data,
    incomeHistory:         strip(data?.incomeHistory),
    reportedIncomeHistory: strip(data?.reportedIncomeHistory),
    balanceHistory:        strip(data?.balanceHistory),
    cashflowHistory:       strip(data?.cashflowHistory),
  }
  return changed ? out : data
}

/**
 * Income used to carry a SEPARATE normalizedIncomeHistory array, merged onto
 * reportedIncomeHistory whole-row-per-year at read time (mergeByYear). That's
 * gone \u2014 normalized netProfit/eps now live as netProfitNormalized/
 * epsNormalized sibling fields directly on the matching reportedIncomeHistory
 * row, computed live where derivable and written here only for a manual
 * NormalizeModal override that can't be.
 *
 * The old array conflated two different origins under one identical shape,
 * with nothing recorded to tell them apart: a genuine manual correction from
 * NormalizeModal, and an entry the OLD auto-derivation wrote on its own for
 * ANY year with a detected exceptional item, every time a paste landed \u2014 a
 * real, intended feature, not something the user did by hand. Labeling every
 * migrated entry "manual" (this function's first version) meant a ticker
 * that only ever had the automatic kind got told, for nearly every year,
 * that it had been "manually normalized from the annual report" \u2014 untrue,
 * and confusing since some of those years show wild swings (a near-zero
 * profit year makes the mechanical subtraction's impact% look enormous,
 * nothing to do with human judgment).
 *
 * There's no recorded flag to settle which an old entry was, but there's a
 * way to infer it: computeNormalizedRow's auto-derivation (unchanged by this
 * migration) recomputes the exact same figure LIVE from this row's own
 * reported fields whenever it's the automatic kind. So if an old entry
 * matches what live derivation independently produces, it's redundant \u2014
 * drop it, and let computeNormalizedRow derive it fresh (correctly labeled
 * 'reported-one-off' in the data-quality display) every time from here on.
 * Only a genuine mismatch \u2014 a human's own correction differing from the
 * mechanical formula \u2014 is worth preserving as a real override.
 */
export function migrateNormalizedTable(data) {
  const old = data?.normalizedIncomeHistory
  if (!old?.length) return data
  const byYear = Object.fromEntries(old.map(r => [String(r.year), r]))
  const reportedBase = data.reportedIncomeHistory || data.incomeHistory || []
  const reportedIncomeHistory = reportedBase.map(row => {
    const o = byYear[String(row.year)]
    if (!o) return row
    const oNp = val(o.netProfit)
    if (oNp == null) return row
    const live = computeNormalizedRow(row)
    const redundant = live && Math.round(live.netProfit.value) === Math.round(oNp)
    if (redundant) return row
    const out = { ...row, netProfitNormalized: o.netProfit }
    if (o.eps?.value != null) out.epsNormalized = o.eps
    return out
  })
  const { normalizedIncomeHistory, ...rest } = data
  return { ...rest, reportedIncomeHistory }
}

export function normalize(source, raw) {
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'merged')   return normalizeMerged(raw)
  if (source === 'sec-merged') return normalizeSecMerged(raw)
  throw new Error(`Unknown source: ${source}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CR = 1e7  // Crore to absolute INR

function src(value)              { return { value, status: 'source',       formula: null } }
function derived(value, formula) { return { value, status: 'derived',      formula } }
function unavailable()           { return { value: null, status: 'unavailable', formula: null } }
function scaleCr(tagged) {
  if (!tagged || tagged.value == null) return tagged ?? unavailable()
  return { ...tagged, value: tagged.value * CR }
}
// capex is a spend MAGNITUDE by convention (metrics.js: alwaysPositive), not
// a signed quantity — Screener's own Investing-Activity row is negative (an
// outflow, same convention as the rest of that statement), and this scrape
// path passes it straight through with no sign handling otherwise. The Yahoo
// fts path already forces this inline further down; this is the same rule
// for the Screener path.
function absTagged(tagged) {
  if (!tagged || tagged.value == null) return tagged
  return { ...tagged, value: Math.abs(tagged.value) }
}
function n(v) { return typeof v === 'number' && isFinite(v) ? v : null }
function yearOf(d) {
  if (!d) return null
  if (d instanceof Date) return isNaN(d) ? null : d.getFullYear().toString()
  if (typeof d === 'number') return new Date(d * 1000).getFullYear().toString()
  // Over the wire the API sends JSON, so Date values arrive as ISO STRINGS
  // ("2026-03-31T00:00:00.000Z"). Without this branch every FTS row's year
  // resolved to null, ftsYears came out empty, and normalize fell back to the
  // synthetic single-year row — the root cause of "1yr" + missing metrics.
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-\d{2}-\d{2}/)          // ISO date
    if (m) return m[1]
    const m2 = d.match(/\b(19|20)\d{2}\b/)             // any 4-digit year fallback
    if (m2) return m2[0]
    const parsed = new Date(d)
    return isNaN(parsed) ? null : parsed.getFullYear().toString()
  }
  return null
}

// ─── Yahoo normalizer (yahoo-finance2 output) ─────────────────────────────────

function normalizeYahoo({ ticker, quote, summary, history, fts }) {
  const q   = quote    || {}
  const fin = summary?.financialData      || {}
  const ks  = summary?.defaultKeyStatistics || {}
  const sd  = summary?.summaryDetail      || {}
  const ap  = summary?.assetProfile       || {}

  // ── Currency & price ────────────────────────────────────────────────────────
  const currency  = q.currency || 'USD'
  const price     = n(q.regularMarketPrice)
  const marketCap = n(q.marketCap)
  const shares    = n(q.sharesOutstanding) ?? n(ks.sharesOutstanding)

  // ── Price history (from historical()) ────────────────────────────────────────
  // yahoo-finance2 historical() returns [{date, open, high, low, close, adjClose, volume}]
  // adjClose is already adjusted — use it for accurate technicals
  const priceHistory = (history || [])
    .filter(d => d.adjClose != null || d.close != null)
    .map(d => ({
      date:   d.date instanceof Date
                ? d.date.toISOString().slice(0, 10)
                : new Date(d.date).toISOString().slice(0, 10),
      open:   n(d.open),
      high:   n(d.high),
      low:    n(d.low),
      close:  n(d.adjClose) ?? n(d.close),
      volume: n(d.volume)
    }))

  // ── Statement history (from fundamentalsTimeSeries) ───────────────────────────
  // MIGRATED: quoteSummary's incomeStatementHistory/balanceSheetHistory/
  // cashflowStatementHistory have been dead since Nov 2024 (confirmed by
  // yahoo-finance2's own runtime warning). fundamentalsTimeSeries is the
  // current replacement, returning one entry per fiscal-year date with
  // requested "type" fields flattened directly onto each entry.
  //
  // Field naming: each metric below tries multiple alias candidates, in
  // priority order. The first-listed candidate for every field here was
  // checked directly against yahoo-finance2's own published
  // fundamentalsTimeSeries schema (its GitHub source) and is a real,
  // correctly-cased concept key, not a guess — so a field coming back empty
  // is more likely a genuine coverage gap (Yahoo not having that data for
  // that ticker) than a wrong alias. The DIAGNOSTIC log in api/yahoo.js
  // (FTS_DIAGNOSTIC=1) still shows the real per-ticker keys if a candidate
  // ever needs correcting.
  const ftsRows = Array.isArray(fts) ? fts : []

  const pick = (row, ...candidates) => {
    for (const c of candidates) {
      const v = n(row[c])
      if (v != null) return v
    }
    return null
  }

  const dateOf = row => row.date || row.asOfDate || row.endDate
  const ftsYears = [...new Set(ftsRows.map(r => yearOf(dateOf(r))).filter(Boolean))].sort()

  const incomeHistory = ftsYears.map(year => {
    const row = ftsRows.find(r => yearOf(dateOf(r)) === year) || {}
    // yahoo-finance2 returns concept keys with the period prefix STRIPPED
    // (annualTotalRevenue -> totalRevenue, etc). These are those real keys.
    const rev = pick(row, 'totalRevenue', 'operatingRevenue')
    const opI = pick(row, 'operatingIncome', 'totalOperatingIncomeAsReported', 'EBIT')
    const dep = pick(row, 'reconciledDepreciation', 'depreciationAndAmortizationInIncomeStatement',
                          'depreciationAmortizationDepletionIncomeStatement', 'depreciationIncomeStatement')
    const int = pick(row, 'interestExpense', 'interestExpenseNonOperating', 'netNonOperatingInterestIncomeExpense')
    const ni  = pick(row, 'netIncome', 'netIncomeCommonStockholders')
    const epsVal = pick(row, 'dilutedEPS', 'basicEPS')
    const ebd = pick(row, 'EBITDA', 'normalizedEBITDA')
    // fundamentalsTimeSeries is requested with module:'all', so gross profit and
    // cost of revenue ARE in the payload. They were previously hard-coded
    // unavailable — a leftover stub from the fts migration, not a decision.
    const gp  = pick(row, 'grossProfit')
    const cog = pick(row, 'costOfRevenue', 'reconciledCostOfRevenue')
    return {
      year,
      revenue:         rev != null ? src(rev) : unavailable(),
      expenses:        unavailable(),
      grossProfit:     gp  != null ? src(gp)  : unavailable(),
      cogs:            cog != null ? src(cog) : unavailable(),
      operatingProfit: opI != null ? src(opI) : unavailable(),
      ebitda:          ebd != null ? src(ebd) : unavailable(), // else derived later in ratios.js
      depreciation:    dep != null ? src(dep) : unavailable(),
      interest:        int != null ? src(int) : unavailable(),
      otherIncome:     unavailable(),
      netProfit:       ni  != null ? src(ni)  : unavailable(),
      eps:             epsVal != null ? src(epsVal) : unavailable(),
    }
  }).filter(r => r.year && r.revenue.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // Backfill from Yahoo's earnings module (annual). IMPORTANT: in
  // financialsChart.yearly, `earnings` is NET INCOME (absolute currency), NOT
  // EPS. Assigning it to eps produced garbage EPS/P/E/Graham/fair-value. Use it
  // only to fill a missing Net Profit; real EPS is derived (Net Profit ÷ Shares)
  // in ratios.js.
  for (const e of (summary?.earnings?.financialsChart?.yearly || [])) {
    const row = incomeHistory.find(r => r.year === String(e.date))
    if (row && row.netProfit.value == null && e.earnings != null) row.netProfit = src(n(e.earnings))
  }

  const balanceHistory = ftsYears.map(year => {
    const row = ftsRows.find(r => yearOf(dateOf(r)) === year) || {}
    const ta  = pick(row, 'totalAssets')
    const eq  = pick(row, 'stockholdersEquity', 'totalEquityGrossMinorityInterest', 'commonStockEquity')
    const ltd = pick(row, 'totalDebt', 'longTermDebt', 'longTermDebtAndCapitalLeaseObligation')
    // Cash was hard-coded unavailable — same leftover stub as grossProfit above.
    const csh = pick(row, 'cashAndCashEquivalents', 'cashCashEquivalentsAndShortTermInvestments',
                          'endCashPosition', 'cashAndCashEquivalentsAtCarryingValue')
    const ca  = pick(row, 'currentAssets', 'totalCurrentAssets')
    const cl  = pick(row, 'currentLiabilities', 'totalCurrentLiabilities')
    // Screener has no equivalent line for these — Indian disclosure doesn't
    // present a current/non-current split the way US GAAP does — so they
    // stay Yahoo-only permanently, same standing as grossProfit for an
    // Indian ticker. That's fine: they're tracked in metrics.js like any
    // other field (so the data table shows them, tagged, whenever Yahoo
    // supplies them) rather than dropped for having no active consumer
    // today — metrics.js is a catalog of what's available, not just what's
    // currently wired into a calculation.
    return {
      year,
      equityCapital:    unavailable(),
      reserves:         unavailable(),
      totalEquity:      eq  != null ? src(eq)  : unavailable(),
      // NEVER default to src(0): a fabricated zero tagged 'source' understated
      // capital employed (inflating ROCE) and corrupted netDebt/EV.
      totalDebt:        ltd != null ? src(ltd) : unavailable(),
      cash:             csh != null ? src(csh) : unavailable(),
      totalAssets:      ta  != null ? src(ta)  : unavailable(),
      totalLiabilities: unavailable(),
      currentAssets:    ca  != null ? src(ca)  : unavailable(),
      currentLiabilities: cl != null ? src(cl) : unavailable(),
      fixedAssets:      unavailable(),
      investments:      unavailable(),
    }
  }).filter(r => r.year && r.totalAssets.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  const cashflowHistory = ftsYears.map(year => {
    const row = ftsRows.find(r => yearOf(dateOf(r)) === year) || {}
    const opCF = pick(row, 'operatingCashFlow', 'cashFlowFromContinuingOperatingActivities')
    const fcf  = pick(row, 'freeCashFlow')
    // capitalExpenditure is in the fts payload and was never picked up. Yahoo
    // files it as a NEGATIVE outflow; store the absolute magnitude so every
    // source agrees on sign (SEC files it positive).
    const cxRaw = pick(row, 'capitalExpenditure', 'netPPEPurchaseAndSale', 'purchaseOfPPE')
    const cx    = cxRaw != null ? Math.abs(cxRaw) : null
    return {
      year,
      operatingCF:  opCF != null ? src(opCF) : unavailable(),
      investingCF:  unavailable(),
      financingCF:  unavailable(),
      capex:        cx != null ? src(cx) : unavailable(),
      // Real FCF only. The old `opCF x 0.7` proxy invented a 30%-of-OCF capex
      // assumption and fed it to fcfYield / fcfConversion / DCF / reverse-DCF.
      // If capex is genuinely unknown, FCF is unknown — say so.
      freeCashFlow: fcf  != null ? src(fcf)
                  : (opCF != null && cx != null)
                      ? derived(opCF - cx, 'Operating CF − CapEx')
                      : unavailable(),
    }
  }).filter(r => r.year && r.operatingCF.value != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // A genuinely empty statement history (fundamentalsTimeSeries returned
  // nothing usable) used to be papered over with a single synthetic
  // current-year row built from Yahoo's financialData TTM snapshot. That
  // stub couldn't feed a CAGR, a multiple band, or anything requiring a
  // trend regardless of why the history was empty, and it was itself
  // sourced from the same shaky post-Nov-2024-migration pipeline as the
  // primary data — not a more reliable substitute, just a weaker one
  // dressed up as an answer. Removed: an empty history now stays empty and
  // every dependent ratio/model correctly declines (`unavailable()`)
  // instead. `ratios.js`'s `coalesceLatest()` already handles an empty
  // array by returning `{}`, so nothing downstream assumed the stub existed.

  return {
    ticker,
    name:     q.longName || q.shortName || ticker,
    source:   'yahoo',
    deepSource: null,        // 'screener' | 'sec' once a deep source merges in
    currency,
    price,
    marketCap,
    shares,
    priceHistory,
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    meta: {
      sector:    ap.sector    || null,
      industry:  ap.industry  || null,
      website:   ap.website   || null,
      exchange:  q.exchange   || null,
      pe:        n(q.trailingPE)   ?? n(sd.trailingPE),
      pb:        n(q.priceToBook)  ?? n(ks.priceToBook),
      divYield:  n(q.trailingAnnualDividendYield) ?? n(sd.dividendYield),
      beta:      n(q.beta)         ?? n(sd.beta),
      high52:    n(q.fiftyTwoWeekHigh)  ?? n(sd.fiftyTwoWeekHigh),
      low52:     n(q.fiftyTwoWeekLow)   ?? n(sd.fiftyTwoWeekLow),
      avgVolume: n(q.averageDailyVolume3Month) ?? n(sd.averageVolume),
      change1d:  n(q.regularMarketChangePercent) ?? null,
      volume:    n(q.regularMarketVolume) ?? null,
    },
    sourceStats: {}
  }
}

// ─── Screener normalizer (unchanged) ─────────────────────────────────────────

function normalizeScreener(raw) {
  const inc = (raw.incomeHistory  || []).map(r => ({
    year:            r.year,
    revenue:         scaleCr(r.revenue),
    expenses:        scaleCr(r.expenses),
    operatingProfit: scaleCr(r.operatingProfit),
    ebitda:          scaleCr(r.ebitda),
    depreciation:    scaleCr(r.depreciation),
    interest:        scaleCr(r.interest),
    otherIncome:     scaleCr(r.otherIncome),
    netProfit:       scaleCr(r.netProfit),
    eps:             r.eps ?? unavailable(),
    grossProfit:     unavailable(),   // Indian P&L has no gross-profit line...
    // ...but the Expenses "+" gives Material Cost, which the parser has already
    // converted from % of sales to an absolute figure. ratios.js turns it into
    // gross profit. Was hard-coded unavailable, which binned the user's expand.
    cogs:            scaleCr(r.cogs),
  }))
  const bal = (raw.balanceHistory || []).map(r => ({
    year:             r.year,
    equityCapital:    scaleCr(r.equityCapital),
    reserves:         scaleCr(r.reserves),
    // api/screener.js already derives this (equityCapital + reserves,
    // tagged 'derived') before it ever reaches here — r.totalEquity is
    // already a tagged {value,status,formula} object, same as every other
    // field on this row, so scaleCr alone is correct; re-deriving from
    // r.equityCapital/r.reserves here would be adding two TAGGED OBJECTS
    // instead of their .value — wrong, and unnecessary besides.
    totalEquity:      scaleCr(r.totalEquity),
    totalDebt:        scaleCr(r.totalDebt),
    totalAssets:      scaleCr(r.totalAssets),
    totalLiabilities: scaleCr(r.totalLiabilities),
    fixedAssets:      scaleCr(r.fixedAssets),   // visible row — feeds the CapEx estimate
    investments:      scaleCr(r.investments),
    cash:             scaleCr(r.cash),   // Other Assets "+" -> Cash Equivalents
    // Screener has no current/non-current split to supply these from —
    // stays Yahoo-only, same as normalizeYahoo's balanceHistory above.
    currentAssets:      unavailable(),
    currentLiabilities: unavailable(),
  }))
  const cf = (raw.cashflowHistory || []).map(r => ({
    year:         r.year,
    operatingCF:  scaleCr(r.operatingCF),
    investingCF:  scaleCr(r.investingCF),
    financingCF:  scaleCr(r.financingCF),
    capex:        absTagged(scaleCr(r.capex)),   // Investing "+" -> Fixed assets purchased
    freeCashFlow: scaleCr(r.freeCashFlow),
  }))

  const ks       = raw.keyStats || {}
  const price    = ks['currentprice']?.value ?? null
  const mcapCr   = ks['marketcap']?.value    ?? null
  const marketCap = mcapCr != null ? mcapCr * CR : null

  return {
    ticker:   raw.ticker,
    name:     raw.name || raw.ticker,
    source:   'screener',
    deepSource: null,
    currency: 'INR',
    price,
    marketCap,
    shares:   null,
    priceHistory: [],
    incomeHistory:  inc,
    balanceHistory: bal,
    cashflowHistory: cf,
    meta: {
      sector: null, industry: null, website: null, exchange: 'NSE/BSE',
      pe: ks['stockpe']?.value ?? null,
      pb: null, divYield: ks['dividendyield']?.value ?? null,
    },
    keyStats: raw.keyStats,
    sourceStats: raw.keyStats || {},
    parserStatus: raw.parserStatus
  }
}

// ─── Merged normalizer ────────────────────────────────────────────────────────


/**
 * THE merge. Used by both deep sources — Screener (India) and SEC (US).
 *
 * Yahoo is a taster: it exists so the first search isn't a screen of empty boxes,
 * and so a ticker nobody has fed still shows something. The moment a real source
 * covers a year, Yahoo stops being the answer for that year.
 *
 *   - Deep source wins every year it covers, FIELD BY FIELD.
 *   - Yahoo fills only what the deep source doesn't carry (cash, EBITDA, gross
 *     profit on the Indian path — things Screener has no row for).
 *   - Years no deep source reaches stay pure Yahoo.
 *
 * This replaces "Yahoo always wins overlapping years", which spliced two sources
 * mid-series: Screener for the old years, Yahoo for the recent ones, and a seam
 * in the middle carrying every restatement and basis change — directly under the
 * 10-year CAGR. One basis per series now.
 *
 * There is no numeric gate. Screener and SEC both win every year they carry. A
 * paste that reaches here has already passed the structural check in the parser
 * (right table, annual not quarterly) and nothing else needs to be true of it.
 */
function mergeDeep(yahooRows, deepRows, fields) {
  const byYear = {}

  for (const r of (yahooRows || [])) {
    if (r?.year) byYear[r.year] = r
  }

  for (const d of (deepRows || [])) {
    if (!d?.year) continue
    const year = String(d.year)
    const y = byYear[year]
    if (!y) { byYear[year] = d; continue }

    const out = { ...y, ...d }                 // deep source wins the shape
    if (y.synthetic) delete out.synthetic      // real data replaced the stub
    for (const f of fields) {
      if (d[f]?.value != null) { out[f] = d[f]; continue }
      // Deep source has no value here. Keep Yahoo's, labelled as a fill.
      if (y[f]?.value != null) {
        out[f] = { ...y[f], status: 'cross-source', formula: `From Yahoo (deep source has no ${f})` }
      } else {
        out[f] = y[f] ?? d[f] ?? unavailable()
      }
    }
    byYear[year] = out
  }
  return Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year))
}

const INCOME_F  = ['revenue', 'expenses', 'grossProfit', 'cogs', 'operatingProfit', 'ebitda',
                   'depreciation', 'interest', 'otherIncome', 'netProfit', 'eps']
const BALANCE_F = ['equityCapital', 'reserves', 'totalEquity', 'totalDebt', 'cash', 'totalAssets',
                   'totalLiabilities', 'fixedAssets', 'investments',
                   'currentAssets', 'currentLiabilities']
const CF_F      = ['operatingCF', 'investingCF', 'financingCF', 'capex', 'freeCashFlow']

function normalizeMerged({ yahoo, screener }) {
  const y = normalizeYahoo(yahoo)
  const sc = normalizeScreener(screener)

  const incomeHistory   = mergeDeep(y.incomeHistory,   sc.incomeHistory,   INCOME_F)
  const balanceHistory  = mergeDeep(y.balanceHistory,  sc.balanceHistory,  BALANCE_F)
  const cashflowHistory = mergeDeep(y.cashflowHistory, sc.cashflowHistory, CF_F)

  const used = sc.incomeHistory?.length || 0
  return {
    ...y,                                   // price, mcap, shares, priceHistory, beta
    source:       used > 0 ? 'merged' : 'yahoo',
    deepSource:   used > 0 ? 'screener' : null,
    historyYears: incomeHistory.length - (y.incomeHistory?.length || 0),
    incomeHistory,
    balanceHistory,
    cashflowHistory,
  }
}


// NOTE: five per-statement merge helpers (mergeByYear / mergeIncomeRow /
// mergeBalanceRow / mergeCFRow / mergeTTM) were removed here. They had no call
// sites — mergeDeep replaced them — and they were actively misleading as a
// reference: their field lists omitted cogs, grossProfit and currentAssets,
// which the live path does carry.

// ── SEC (US tickers) ─────────────────────────────────────────────────────────
// SEC EDGAR fills the same slot Screener fills for Indian tickers: deep annual
// history. Yahoo still supplies price / marketCap / priceHistory / meta.
//
// Same merge contract as normalizeMerged: the DEEP source wins field by field.
// SEC is a read of the filings and Yahoo is a vendor feed, so where both have a
// value for a year, SEC's is kept; Yahoo fills only the fields SEC lacks (tagged
// 'cross-source') and supplies whole years SEC doesn't reach. No
// validation list is needed — SEC is the primary filing source, not a scrape.
//
// raw = { yahoo, sec } where sec = { incomeHistory, balanceHistory, cashflowHistory }
// with PLAIN NUMBER fields; we tag them here to match the app's row shape.
function normalizeSecMerged({ yahoo, sec }) {
  const y = normalizeYahoo(yahoo)
  if (!sec || sec.error) return y

  const tagRow = (row, fields) => {
    const out = { year: String(row.year) }
    for (const f of fields) out[f] = row[f] != null ? src(row[f]) : unavailable()
    return out
  }
  const secYears = (sec.incomeHistory || []).map(r => String(r.year))
  const tag = (rows, fields) => (rows || []).map(r => tagRow(r, fields))

  const incomeHistory   = mergeDeep(y.incomeHistory,   tag(sec.incomeHistory,   INCOME_F),  INCOME_F)
  const balanceHistory  = mergeDeep(y.balanceHistory,  tag(sec.balanceHistory,  BALANCE_F), BALANCE_F)
  const cashflowHistory = mergeDeep(y.cashflowHistory, tag(sec.cashflowHistory, CF_F),      CF_F)

  return {
    ...y,
    source:       secYears.length > 0 ? 'merged' : 'yahoo',
    deepSource:   'sec',
    historyYears: incomeHistory.length - (y.incomeHistory?.length || 0),
    incomeHistory,
    balanceHistory,
    cashflowHistory,
  }
}
