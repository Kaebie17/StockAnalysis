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

export function getFormula(data, key) {
  return listFormulas(data).find(f => f.key === key) || null
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
// through activeValue here, INSIDE the formula, is the fallback the user
// asked for: 'reported' reads the field itself, 'normalized' reads its
// Normalized sibling where one exists and falls back to reported where it
// doesn't — one fallback rule, applied once, at the point a formula reads
// an input, rather than every consumer file re-deciding it per field.
function resolvedValue(row, field, basis) {
  return val(activeValue(row, field, basis))
}

/**
 * A derived formula's output for ONE already-picked row, under ONE basis —
 * the shared core both computeDerivedFormulaLatest (below, for the Formulas
 * tab) and any real calculation consumer (ratios.js's netWorkingCapitalOf)
 * go through, so there is exactly one place that knows how to combine NWC's
 * buckets AND how to resolve reported-vs-normalized for each constituent,
 * rather than a second, hardcoded copy that could silently drift.
 */
export function computeDerivedFormulaForRow(data, formulaKey, row, basis = 'reported') {
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
  if (Object.values(bucketSums).some(v => v == null)) return { output: null, bucketSums }

  let output = 0
  for (const bucket of formula.buckets) output += bucket.sign * bucketSums[bucket.key]
  return { output, bucketSums }
}

/**
 * The live output of a derived formula for its most recent real year only —
 * this tab is an audit view, not a historical series. Returns null output if
 * any bucket ends up with nothing assigned/valued that year (no partial
 * output, same "never show a value nothing produced" rule as the rest of
 * the app). `basis` defaults to 'reported'; pass 'normalized' for the
 * Formulas tab's toggle.
 */
export function computeDerivedFormulaLatest(data, formulaKey, basis = 'reported') {
  const formula = DERIVED_FORMULAS[formulaKey]
  if (!formula) return null
  const hist = fieldHistory(data, formula.table)
  const realRows = hist.filter(r => /^\d{4}$/.test(String(r?.year ?? '').trim()))
  const row = realRows[realRows.length - 1]
  if (!row) return null
  const result = computeDerivedFormulaForRow(data, formulaKey, row, basis)
  return result ? { year: row.year, ...result } : null
}

/** Every assignment currently on this field, across both kinds. */
export function assignmentsForField(data, field) {
  return (data?.fieldAssignments || []).filter(a => a.field === field)
}
