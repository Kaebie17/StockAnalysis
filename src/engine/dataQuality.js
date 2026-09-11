/**
 * src/engine/dataQuality.js — what in this history is adjusted, doubtful, or
 * not comparable.
 *
 * Three situations, three treatments, and the difference between them is the
 * whole design:
 *
 *   REPORTED ONE-OFF — an exceptional item disclosed on its own line. The
 *   correction is arithmetic, so it is applied silently: adjusted profit =
 *   reported less the exceptional. The year stays in every series. This is
 *   ordinary normalisation, and it covers the LATEST year, which is the one an
 *   estimate rests on.
 *
 *   UNREPORTED ONE-OFF — a year whose margin sits far outside the company's own
 *   range with nothing disclosed to explain it. The app cannot correct this and
 *   does not try. It says which year looks odd and leaves the figure alone; the
 *   fact input exists for supplying the number.
 *
 *   STRUCTURAL CHANGE — a step in revenue or share count that never reverts: an
 *   acquisition, a demerger, a disposal. Reported, never repaired, and NEVER
 *   used to truncate history. Whether the old years are comparable depends on
 *   the accounting: a qualifying divestiture is restated by the company and the
 *   old years are already clean, while an acquisition is not restated and the
 *   break is real. The app cannot tell which from the numbers, so cutting
 *   history would destroy good data half the time.
 *
 * Nothing here removes a year from any series. Fix what is determined, flag what
 * is not, never truncate.
 */

const val = t => (t && typeof t === 'object' ? t.value : t)
const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

// Fields Screener and Yahoo use for separately-disclosed one-off items.
// AFTER_TAX_FIELDS are checked first and used directly — Screener's own
// "Exceptional Items (AT)" line already IS the after-tax impact, so running
// it through the tax-rate estimate below would double-adjust it. The
// PRE_TAX_FIELDS fallback still needs that estimate, same as before.
const AFTER_TAX_FIELDS = ['exceptionalItemsAT']
const PRE_TAX_FIELDS = [
  'exceptionalItems', 'exceptional', 'extraordinaryItems', 'extraordinary',
  'otherIncomeExceptional', 'exceptionalItemsBeforeTax',
]

function exceptionalOf(row) {
  for (const f of AFTER_TAX_FIELDS) {
    const v = val(row?.[f])
    if (v != null && isFinite(v) && v !== 0) return { value: v, alreadyAfterTax: true }
  }
  for (const f of PRE_TAX_FIELDS) {
    const v = val(row?.[f])
    if (v != null && isFinite(v) && v !== 0) return { value: v, alreadyAfterTax: false }
  }
  return null
}

/**
 * Normalise reported one-offs out of the income history.
 *
 * Two DIFFERENT bases are adjusted, not one, because they're not the same
 * quantity — confirmed against a real reported waterfall (Airtel):
 *
 *   netProfit (this app's field, = Screener's "Net Profit") is the
 *   CONSOLIDATED figure — BEFORE deducting minority interest. Screener's own
 *   published EPS is NOT netProfit ÷ shares; it's (netProfit − minorityShare)
 *   ÷ shares, i.e. "Profit for EPS" ÷ shares — required by Ind AS 33 (EPS
 *   must be based on profit attributable to the parent's own shareholders).
 *   Reconstructing an implied share count as netProfit ÷ reportedEps (the
 *   previous approach here) is therefore wrong for any company with
 *   nonzero minority interest: it divides a pre-minority number by a
 *   post-minority-based EPS, inflating the implied share count.
 *
 * So this now adjusts netProfit and eps SEPARATELY, each on its own correct
 * basis, preferring a directly disclosed figure over deriving one at every
 * step:
 *
 *   netProfit basis (consolidated): profitExclExceptional (= netProfit −
 *   exceptionalItemsAT) if disclosed, else derived by subtracting
 *   exceptionalItems(AT) from netProfit directly.
 *
 *   eps basis (attributable to parent shareholders): profitForPE if
 *   disclosed — the fully resolved figure, confirmed equal to
 *   profitForEPS − exceptionalItemsAT. Falls back to (profitForEPS, or
 *   netProfit − minorityInterest when even that's absent) minus the same
 *   exceptional-items-after-tax figure. eps is then scaled proportionally
 *   (reportedEps × adjustedBasis/reportedBasis) rather than reconstructing
 *   a share count — sidesteps the inflated-share-count bug above entirely,
 *   and is algebraically identical to the old shares-based method whenever
 *   minority interest is genuinely zero.
 *
 * `derivedByOrdering` flags whichever half (or both) fell back to
 * subtraction instead of using a directly disclosed, fully-resolved figure.
 *
 * Returns a NEW history — the original is left untouched, so a caller that
 * wants reported figures still has them. Each adjusted row carries what was
 * removed, so the ⓘ can show the working.
 */
/**
 * The whole of normalization, for ONE row, computed live from that row's own
 * fields — nothing stored, nothing merged from a second table. There is
 * exactly one income table (reportedIncomeHistory); a row that needs a
 * normalized netProfit/eps either says so itself (netProfitNormalized /
 * epsNormalized — a MANUAL correction from NormalizeModal, for something not
 * derivable from anything Screener discloses, e.g. an AR footnote) or carries
 * enough of the exceptional-items group for this function to derive it on the
 * spot, every time it's asked, from the row's own current values. Either way
 * there is nothing to go stale, and nothing that needs merging field-by-field
 * or row-by-row with anything else.
 *
 * Returns null when there's genuinely nothing to normalize for this row.
 */
export function computeNormalizedRow(row) {
  // A manual override always wins outright — a human read an annual report
  // and said so; that's not something this function's own arithmetic should
  // ever second-guess or recompute over.
  if (row?.netProfitNormalized) {
    const reportedProfit = val(row.netProfitNormalized?.reported) ?? val(row.netProfit)
    const adjustedProfit = val(row.netProfitNormalized)
    return {
      netProfit: row.netProfitNormalized,
      eps: row.epsNormalized ?? row.eps,
      adjustment: {
        year: yearOf(row), kind: 'manual', resolved: true,
        reportedProfit: round(reportedProfit, 0),
        adjustedProfit: round(adjustedProfit, 0),
        impactPct: reportedProfit > 0 ? round(((reportedProfit - adjustedProfit) / reportedProfit) * 100, 1) : null,
        note: 'Manually normalized from the annual report.',
      },
    }
  }

  const np = val(row?.netProfit)
  if (!(np > 0)) return null

  const directClean = val(row?.profitExclExceptional)
  const exc = exceptionalOf(row)
  if (directClean == null && exc == null) return null

  // ── netProfit basis (consolidated) ──
  let excAfterTax, npAdjusted, taxRate = null, npDerived
  if (directClean != null && directClean > 0 && directClean !== np) {
    npAdjusted = directClean
    excAfterTax = np - directClean
    npDerived = false
  } else if (exc != null) {
    // Exceptional items are usually reported pre-tax; the after-tax effect
    // is what reaches net profit. Where Screener's own after-tax figure is
    // available it's used directly (exceptionalOf already flags this via
    // alreadyAfterTax); otherwise the effective rate is estimated where
    // derivable, and failing that the item is removed gross.
    const pbt = val(row?.profitBeforeTax) ?? val(row?.pbt)
    taxRate = (!exc.alreadyAfterTax && pbt > 0 && np > 0 && pbt > np) ? 1 - (np / pbt) : null
    excAfterTax = exc.alreadyAfterTax ? exc.value : (taxRate != null ? exc.value * (1 - taxRate) : exc.value)
    npAdjusted = np - excAfterTax
    npDerived = true
  } else {
    return null
  }
  if (!(npAdjusted > 0)) return null    // removing it would leave a loss; leave alone

  // ── eps basis (attributable to parent shareholders) ──
  const minorityShare = val(row?.minorityInterest) ?? 0
  const reportedEpsBasis = val(row?.profitForEPS) ?? (np - minorityShare)
  const directPE = val(row?.profitForPE)
  let epsBasisAdjusted, epsDerived
  if (directPE != null && directPE > 0) {
    epsBasisAdjusted = directPE
    epsDerived = false
  } else {
    epsBasisAdjusted = reportedEpsBasis - excAfterTax
    epsDerived = true
  }
  const reportedEps = val(row?.eps)
  const adjustedEps = (reportedEps > 0 && reportedEpsBasis > 0 && epsBasisAdjusted > 0)
    ? reportedEps * (epsBasisAdjusted / reportedEpsBasis) : null

  return {
    netProfit: { value: npAdjusted, adjusted: true },
    eps: adjustedEps != null ? { value: adjustedEps, adjusted: true } : row.eps,
    adjustment: {
      year: yearOf(row),
      kind: 'reported-one-off',
      removed: round(excAfterTax, 0),
      reportedProfit: round(np, 0),
      adjustedProfit: round(npAdjusted, 0),
      taxAdjusted: taxRate != null,
      alreadyAfterTax: exc?.alreadyAfterTax ?? true,
      // Whether EITHER basis fell back to subtraction instead of a directly
      // disclosed, fully-resolved figure (profitExclExceptional / profitForPE).
      derivedByOrdering: npDerived || epsDerived,
      minorityAdjusted: minorityShare !== 0 || val(row?.profitForEPS) != null,
      impactPct: round(((np - npAdjusted) / np) * 100, 1),
      epsImpactPct: adjustedEps != null && reportedEps > 0
        ? round(((reportedEps - adjustedEps) / reportedEps) * 100, 1) : null,
      note: `${excAfterTax > 0 ? 'A gain of' : 'A charge of'} ${Math.abs(round(excAfterTax, 0))} was reported separately and has been removed`,
      resolved: true,
    },
  }
}

/** Whether ANY year in this table has something to normalize — manual or
 *  auto-derivable — without computing the whole adjusted series. Drives
 *  whether the Reported/Normalized toggle even appears. */
export function hasNormalizableYear(incomeHistory = []) {
  return (incomeHistory || []).some(row => computeNormalizedRow(row) != null)
}

/**
 * The adjustments list only — for the data-quality display (the "ⓘ" that
 * shows reported vs. normalized). Doesn't touch or return the rows
 * themselves; computeAll builds the actual normalized series live, per row,
 * via computeNormalizedRow above.
 */
export function normaliseIncome(incomeHistory = []) {
  const adjustments = []
  for (const row of (incomeHistory || [])) {
    const n = computeNormalizedRow(row)
    if (n) adjustments.push(n.adjustment)
  }
  return { adjustments }
}

/**
 * NOTE — no inferential detection here.
 *
 * Earlier versions guessed at unreported one-offs (a year whose margin sat far
 * outside the company's own range) and at structural breaks (a revenue step that
 * didn't revert). Both are removed. Neither could be corrected from the numbers,
 * so each produced a flag resting on thresholds I chose — and a threshold that
 * decides whether the app raises doubt is still the app deciding.
 *
 * What remains is only what can be read off a disclosed line, plus flags the
 * USER records. Where a year is known to contain something one-time and the
 * statements don't separate it, that is entered as an override below — from the
 * guidance keyword search where the annual report states it, or by hand.
 */

/**
 * Everything worth saying about this history, in one place.
 *
 * @returns { rows, adjustments, flags, summary }
 *   `rows` is the normalised income history for every downstream calculation;
 *   `flags` is what the app could not fix and is telling the user about.
 */
/**
 * Years whose margin sits far outside the company's own range.
 *
 * Not a reversion test: one that requires the FOLLOWING year to exist can never
 * fire on the latest year — the one an estimate is anchored on. This compares
 * each year against the distribution of all the others, so it works at either
 * end of the series.
 *
 * Two conditions, both required. Relative distance alone breaks on a stable
 * company, where a near-zero spread makes any rounding difference look
 * enormous; proportional distance alone breaks on a volatile one, where a large
 * swing is ordinary. Together they mean unusual FOR THIS COMPANY and large in
 * absolute terms.
 */
export function suspectYears(incomeHistory = [], { alreadyAdjusted = [] } = {}) {
  const pts = (incomeHistory || [])
    .map(r => ({ year: yearOf(r), margin: marginOf(r) }))
    .filter(p => p.year != null && p.margin != null)
  if (pts.length < 4) return []

  const out = []
  for (const p of pts) {
    if (alreadyAdjusted.includes(p.year)) continue
    const others = pts.filter(o => o.year !== p.year).map(o => o.margin).sort((a, b) => a - b)
    const median = others[Math.floor(others.length / 2)]
    const spread = others[others.length - 1] - others[0]

    // A zero spread means every other year was identical, so any deviation is
    // infinitely far out — not zero.
    const relative = spread > 0 ? Math.abs(p.margin - median) / spread : Infinity
    const proportional = Math.abs(median) > 0 ? Math.abs(p.margin - median) / Math.abs(median) : 0

    if (relative > 1.5 && proportional > 0.5) {
      out.push({
        year: p.year, kind: 'margin-outlier',
        marginPct: round(p.margin, 1), typicalPct: round(median, 1),
        note: `Margin of ${round(p.margin, 1)}% against a usual ${round(median, 1)}%`,
      })
    }
  }
  return out
}

function marginOf(row) {
  const np = val(row?.netProfit), rev = val(row?.revenue)
  return (rev > 0 && np != null) ? (np / rev) * 100 : null
}

/**
 * A step in scale that doesn't revert.
 *
 * Reported, never repaired, and never used to truncate history. Whether earlier
 * years stay comparable depends on accounting the app cannot see: a qualifying
 * divestiture is restated by the company and those years are already clean,
 * while an acquisition is not restated and the break is real. Cutting history
 * would be wrong half the time.
 */
// Watch only INDEPENDENT source lines. operatingProfit/ebitda are derived, so a
// revenue or depreciation spike already propagates into them — watching them too
// would double-report. otherIncome is the usual hiding place for a buried one-off.
const SPIKE_FIELDS = [
  ['revenue',      'Revenue'],
  ['otherIncome',  'Other income'],
  ['interest',     'Interest'],
  ['depreciation', 'Depreciation'],
  ['netProfit',    'Net profit'],
]

// Watched on the BALANCE SHEET. A jump here often isn't bad data at all — it's
// a real financing event (a large loan drawn or repaid mid-year). But it's
// exactly what makes interest ÷ debt (cost of debt, used in WACC) misleading
// for that year: a company that borrowed heavily in Q4 shows a full year's
// low average debt against a much smaller interest charge, understating what
// its actual current cost of debt now is. Flag it the same way a P&L spike is
// flagged — not corrected, just surfaced, so a ratio built on that year is
// read with the right context.
const BALANCE_SPIKE_FIELDS = [
  ['totalDebt', 'Total debt'],
]

// Watched on the CASH FLOW STATEMENT, same reasoning as BALANCE_SPIKE_FIELDS
// but for the EV/EBITDA and Justified EV/EBITDA conversion ratio (FCF ÷
// EBITDA): a one-off working-capital swing (a large customer prepayment, a
// change in supplier credit terms) moves operating cash flow and free cash
// flow without changing the business's real, ongoing cash conversion at all.
// There's no separate "change in working capital" line in this codebase's
// data model — it's already folded into operatingCF — so operatingCF and
// freeCashFlow themselves are the two lines a working-capital swing shows up
// on.
const CASHFLOW_SPIKE_FIELDS = [
  ['operatingCF', 'Operating cash flow'],
  ['freeCashFlow', 'Free cash flow'],
]

/**
 * Flag any major year-over-year spike on a watched line — reverting or not.
 * Detection only, never a correction: the year stays exactly as reported.
 * "Major" = >4x the line's own usual (median) year-to-year change.
 *
 * Shared by pnlSpikes() (income statement), balanceSheetSpikes() and
 * cashFlowSpikes() below — the same "compare a line's move against its own
 * usual move" test, extracted once it needed to run against three different
 * statements rather than reimplemented per statement (the exact class of
 * risk this module's docblock and spread.js already describe: a fix to one
 * copy silently missing its siblings).
 */
// `suppress` maps a field name to the years it's already fully explained for
// — e.g. netProfit for years normaliseIncome's adjustments list already gives
// a reason for (a disclosed exceptional item, shown with its own note), or
// otherIncome for years a disclosed exceptional item is known at all (it's a
// component OF otherIncome — Other Income = Exceptional items + Other income
// normal, confirmed against real Screener data), independent of whether
// netProfit's OWN adjustment happened to succeed. Without this, a year
// already explained elsewhere gets flagged AGAIN here as an unexplained
// "jumped X%, well beyond its usual change" — telling the user the app has
// no idea why, when it does. suspectYears() (the margin-outlier check)
// already had this exact guard for netProfit (`alreadyAdjusted`); this never
// had it at all, for any field. Deliberately per-field, not per-year-for-the-
// whole-row: a known exceptional item explains netProfit and otherIncome
// specifically (both are directly built from it), but proves nothing about
// interest, revenue or depreciation moving the same year — those still get
// flagged as usual if they're genuinely unusual.
function lineSpikes(rows, fields, kind, suppress = {}) {
  const sorted = (rows || []).slice().sort((a, b) => (yearOf(a) - yearOf(b)))
  const out = []
  for (const [field, label] of fields) {
    const pts = sorted
      .map(r => ({ year: yearOf(r), v: val(r?.[field]) }))
      .filter(p => p.year != null && p.v != null && p.v > 0)
    if (pts.length < 4) continue
    const steps = []
    for (let i = 1; i < pts.length; i++) steps.push(pts[i].v / pts[i - 1].v - 1)
    const sortedSteps = [...steps].sort((a, b) => a - b)
    const median = sortedSteps[Math.floor(sortedSteps.length / 2)]
    const scale  = Math.max(Math.abs(median), 0.02)
    for (let i = 0; i < steps.length; i++) {
      if (Math.abs(steps[i]) < scale * 4) continue
      const year = pts[i + 1].year
      if (suppress[field]?.includes(year)) continue
      out.push({
        year,
        kind,
        field,
        note: `${label} ${steps[i] > 0 ? 'jumped' : 'dropped'} ${Math.abs(round(steps[i] * 100, 0))}% in ${year}, well beyond its usual year-to-year change`,
      })
    }
  }
  return out.sort((a, b) => (b.year || 0) - (a.year || 0))
}

/** Income-statement version. `alreadyAdjusted` = years normaliseIncome
 *  already has a disclosed, explained netProfit adjustment for — suppresses
 *  the redundant "netProfit jumped/dropped X%" flag for exactly those years,
 *  same as suspectYears() already does for the margin-outlier check.
 *  otherIncome is suppressed separately, for every year a disclosed
 *  exceptional item is known at all (exceptionalOf, below) — it's a
 *  component of otherIncome regardless of whether netProfit's own adjustment
 *  happened to succeed that year. */
export function pnlSpikes(incomeHistory = [], alreadyAdjusted = []) {
  const exceptionalYears = (incomeHistory || [])
    .filter(row => exceptionalOf(row) != null)
    .map(row => yearOf(row))
  return lineSpikes(incomeHistory, SPIKE_FIELDS, 'pnl-spike', {
    netProfit: alreadyAdjusted,
    otherIncome: exceptionalYears,
  })
}

/** Balance-sheet version — see BALANCE_SPIKE_FIELDS above. */
export function balanceSheetSpikes(balanceHistory = []) {
  return lineSpikes(balanceHistory, BALANCE_SPIKE_FIELDS, 'balance-spike')
}

/** Cash-flow-statement version — see CASHFLOW_SPIKE_FIELDS above. */
export function cashFlowSpikes(cashflowHistory = []) {
  return lineSpikes(cashflowHistory, CASHFLOW_SPIKE_FIELDS, 'cashflow-spike')
}

export function assessDataQuality(incomeHistory = [], opts = {}) {
  // Reported basis: rows are never silently adjusted. One-offs are flagged;
  // correction is manual via the reconstruction modal (separate normalized table).
  const rows = incomeHistory

  // normaliseIncome is still called for its adjustments list only (disclosed
  // exceptionals, surfaced as information). Its mutated rows are discarded.
  const { adjustments } = normaliseIncome(incomeHistory)

  // balanceHistory/cashflowHistory are optional — callers that only have the
  // income statement (or haven't been updated to pass the others yet) still
  // get everything they got before; the balance/cash-flow checks just don't
  // run without their input, same as any other "not enough data" decline.
  const adjustedYears = adjustments.map(a => a.year)
  const detected = [
    ...suspectYears(rows, { alreadyAdjusted: adjustedYears }),
    ...pnlSpikes(rows, adjustedYears),
    ...balanceSheetSpikes(opts.balanceHistory || []),
    ...cashFlowSpikes(opts.cashflowHistory || []),
  ]
  const userFlags = Object.entries(opts.flags || {})
    .map(([year, note]) => ({ year: Number(year), kind: 'user-flagged', note }))
  const flags = [...detected, ...userFlags].sort((a, b) => (b.year || 0) - (a.year || 0))

  const years = rows.map(yearOf).filter(y => y != null).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] > 1) {
      for (let y = years[i - 1] + 1; y < years[i]; y++) gaps.push(y)
    }
  }

  const allAdjustments = [...adjustments].sort((a, b) => (b.year || 0) - (a.year || 0))

  return {
    rows, adjustments: allAdjustments, flags,
    years,
    span: years.length,
    gaps,
    hasIssues: allAdjustments.length > 0 || flags.length > 0 || gaps.length > 0,
    summary: {
      adjusted: allAdjustments.length,
      flagged: flags.length,
      missing: gaps.length,
    },
  }
}
