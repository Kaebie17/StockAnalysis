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

function hasData(data, field) {
  const table = fieldTable(data, field)
  if (!table) return false
  return fieldHistory(data, table).some(r => rowValue(r, field) != null)
}

// Fixed, code-defined shape: buckets and how they combine. This is the part
// the user meant by "you need to be smart about how the buckets will be
// created" — not every formula is assets-minus-liabilities, so each one
// spells out its own bucket signs rather than inferring a rule.
//
// Two kinds:
//   'derived'  — the buckets ARE the value; there's no separately-reported
//                figure to prefer (Net Working Capital — no statement ever
//                discloses "NWC" as its own line).
//   'fallback' — a figure that MAY already be directly reported (Gross
//                Profit, Profit Before Tax, Tax, EBITDA all sometimes are)
//                — if it is, that reported value and ITS OWN normalization
//                (the ordinary restatement mechanism, since these are all
//                real metrics.js fields) stand untouched; the buckets only
//                fill in when it's genuinely absent. Ports ratios.js's old
//                inline "reported ?? derived" ladders one for one — same
//                fallback order, just centralized instead of copied inline
//                wherever the figure was needed.
//
// Declaration order matters for 'fallback' entries that consume another
// formula's own output (tax reads profitBeforeTax) — materializeFormulas
// processes this object's entries in order, so profitBeforeTax must be
// declared, and therefore materialized, before tax.
const DERIVED_FORMULAS = {
  nwc: {
    key: 'nwc',
    kind: 'derived',
    label: 'Net Working Capital',
    table: 'balance',
    buckets: [
      // Candidate filtering is NOT declared per bucket here any more — see
      // candidatesFor (HistoryTableModal.jsx): it derives the valid set from
      // metrics.js's own expandFrom tag (tradeReceivables/inventories both
      // expand from "Other Assets"; tradePayables/advanceFromCustomers both
      // expand from "Other Liabilities" — real, already-declared category
      // siblings, not a second hand-maintained list that a newly added
      // metrics.js field would silently fall outside of).
      { key: 'currentOperatingAssets',      label: 'Current Operating Assets',      sign: 1,  defaults: ['tradeReceivables', 'inventories'] },
      { key: 'currentOperatingLiabilities', label: 'Current Operating Liabilities', sign: -1, defaults: ['tradePayables', 'advanceFromCustomers'] },
    ],
  },
  capitalEmployed: {
    key: 'capitalEmployed',
    kind: 'derived',
    label: 'Capital Employed',
    table: 'balance',
    buckets: [
      { key: 'equity', label: 'Equity', sign: 1, defaults: ['totalEquity'] },
      { key: 'debt',   label: 'Debt',   sign: 1, defaults: ['totalDebt'] },
    ],
  },
  netDebt: {
    key: 'netDebt',
    kind: 'derived',
    label: 'Net Debt',
    table: 'balance',
    buckets: [
      { key: 'debt', label: 'Debt', sign: 1,  defaults: ['totalDebt'] },
      { key: 'cash', label: 'Cash', sign: -1, defaults: ['cash'] },
    ],
  },
  grossProfit: {
    key: 'grossProfit',
    kind: 'fallback',
    label: 'Gross Profit',
    table: 'income',
    buckets: [
      { key: 'revenue', label: 'Revenue', sign: 1,  defaults: ['revenue'] },
      { key: 'cogs',    label: 'COGS',    sign: -1, defaults: ['cogs'] },
    ],
  },
  profitBeforeTax: {
    key: 'profitBeforeTax',
    kind: 'fallback',
    label: 'Profit Before Tax',
    table: 'income',
    buckets: [
      { key: 'operatingProfit', label: 'Operating Profit', sign: 1,  defaults: ['operatingProfit'] },
      { key: 'otherIncome',     label: 'Other Income',     sign: 1,  defaults: ['otherIncome'] },
      { key: 'interest',        label: 'Interest',         sign: -1, defaults: ['interest'] },
      { key: 'depreciation',    label: 'Depreciation',     sign: -1, defaults: ['depreciation'] },
    ],
  },
  // Reads profitBeforeTax's own materialized output, not a raw field — see
  // the ordering note above.
  tax: {
    key: 'tax',
    kind: 'fallback',
    label: 'Tax',
    table: 'income',
    buckets: [
      { key: 'pbt',       label: 'Profit Before Tax', sign: 1,  defaults: ['profitBeforeTax'] },
      { key: 'netProfit', label: 'Net Profit',        sign: -1, defaults: ['netProfit'] },
    ],
  },
  ebitda: {
    key: 'ebitda',
    kind: 'fallback',
    label: 'EBITDA',
    table: 'income',
    // One bucket, not two signed ones: a bucket sum tolerates a missing
    // member (skips it rather than failing the whole formula), which is
    // exactly the old ladder's "Op Profit + Depreciation, or Op Profit
    // alone if Depreciation is missing" — for free, from the bucket-sum
    // rule itself, not a separate ladder.
    buckets: [
      { key: 'components', label: 'Components', sign: 1, defaults: ['operatingProfit', 'depreciation'] },
    ],
  },
  // EBIT is never itself a disclosed line — but Operating Profit effectively
  // IS EBIT whenever it's reported (this app's own convention — see ROCE),
  // so its reportedField points at operatingProfit instead of at 'ebit'
  // itself. Falls back to EBITDA − Depreciation (tolerating Depreciation
  // being missing, same bucket-sum rule as EBITDA's own fallback) only when
  // Operating Profit is genuinely absent. Declared after ebitda since the
  // fallback path depends on its materialized output.
  ebit: {
    key: 'ebit',
    kind: 'fallback',
    label: 'EBIT',
    table: 'income',
    reportedField: 'operatingProfit',
    buckets: [
      { key: 'ebitda',       label: 'EBITDA',       sign: 1,  defaults: ['ebitda'] },
      { key: 'depreciation', label: 'Depreciation', sign: -1, defaults: ['depreciation'] },
    ],
  },
  // Free Cash Flow: a real metrics.js field (base:false, estimable:true) —
  // ratios.js used to estimate it inline (operatingCF − capex) the exact
  // same way EBITDA/EBIT used to before THEY were registered; this is that
  // same move for FCF. table:'cashflow' since both its own reported figure
  // and both bucket members live there.
  freeCashFlow: {
    key: 'freeCashFlow',
    kind: 'fallback',
    label: 'Free Cash Flow',
    table: 'cashflow',
    buckets: [
      { key: 'operatingCF', label: 'Operating Cash Flow', sign: 1,  defaults: ['operatingCF'] },
      { key: 'capex',       label: 'CapEx',               sign: -1, defaults: ['capex'] },
    ],
  },
  // ── 'ratio' formulas: numerator ÷ denominator × scale ─────────────────────
  // Each bucket may declare its OWN `table` when it differs from the
  // formula's primary one (ROA/ROE/Net Debt÷EBITDA all mix a P&L figure
  // with a balance-sheet one) — resolved by matching YEAR across the two
  // statements (see rowForBucket), not by sharing a row object. Declared
  // after grossProfit/ebitda/netDebt/capitalEmployed since several of
  // these use THOSE formulas' own materialized output as a default
  // ingredient (EBITDA, Net Debt) — same ordering rule as tax/profitBeforeTax.
  netMargin: {
    key: 'netMargin', kind: 'ratio', label: 'Net Margin', table: 'income', scale: 100,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Net Profit', sign: 1, defaults: ['netProfit'] },
      { key: 'denominator', role: 'denominator', label: 'Revenue',    sign: 1, defaults: ['revenue'] },
    ],
  },
  operatingMargin: {
    key: 'operatingMargin', kind: 'ratio', label: 'Operating Margin', table: 'income', scale: 100,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Operating Profit', sign: 1, defaults: ['operatingProfit'] },
      { key: 'denominator', role: 'denominator', label: 'Revenue',          sign: 1, defaults: ['revenue'] },
    ],
  },
  ebitdaMargin: {
    key: 'ebitdaMargin', kind: 'ratio', label: 'EBITDA Margin', table: 'income', scale: 100,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'EBITDA',  sign: 1, defaults: ['ebitda'] },
      { key: 'denominator', role: 'denominator', label: 'Revenue', sign: 1, defaults: ['revenue'] },
    ],
  },
  grossMarginPct: {
    key: 'grossMarginPct', kind: 'ratio', label: 'Gross Margin', table: 'income', scale: 100,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Gross Profit', sign: 1, defaults: ['grossProfit'] },
      { key: 'denominator', role: 'denominator', label: 'Revenue',      sign: 1, defaults: ['revenue'] },
    ],
  },
  roa: {
    key: 'roa', kind: 'ratio', label: 'Return on Assets', table: 'income', scale: 100,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Net Profit',  sign: 1, defaults: ['netProfit'] },
      { key: 'denominator', role: 'denominator', label: 'Total Assets', table: 'balance', sign: 1, defaults: ['totalAssets'] },
    ],
  },
  // Depends on EBIT's own materialized output (declared above) and Capital
  // Employed (declared earlier still) — both real fields by the time this
  // runs, so ROCE itself needs no fallback ladder of its own any more.
  roce: {
    key: 'roce', kind: 'ratio', label: 'Return on Capital Employed', table: 'income', scale: 100,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'EBIT',              sign: 1, defaults: ['ebit'] },
      { key: 'denominator', role: 'denominator', label: 'Capital Employed',  table: 'balance', sign: 1, defaults: ['capitalEmployed'] },
    ],
  },
  de: {
    key: 'de', kind: 'ratio', label: 'Debt-to-Equity', table: 'balance',
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Total Debt',   sign: 1, defaults: ['totalDebt'] },
      { key: 'denominator', role: 'denominator', label: 'Total Equity', sign: 1, defaults: ['totalEquity'] },
    ],
  },
  icr: {
    key: 'icr', kind: 'ratio', label: 'Interest Coverage', table: 'income',
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'EBITDA',   sign: 1, defaults: ['ebitda'] },
      { key: 'denominator', role: 'denominator', label: 'Interest', sign: 1, defaults: ['interest'] },
    ],
  },
  netDebtToEbitda: {
    key: 'netDebtToEbitda', kind: 'ratio', label: 'Net Debt / EBITDA', table: 'balance',
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Net Debt', sign: 1, defaults: ['netDebt'] },
      { key: 'denominator', role: 'denominator', label: 'EBITDA',   table: 'income', sign: 1, defaults: ['ebitda'] },
    ],
  },
  // Only formula needing averageDenominator: ROE compares one year's profit
  // against the AVERAGE of this year's and last year's equity, not either
  // year alone — the standard convention (a year-end balance is a snapshot;
  // averaging approximates the capital actually deployed across the year).
  roe: {
    key: 'roe', kind: 'ratio', label: 'Return on Equity', table: 'income', scale: 100, averageDenominator: true,
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Net Profit',   sign: 1, defaults: ['netProfit'] },
      { key: 'denominator', role: 'denominator', label: 'Total Equity', table: 'balance', sign: 1, defaults: ['totalEquity'] },
    ],
  },
  // Measured (not statutory) effective tax rate — a decimal, not a percent
  // (no `scale`, same convention D/E and ICR already use for a raw ratio
  // rather than a displayed percentage): what THIS company actually paid
  // against pre-tax profit, used as FCFF's tax-shield weight below. Declared
  // after tax/profitBeforeTax since it reads both formulas' own outputs.
  effectiveTaxRate: {
    key: 'effectiveTaxRate', kind: 'ratio', label: 'Effective Tax Rate', table: 'income',
    buckets: [
      { key: 'numerator',   role: 'numerator',   label: 'Tax',                sign: 1, defaults: ['tax'] },
      { key: 'denominator', role: 'denominator', label: 'Profit Before Tax',  sign: 1, defaults: ['profitBeforeTax'] },
    ],
  },
  // Free Cash Flow to Firm — unlevered cash flow available to ALL
  // capital providers (equity + debt), the numerator DCF/enterprise-value
  // work actually wants, vs freeCashFlow above which is already net of
  // interest (a levered, equity-side figure). The one term that isn't a
  // plain additive field — EBIT × (1 − effective tax rate) — is exactly
  // why this needs 'weighted' rather than 'derived': a bucket sum can only
  // ADD signed fields, never multiply two of them together.
  //
  // ΔNWC is expressed as two lagged terms (this year's NWC minus last
  // year's) rather than one "change" bucket, because there's no such thing
  // as a single stored "NWC change" field to point at — nwc itself only
  // exists per-year, so the subtraction has to happen HERE, at the point
  // FCFF needs it, via the same `lag` mechanism rowForBucket/resolveTermValue
  // already support for any cross-year term.
  fcff: {
    key: 'fcff', kind: 'weighted', label: 'Free Cash Flow to Firm', table: 'income',
    terms: [
      { key: 'nopat', label: 'EBIT × (1 − Effective Tax Rate)',
        value: { field: 'ebit' }, weight: { field: 'effectiveTaxRate', oneMinus: true } },
      { key: 'da', label: 'Depreciation & Amortization',
        value: { field: 'depreciation' }, weight: 1 },
      { key: 'capex', label: 'CapEx',
        value: { field: 'capex', table: 'cashflow' }, weight: -1 },
      { key: 'nwc', label: 'Net Working Capital (current year)',
        value: { field: 'nwc', table: 'balance' }, weight: -1 },
      { key: 'nwcPrior', label: 'Net Working Capital (prior year)',
        value: { field: 'nwc', table: 'balance', lag: 1 }, weight: 1 },
    ],
  },
  // ── 'growth' formulas: a multi-year SUMMARY of one field's whole history,
  // not a per-row bucket combination — see computeGrowthBundle below for the
  // actual statistics (full-period CAGR, comparable-YoY median, recent
  // median, volatility, and the deterministic selected rate). No `buckets`:
  // there's exactly one input field, named directly.
  revenueGrowth:   { key: 'revenueGrowth',   kind: 'growth', label: 'Revenue Growth',    table: 'income', field: 'revenue' },
  netProfitGrowth: { key: 'netProfitGrowth', kind: 'growth', label: 'Net Profit Growth', table: 'income', field: 'netProfit' },
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
      const normKey = `${target}Normalized`
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
  return [...restatement, ...Object.values(DERIVED_FORMULAS)]
}

/**
 * One-time seeding of the known constituents of a derived formula (NWC's
 * four tracked working-capital fields) into data.fieldAssignments, so the
 * user never has to hand-wire what's already known. Guarded per (field,
 * formula, bucket) triple by data.formulaDefaultsApplied — once a triple's
 * been offered, it's never re-added even if the user deletes it, but a
 * triple whose field has NO data yet (a ticker with no balance sheet pasted
 * yet) is left un-applied so it can still seed later once that data exists.
 * Called from migrateStoredData (normalize.js) — same idempotent-migration
 * chokepoint every other retroactive fix in this app already uses.
 */
export function seedFormulaDefaults(data) {
  if (!data) return data
  const applied = new Set(data.formulaDefaultsApplied || [])
  const assignments = [...(data.fieldAssignments || [])]
  let changed = false

  for (const formula of Object.values(DERIVED_FORMULAS)) {
    // 'growth' has no buckets at all (a whole-series summary, not a
    // per-row combination); 'weighted' names its inputs directly (see
    // resolveTermValue) rather than through assignable buckets — neither
    // has anything for this seeding step to do.
    for (const bucket of (formula.buckets || [])) {
      for (const field of (bucket.defaults || [])) {
        const triple = `${field}:${formula.key}:${bucket.key}`
        if (applied.has(triple)) continue
        if (!hasData(data, field)) continue
        const already = assignments.some(a =>
          a.field === field && a.kind === 'formula' && a.formula === formula.key && a.bucket === bucket.key)
        if (!already) assignments.push({ field, kind: 'formula', formula: formula.key, bucket: bucket.key, sign: 1 })
        applied.add(triple)
        changed = true
      }
    }
  }
  if (!changed) return data
  return { ...data, fieldAssignments: assignments, formulaDefaultsApplied: [...applied] }
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

// A bucket's OWN statement, when it declares one (ROA/ROE/Net Debt÷EBITDA
// mix a P&L figure with a balance-sheet one) — matched to the primary row's
// YEAR, since the two tables are separate arrays, not the same row object.
// `bucket.lag` (years back from the primary row's year) is the other way a
// bucket can point somewhere other than "this same row" — ΔNWC-style terms
// (FCFF) need THIS year's value minus LAST year's of the SAME field, which
// is a lag of 1 on the SAME table, not a different one; the two are
// independent (a bucket can set either, both, or neither).
function rowForBucket(data, formula, bucket, primaryRow) {
  const table = bucket.table || formula.table
  const lag = bucket.lag || 0
  if (table === formula.table && lag === 0) return primaryRow
  const year = yearOf(primaryRow)
  if (year == null) return null
  return fieldHistory(data, table).find(r => yearOf(r) === year - lag) || null
}

// 'weighted' formulas (Free Cash Flow to Firm — see DERIVED_FORMULAS) name
// their inputs DIRECTLY (a metrics.js field, or another formula's own
// output field, e.g. 'ebit'/'nwc') rather than going through the
// user-assignable fieldAssignments/bucketSum indirection every other kind
// uses — there's nothing to REBUCKET here (nobody maps a custom row into
// "the EBIT term of FCFF"; they'd map it into EBIT itself, upstream, and
// this reads whatever EBIT resolves to). A term spec is either a bare
// number (a fixed weight, e.g. -1 for a subtracted term) or
// {field, table?, lag?, oneMinus?} — table/lag mirror rowForBucket's own
// cross-table/prior-year resolution; oneMinus turns a resolved rate r into
// (1 - r), the shape a tax-shield weight (1 - effective tax rate) needs.
function resolveTermValue(data, formula, spec, row, basis) {
  if (spec == null) return null
  if (typeof spec === 'number') return spec
  const table = spec.table || formula.table
  const lag = spec.lag || 0
  const specRow = (table === formula.table && lag === 0) ? row
    : fieldHistory(data, table).find(r => yearOf(r) === yearOf(row) - lag)
  if (!specRow) return null
  const v = resolvedValue(specRow, spec.field, basis)
  if (v == null) return null
  return spec.oneMinus ? (1 - v) : v
}

function bucketSum(data, formulaKey, bucket, row, basis) {
  if (!row) return null
  const contributors = (data?.fieldAssignments || [])
    .filter(a => a.kind === 'formula' && a.formula === formulaKey && a.bucket === bucket.key)
  let sum = null
  for (const c of contributors) {
    const v = resolvedValue(row, c.field, basis)
    if (v != null) sum = (sum ?? 0) + (c.sign ?? 1) * v
  }
  return sum
}

function computeForRow(data, formulaKey, row, basis) {
  const formula = DERIVED_FORMULAS[formulaKey]
  if (!formula || !row) return null

  if (formula.kind === 'ratio') {
    const numBucket = formula.buckets.find(b => b.role === 'numerator')
    const denBucket = formula.buckets.find(b => b.role === 'denominator')
    const num = bucketSum(data, formulaKey, numBucket, rowForBucket(data, formula, numBucket, row), basis)
    let den = bucketSum(data, formulaKey, denBucket, rowForBucket(data, formula, denBucket, row), basis)
    // ROE-only: average this year's and last year's denominator rather than
    // using either alone (a year-end balance is a snapshot; averaging
    // approximates capital deployed across the whole year). Falls back to
    // the single current-year figure when there's no prior year to average
    // against, same as ratios.js's own avgEquity.
    if (formula.averageDenominator) {
      const denTable = denBucket.table || formula.table
      const denHist = fieldHistory(data, denTable)
      const year = yearOf(row)
      const idx = denHist.findIndex(r => yearOf(r) === year)
      const prevDenRow = idx > 0 ? denHist[idx - 1] : null
      const denPrev = prevDenRow ? bucketSum(data, formulaKey, denBucket, prevDenRow, basis) : null
      den = (den != null && denPrev != null) ? (den + denPrev) / 2 : den
    }
    if (num == null || !den) return null
    return (num / den) * (formula.scale ?? 1)
  }

  if (formula.kind === 'weighted') {
    // Strict: every term must resolve, or the whole formula declines — same
    // "don't fabricate a partial answer" rule as every other kind. Unlike
    // WACC's own weights (E/(E+D), D/(E+D) — genuinely conditional: an
    // all-equity company legitimately has a ZERO debt weight, not a missing
    // one, so a term can validly drop out without the formula failing),
    // FCFF's terms are all real, always-applicable statement lines — there's
    // no valid state where one of them is supposed to be absent. That
    // conditional-weight case is exactly why WACC itself stays procedural in
    // valuation.js rather than being forced into this generic shape.
    let sum = 0
    for (const term of formula.terms) {
      const v = resolveTermValue(data, formula, term.value, row, basis)
      const w = resolveTermValue(data, formula, term.weight, row, basis)
      if (v == null || w == null) return null
      sum += v * w
    }
    return sum * (formula.scale ?? 1)
  }

  // 'derived' / 'fallback': the buckets ARE the value, combined by sum with
  // each bucket's own sign — always single-table today.
  const bucketSums = {}
  for (const bucket of formula.buckets) bucketSums[bucket.key] = bucketSum(data, formulaKey, bucket, row, basis)
  if (Object.values(bucketSums).some(v => v == null)) return null
  let output = 0
  for (const bucket of formula.buckets) output += bucket.sign * bucketSums[bucket.key]
  return output
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
 * Writes each derived formula's own output directly onto the row it belongs
 * to — {key} for the reported figure, {key}Normalized alongside it only
 * when normalizing an input actually changes the result — the EXACT same
 * sibling-field convention netProfit/eps and the restatement targets
 * already use. This is the whole point: a formula's result becomes just
 * another field on the row, so any consumer (ratios.js, valuation.js, the
 * Formulas tab) reads it with the SAME activeValue(row, key, basis) call it
 * already uses for revenue or netProfit — no formulas.js-specific accessor,
 * no re-deriving it from fieldAssignments at every read site. Called from
 * computeAll (AppContext.jsx) right after recomputeNormalizedTargets, so a
 * formula's own inputs (tradeReceivablesNormalized etc.) already exist by
 * the time it runs, and every path that changes an assignment, a value, or
 * a normalization automatically keeps this in sync — there's nothing to
 * carry over by hand, and nothing for an inline copy elsewhere to miss.
 */
export function materializeFormulas(data) {
  let out = data
  for (const formula of Object.values(DERIVED_FORMULAS)) {
    const histKey = formula.table === 'income' ? 'reportedIncomeHistory' : `${formula.table}History`
    const base = fieldHistory(out, formula.table)
    if (!base.length) continue
    const normKey = `${formula.key}Normalized`

    // 'growth': a summary of the WHOLE series, not a per-row value — written
    // onto the latest row only (nothing downstream ever wants "growth as of
    // 2015 mid-history," only the current reading), with the full bundle
    // (every method, not just the selected one) riding along as `.methods`
    // so a UI can offer every candidate for inspection, not just the pick.
    if (formula.kind === 'growth') {
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
      continue
    }

    const newHistory = base.map(row => {
      // 'fallback': a real reported value already exists for whichever
      // field counts as "reported" for this formula (formula.key itself,
      // e.g. Gross Profit — or a DIFFERENT field entirely, when the
      // formula's own output has no metrics.js field of its own to check:
      // EBIT is never a disclosed line, but Operating Profit effectively
      // IS EBIT whenever it's reported, so EBIT's reportedField points at
      // operatingProfit instead of at itself) — leave it, and its OWN
      // Normalized sibling, completely alone. A genuine restatement-
      // eligible metrics.js field already gets its normalization handled
      // independently by recomputeNormalizedTargets (which already ran,
      // above); the buckets here only fill the figure in when it's
      // genuinely absent.
      const reportedField = formula.reportedField || formula.key
      if (formula.kind === 'fallback' && rowValue(row, reportedField) != null) {
        if (formula.key === reportedField) return row
        // Copying a DIFFERENT field's value forward (EBIT <- Operating
        // Profit) — carry its Normalized sibling forward too, so a
        // restatement on the real field (Operating Profit) still reaches
        // EBIT, which has no metrics.js entry of its own to be restated
        // through directly.
        const next = { ...row, [formula.key]: row[reportedField] }
        const reportedNormKey = `${reportedField}Normalized`
        if (row[reportedNormKey] != null) next[normKey] = row[reportedNormKey]
        else if (normKey in next) { const { [normKey]: _drop, ...rest } = next; return rest }
        return next
      }
      const reported = computeForRow(out, formula.key, row, 'reported')
      if (reported == null) {
        if (!(formula.key in row) && !(normKey in row)) return row
        const { [formula.key]: _a, [normKey]: _b, ...rest } = row
        return rest
      }
      let next = { ...row, [formula.key]: { value: reported, status: 'calculated', formula: null } }
      const normalized = computeForRow(out, formula.key, row, 'normalized')
      if (normalized != null && normalized !== reported) {
        next[normKey] = { value: normalized, adjusted: true, formula: null }
      } else if (normKey in next) {
        const { [normKey]: _drop, ...rest } = next
        next = rest
      }
      return next
    })
    out = formula.table === 'income'
      ? { ...out, reportedIncomeHistory: newHistory }
      : { ...out, [histKey]: newHistory }
  }
  return out
}

/**
 * Runs seedFormulaDefaults + materializeFormulas repeatedly until a pass
 * seeds nothing new, instead of the caller guessing a fixed number of
 * rounds. That guess is exactly what broke: a formula whose default is
 * ANOTHER formula's output can only be seeded once that other formula has
 * actually materialized (hasData() reads the real row), so each extra
 * level of formula-depends-on-formula needs one more seed+materialize
 * round than the last. Two rounds covered the shallow chains this
 * registry had for most of this session (Net Debt/EBITDA needing Net
 * Debt + EBITDA, one level deep) — but profitBeforeTax → tax →
 * effectiveTaxRate → FCFF is FOUR levels deep, and two rounds silently
 * left effectiveTaxRate and FCFF permanently unmaterialized (their bucket
 * assignments never got seeded in time), not a data problem, a genuine
 * gap in how many passes computeAll ran. This is the fix: keep going
 * until seeding stops finding anything new, so the number of rounds
 * tracks the registry's actual dependency depth automatically, not a
 * number someone has to remember to bump the next time a formula is
 * added on top of another formula on top of another formula.
 *
 * Capped at maxPasses purely as a runaway guard (a real dependency chain
 * anywhere near this deep would be a design problem worth noticing, not
 * something to loop through silently) — every realistic chain in this
 * registry today resolves in well under 8.
 */
export function materializeAllFormulas(data, { maxPasses = 8 } = {}) {
  let out = materializeFormulas(data)
  for (let i = 0; i < maxPasses; i++) {
    const seeded = seedFormulaDefaults(out)
    const seedChanged = seeded !== out
    out = materializeFormulas(seeded)
    if (!seedChanged) break
  }
  return out
}

/** Every assignment currently on this field, across both kinds. */
export function assignmentsForField(data, field) {
  return (data?.fieldAssignments || []).filter(a => a.field === field)
}
