/**
 * src/engine/derivable.js
 *
 * Registry of metrics the primary data can't provide directly, plus the indirect
 * inputs that DERIVE them. Those inputs are captured from documents through the
 * same keep/discard review the user already does — so a derived value only exists
 * because the user confirmed the source number. This is not OCR and not blind
 * scraping: deterministic text extraction + a human gate + a formula.
 *
 * Currently: gross margin, derived from "cost of materials consumed" + revenue.
 * The registry is structured so more (e.g. liquidity from current assets/
 * liabilities) can be added the same way.
 */

// Which missing metrics can be derived, and from what inputs.
export const DERIVABLE = {
  grossMargin: {
    label: 'Gross margin',
    deriveFrom: 'Cost of materials consumed',
    inputField: 'materialCost',
  },
}

/**
 * Compute derived metric series from captured inputs.
 * @param {object} arData         has arData.derivedInputs.materialCost = [{asOf,value}]
 * @param {object} revenueByYear  { 2024: <revenue>, … } from the income series
 * @returns {{ grossMargin?: [{asOf, pct}] }}
 */
export function deriveMetrics(arData, revenueByYear) {
  const out = {}
  const gm = deriveGrossMargin(arData?.derivedInputs?.materialCost, revenueByYear)
  if (gm.length) out.grossMargin = gm
  return out
}

function deriveGrossMargin(materialCost, revenueByYear) {
  const rows = materialCost || []
  const out = []
  for (const r of rows) {
    if (r.value == null) continue
    const y = yearOf(r.asOf)
    const rev = revenueByYear[y] ?? nearestRevenue(revenueByYear, y)
    if (!rev || rev <= 0) continue

    // Unit reconciliation: the series revenue may be absolute while the AR figure
    // is in ₹ crore. Gross margin is a ratio, so scale the captured cost up until
    // it's a plausible fraction of revenue (never past a sane range).
    let cost = r.value, guard = 0
    while (cost / rev < 0.01 && guard < 4) { cost *= 1e7; guard++ }

    const pct = (rev - cost) / rev * 100
    if (pct > 0 && pct < 100) out.push({ asOf: r.asOf, pct: Math.round(pct * 10) / 10, source: r.source })
  }
  return out.sort((a, b) => yearOf(a.asOf) - yearOf(b.asOf))
}

// Human-facing list for the panel: what's missing and how to fill it.
export function derivationHints() {
  return Object.values(DERIVABLE).map(d => ({ metric: d.label, deriveFrom: d.deriveFrom }))
}

// ── helpers ───────────────────────────────────────────────────────────────────
export function yearOf(asOf) {
  const s = String(asOf || '').toLowerCase()
  let m = s.match(/\b(19|20)\d{2}\b/)
  if (m) return Number(m[0])
  m = s.match(/fy\s*'?(\d{2,4})/)
  if (m) { const n = Number(m[1]); return n < 100 ? 2000 + n : n }
  m = s.match(/'?(\d{2})\b/)
  if (m) return 2000 + Number(m[1])
  return 0
}

function nearestRevenue(revenueByYear, y) {
  if (!y) return null
  const years = Object.keys(revenueByYear).map(Number).filter(Boolean)
  if (!years.length) return null
  years.sort((a, b) => Math.abs(a - y) - Math.abs(b - y))
  return revenueByYear[years[0]]
}
