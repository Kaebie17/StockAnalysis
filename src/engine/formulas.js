/**
 * src/engine/formulas.js
 *
 * THE one place every formula in the app is defined — the single source of
 * truth the Formulas tab reads to list, and data.fieldAssignments controls
 * the membership of. Three kinds, all sharing one assignment shape so a
 * single row can feed several formulas/targets at once:
 *   { field, kind: 'restatement', target: <fieldKey>, sign: 1|-1 }
 *   { field, kind: 'formula', formula: <formulaKey>, bucket: <bucketKey>, sign: 1|-1 }
 *
 *   - "restatement": correcting ONE already-reported field (revenue,
 *     operatingProfit, tradeReceivables, ...) by summing whatever custom rows
 *     point at it, with a sign each. Dynamic in TARGET CHOICE (any field with
 *     data, or any custom row, can be a target — see availableTargets), but
 *     each individual target is structurally a one-bucket formula: output =
 *     reported + sum(contributions). Used to live in a separate file
 *     (normalizationTargets.js) — moved in here since it's the exact same
 *     job materializeFormulas does for the other two kinds, just for a
 *     dynamically-chosen target instead of a fixed registry entry.
 *   - "derived": a genuinely NEW figure built from more than one bucket of
 *     rows (Net Working Capital: current operating assets minus current
 *     operating liabilities). Fixed bucket shape and combination rule,
 *     defined in code below — not every formula is a straight sum, so each
 *     one says explicitly how its buckets combine.
 *   - "fallback"/"ratio": see DERIVED_FORMULAS below.
 *
 * `field` is a metrics.js key or a data.customFields[].key — either way, a
 * key on the SAME table's history rows as what it's feeding (a restatement
 * target's table, or a derived formula's table) so contributor and target
 * are always read off the same row object, no cross-table year alignment
 * needed.
 *
 * A formula's OUTPUT is not something a consumer calls a function to get —
 * materializeFormulas/recomputeNormalizedTargets (both called once, from
 * computeAll) write it directly onto the row as {key}/{key}Normalized. So
 * NWC — or a restated Revenue — is just another field: any file reads it
 * the same way it reads netProfit — activeValue(row, 'nwc', basis) — never
 * a formulas.js-specific accessor, and never re-derived from
 * fieldAssignments at the point of use.
 */
import { METRICS } from './metrics.js'
import { activeValue } from './dataQuality.js'

const val = t => (t && typeof t === 'object' ? t.value : t)

export function fieldTable(data, field) {
  return METRICS[field]?.table ?? DERIVED_FORMULAS[field]?.table
    ?? (data?.customFields || []).find(f => f.key === field)?.table ?? null
}

export function fieldLabel(data, field) {
  return METRICS[field]?.label ?? DERIVED_FORMULAS[field]?.label
    ?? (data?.customFields || []).find(f => f.key === field)?.label ?? field
}

export function fieldHistory(data, table) {
  if (table === 'income')   return data?.reportedIncomeHistory || data?.incomeHistory || []
  if (table === 'balance')  return data?.balanceHistory || []
  if (table === 'cashflow') return data?.cashflowHistory || []
  return []
}

export function rowValue(row, field) { return val(row?.[field]) }

// DERIVED_FORMULAS now holds ONLY the two kinds that genuinely cannot be a
// per-year data-table row: 'growth' (a multi-year SUMMARY, not one year's
// value) and, via INPUT_FORMULAS below, live market-wide inputs. Every
// other formula that used to live here (NWC, PBT, EBITDA, every margin,
// ROE, FCFF, ...) is now a `computed: true` custom row — see
// STANDARD_FORMULA_ROWS and computeCustomRowValue/materializeCustomRows
// below. That move: (1) removed the bucket-seeding indirection that
// silently broke on a long-lived ticker (a formula's ingredients are now
// just data.fieldAssignments entries, edited straight through the data
// table, nothing pre-declared in code to fall out of sync with), and
// (2) gave every one of them the SAME free, unrestricted add/subtract
// editing a custom row already had — no fixed bucket shape.
const DERIVED_FORMULAS = {
  revenueGrowth:   { key: 'revenueGrowth',   kind: 'growth', label: 'Revenue Growth',    table: 'income', field: 'revenue' },
  netProfitGrowth: { key: 'netProfitGrowth', kind: 'growth', label: 'Net Profit Growth', table: 'income', field: 'netProfit' },
}

// ── Standard formula rows ────────────────────────────────────────────────
// The starting definition every one of these ~20 formulas seeds as, the
// FIRST time a ticker is loaded (see seedStandardFormulaRows) — after
// that, the row is the user's own, editable however they want (rebuild PBT
// from EBITDA instead of Operating Profit, add a 5th item to NWC, whatever)
// and this seed is never consulted again for that ticker.
//
// mode:
//   'sum'      — terms: [{field, sign, table?, lag?}], value = Σ sign×term.
//                The plain "add these, subtract those" case (NWC, PBT,
//                EBITDA, EBIT, Free Cash Flow, Tax, Gross Profit, Capital
//                Employed, Net Debt).
//   'ratio'    — numerator/denominator: each its own signed term list (a
//                ratio is inherently two groups, not one flat sum — Net
//                Profit ÷ Revenue can't be "+Net Profit −Revenue"), value =
//                Σnum / Σden × scale. averageDenominator: true (ROE only)
//                averages this year's and last year's denominator.
//   'weighted' — terms: [{field, sign, weightField?, weightOneMinus?}],
//                value = Σ sign × field × (weightField resolved, optionally
//                1−that / else 1). The one shape needing this: FCFF's
//                EBIT × (1 − Effective Tax Rate) term is a genuine product,
//                which a signed sum can't express.
//
// A term's `table`/`lag` mirror the old bucket mechanism's cross-table/
// prior-year resolution (ROA pulling Total Assets from the balance sheet
// while anchored on an income-table row; FCFF's ΔNWC needing this year's
// AND last year's NWC) — same idea, just living as plain term data instead
// of a fixed per-formula declaration.
const STANDARD_FORMULA_ROWS = {
  nwc: {
    key: 'nwc', label: 'Net Working Capital', table: 'balance', mode: 'sum',
    terms: [
      { field: 'tradeReceivables', sign: 1 }, { field: 'inventories', sign: 1 },
      { field: 'tradePayables', sign: -1 }, { field: 'advanceFromCustomers', sign: -1 },
    ],
  },
  capitalEmployed: {
    key: 'capitalEmployed', label: 'Capital Employed', table: 'balance', mode: 'sum',
    terms: [{ field: 'totalEquity', sign: 1 }, { field: 'totalDebt', sign: 1 }],
  },
  netDebt: {
    key: 'netDebt', label: 'Net Debt', table: 'balance', mode: 'sum',
    terms: [{ field: 'totalDebt', sign: 1 }, { field: 'cash', sign: -1 }],
  },
  grossProfit: {
    key: 'grossProfit', label: 'Gross Profit', table: 'income', mode: 'sum',
    terms: [{ field: 'revenue', sign: 1 }, { field: 'cogs', sign: -1 }],
  },
  profitBeforeTax: {
    key: 'profitBeforeTax', label: 'Profit Before Tax', table: 'income', mode: 'sum',
    terms: [
      { field: 'operatingProfit', sign: 1 }, { field: 'otherIncome', sign: 1 },
      { field: 'interest', sign: -1 }, { field: 'depreciation', sign: -1 },
    ],
  },
  tax: {
    key: 'tax', label: 'Tax', table: 'income', mode: 'sum',
    terms: [{ field: 'profitBeforeTax', sign: 1 }, { field: 'netProfit', sign: -1 }],
  },
  ebitda: {
    key: 'ebitda', label: 'EBITDA', table: 'income', mode: 'sum',
    terms: [{ field: 'operatingProfit', sign: 1 }, { field: 'depreciation', sign: 1 }],
  },
  // Algebraically equal to Operating Profit whenever EBITDA follows its own
  // default (EBITDA − Depreciation = Op Profit + Depreciation − Depreciation
  // = Op Profit) — but expressed via EBITDA/Depreciation rather than reading
  // Operating Profit directly, so it still resolves when EBITDA/Depreciation
  // are available from other sources but Op Profit itself isn't cleanly one.
  ebit: {
    key: 'ebit', label: 'EBIT', table: 'income', mode: 'sum',
    terms: [{ field: 'ebitda', sign: 1 }, { field: 'depreciation', sign: -1 }],
  },
  freeCashFlow: {
    key: 'freeCashFlow', label: 'Free Cash Flow', table: 'cashflow', mode: 'sum',
    terms: [{ field: 'operatingCF', sign: 1 }, { field: 'capex', sign: -1 }],
  },
  netMargin: {
    key: 'netMargin', label: 'Net Margin', table: 'income', mode: 'ratio', scale: 100,
    numerator: [{ field: 'netProfit', sign: 1 }], denominator: [{ field: 'revenue', sign: 1 }],
  },
  operatingMargin: {
    key: 'operatingMargin', label: 'Operating Margin', table: 'income', mode: 'ratio', scale: 100,
    numerator: [{ field: 'operatingProfit', sign: 1 }], denominator: [{ field: 'revenue', sign: 1 }],
  },
  ebitdaMargin: {
    key: 'ebitdaMargin', label: 'EBITDA Margin', table: 'income', mode: 'ratio', scale: 100,
    numerator: [{ field: 'ebitda', sign: 1 }], denominator: [{ field: 'revenue', sign: 1 }],
  },
  grossMarginPct: {
    key: 'grossMarginPct', label: 'Gross Margin', table: 'income', mode: 'ratio', scale: 100,
    numerator: [{ field: 'grossProfit', sign: 1 }], denominator: [{ field: 'revenue', sign: 1 }],
  },
  roa: {
    key: 'roa', label: 'Return on Assets', table: 'income', mode: 'ratio', scale: 100,
    numerator: [{ field: 'netProfit', sign: 1 }],
    denominator: [{ field: 'totalAssets', sign: 1, table: 'balance' }],
  },
  roce: {
    key: 'roce', label: 'Return on Capital Employed', table: 'income', mode: 'ratio', scale: 100,
    numerator: [{ field: 'ebit', sign: 1 }],
    denominator: [{ field: 'capitalEmployed', sign: 1, table: 'balance' }],
  },
  de: {
    key: 'de', label: 'Debt-to-Equity', table: 'balance', mode: 'ratio',
    numerator: [{ field: 'totalDebt', sign: 1 }], denominator: [{ field: 'totalEquity', sign: 1 }],
  },
  icr: {
    key: 'icr', label: 'Interest Coverage', table: 'income', mode: 'ratio',
    numerator: [{ field: 'ebitda', sign: 1 }], denominator: [{ field: 'interest', sign: 1 }],
  },
  netDebtToEbitda: {
    key: 'netDebtToEbitda', label: 'Net Debt / EBITDA', table: 'balance', mode: 'ratio',
    numerator: [{ field: 'netDebt', sign: 1 }],
    denominator: [{ field: 'ebitda', sign: 1, table: 'income' }],
  },
  roe: {
    key: 'roe', label: 'Return on Equity', table: 'income', mode: 'ratio', scale: 100, averageDenominator: true,
    numerator: [{ field: 'netProfit', sign: 1 }],
    denominator: [{ field: 'totalEquity', sign: 1, table: 'balance' }],
  },
  effectiveTaxRate: {
    key: 'effectiveTaxRate', label: 'Effective Tax Rate', table: 'income', mode: 'ratio',
    numerator: [{ field: 'tax', sign: 1 }], denominator: [{ field: 'profitBeforeTax', sign: 1 }],
  },
  fcff: {
    key: 'fcff', label: 'Free Cash Flow to Firm', table: 'income', mode: 'weighted',
    terms: [
      { field: 'ebit', sign: 1, weightField: 'effectiveTaxRate', weightOneMinus: true },
      { field: 'depreciation', sign: 1 },
      { field: 'capex', sign: -1, table: 'cashflow' },
      { field: 'nwc', sign: -1, table: 'balance' },
      { field: 'nwc', sign: 1, table: 'balance', lag: 1 },
    ],
  },
  // No terms — nothing here is an assignable statement field to add/remove,
  // same reason growth/CAGR and the AI-fetched inputs stay outside the
  // The closing price nearest this row's own fiscal year end
  // (data.priceHistory, a separate date-keyed series, not another
  // statement field) — its own row, not a private lookup pe/marketCap each
  // ran independently, since both need the exact same number and there's
  // no reason to compute it twice, silently, with nothing to look at or
  // correct if the match picked a date you don't agree with. No
  // reported/normalized distinction — a market price isn't a restatable
  // accounting figure.
  price: {
    key: 'price', label: 'Price (FY-end)', table: 'income', mode: 'closePrice',
  },
  // Divided by that year's EPS — reported or normalized, whichever basis
  // is active.
  pe: {
    key: 'pe', label: 'P/E', table: 'income', mode: 'priceRatio',
  },
  // No stored historical shares-outstanding series exists anywhere in this
  // app — every other historical multiple (targetMultiple.js's
  // yearlyObservations, valuation.js's pbBand) already back-solves it the
  // same way: shares = netProfit ÷ eps, sign-safe (both carry eps's sign,
  // so the ratio is positive whenever they genuinely agree — see
  // computeCustomRowValue). table:'income' since that's where netProfit/eps
  // (and the shares they imply) live; capitalEmployed etc. show cross-table
  // referencing a term this way is already normal.
  marketCap: {
    key: 'marketCap', label: 'Market Cap', table: 'income', mode: 'marketCap',
  },
  // Composed from marketCap (above) rather than re-deriving price×shares
  // itself — an ordinary 'sum' row, EXCEPT marketCap's absence must mean
  // "don't know," never "treat as zero" the way sum mode's other terms
  // correctly do for something like otherIncome — so this gets its own
  // small mode rather than reusing 'sum' and silently shipping "total
  // debt − cash" mislabeled as Enterprise Value on a year with no price
  // coverage.
  enterpriseValue: {
    key: 'enterpriseValue', label: 'Enterprise Value', table: 'balance', mode: 'enterpriseValue',
  },
}

// ── Market-input "formulas" ────────────────────────────────────────────
// Risk-free rate and equity risk premium are NOT per-ticker history — they
// are live, market-wide inputs (src/api/riskFreeClient.js, erpClient.js),
// fetched at most monthly and cached across sessions, identical for every
// ticker in the same market. They don't fit materializeFormulas' per-row
// model at all — there's no history ROW to write onto, since the value
// isn't a function of this ticker's own statements. Declared here purely so
// the Formulas tab has one place listing every formula in the app,
// including these — the actual value/refresh is read live from the
// existing clients (see HistoryTableModal.jsx's InputFormulaRow), not
// computed via computeForRow.
export const INPUT_FORMULAS = [
  { key: 'riskFreeRate', label: 'Risk-Free Rate',
    formula: '10-year government bond yield (live, refreshed monthly)' },
  { key: 'equityRiskPremium', label: 'Equity Risk Premium',
    formula: "Damodaran's published total equity risk premium (live, refreshed monthly)" },
]

// ── Restatement targets ─────────────────────────────────────────────────
// The fixed set of fields the historical-normalization restatement tool
// (NormalizeModal's generic paste mode) suggests by keyword — deliberately
// narrow, not "every metrics.js field." Just the ones that actually get
// historically normalized per the plan: EBIT, interest, tax, D&A, capex,
// revenue, and the four core working-capital components. label/table are
// read straight off metrics.js — one source of truth for what a field is
// called and which statement it lives on, not a second copy of it here.
//
// This used to live in a separate file (normalizationTargets.js) — moved in
// here because a restatement target IS a formula (kind: 'restatement', see
// listFormulas below): one place every formula in the app is defined, not
// two mechanisms that happen to do the same job.
export const NORMALIZATION_TARGET_KEYS = [
  'revenue', 'operatingProfit', 'interest', 'tax', 'depreciation', 'capex',
  'tradeReceivables', 'inventories', 'tradePayables', 'advanceFromCustomers',
]

// "Aligned" keywords drive ONLY this tool's dropdown pre-fill — a normalized
// (lowercased, alphanumeric-only) row label that CONTAINS one of these
// suggests the target, shown as an editable suggestion, never applied
// silently. Deliberately short and conservative: an unmatched, blank
// dropdown (the user picks manually) is meant to be the common case, not a
// wrong guess needing correction — the same "exact/longest match, no fuzzy
// guessing" discipline pasteParser.js's alias matching already follows.
//
// This is a DIFFERENT keyword set from metrics.js's own `ar` regex arrays.
// Those feed AR full-text SEARCH (arTargets()/arExtract.js — a different
// feature, hunting for a metric's own reported value across a whole
// document). These feed dropdown suggestion for a pasted ROW LABEL that's
// already been isolated — a much narrower, higher-precision job, which is
// why the lists don't just reuse each other.
const ALIGNED_KEYWORDS = {
  operatingProfit: [
    'restructuring', 'impairment', 'onetimeoperating', 'exceptionaloperating',
    'litigationprovision', 'legalsettlement', 'shutdowncost', 'voluntaryretirement', 'vrs',
  ],
  interest: [
    'onetimefinancecost', 'prepaymentpenalty', 'earlyredemption', 'debtrestructuring',
  ],
  tax: [
    'onetimetax', 'taxsettlement', 'taxcredit', 'deferredtaxwriteback', 'taxrefund',
  ],
  depreciation: [
    'assetimpairment', 'accelerateddepreciation', 'assetwriteoff',
  ],
  revenue: [
    'discontinuedoperation', 'divestment', 'demerger', 'restatedrevenue', 'consolidationchange',
  ],
  capex: [
    'spectrum', 'acquisitionofcompanies',
  ],
  tradeReceivables: [],
  inventories: [],
  tradePayables: [],
  // NOT 'unbilledrevenue' — that's an asset (revenue earned but not yet
  // invoiced), the mirror image of advanceFromCustomers (a liability:
  // invoiced/received but not yet earned). They're related concepts, not
  // the same target, and unbilled revenue isn't one of the ten targets
  // tracked at all — suggesting this field for it would be actively wrong,
  // not just imprecise. Better to suggest nothing than a wrong target.
  advanceFromCustomers: [
    'deferredrevenue', 'contractliability',
  ],
}

export const NORMALIZATION_TARGETS = Object.fromEntries(
  NORMALIZATION_TARGET_KEYS.map(key => [key, {
    key,
    label: METRICS[key]?.label ?? key,
    table: METRICS[key]?.table ?? null,
    aligned: ALIGNED_KEYWORDS[key] || [],
  }])
)

/**
 * Given a raw pasted row label, suggest which target it likely belongs to —
 * longest aligned-keyword match wins (same precedence pasteParser.js's own
 * alias matching uses), or null if nothing matches. A suggestion, not a
 * verdict: the caller shows it as the dropdown's pre-selected value, always
 * changeable, never applied without the user seeing and confirming it.
 */
export function suggestNormalizationTarget(rawLabel) {
  const norm = String(rawLabel || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!norm) return null
  let best = null, bestLen = 0
  for (const [key, { aligned }] of Object.entries(NORMALIZATION_TARGETS)) {
    for (const kw of aligned) {
      if (norm.includes(kw) && kw.length > bestLen) { best = key; bestLen = kw.length }
    }
  }
  return best
}

/**
 * The full set of valid restatement targets for THIS ticker — the curated
 * ten above, still pinned first (the fields a user is most likely to look
 * for by name, kept from reordering or disappearing as data fills in mid-
 * session), plus every other metrics.js field that actually has data
 * somewhere in this ticker's history, plus every custom row added through
 * the data table (HistoryTableModal.jsx). A company can just as easily
 * disclose a one-off inside a field that isn't one of the curated ten —
 * Other Income, Minority Interest, a custom line item — so the dropdown
 * shouldn't be limited to a fixed whitelist once there's real data (or a
 * user-created row) to normalize against.
 *
 * Only `aligned` (the keyword-suggestion list) is special to the curated
 * ten; everything else gets aligned: [] — no suggestion, the user picks
 * manually, same "unmatched is the common, expected case" rule
 * suggestNormalizationTarget already follows for the ten themselves.
 *
 * Returns a plain array (not a lookup object) — callers building a <select>
 * want the order preserved: the ten first, then every other qualifying
 * metrics.js field in metrics.js's own declaration order, then custom rows
 * in the order they were created.
 */
export function availableTargets(data) {
  if (!data) return Object.values(NORMALIZATION_TARGETS)
  const histFor = (table) => fieldHistory(data, table)
  const hasFieldData = (table, key) => histFor(table).some(r => rowValue(r, key) != null)

  const out = []
  const seen = new Set()
  for (const key of NORMALIZATION_TARGET_KEYS) {
    out.push(NORMALIZATION_TARGETS[key]); seen.add(key)
  }
  for (const [key, m] of Object.entries(METRICS)) {
    if (seen.has(key) || !m.table) continue
    if (!hasFieldData(m.table, key)) continue
    out.push({ key, label: m.label, table: m.table, aligned: [] })
    seen.add(key)
  }
  for (const f of (data.customFields || [])) {
    // A computed row (Net Margin, PBT, ...) is a FORMULA, not a target the
    // restatement tool can adjust — "restate Net Margin" isn't a
    // meaningful action the way "restate Revenue" is. Without this, a
    // computed row's own key collided with itself here, and listFormulas
    // returned this restatement stand-in instead of the real computed
    // entry for it (spread first in listFormulas' output array).
    if (f.computed) continue
    if (seen.has(f.key)) continue
    out.push({ key: f.key, label: f.label, table: f.table, aligned: [] })
    seen.add(f.key)
  }
  return out
}

/**
 * The normalized value for one restatement target field, on one row — a
 * genuine STORED field ({key}Normalized), not something reconstructed only
 * for display. See recomputeNormalizedTargets below for who writes it and
 * when: this function just reads it.
 *
 * A computed-only-at-render figure would be invisible to exactly the kind
 * of audit that caught the balance-sheet bugs (the year-shift, borrowings
 * silently renamed) — you can only notice a number is wrong by looking at
 * where it's actually stored, and a value that only ever exists transiently
 * inside a display function has nowhere to look. So the result of
 * normalizing a field lives in the table as its own real row, addressable
 * and inspectable the same way any tracked or custom row is, and stays
 * correct by being RECOMPUTED AND REWRITTEN (not read fresh each time)
 * whenever something that feeds it changes — see recomputeNormalizedTargets.
 */
// Same lookup dataQuality.js's activeValue uses for every calculation
// consumer — this is its display-purpose twin: the data table's own
// "(Normalized)" audit rows always show the computed figure when one
// exists, regardless of which basis the rest of the app is currently
// viewing (that's the whole point of an audit row), where activeValue
// respects the toggle because a CALCULATION needs to know which basis it's
// actually running on. Same field, same {key}Normalized convention, same
// underlying rule — just called with basis hard-pinned to 'normalized'.
export function normalizedFieldValue(row, key) {
  return activeValue(row, key, 'normalized') ?? null
}

/**
 * Rewrites {target}Normalized on every row, for every target that currently
 * has at least one custom row pointing at it, from that target's CURRENT
 * reported value and its CURRENT contributors' current values. Called from
 * computeAll (AppContext.jsx) — the one chokepoint every reducer path
 * already funnels through — so it never needs remembering at each
 * individual mutation site: add a custom field, edit one's value, delete
 * one, merge several, or re-paste the reported figure itself, and the next
 * computeAll pass rewrites the Normalized row to match, from scratch, with
 * nothing carried over from before. That also means a removed contributor's
 * effect disappears on its own — there is no leftover delta to unwind.
 *
 * `formula` names which rows are actually feeding it, so the stored value
 * carries its own explanation rather than requiring a reader to go find the
 * contributing rows themselves.
 */
export function recomputeNormalizedTargets(data) {
  const customFields = data?.customFields || []
  const restatementAssignments = (data?.fieldAssignments || []).filter(a => a.kind === 'restatement')
  const targetsInUse = new Set(restatementAssignments.map(a => a.target).filter(Boolean))

  // A target whose LAST contributor was just removed has zero entries in
  // fieldAssignments any more — it would never appear above, so its stale
  // {target}Normalized would never get cleared. Sweep every row for any
  // already-written *Normalized field and add its target too; with no
  // contributors left, that target's own pass below will correctly strip it
  // from every row (the "not touched" branch), rather than leaving a
  // Normalized figure with nothing behind it any more.
  const allRows = [
    ...(data?.reportedIncomeHistory || data?.incomeHistory || []),
    ...(data?.balanceHistory || []),
    ...(data?.cashflowHistory || []),
  ]
  for (const row of allRows) {
    for (const k of Object.keys(row || {})) {
      if (k.endsWith('Normalized')) targetsInUse.add(k.slice(0, -'Normalized'.length))
    }
  }
  if (!targetsInUse.size) return data

  let out = data
  for (const target of targetsInUse) {
    let table = METRICS[target]?.table ?? customFields.find(f => f.key === target)?.table
    // A restatement CAN target another custom row (Part C); if THAT row was
    // since deleted, its table is no longer known from either source above.
    // Its stale Normalized field still needs clearing, so fall back to
    // checking all three arrays rather than leaving it forever un-cleaned.
    if (!table) {
      const normKey = `${target}Normalized`
      for (const t of ['income', 'balance', 'cashflow']) {
        const hk = t === 'income' ? 'reportedIncomeHistory' : `${t}History`
        const arr = t === 'income' ? (out.reportedIncomeHistory || out.incomeHistory) : out[hk]
        if (!arr?.some(r => normKey in r)) continue
        const cleaned = arr.map(r => { if (!(normKey in r)) return r; const { [normKey]: _d, ...rest } = r; return rest })
        out = t === 'income' ? { ...out, reportedIncomeHistory: cleaned } : { ...out, [hk]: cleaned }
      }
      continue
    }
    const histKey = table === 'income' ? 'reportedIncomeHistory' : `${table}History`
    const base = table === 'income' ? (out.reportedIncomeHistory || out.incomeHistory || []) : (out[histKey] || [])
    const contributors = restatementAssignments.filter(a => a.target === target)
    const labelOf = key => customFields.find(f => f.key === key)?.label ?? METRICS[key]?.label ?? key
    const formula = contributors.map(c => `${(c.sign ?? 1) > 0 ? '+' : '−'} ${labelOf(c.field)}`).join(' ')

    const newHistory = base.map(row => {
      // Highest precedence, always: a genuinely typed-in Normalized figure
      // (HistoryTableModal's own Normalized row, EDIT_HISTORY_CELLS with
      // normalized:true) is a real, hand-entered value exactly like a
      // pasted reported one — never recomputed over, never swept away as a
      // stale orphan just because it currently has no restatement
      // contributors behind it.
      const normKey = `${target}Normalized`
      if (row?.[normKey]?.manual) return row
      const reported = row?.[target]
      if (reported?.value == null) return row
      // A year no contributor has anything for gets no Normalized row at
      // all — not one fabricated equal to reported. That keeps the row
      // itself telling you, at a glance, exactly which years were actually
      // touched, the same "never show a value nothing produced" rule
      // dataQuality.js already applies elsewhere (a 0% material cost row is
      // null, not a claimed 100% gross margin).
      let delta = 0, touched = false
      for (const c of contributors) {
        const v = row?.[c.field]?.value
        if (v != null) { delta += (c.sign ?? 1) * v; touched = true }
      }
      // Explicitly strip rather than leave alone: a year whose only
      // contributor's value was just cleared could otherwise keep whatever
      // Normalized figure an EARLIER recompute pass had already written —
      // this always rewrites from the CURRENT contributors, so nothing
      // stale survives a year going from touched to untouched.
      if (!touched) {
        if (!(normKey in row)) return row
        const { [normKey]: _drop, ...rest } = row
        return rest
      }
      return { ...row, [normKey]: { value: reported.value + delta, adjusted: true, formula } }
    })

    out = table === 'income'
      ? { ...out, reportedIncomeHistory: newHistory }
      : { ...out, [histKey]: newHistory }
  }
  return out
}

/**
 * Every formula the Formulas tab can show for this ticker: every valid
 * restatement target (dynamic — availableTargets already covers "any field
 * with data, or a custom row"), reshaped as a one-bucket formula, plus the
 * fixed derived formulas (currently just NWC). One list, one shape, so the
 * tab and the per-row assignment picker don't need to know which kind
 * they're looking at.
 */
export function listFormulas(data) {
  const restatement = availableTargets(data).map(t => ({
    key: t.key, kind: 'restatement', label: t.label, table: t.table,
    buckets: [{ key: 'adjustments', label: 'Adjustments', sign: 1, defaults: [] }],
  }))
  // Every `computed: true` custom row — the ~20 formulas that used to be
  // DERIVED_FORMULAS entries, now ordinary data-table rows (see
  // STANDARD_FORMULA_ROWS/materializeCustomRows). Read-only in the
  // Formulas tab: the row IS the definition, edited through the data
  // table, not through a picker here.
  const computed = (data?.customFields || []).filter(f => f.computed).map(f => ({
    key: f.key, kind: 'computed', label: f.label, table: f.table,
    mode: f.mode, scale: f.scale, averageDenominator: f.averageDenominator,
  }))
  return [...restatement, ...computed, ...Object.values(DERIVED_FORMULAS)]
}

/**
 * Field-name equation string for a computed custom row's current
 * definition — "(Net Profit) ÷ (Revenue) × 100", "Operating Profit +
 * Other Income − Interest − Depreciation" — built from whatever
 * data.fieldAssignments currently holds for it, the same "names only, the
 * actual figures are one click away" convention every formula's equation
 * already follows.
 */
export function computedRowEquation(data, field) {
  const termsText = (terms) => {
    if (!terms.length) return '—'
    return terms.map((t, i) => {
      const text = fieldLabel(data, t.field)
      const negative = (t.sign ?? 1) < 0
      if (i === 0) return negative ? `− ${text}` : text
      return `${negative ? '−' : '+'} ${text}`
    }).join(' ')
  }
  if (field.mode === 'ratio') {
    const num = termsFor(data, field.key, 'numerator')
    const den = termsFor(data, field.key, 'denominator')
    const scaleText = field.scale && field.scale !== 1 ? ` × ${field.scale}` : ''
    return `(${termsText(num)}) ÷ (${termsText(den)})${scaleText}`
  }
  if (field.mode === 'closePrice') {
    return 'Closing price nearest this fiscal year’s end'
  }
  if (field.mode === 'priceRatio') {
    return 'Price ÷ EPS'
  }
  if (field.mode === 'marketCap') {
    return 'Price × Shares (Net Profit ÷ EPS)'
  }
  if (field.mode === 'enterpriseValue') {
    return 'Market Cap + Total Debt − Cash'
  }
  if (field.mode === 'weighted') {
    const terms = termsFor(data, field.key, 'terms')
    if (!terms.length) return '—'
    return terms.map((t, i) => {
      const label = t.weightField
        ? `${fieldLabel(data, t.field)} × (1 − ${fieldLabel(data, t.weightField)})`
        : fieldLabel(data, t.field)
      const negative = (t.sign ?? 1) < 0
      if (i === 0) return negative ? `− ${label}` : label
      return `${negative ? '−' : '+'} ${label}`
    }).join(' ')
  }
  return termsText(termsFor(data, field.key, 'terms'))
}

// A bucket's own members can THEMSELVES be normalized — tradeReceivables,
// inventories, tradePayables and advanceFromCustomers are all in the
// curated restatement-target list, so any of them can carry a
// {field}Normalized sibling before NWC ever combines them. Resolving
// through activeValue here, INSIDE the formula, is the one fallback rule
// (Normalized-if-present, else reported), applied once per input, rather
// than every consumer re-deciding it per field.
function resolvedValue(row, field, basis) {
  return val(activeValue(row, field, basis))
}

function yearOf(row) {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

// Fiscal year end assumed March (Indian convention) — same hardcoded
// default every other fiscal-year-to-price-date mapping in this codebase
// already uses (estimate.js's forwardPeBand, targetMultiple.js's
// yearlyObservations); never actually configured per-ticker anywhere.
const FY_END_MONTH = 3

// The closing price nearest a given date, from data.priceHistory (a
// separate, date-keyed daily series — NOT another statement field, so this
// doesn't go through rowForTerm/activeValue like every other term does).
// Capped at 14 calendar days: a trading holiday run around a fiscal
// year-end is realistic, a match three months away is not a year-end price
// at all — returns null rather than silently pairing the wrong date.
function nearestClosePrice(data, targetT, toleranceDays = 14) {
  const toleranceMs = toleranceDays * 86400000
  let best = null, bestDiff = Infinity
  for (const p of (data?.priceHistory || [])) {
    if (!p?.date || !(p.close > 0)) continue
    const t = Date.parse(p.date)
    if (!isFinite(t)) continue
    const diff = Math.abs(t - targetT)
    if (diff < bestDiff) { bestDiff = diff; best = p.close }
  }
  return bestDiff <= toleranceMs ? best : null
}

// Shared with ratios.js — the CURRENT snapshot's price-based ratios (P/E,
// P/B, EV/EBITDA, ...) are the exact same formulas as these table rows,
// just paired with a live quote (ratios.js's data.price, polled every 60s)
// instead of a fiscal-year-end close (data.priceHistory, a separately-
// fetched daily series that can lag the live quote by a day mid-session —
// a real reason the PRICE SOURCE has to stay two different things). No
// reason the ARITHMETIC should also be written twice: both call these.
//
// netProfit and eps always carry the SAME sign (eps = netProfit ÷ shares,
// shares always positive) — so this ratio is only ever a genuine share
// count when they actually agree; a mismatch (large minority interest can
// cause this) means the two figures aren't describing the same thing and
// shouldn't be divided at all.
export function sharesFromNetProfitEps(netProfit, eps) {
  if (netProfit == null || !eps) return null
  const shares = netProfit / eps
  return shares > 0 ? shares : null
}

// All three required, not summed-with-gaps-skipped — an absent marketCap
// means "no price to compute it from," not "market cap was zero," and
// silently shipping "debt − cash" mislabeled as Enterprise Value would be
// a wrong number, not a partial one.
export function enterpriseValueFrom(marketCap, debt, cash) {
  if (marketCap == null || debt == null || cash == null) return null
  return marketCap + debt - cash
}

// A term's own statement, when it declares one (ROA/ROE/Net Debt÷EBITDA mix
// a P&L figure with a balance-sheet one) — matched to the primary row's
// YEAR, since the two tables are separate arrays, not the same row object.
// `lag` (years back from the primary row's year) is the other way a term
// can point somewhere other than "this same row" — FCFF's ΔNWC needs THIS
// year's value minus LAST year's of the SAME field; the two are
// independent (a term can set either, both, or neither).
function rowForTerm(data, rowTable, term, primaryRow) {
  const table = term.table || rowTable
  const lag = term.lag || 0
  if (table === rowTable && lag === 0) return primaryRow
  const year = yearOf(primaryRow)
  if (year == null) return null
  return fieldHistory(data, table).find(r => yearOf(r) === year - lag) || null
}

// Every term currently assigned to one bucket of one computed row — ALWAYS
// read live from data.fieldAssignments, never from a code-side declaration.
// A computed row's own metadata (key/label/table/mode/scale) lives on its
// data.customFields entry; its actual ingredients live here, exactly like
// any other field's fieldAssignments entries, editable through the same
// mechanism — there is no separate, parallel "formula definition" object.
function termsFor(data, rowKey, bucketName) {
  return (data?.fieldAssignments || [])
    .filter(a => a.kind === 'formula' && a.formula === rowKey && a.bucket === bucketName)
}

// Every term currently on a computed row, across all of its buckets, with a
// human label — for UI that lets a new row "attach to" an existing formula
// (pick NWC, then pick "Trade Receivables" to inherit its sign from) without
// needing to know which bucket a given field happens to live in.
export function formulaTerms(data, formulaKey) {
  const out = []
  for (const bucket of ['terms', 'numerator', 'denominator']) {
    for (const t of termsFor(data, formulaKey, bucket)) {
      out.push({ field: t.field, label: fieldLabel(data, t.field), bucket, sign: t.sign ?? 1 })
    }
  }
  return out
}

// Σ sign × resolvedValue(term) — the one summing rule a 'sum'-mode row, and
// each side of a 'ratio'-mode row, uses.
function sumTerms(data, rowTable, terms, row, basis) {
  if (!row) return null
  let sum = null
  for (const term of terms) {
    const termRow = rowForTerm(data, rowTable, term, row)
    const v = termRow ? resolvedValue(termRow, term.field, basis) : null
    if (v != null) sum = (sum ?? 0) + (term.sign ?? 1) * v
  }
  return sum
}

// Computes one row's value from a computed custom field's CURRENT
// definition — field.mode (from data.customFields) plus whatever terms are
// currently assigned to it (from data.fieldAssignments) — whatever that
// currently is, seed or user-edited; there's nothing else to consult. See
// STANDARD_FORMULA_ROWS for the three modes' shapes.
function computeCustomRowValue(data, field, row, basis) {
  if (!row) return null
  if (field.mode === 'closePrice') {
    const year = yearOf(row)
    if (year == null) return null
    return nearestClosePrice(data, Date.UTC(year, FY_END_MONTH, 0))
  }
  if (field.mode === 'priceRatio') {
    // Reads the sibling 'price' row rather than looking up its own — same
    // number pe and marketCap have always used (both called
    // nearestClosePrice with the identical target date), just from one
    // place now instead of two independent lookups, and visible/correctable
    // as its own row instead of buried inside this one.
    const price = resolvedValue(row, 'price', basis)
    const eps = resolvedValue(row, 'eps', basis)
    // Not `!eps` (only catches 0/null) — a negative P/E is arithmetically
    // real but economically meaningless (it doesn't mean "cheap," it means
    // loss-making), same reason valuation.js/peg.js already refuse to use
    // one anywhere else in this app. Blank here, not a misleading number.
    if (price == null || !(eps > 0)) return null
    return price / eps
  }
  if (field.mode === 'marketCap') {
    const price = resolvedValue(row, 'price', basis)
    const netProfit = resolvedValue(row, 'netProfit', basis)
    const eps = resolvedValue(row, 'eps', basis)
    const shares = sharesFromNetProfitEps(netProfit, eps)
    if (price == null || shares == null) return null
    return price * shares
  }
  if (field.mode === 'enterpriseValue') {
    const year = yearOf(row)
    if (year == null) return null
    const incomeRow = fieldHistory(data, 'income').find(r => yearOf(r) === year)
    const marketCap = incomeRow ? resolvedValue(incomeRow, 'marketCap', basis) : null
    const debt = resolvedValue(row, 'totalDebt', basis)
    const cash = resolvedValue(row, 'cash', basis)
    return enterpriseValueFrom(marketCap, debt, cash)
  }
  if (field.mode === 'ratio') {
    const numTerms = termsFor(data, field.key, 'numerator')
    const denTerms = termsFor(data, field.key, 'denominator')
    const num = sumTerms(data, field.table, numTerms, row, basis)
    let den = sumTerms(data, field.table, denTerms, row, basis)
    // ROE-only: average this year's and last year's denominator rather than
    // using either alone (a year-end balance is a snapshot; averaging
    // approximates capital deployed across the whole year).
    if (field.averageDenominator) {
      const denTable = denTerms[0]?.table || field.table
      const denHist = fieldHistory(data, denTable)
      const year = yearOf(row)
      const idx = denHist.findIndex(r => yearOf(r) === year)
      const prevRow = idx > 0 ? denHist[idx - 1] : null
      const denPrev = prevRow ? sumTerms(data, field.table, denTerms, prevRow, basis) : null
      den = (den != null && denPrev != null) ? (den + denPrev) / 2 : den
    }
    if (num == null || !den) return null
    return (num / den) * (field.scale ?? 1)
  }
  if (field.mode === 'weighted') {
    // Strict: every term must resolve, or the whole row declines — same
    // "don't fabricate a partial answer" rule as everywhere else. This is
    // deliberately the one mode that isn't a pure signed sum (FCFF's
    // EBIT × (1 − Effective Tax Rate) term is a genuine product); a term's
    // OWN sign still applies to that product, same as any other term.
    let sum = 0
    for (const term of termsFor(data, field.key, 'terms')) {
      const termRow = rowForTerm(data, field.table, term, row)
      const v = termRow ? resolvedValue(termRow, term.field, basis) : null
      if (v == null) return null
      let w = 1
      if (term.weightField) {
        const wv = resolvedValue(row, term.weightField, basis)
        if (wv == null) return null
        w = term.weightOneMinus ? (1 - wv) : wv
      }
      sum += (term.sign ?? 1) * v * w
    }
    return sum * (field.scale ?? 1)
  }
  // 'sum' (default)
  return sumTerms(data, field.table, termsFor(data, field.key, 'terms'), row, basis)
}

// ── 'growth' formulas ────────────────────────────────────────────────────
// A multi-year SUMMARY of one field's whole history — full-period CAGR,
// comparable-YoY median, recent median, volatility, and a deterministic
// selected rate — not a per-row bucket combination, so it doesn't go
// through computeForRow/bucketSum at all. See materializeFormulas' own
// 'growth' branch for where this gets written.
//
// No separate "perimeter break" concept: each method (below) is windowed
// by an explicit start AND end year, both directly editable — excluding a
// bad year (an acquisition, a demerger, an in-progress/incomplete latest
// period) is just picking a start/end pair that doesn't span it, the same
// control either way, not a second mechanism layered on top.
const RECENT_GROWTH_YEARS = 3
// stdDev (percentage points) below `low` = low volatility, below `medium` =
// medium, else high. Adjustable, not universal — same standing as
// TERMINAL_GROWTH_BY_MARKET/ERP_BY_MARKET (requiredReturn.js): a disclosed
// convention to calibrate against real data, not a law of finance.
const VOLATILITY_BANDS = { low: 8, medium: 20 }

function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Same guard ratios.js's own realRows() has always used (isFiscalYear +
// !synthetic) — a stub/TTM row can carry a clean-looking 4-digit year with a
// partial-period value, and without this it silently becomes "the latest
// year," corrupting both the YoY series (a partial period compared to a
// full one reads as a huge swing) and materializeFormulas' own "which row
// is latest" pick below.
function isFiscalYearRow(r) {
  return !r?.synthetic && /^\d{4}$/.test(String(r?.year ?? '').trim())
}

function computeGrowthBundle(data, formula, basis) {
  const fLabel = fieldLabel(data, formula.field)
  const series = fieldHistory(data, formula.table)
    .filter(isFiscalYearRow)
    .map(r => ({ year: yearOf(r), value: resolvedValue(r, formula.field, basis) }))
    .filter(p => p.year != null && p.value > 0)
    .sort((a, b) => a.year - b.year)
  if (series.length < 2) return null

  const n = series.length - 1
  const latestYear = series[n].year
  const availableYears = series.map(p => p.year)

  // Every YoY transition, unfiltered — no separate "perimeter break"
  // concept: picking a start AND end year for a method already excludes
  // whatever's outside that range on its own, which is what a break was
  // for in the first place. Wanting to drop a bad year mid-range just
  // means picking a start/end pair on either side of it.
  const yoyAll = []
  for (let i = 1; i < series.length; i++) {
    yoyAll.push({ year: series[i].year, g: (series[i].value / series[i - 1].value - 1) * 100 })
  }

  // Each method is windowed by an explicit start AND end year, both
  // editable straight from that method's own two dropdowns (GrowthMethodRow)
  // — populated from the years actually present in this field's history,
  // the data's real breadth. End defaults to the latest year but is NOT
  // pinned to it: without an adjustable end, there was no way to exclude a
  // bad *latest* year (an incomplete in-progress period, say) from a
  // calculation at all. `n` and the observation count are always
  // recomputed from whichever start/end pair is actually in effect.
  const overrides = data?.growthMethodWindow?.[formula.key] || {}
  const snapToAvailable = (requested, fallback, dir) => {
    if (requested == null) return fallback
    if (availableYears.includes(requested)) return requested
    const pool = dir === 'up' ? availableYears.filter(y => y > requested) : availableYears.filter(y => y < requested)
    if (!pool.length) return fallback
    return dir === 'up' ? Math.min(...pool) : Math.max(...pool)
  }

  const buildEndpointMethod = (key, defaultStartYear, defaultEndYear) => {
    const o = overrides[key] || {}
    const startYear = snapToAvailable(o.start, defaultStartYear, 'up')
    const endYear = snapToAvailable(o.end, defaultEndYear, 'down')
    const startPoint = series.find(p => p.year === startYear)
    const endPoint = series.find(p => p.year === endYear)
    const span = endPoint && startPoint ? endPoint.year - startPoint.year : 0
    if (!startPoint || !endPoint || span <= 0) return { value: null, equation: null, desc: null, startYear, endYear }
    const value = (Math.pow(endPoint.value / startPoint.value, 1 / span) - 1) * 100
    return {
      value,
      equation: `(${fLabel} FY${endPoint.year} ÷ ${fLabel} FY${startPoint.year})^(1/${span}) − 1`,
      desc: `Endpoint CAGR, FY${startPoint.year} → FY${endPoint.year} (${span} year${span === 1 ? '' : 's'})`,
      startYear: startPoint.year, endYear: endPoint.year,
    }
  }
  const buildMedianMethod = (key, defaultStartYear, defaultEndYear) => {
    const o = overrides[key] || {}
    const startYear = snapToAvailable(o.start, defaultStartYear, 'up')
    const endYear = snapToAvailable(o.end, defaultEndYear, 'down')
    const windowed = yoyAll.filter(p => p.year > startYear && p.year <= endYear)
    if (!windowed.length) return { value: null, equation: null, desc: null, startYear, endYear, count: 0 }
    return {
      value: median(windowed.map(p => p.g)),
      equation: `Median( ${fLabel} YoY, FY${windowed[0].year} → FY${windowed[windowed.length - 1].year} )`,
      desc: `Median YoY, FY${windowed[0].year} → FY${windowed[windowed.length - 1].year} (${windowed.length} comparable observation${windowed.length === 1 ? '' : 's'})`,
      startYear, endYear, count: windowed.length,
    }
  }

  const cagr = buildEndpointMethod('fullPeriodCagr', series[0].year, latestYear)
  const med = buildMedianMethod('medianYoY', series[0].year, latestYear)
  const defaultRecentStart = series[Math.max(0, n - RECENT_GROWTH_YEARS)].year
  const recent = buildMedianMethod('recentMedianYoY', defaultRecentStart, latestYear)

  const fullPeriodCagr = cagr.value, fullPeriodCagrEquation = cagr.equation, fullPeriodCagrDesc = cagr.desc
  const medianYoY = med.value, medianYoYEquation = med.equation, medianYoYDesc = med.desc
  const recentMedianYoY = recent.value, recentMedianYoYEquation = recent.equation, recentMedianYoYDesc = recent.desc

  // Volatility is measured over the FULL comparable history regardless of
  // any per-method window — it's a property of how this field behaves
  // overall, not of whichever window a method happens to be looking at.
  const vals = yoyAll.map(p => p.g)
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  const stdDev = vals.length > 1
    ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1)) : null
  const sortedVals = [...vals].sort((a, b) => a - b)
  const quantile = p => {
    const idx = (sortedVals.length - 1) * p
    const lo = Math.floor(idx), hi = Math.ceil(idx)
    return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * (idx - lo)
  }
  const iqr = sortedVals.length >= 4 ? quantile(0.75) - quantile(0.25) : null
  const volatilityClass = stdDev == null ? null
    : stdDev < VOLATILITY_BANDS.low ? 'low'
    : stdDev < VOLATILITY_BANDS.medium ? 'medium' : 'high'

  // The ONE real control — set from the header (GrowthMethodBadge), not the
  // Formulas tab, which only ever DISPLAYS every method as its own static
  // card. Defaults to the full-history median when nothing's picked.
  const methodOverride = data?.growthMethodOverride?.[formula.key]
  const BASE_METHODS = {
    fullPeriodCagr:  { value: fullPeriodCagr,  label: 'Full-period CAGR' },
    medianYoY:       { value: medianYoY,       label: 'Median YoY (comparable)' },
    recentMedianYoY: { value: recentMedianYoY, label: 'Recent median YoY' },
  }
  let selected, method
  if (methodOverride && BASE_METHODS[methodOverride]?.value != null) {
    selected = BASE_METHODS[methodOverride].value
    method = `Manually selected: ${BASE_METHODS[methodOverride].label}`
  } else {
    selected = medianYoY
    method = medianYoYDesc || `Median of ${med.count || 0} comparable years`
  }

  return {
    fullPeriodCagr, fullPeriodCagrEquation, fullPeriodCagrDesc,
    fullPeriodCagrStartYear: cagr.startYear, fullPeriodCagrEndYear: cagr.endYear,
    medianYoY, medianYoYEquation, medianYoYDesc,
    medianYoYStartYear: med.startYear, medianYoYEndYear: med.endYear,
    recentMedianYoY, recentMedianYoYEquation, recentMedianYoYDesc,
    recentMedianYoYStartYear: recent.startYear, recentMedianYoYEndYear: recent.endYear,
    stdDev, iqr, volatilityClass,
    availableStartYears: availableYears.slice(0, -1),
    availableEndYears: availableYears.slice(1),
    selected, method, methodOverride: methodOverride || null,
  }
}

/**
 * Writes each DERIVED_FORMULAS entry's own output onto the row it belongs
 * to — {key}/{key}Normalized, the same sibling-field convention every
 * other formula in this app uses. DERIVED_FORMULAS today holds only
 * 'growth' entries (revenueGrowth/netProfitGrowth) — everything else lives
 * as a computed custom row now (see materializeCustomRows below).
 *
 * 'growth' is a summary of the WHOLE series, not a per-row value — written
 * onto the latest row only (nothing downstream ever wants "growth as of
 * 2015 mid-history," only the current reading), with the full bundle
 * (every method, not just the selected one) riding along as `.methods` so
 * a UI can offer every candidate for inspection, not just the pick.
 */
export function materializeFormulas(data) {
  let out = data
  for (const formula of Object.values(DERIVED_FORMULAS)) {
    const histKey = formula.table === 'income' ? 'reportedIncomeHistory' : `${formula.table}History`
    const base = fieldHistory(out, formula.table)
    if (!base.length) continue
    const normKey = `${formula.key}Normalized`

    // Real fiscal-year rows only (see isFiscalYearRow) — a synthetic/TTM
    // stub with a later-looking year must never win "latest," or the
    // whole bundle gets written onto (and read back from) a row that
    // isn't a real, complete year.
    const realBase = base.filter(isFiscalYearRow)
    const latestPool = realBase.length ? realBase : base
    const latest = latestPool.reduce((a, b) => (yearOf(b) > yearOf(a) ? b : a))
    const reportedBundle = computeGrowthBundle(out, formula, 'reported')
    const normalizedBundle = computeGrowthBundle(out, formula, 'normalized')
    const newHistory = base.map(row => {
      if (row !== latest) {
        if (!(formula.key in row) && !(normKey in row)) return row
        const { [formula.key]: _a, [normKey]: _b, ...rest } = row
        return rest
      }
      let next = { ...row }
      if (reportedBundle) {
        next[formula.key] = { value: reportedBundle.selected, status: 'calculated', formula: reportedBundle.method, methods: reportedBundle }
      } else if (formula.key in next) {
        const { [formula.key]: _a, ...rest } = next; next = rest
      }
      if (normalizedBundle && normalizedBundle.selected !== reportedBundle?.selected) {
        next[normKey] = { value: normalizedBundle.selected, adjusted: true, formula: normalizedBundle.method, methods: normalizedBundle }
      } else if (normKey in next) {
        const { [normKey]: _d, ...rest } = next; next = rest
      }
      return next
    })
    out = formula.table === 'income'
      ? { ...out, reportedIncomeHistory: newHistory }
      : { ...out, [histKey]: newHistory }
  }
  return out
}

// Method key -> its three field names in a computeGrowthBundle bundle
// (formula.key/formula.keyStartYear/formula.keyEndYear) — used below to
// look up whichever method is actually in play without three separate
// if-chains.
const GROWTH_METHOD_FIELDS = {
  fullPeriodCagr:  ['fullPeriodCagr',  'fullPeriodCagrStartYear',  'fullPeriodCagrEndYear'],
  medianYoY:       ['medianYoY',       'medianYoYStartYear',       'medianYoYEndYear'],
  recentMedianYoY: ['recentMedianYoY', 'recentMedianYoYStartYear', 'recentMedianYoYEndYear'],
}

/**
 * The table's own growth reading for one DERIVED_FORMULAS growth entry
 * ('revenueGrowth' or 'netProfitGrowth'), toggle-conscious — the single
 * growth figure every consumer (DCF, App Target, Market Expectation, the
 * Quality Score, stage classification, ...) should read, replacing each of
 * them separately recomputing their own windowed CAGR.
 *
 * Reported basis: always the plain full-period CAGR (first year to latest,
 * no method-selection cleverness) — "as reported" means the literal
 * compounding between the two ends of the data, nothing smarter.
 * Normalized basis: whichever method is actually selected for this ticker
 * (the header's GrowthMethodBadge override, or the medianYoY default when
 * nothing's been picked) — the SAME selection already governing what the
 * Formulas tab and header show, not a second, independent "best fit" of
 * its own. Falls back to the reported bundle's own selection when nothing
 * was actually normalized that year (no normalized sibling exists).
 *
 * materializeFormulas must already have run (computeAll's own order) —
 * this reads what it wrote, it doesn't recompute anything itself.
 */
export function tableGrowthRate(data, formulaKey, basis) {
  const formula = DERIVED_FORMULAS[formulaKey]
  if (!formula) return { value: null, windowYears: null }
  const base = fieldHistory(data, formula.table)
  if (!base.length) return { value: null, windowYears: null }
  const realBase = base.filter(isFiscalYearRow)
  const latestPool = realBase.length ? realBase : base
  const latest = latestPool.reduce((a, b) => (yearOf(b) > yearOf(a) ? b : a))

  const empty = { value: null, windowYears: null }
  const fromBundle = (bundle, methodKey) => {
    const fields = GROWTH_METHOD_FIELDS[methodKey]
    if (!bundle || !fields) return empty
    const [vKey, sKey, eKey] = fields
    const value = bundle[vKey] ?? null
    const start = bundle[sKey], end = bundle[eKey]
    return { value, windowYears: (start != null && end != null) ? end - start : null }
  }

  if (basis === 'normalized') {
    const normRow = latest[`${formula.key}Normalized`] ?? latest[formula.key]
    const bundle = normRow?.methods
    return fromBundle(bundle, bundle?.methodOverride || 'medianYoY')
  }
  return fromBundle(latest[formula.key]?.methods, 'fullPeriodCagr')
}

/**
 * Materializes every `computed: true` custom field's value onto its own
 * row, from whatever definition it currently has (a STANDARD_FORMULA_ROWS
 * seed, or the user's own edit — see seedStandardFormulaRows/normalize.js
 * for how a row gets its first definition, ONCE, and never again). This is
 * the data-driven replacement for the old DERIVED_FORMULAS
 * 'derived'/'fallback'/'ratio'/'weighted' kinds.
 *
 * A computed row can reference ANOTHER computed row (Tax reading Profit
 * Before Tax, FCFF reading EBIT and Effective Tax Rate) — since there's no
 * fixed code declaration order any more (the set of computed rows, and
 * what each one reads, is entirely data), this iterates: materialize
 * whatever resolves, repeat until a pass changes nothing. Capped at 10
 * rounds purely as a runaway guard — every real chain in this registry
 * resolves in well under that.
 *
 * A field whose key ALSO happens to be a real, independently-reportable
 * metrics.js field (Gross Profit, Profit Before Tax, Tax, EBITDA, EBIT,
 * Free Cash Flow all sometimes are) never overwrites a genuine reported
 * value already sitting on the row — it only computes when that's absent,
 * or when what's there was itself written by an EARLIER pass of this same
 * function (status:'calculated' — the one thing distinguishing "a real
 * reported figure" from "nothing here yet, compute it"). A real reported
 * value's own Normalized sibling stays exactly as recomputeNormalizedTargets
 * (the ordinary restatement mechanism) already produced it — never touched
 * here.
 */
export function materializeCustomRows(data) {
  let out = data
  for (let pass = 0; pass < 10; pass++) {
    const computedFields = (out.customFields || []).filter(f => f.computed)
    if (!computedFields.length) break
    let changedThisPass = false

    for (const field of computedFields) {
      const base = fieldHistory(out, field.table)
      if (!base.length) continue
      const histKey = field.table === 'income' ? 'reportedIncomeHistory' : `${field.table}History`
      const normKey = `${field.key}Normalized`

      // A field whose key is ALSO a restatement TARGET (grossProfit, PBT,
      // tax, EBITDA, EBIT, freeCashFlow can each be one — see
      // availableTargets) has a second, independent way to get a Normalized
      // sibling: a user directly restating the whole figure, via
      // recomputeNormalizedTargets (runs before this, every computeAll
      // pass). That one wins outright — it's an explicit, evidence-based
      // correction to the field itself; this function's own normalized
      // computation (deriving it from the field's OWN TERMS' normalized
      // values) knows nothing about that direct restatement and must not
      // recompute over it.
      const isRestatementTarget = (out.fieldAssignments || [])
        .some(a => a.kind === 'restatement' && a.target === field.key)

      const newHistory = base.map(row => {
        // Highest precedence, always: a genuinely typed-in Normalized figure
        // (HistoryTableModal's own Normalized row) is real, hand-entered
        // data — never recomputed over, never stripped, regardless of what
        // happens to the reported side or whether this field is also a
        // restatement target.
        const isManualNormalized = row[normKey]?.manual === true

        const existing = row[field.key]
        if (existing != null && existing.status !== 'calculated') return row

        const reported = computeCustomRowValue(out, field, row, 'reported')
        if (reported == null) {
          if (isManualNormalized) {
            if (field.key in row) { changedThisPass = true; const { [field.key]: _a, ...rest } = row; return rest }
            return row
          }
          // recomputeNormalizedTargets itself declines to write normKey for
          // any row whose target has no value (see its own `reported?.value
          // == null` guard) — so if THIS formula can't produce a value
          // either, normKey can't legitimately exist here regardless of
          // isRestatementTarget; stripping both is always correct.
          if (!(field.key in row) && !(normKey in row)) return row
          changedThisPass = true
          const { [field.key]: _a, [normKey]: _b, ...rest } = row
          return rest
        }
        let next = { ...row, [field.key]: { value: reported, status: 'calculated', formula: null } }
        if (!isRestatementTarget && !isManualNormalized) {
          const normalized = computeCustomRowValue(out, field, row, 'normalized')
          if (normalized != null && normalized !== reported) {
            next[normKey] = { value: normalized, adjusted: true, formula: null }
          } else if (normKey in next) {
            const { [normKey]: _drop, ...rest } = next
            next = rest
          }
        }
        if (existing?.value !== reported) changedThisPass = true
        return next
      })
      out = field.table === 'income'
        ? { ...out, reportedIncomeHistory: newHistory }
        : { ...out, [histKey]: newHistory }
    }
    if (!changedThisPass) break
  }
  return out
}

/**
 * One-time creation of the ~20 standard computed rows (STANDARD_FORMULA_ROWS)
 * for a ticker that doesn't have them yet — checked by KEY, not a separate
 * ledger: if data.customFields already has an entry for this key, it's
 * left completely alone (it's the user's own row now, whatever they've
 * built it into — never reverted to the seed). Called once from
 * migrateStoredData (normalize.js), the same idempotent-migration
 * chokepoint every other retroactive fix in this app already uses.
 */
export function seedStandardFormulaRows(data) {
  if (!data) return data
  const existingKeys = new Set((data.customFields || []).map(f => f.key))
  const missing = Object.values(STANDARD_FORMULA_ROWS).filter(f => !existingKeys.has(f.key))
  if (!missing.length) return data

  const newFields = missing.map(f => ({
    key: f.key, label: f.label, table: f.table, computed: true,
    mode: f.mode, scale: f.scale, averageDenominator: f.averageDenominator,
  }))
  const newAssignments = []
  for (const f of missing) {
    const pushTerms = (terms, bucket) => {
      for (const t of (terms || [])) {
        newAssignments.push({
          field: t.field, kind: 'formula', formula: f.key, bucket,
          sign: t.sign ?? 1, table: t.table, lag: t.lag,
          weightField: t.weightField, weightOneMinus: t.weightOneMinus,
        })
      }
    }
    if (f.mode === 'ratio') { pushTerms(f.numerator, 'numerator'); pushTerms(f.denominator, 'denominator') }
    else pushTerms(f.terms, 'terms')
  }
  return {
    ...data,
    customFields: [...(data.customFields || []), ...newFields],
    fieldAssignments: [...(data.fieldAssignments || []), ...newAssignments],
  }
}

/** Every assignment currently on this field, across both kinds. */
export function assignmentsForField(data, field) {
  return (data?.fieldAssignments || []).filter(a => a.field === field)
}
