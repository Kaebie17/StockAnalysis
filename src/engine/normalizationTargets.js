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
export function normalizedFieldValue(row, key) {
  const normalized = row?.[`${key}Normalized`]
  if (normalized?.value != null) return normalized
  return row?.[key] ?? null
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
  const targetsInUse = new Set(customFields.map(f => f.target).filter(Boolean))

  // A target whose LAST contributor was just removed has zero entries in
  // customFields any more — it would never appear above, so its stale
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
        out = t === 'income' ? { ...out, incomeHistory: cleaned, reportedIncomeHistory: cleaned } : { ...out, [hk]: cleaned }
      }
      continue
    }
    const histKey = table === 'income' ? 'reportedIncomeHistory' : `${table}History`
    const base = table === 'income' ? (out.reportedIncomeHistory || out.incomeHistory || []) : (out[histKey] || [])
    const contributors = customFields.filter(f => f.target === target)
    const formula = contributors.map(f => `${f.sign > 0 ? '+' : '−'} ${f.label}`).join(' ')

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
      for (const f of contributors) {
        const v = row?.[f.key]?.value
        if (v != null) { delta += (f.sign ?? 1) * v; touched = true }
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
      ? { ...out, incomeHistory: newHistory, reportedIncomeHistory: newHistory }
      : { ...out, [histKey]: newHistory }
  }
  return out
}
