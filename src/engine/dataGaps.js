/**
 * src/engine/dataGaps.js
 *
 * What's still missing, and what to do about it.
 *
 * This used to check 11 metrics against a hard-coded list of its own. Three
 * things were wrong with that:
 *
 *   1. cash, capex and gross profit weren't on the list. The three metrics with
 *      the worst coverage in the whole app were the three it never looked at.
 *   2. Even if they had been, it tests for null — and none of them were ever
 *      null, because cash fell back to 0, capex to `opCF x 0.7`, and gross margin
 *      to operating margin. A hole that always returns a number is invisible to a
 *      null check. That is why this never fired and nobody noticed the gaps.
 *   3. It knew which Screener TABLE to point at, but not which "+" row hides the
 *      metric, and it could not tell the AR reader what to hunt for. So the AR
 *      reader only ever looked for material cost — the one thing someone had
 *      hard-coded into it.
 *
 * It now reads src/engine/metrics.js like everything else, so a gap knows its own
 * vocabulary in every source.
 *
 * STAGES. Yahoo is a taster. The order is Yahoo -> deep source (Screener paste or
 * SEC) -> AR/QR documents for whatever is STILL missing. This runs after each
 * stage and hands the residue to the next one. It is not a first-load list.
 */

import { METRICS, expandHints, arTargets } from './metrics.js'

export const TABLE_INFO = {
  income:   { name: 'Profit & Loss', screenerSection: 'Profit & Loss' },
  balance:  { name: 'Balance Sheet', screenerSection: 'Balance Sheet' },
  cashflow: { name: 'Cash Flow',     screenerSection: 'Cash Flows' },
}

/**
 * The resolved scalars, keyed by dictionary name. These come off ratioResult, so
 * every fallback (statement -> TTM -> derived) has already been applied: a metric
 * only shows up as a gap if it is genuinely unrecoverable.
 */
function resolvedValues(r, data) {
  const latestI = data?.incomeHistory?.[data.incomeHistory.length - 1] || {}
  const latestC = data?.cashflowHistory?.[data.cashflowHistory.length - 1] || {}
  return {
    revenue:         r.revenue,
    operatingProfit: r.opProfit,
    depreciation:    r.depreciation,
    interest:        r.interest,
    netProfit:       r.netProfit,
    eps:             r.eps,
    totalEquity:     r.totalEquity,
    totalDebt:       r.totalDebt,
    totalAssets:     r.totalAssets,
    cash:            r.cash,
    operatingCF:     r.opCF,
    freeCashFlow:    r.fcf,
    // Not on ratioResult — read off the latest row. Both were invisible before.
    capex:           latestC.capex?.value ?? null,
    cogs:            latestI.cogs?.value ?? latestI.grossProfit?.value ?? null,
  }
}

/**
 * @returns {{ hasGaps, missing, byTable, softGaps, expandHints, arTargets, nextStep, message }}
 *   missing     — genuinely absent. No source has it, no formula recovers it.
 *   softGaps    — present but ESTIMATED (e.g. FCF from CapEx ~ Depreciation).
 *                 Real data would replace an assumption. Worth prompting, not an
 *                 error.
 *   expandHints — which Screener "+" to click, per table, for the missing ones.
 *   arTargets   — keyword config for the AR reader, for whatever survives the
 *                 deep source.
 *   nextStep    — 'paste' | 'ar' | null
 */
export function findMissingBaseMetrics(ratioResult, data = null) {
  const empty = {
    hasGaps: false, missing: [], byTable: {}, softGaps: [],
    expandHints: [], arTargets: [], nextStep: null, message: null,
  }
  if (!ratioResult) return empty

  const values = resolvedValues(ratioResult, data)

  const missing = []
  for (const [key, val] of Object.entries(values)) {
    const m = METRICS[key]
    if (!m || val != null) continue
    missing.push({ metric: key, label: m.label, table: m.table, needs: m.needs })
  }

  // Present, but resting on an assumption rather than a reported figure.
  const softGaps = []
  if (ratioResult.fcfEstimated) {
    softGaps.push({
      metric: 'capex',
      label:  METRICS.capex.label,
      table:  'cashflow',
      note:   'Free Cash Flow is estimated (CapEx \u2248 Depreciation). Real CapEx would replace the assumption.',
    })
  }

  const byTable = {}
  for (const m of missing) (byTable[m.table] ||= []).push(m)

  const keys = [...missing.map(m => m.metric), ...softGaps.map(m => m.metric)]

  // A deep source has run if the data carries one. Before that, the fix is a
  // paste (or SEC, which is automatic). After it, the only route left is the
  // documents — so the AR reader gets told exactly what to hunt for.
  const deep = data?.deepSource || null
  const nextStep = keys.length === 0 ? null : (deep ? 'ar' : 'paste')

  return {
    hasGaps: missing.length > 0,
    missing,
    byTable,
    softGaps,
    expandHints: expandHints(keys),
    arTargets:   arTargets(keys),
    nextStep,
    message: buildMessage(missing, softGaps, deep, nextStep),
  }
}

function buildMessage(missing, softGaps, deep, nextStep) {
  if (!missing.length && !softGaps.length) return null
  const names = missing.map(m => m.label).join(', ')
  if (nextStep === 'paste') {
    return missing.length
      ? `Missing: ${names}. Paste the Screener tables to fill them.`
      : 'Some figures are estimated. Paste the Screener tables to replace the assumptions.'
  }
  const src = deep === 'sec' ? 'SEC filings' : 'Screener'
  return missing.length
    ? `Still missing after ${src}: ${names}. Upload the annual report and these will be searched for.`
    : `Some figures are estimated even after ${src}. The annual report may carry the real ones.`
}

/**
 * Which "+" rows to expand for ONE paste box. Drives the hint in the paste area
 * so it names the exact rows, and only the ones actually missing.
 * @returns [{ expand, metrics: [label], needs: [string] }]
 */
export function expandHintsForTable(gaps, tableType) {
  return (gaps?.expandHints || []).filter(h => h.table === tableType)
}
