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

/** Fields Screener and Yahoo use for separately-disclosed one-off items. */
const EXCEPTIONAL_FIELDS = [
  'exceptionalItems', 'exceptional', 'extraordinaryItems', 'extraordinary',
  'otherIncomeExceptional', 'exceptionalItemsBeforeTax',
]

function exceptionalOf(row) {
  for (const f of EXCEPTIONAL_FIELDS) {
    const v = val(row?.[f])
    if (v != null && isFinite(v) && v !== 0) return v
  }
  return null
}

/**
 * Normalise reported one-offs out of the income history.
 *
 * Returns a NEW history — the original is left untouched, so a caller that
 * wants reported figures still has them. Each adjusted row carries what was
 * removed, so the ⓘ can show the working.
 */
export function normaliseIncome(incomeHistory = []) {
  const adjustments = []
  const rows = (incomeHistory || []).map(row => {
    const exc = exceptionalOf(row)
    const np = val(row?.netProfit)
    if (exc == null || !(np > 0)) return row

    // Exceptional items are reported pre-tax; the after-tax effect is what
    // reaches net profit. Where the effective rate is derivable it is used,
    // otherwise the item is removed gross and that is stated.
    const pbt = val(row?.profitBeforeTax) ?? val(row?.pbt)
    const taxRate = (pbt > 0 && np > 0 && pbt > np) ? 1 - (np / pbt) : null
    const afterTax = taxRate != null ? exc * (1 - taxRate) : exc
    const adjusted = np - afterTax
    if (!(adjusted > 0)) return row      // removing it would leave a loss; leave alone

    const eps = val(row?.eps)
    const shares = (eps > 0) ? np / eps : null

    adjustments.push({
      year: yearOf(row),
      kind: 'reported-one-off',
      removed: round(afterTax, 0),
      reportedProfit: round(np, 0),
      adjustedProfit: round(adjusted, 0),
      taxAdjusted: taxRate != null,
      impactPct: round(((np - adjusted) / np) * 100, 1),
      note: `${afterTax > 0 ? 'A gain of' : 'A charge of'} ${Math.abs(round(afterTax, 0))} was reported separately and has been removed`,
      resolved: true,
    })

    return {
      ...row,
      netProfit: { value: adjusted, adjusted: true },
      eps: shares > 0 ? { value: adjusted / shares, adjusted: true } : row.eps,
      reportedNetProfit: np,
    }
  })

  return { rows, adjustments }
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
        // A one-off is usually inside Other income or an expense sub-line, which
        // Screener keeps collapsed — a normal copy misses it, so re-pasting with
        // those rows expanded resolves this more often than not.
        resolveHint: 'income',
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

/**
 * Flag any major year-over-year spike on any P&L line — reverting or not.
 * Detection only. User acts by choosing the CAGR window. "Major" = >4x the line's
 * own usual (median) year-to-year change.
 */
export function pnlSpikes(incomeHistory = []) {
  const rows = (incomeHistory || []).slice().sort((a, b) => (yearOf(a) - yearOf(b)))
  const out = []
  for (const [field, label] of SPIKE_FIELDS) {
    const pts = rows
      .map(r => ({ year: yearOf(r), v: val(r?.[field]) }))
      .filter(p => p.year != null && p.v != null && p.v > 0)
    if (pts.length < 4) continue
    const steps = []
    for (let i = 1; i < pts.length; i++) steps.push(pts[i].v / pts[i - 1].v - 1)
    const sorted = [...steps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const scale  = Math.max(Math.abs(median), 0.02)
    for (let i = 0; i < steps.length; i++) {
      if (Math.abs(steps[i]) < scale * 4) continue
      out.push({
        year: pts[i + 1].year,
        kind: 'pnl-spike',
        field,
        note: `${label} ${steps[i] > 0 ? 'jumped' : 'dropped'} ${Math.abs(round(steps[i] * 100, 0))}% in ${pts[i + 1].year}, well beyond its usual year-to-year change`,
        resolveHint: 'window',
      })
    }
  }
  return out.sort((a, b) => (b.year || 0) - (a.year || 0))
}

export function assessDataQuality(incomeHistory = [], opts = {}) {
  // Reported basis: rows are never silently adjusted. One-offs are flagged;
  // correction is manual via the reconstruction modal (separate normalized table).
  const rows = incomeHistory

  // normaliseIncome is still called for its adjustments list only (disclosed
  // exceptionals, surfaced as information). Its mutated rows are discarded.
  const { adjustments } = normaliseIncome(incomeHistory)

  const detected = [
    ...suspectYears(rows, { alreadyAdjusted: adjustments.map(a => a.year) }),
    ...pnlSpikes(rows),
  ]
  const userFlags = Object.entries(opts.flags || {})
    .map(([year, note]) => ({ year: Number(year), kind: 'user-flagged', note, resolveHint: 'income' }))
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
