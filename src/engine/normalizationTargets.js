/**
 * src/engine/normalizationTargets.js
 *
 * The fixed set of fields the historical-normalization restatement tool
 * (NormalizeModal's generic paste mode) can adjust — deliberately narrow,
 * not "every metrics.js field." Just the ones that actually get historically
 * normalized per the plan: EBIT, interest, tax, D&A, capex, revenue, and the
 * four core working-capital components.
 *
 * label/table are read straight off metrics.js — one source of truth for
 * what a field is called and which statement it lives on, not a second copy
 * of it here.
 */
import { METRICS } from './metrics.js'

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

const val = t => (t && typeof t === 'object' ? t.value : t)

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

  const histFor = (table) => table === 'income' ? (data.reportedIncomeHistory || data.incomeHistory || [])
    : table === 'balance' ? (data.balanceHistory || [])
    : table === 'cashflow' ? (data.cashflowHistory || [])
    : []

  const hasData = (table, key) => histFor(table).some(r => val(r?.[key]) != null)

  const out = []
  const seen = new Set()
  for (const key of NORMALIZATION_TARGET_KEYS) {
    out.push(NORMALIZATION_TARGETS[key]); seen.add(key)
  }
  for (const [key, m] of Object.entries(METRICS)) {
    if (seen.has(key) || !m.table) continue
    if (!hasData(m.table, key)) continue
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
 * The normalized value for one restatement target field, on one row —
 * `{key}Normalized` if the restatement tool has written one for this row,
 * else just the reported `{key}` value, untouched. Unlike netProfit/eps
 * (dataQuality.js's computeNormalizedRow), there's no auto-derivation step
 * for any of these ten — Screener never discloses a structured "exceptional"
 * breakdown for EBIT, interest, D&A, capex, or the working-capital lines the
 * way it does for Other Income. Every one of these only ever gets a
 * normalized value from an explicit, user-confirmed restatement; never
 * guessed, never computed from a formula.
 */
export function normalizedFieldValue(row, key) {
  const normalized = row?.[`${key}Normalized`]
  if (normalized?.value != null) return normalized
  return row?.[key] ?? null
}
