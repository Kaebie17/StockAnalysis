/**
 * src/engine/dataGaps.js
 *
 * Checks the latest year's data (the one driving the live dashboard)
 * for the 12 base metrics. If any are genuinely unavailable — not
 * just absent from one source but unrecoverable through every
 * fallback already built (TTM synthesis, D/E-derived equity, etc.) —
 * groups them by which Screener table would supply them.
 *
 * This powers a single collective "some data is missing" prompt,
 * rather than scattering individual fix-links throughout the UI.
 */

const METRIC_TABLE = {
  revenue:         { table: 'income',   label: 'Revenue' },
  operatingProfit: { table: 'income',   label: 'Operating Profit' },
  depreciation:    { table: 'income',   label: 'Depreciation' },
  interest:        { table: 'income',   label: 'Interest' },
  netProfit:       { table: 'income',   label: 'Net Profit' },
  eps:             { table: 'income',   label: 'EPS' },
  totalEquity:     { table: 'balance',  label: 'Total Equity' },
  totalDebt:       { table: 'balance',  label: 'Total Debt' },
  totalAssets:     { table: 'balance',  label: 'Total Assets' },
  operatingCF:     { table: 'cashflow', label: 'Operating Cash Flow' },
  freeCashFlow:    { table: 'cashflow', label: 'Free Cash Flow' },
}

export const TABLE_INFO = {
  income:   { name: 'Profit & Loss',   screenerSection: 'Profit & Loss' },
  balance:  { name: 'Balance Sheet',   screenerSection: 'Balance Sheet' },
  cashflow: { name: 'Cash Flow',       screenerSection: 'Cash Flows' },
}

/**
 * Returns { hasGaps, missing: [{metric, label, table}], byTable: {income:[...], ...} }
 * Checks the scalar values already resolved onto ratioResult — these
 * reflect every fallback (statement → TTM → derived) already applied.
 * A metric only appears here if it's truly unavailable after all of that.
 */
export function findMissingBaseMetrics(ratioResult) {
  if (!ratioResult) return { hasGaps: false, missing: [], byTable: {} }

  const r = ratioResult
  const values = {
    revenue:         r.revenue,
    operatingProfit: r.opProfit,
    depreciation:    r.depreciation,
    interest:        r.interest,
    netProfit:       r.netProfit,
    eps:             r.eps,
    totalEquity:     r.totalEquity,
    totalDebt:       r.totalDebt,
    totalAssets:     r.totalAssets,
    operatingCF:     r.opCF,
    freeCashFlow:    r.fcf,
  }

  const missing = []
  for (const [metric, val] of Object.entries(values)) {
    if (val == null) {
      const meta = METRIC_TABLE[metric]
      missing.push({ metric, label: meta.label, table: meta.table })
    }
  }

  const byTable = {}
  for (const m of missing) {
    if (!byTable[m.table]) byTable[m.table] = []
    byTable[m.table].push(m)
  }

  return { hasGaps: missing.length > 0, missing, byTable }
}
