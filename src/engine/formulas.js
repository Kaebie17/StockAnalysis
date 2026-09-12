/**
 * src/engine/formulas.js
 *
 * Unifies two mechanisms that used to be separate:
 *   - "restatement" formulas: correcting ONE already-reported field (revenue,
 *     operatingProfit, tradeReceivables, ...) by summing whatever custom rows
 *     point at it, with a sign each. This is normalizationTargets.js's job —
 *     dynamic in TARGET CHOICE (any field with data, or any custom row, can
 *     be a target), but each individual target is structurally a one-bucket
 *     formula: output = reported + sum(contributions). See listFormulas().
 *   - "derived" formulas: a genuinely NEW figure built from more than one
 *     bucket of rows (Net Working Capital: current operating assets minus
 *     current operating liabilities). Fixed bucket shape and combination
 *     rule, defined in code below — not every formula is a straight sum, so
 *     each one says explicitly how its buckets combine. Row-to-bucket
 *     MEMBERSHIP is the only dynamic part (data.fieldAssignments).
 *
 * Both kinds share one assignment shape, so a single row can feed several
 * formulas/targets at once:
 *   { field, kind: 'restatement', target: <fieldKey>, sign: 1|-1 }
 *   { field, kind: 'formula', formula: <formulaKey>, bucket: <bucketKey>, sign: 1|-1 }
 * `field` is a metrics.js key or a data.customFields[].key — either way, a
 * key on the SAME table's history rows as what it's feeding (a restatement
 * target's table, or a derived formula's table) so contributor and target
 * are always read off the same row object, no cross-table year alignment
 * needed.
 *
 * A derived formula's OUTPUT is not something a consumer calls a function
 * to get — materializeFormulas (called once, from computeAll) writes it
 * directly onto the row as {formulaKey}/{formulaKey}Normalized, exactly
 * like recomputeNormalizedTargets already does for a restatement target.
 * So NWC is just another field: any file reads it the same way it reads
 * revenue or netProfit — activeValue(row, 'nwc', basis) — never a
 * formulas.js-specific accessor, and never re-derived from fieldAssignments
 * at the point of use.
 */
import { METRICS } from './metrics.js'
import { availableTargets } from './normalizationTargets.js'
import { activeValue } from './dataQuality.js'

const val = t => (t && typeof t === 'object' ? t.value : t)

export function fieldTable(data, field) {
  return METRICS[field]?.table ?? (data?.customFields || []).find(f => f.key === field)?.table ?? null
}

export function fieldLabel(data, field) {
  return METRICS[field]?.label ?? (data?.customFields || []).find(f => f.key === field)?.label ?? field
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
    for (const bucket of formula.buckets) {
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

function computeForRow(data, formulaKey, row, basis) {
  const formula = DERIVED_FORMULAS[formulaKey]
  if (!formula || !row) return null
  const bucketSums = {}
  for (const bucket of formula.buckets) {
    const contributors = (data?.fieldAssignments || [])
      .filter(a => a.kind === 'formula' && a.formula === formulaKey && a.bucket === bucket.key)
    let sum = null
    for (const c of contributors) {
      const v = resolvedValue(row, c.field, basis)
      if (v != null) sum = (sum ?? 0) + (c.sign ?? 1) * v
    }
    bucketSums[bucket.key] = sum
  }
  if (Object.values(bucketSums).some(v => v == null)) return null
  let output = 0
  for (const bucket of formula.buckets) output += bucket.sign * bucketSums[bucket.key]
  return output
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
    const newHistory = base.map(row => {
      // 'fallback': a real reported value for this exact field already
      // exists (e.g. a Yahoo/SEC company that DOES report Gross Profit
      // directly) — leave it, and its OWN Normalized sibling, completely
      // alone. It's a genuine restatement-eligible metrics.js field, so
      // recomputeNormalizedTargets (which already ran, above) already
      // handles its normalization independently of this formula; the
      // buckets here only fill the figure in when it's genuinely absent.
      if (formula.kind === 'fallback' && rowValue(row, formula.key) != null) return row
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
      ? { ...out, incomeHistory: newHistory, reportedIncomeHistory: newHistory }
      : { ...out, [histKey]: newHistory }
  }
  return out
}

/** Every assignment currently on this field, across both kinds. */
export function assignmentsForField(data, field) {
  return (data?.fieldAssignments || []).filter(a => a.field === field)
}
