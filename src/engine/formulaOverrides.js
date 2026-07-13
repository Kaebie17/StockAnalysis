/**
 * src/engine/formulaOverrides.js — persisted user formula overrides (global, not
 * per-ticker). Stored in localStorage now; will ride Supabase sync later.
 * Shape: { [metricKey]: { tokens, tree } }
 */
import { evalTree, exprString } from './formulaBuilder.js'

const KEY = 'sa_formula_overrides'

export function getOverrides() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}
export function setOverride(metricKey, def) {
  const all = getOverrides(); all[metricKey] = def
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch {}
  syncOverrides(all)
}
export function clearOverride(metricKey) {
  const all = getOverrides(); delete all[metricKey]
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch {}
  syncOverrides(all)
}

/**
 * Apply overrides to a computed ratioResult IN PLACE-ish (returns same object).
 * Base metrics live at ratioResult top level, so that's the eval scope. Overridden
 * ratios get value recomputed + status:'override' + formula = the chosen expression.
 * A broken/None result leaves the default untouched.
 */
export function applyFormulaOverrides(ratioResult, overrides = getOverrides()) {
  if (!ratioResult?.ratios || !overrides) return ratioResult
  for (const [key, def] of Object.entries(overrides)) {
    if (!def?.tree || !(key in ratioResult.ratios)) continue
    const value = evalTree(def.tree, ratioResult)
    if (value == null || !isFinite(value)) continue     // keep default if override can't compute
    ratioResult.ratios[key] = { value, status: 'override', formula: exprString(def.tree) }
  }
  return ratioResult
}

// Push override changes to sync (no-op if sync unconfigured/signed out).
function syncOverrides(all) {
  import('../sync/sync.js').then(m => m.queuePush('formulaOverrides:global', all)).catch(() => {})
}
