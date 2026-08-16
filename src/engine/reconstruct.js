/**
 * src/engine/reconstruct.js — manual normalization via P&L reconstruction.
 *
 * The app parses a number (from a pasted table or a report snippet) and rebuilds
 * the year's row via the income-statement identity, so a corrected line flows
 * through pbt → tax → netProfit → eps. Nothing is guessed: the user supplies the
 * restated figure; this only applies arithmetic and validates the result.
 *
 * Identity (top → bottom):
 *   totalIncome = operatingRevenue + otherIncome     (siblings; neither moves the other)
 *   pbt         = totalIncome − expenses − interest − depreciation
 *   tax         = pbt × effectiveRate                (or literal if tax was restated)
 *   netProfit   = pbt − tax
 *   eps         = netProfit / shares
 *
 * NOTE: import helpers from wherever they actually live. In these dumps `val`,
 * `yearOf`, `round` are used throughout engine files — confirm the module path in
 * the real repo (likely './metrics.js' or a shared util). If names differ, adjust.
 */
const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

const num = f => (f && typeof f === 'object') ? f.value : f

function impliedShares(row) {
  const np = num(row.netProfit), eps = num(row.eps)
  return (np > 0 && eps > 0) ? np / eps : null
}

function impliedTaxRate(row) {
  const pbt = num(row.profitBeforeTax) ?? num(row.pbt)
  const np  = num(row.netProfit)
  return (pbt > 0 && np != null && pbt > np) ? 1 - (np / pbt) : null
}

/**
 * Reconstruct one year's row from one or more restated line values.
 *
 * @param {object} reportedRow           the fetched row (tagged fields)
 * @param {Array}  edits                 [{ line, newValue, taxed }]  taxed defaults true
 * @param {object} opts                  { effectiveTaxRate?, shares?, revenueIsTotal? }
 * @returns {{ok:true, row:object} | {ok:false, reason:string}}
 */
export function reconstructRow(reportedRow, edits, opts = {}) {
  const row  = { ...reportedRow }
  const orig = f => num(reportedRow[f])
  const set  = (f, value) => {
    if (value == null || !isFinite(value)) return
    row[f] = { value, adjusted: true, reported: orig(f) ?? null }
  }

  const editMap = new Map(edits.map(e => [e.line, e]))
  const cur = f => editMap.has(f) ? Number(editMap.get(f).newValue) : orig(f)

  // Tag the raw edited values first (so they carry provenance).
  for (const e of edits) set(e.line, Number(e.newValue))

  const opRev    = cur('revenue')
  const otherInc = cur('otherIncome')
  const expenses = cur('expenses')
  const interest = cur('interest')
  const deprec   = cur('depreciation')

  // total income (sibling sum)
  let totalIncome = null
  if (opRev != null && otherInc != null) totalIncome = opRev + otherInc
  else if (opRev != null)                totalIncome = opRev

  // pbt
  let pbt
  if (editMap.has('profitBeforeTax') || editMap.has('pbt')) {
    pbt = cur('profitBeforeTax') ?? cur('pbt')
  } else if (totalIncome != null) {
    pbt = totalIncome - (expenses || 0) - (interest || 0) - (deprec || 0)
    set('profitBeforeTax', pbt)
  } else {
    pbt = orig('profitBeforeTax') ?? orig('pbt')
  }

  // tax
  let tax
  if (editMap.has('tax')) {
    tax = cur('tax')                                   // literal
  } else {
    const anyTaxed = edits.some(e => e.taxed !== false) // default taxed
    const rate = opts.effectiveTaxRate ?? impliedTaxRate(reportedRow)
    if (anyTaxed && rate != null && pbt != null) { tax = pbt * rate; set('tax', tax) }
    else tax = orig('tax')
  }

  // netProfit, eps
  if (pbt != null && tax != null) {
    const np = pbt - tax
    set('netProfit', np)
    const shares = opts.shares ?? impliedShares(reportedRow)
    if (shares > 0) set('eps', np / shares)
  }

  const check = validateIdentity(row, { revenueIsTotal: opts.revenueIsTotal })
  if (!check.ok) return { ok: false, reason: check.reason }
  return { ok: true, row }
}

/**
 * Verify the reconstructed row satisfies the P&L identity within tolerance, and
 * resolve the operating-vs-total revenue ambiguity.
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function validateIdentity(row, { revenueIsTotal = null } = {}) {
  const g = f => num(row[f])
  const rev = g('revenue'), oi = g('otherIncome'), exp = g('expenses')
  const intr = g('interest'), dep = g('depreciation')
  const pbt = g('profitBeforeTax') ?? g('pbt'), np = g('netProfit'), tax = g('tax')
  const tol = v => Math.max(Math.abs(v) * 0.02, 1)     // 2% or 1 unit

  // Revenue-definition detect: does `revenue` already include other income?
  let totalIncome
  if (revenueIsTotal === true)        totalIncome = rev
  else if (revenueIsTotal === false)  totalIncome = (rev != null && oi != null) ? rev + oi : rev
  else {
    const op = g('operatingProfit')
    if (op != null && rev != null && exp != null) {
      totalIncome = (Math.abs((rev - exp) - op) <= tol(op)) ? rev + (oi || 0) : rev
    } else {
      totalIncome = (rev != null && oi != null) ? rev + oi : rev
    }
  }

  if (pbt != null && totalIncome != null && exp != null) {
    const expectPbt = totalIncome - exp - (intr || 0) - (dep || 0)
    if (Math.abs(expectPbt - pbt) > tol(pbt)) {
      return { ok: false,
        reason: `pbt doesn't reconcile: expected ~${round(expectPbt, 0)}, got ${round(pbt, 0)}. ` +
                `Revenue may be total-income vs operating — confirm.` }
    }
  }
  if (np != null && pbt != null && tax != null) {
    if (Math.abs((pbt - tax) - np) > tol(np)) {
      return { ok: false, reason: `netProfit doesn't reconcile: pbt − tax ≠ netProfit.` }
    }
  }
  return { ok: true }
}

/**
 * Merge a multi-year reconstructed/pasted table over the reported one, preserving
 * breadth: reconstruct-if-derivable → carry reported forward → null (flagged).
 * `newRows` are the parsed rows from the user's source; `reportedRows` the fetched.
 */
export function reconstructTable(reportedRows, newRows, opts = {}) {
  const repByYear = Object.fromEntries((reportedRows || []).map(r => [String(yearOf(r)), r]))
  const flags = []
  const out = []

  for (const nr of (newRows || [])) {
    const y = String(yearOf(nr))
    const reported = repByYear[y] || {}
    // Reconstruct the year from whatever lines the new source restated.
    const edits = Object.entries(nr)
      .filter(([f, v]) => f !== 'year' && num(v) != null)
      .map(([line, v]) => ({ line, newValue: num(v), taxed: opts.taxed !== false }))

    const res = reconstructRow({ ...reported, ...nr, year: nr.year }, edits, opts)
    let row = res.ok ? res.row : { ...reported, ...nr, year: nr.year }
    if (!res.ok) flags.push({ year: y, kind: 'reconcile-failed', note: res.reason })

    // Breadth-fill: any field reported had but this row lacks → carry forward or flag.
    for (const f of Object.keys(reported)) {
      if (f === 'year') continue
      if (num(row[f]) == null && num(reported[f]) != null) {
        row[f] = { ...reported[f], carried: true }        // carried-from-reported
      }
    }
    out.push(row)
  }
  return { rows: out, flags }
}

/**
 * Basis selection helper used by computeAll: start from reported, replace whole
 * rows for years present in the normalized table.
 */
export function mergeByYear(reportedRows, normalizedRows) {
  const byYear = Object.fromEntries((reportedRows || []).map(r => [String(yearOf(r)), r]))
  for (const r of (normalizedRows || [])) byYear[String(yearOf(r))] = r
  return Object.values(byYear).sort((a, b) => String(yearOf(a)).localeCompare(String(yearOf(b))))
}

/* ────────────────────────────────────────────────────────────────────────────
 * Minimal self-test (run with `node reconstruct.js` after stubbing the imports,
 * or move into your test runner). Asserts a taxed one-off in otherIncome flows
 * down and the identity validates.
 * ──────────────────────────────────────────────────────────────────────────── */
// Example (pseudo — real run needs the metrics.js helpers):
//   const reported = {
//     year: '2022',
//     revenue:{value:100000}, expenses:{value:70000}, operatingProfit:{value:30000},
//     otherIncome:{value:8000}, interest:{value:2000}, depreciation:{value:3000},
//     profitBeforeTax:{value:33000}, tax:{value:8250}, netProfit:{value:24750},
//     eps:{value:24.75},
//   }
//   // user: "₹5,000 of other income was a one-off asset sale"
//   const { ok, row } = reconstructRow(reported, [{ line:'otherIncome', newValue:3000, taxed:true }])
//   // expect: pbt 28000, tax 7000 (25% eff), netProfit 21000, eps 21.00, ok:true
