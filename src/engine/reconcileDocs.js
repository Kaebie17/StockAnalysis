import { METRICS } from './metrics.js'

/**
 * src/engine/reconcileDocs.js
 *
 * Merges the user-selected "intelligence" from a document into the persisted
 * arData set. We NEVER store the source file — only the reconciled signals.
 *
 * Two slot types (as specified):
 *   SINGLE-VALUE (outlook, pli, initiatives, runway): the newest non-empty value
 *     wins; if a document says nothing about a slot, the old value PERSISTS.
 *   TREND (pledge, rpt): each document contributes a dated row into a table —
 *     never overwritten, so Block 5 can show the metric moving over time. A
 *     re-scan of the same period replaces that period's row (no duplicates).
 *
 * Promoter-holding trend is NOT here — it stays Screener-sourced (holdingsData).
 */

export const SINGLE_SLOTS = ['outlook', 'pli', 'initiatives', 'runway']

// Number slots the gap list can ask a filing for. Read from the dictionary so a
// new metric needs no edit here. Recency wins, same as the text slots: a Q2
// filing's cash beats last year's annual report.
export const NUMBER_SLOTS = Object.entries(METRICS)
  .filter(([, m]) => m.ar?.length)
  .map(([k]) => k)
export const TREND_SLOTS = { pledge: 'pledgeTrend', rpt: 'rptTrend' }

export function emptyArData() {
  return { outlook: null, pli: null, initiatives: null, runway: null,
           pledgeTrend: [], rptTrend: [], derivedInputs: {}, lastDoc: null }
}

/**
 * @param {object|null} existing  current arData
 * @param {object} incoming { docType, docDate, name, at, slots }
 *   slots: { outlook?:{text}, pli?:{text}, initiatives?:{text}, runway?:{text},
 *            pledge?:{pct}, rpt?:{present, pctOfRevenue} }
 */
export function reconcile(existing, incoming) {
  const out = { ...emptyArData(), ...(existing || {}) }
  const asOf = incoming.docDate || null
  const source = incoming.docDate || incoming.name || 'document'
  const at = incoming.at || Date.now()
  const slots = incoming.slots || {}

  // Single-value: recency wins. A document only updates a slot if its period is
  // newer than (or equal to, tie-broken by edit time) what's stored — so a stale
  // value gets refreshed, but an older filing never clobbers a newer note. If the
  // slot is empty (unique/new) it's simply stored.
  for (const k of SINGLE_SLOTS) {
    const s = slots[k]
    if (!s || !s.text || !s.text.trim()) continue          // no new data → keep old
    const cand = { text: s.text.trim(), source, asOf, at, manual: false }
    out[k] = freshest(out[k], cand)
  }

  // Trend: upsert a dated row (keyed by as-of period).
  if (slots.pledge && slots.pledge.pct != null) {
    out.pledgeTrend = upsertRow(out.pledgeTrend, { asOf, pct: slots.pledge.pct, source })
  }
  if (slots.rpt && slots.rpt.present) {
    out.rptTrend = upsertRow(out.rptTrend, { asOf, pctOfRevenue: slots.rpt.pctOfRevenue ?? null, present: true, source })
  }

  // Numbers the user confirmed — upsert by period into their own trend, so a
  // metric can be derived per YEAR, and expose the newest as a flat slot for
  // normalize.applyDocFacts to drop onto the latest row.
  //
  // This used to handle exactly one field: materialCost. Everything else the
  // reader found was discarded — which made asking for it pointless.
  for (const k of NUMBER_SLOTS) {
    const s2 = slots[k]
    if (!s2 || s2.value == null) continue
    out.derivedInputs = { ...(out.derivedInputs || {}) }
    out.derivedInputs[k] = upsertRow(out.derivedInputs[k], { asOf, value: s2.value, source })
    // flat, newest-wins slot — the shape applyDocFacts reads
    out.slots = { ...(out.slots || {}) }
    out.slots[k] = freshest(out.slots[k], { value: s2.value, source, asOf, at, manual: false })
  }

  out.lastDoc = { docType: incoming.docType || null, docDate: incoming.docDate || null,
                  name: incoming.name || null, at }
  return out
}

/**
 * Manual guidance edit → explicit write of a single-value slot, carrying the
 * user-supplied period (asOf). It does NOT auto-count as "most recent": future
 * reconciles compare it by its date like any other value. An undated manual note
 * has no recency claim and a dated document will override it.
 */
export function setManualGuidance(existing, field, text, asOf) {
  if (!SINGLE_SLOTS.includes(field)) return existing
  const out = { ...emptyArData(), ...(existing || {}) }
  const t = (text || '').trim()
  out[field] = t ? { text: t, source: 'manual', asOf: asOf || null, at: Date.now(), manual: true } : null
  return out
}

// Recency comparator — symmetric and date-driven. Both dated → newer period wins
// (tie broken by edit time). Dated vs undated → the DATED one wins (undated is
// ignored for recency). Both undated → most recent edit wins.
function freshest(existing, cand) {
  if (!existing) return cand
  const ke = dateKey(existing.asOf), kc = dateKey(cand.asOf)
  const eD = ke > 0, cD = kc > 0
  if (cD && eD) {
    if (kc > ke) return cand
    if (kc < ke) return existing
    return (cand.at || 0) >= (existing.at || 0) ? cand : existing
  }
  if (cD && !eD) return cand       // dated beats undated
  if (!cD && eD) return existing   // undated ignored vs dated
  return (cand.at || 0) >= (existing.at || 0) ? cand : existing
}

// Replace the row with the same as-of period, else append; keep sorted oldest→newest.
function upsertRow(rows, row) {
  const list = (rows || []).filter(r => !sameAsOf(r.asOf, row.asOf))
  list.push(row)
  return list.sort((a, b) => dateKey(a.asOf) - dateKey(b.asOf))
}

const sameAsOf = (a, b) => normAsOf(a) === normAsOf(b)
const normAsOf = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

// Latest row of a trend (most recent by period).
export function latest(trend) {
  const t = trend || []
  return t.length ? t[t.length - 1] : null
}

// Whether any intelligence has been captured (drives the "sufficient data" gate).
export function hasContent(arData) {
  if (!arData) return false
  return SINGLE_SLOTS.some(k => arData[k]?.text) ||
         (arData.pledgeTrend?.length > 0) || (arData.rptTrend?.length > 0) ||
         Object.values(arData.derivedInputs || {}).some(v => v?.length > 0)
}

/**
 * Sortable key from a period label. Handles 'FY24', 'FY2024', 'Q2 FY25',
 * 'Q3 2024', 'Mar 2024', 'March 2024', '2024'. Fiscal year assumed Apr–Mar.
 * Unknown → 0 (sorts oldest).
 */
export function dateKey(asOf) {
  if (!asOf) return 0
  const s = String(asOf).toLowerCase().trim()

  // Q<n> FY<yy|yyyy>  or  Q<n> <yyyy>
  let m = s.match(/q([1-4])\s*(?:fy)?\s*'?(\d{2,4})/)
  if (m) return yr(m[2]) * 10 + Number(m[1])

  // FY<yy|yyyy>
  m = s.match(/fy\s*'?(\d{2,4})/)
  if (m) return yr(m[1]) * 10 + 4

  // <Mon> <yyyy>
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?(\d{2,4})/)
  if (m) {
    const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1]) + 1
    const q = mon <= 3 ? 4 : mon <= 6 ? 1 : mon <= 9 ? 2 : 3
    return yr(m[2]) * 10 + q
  }

  // bare year
  m = s.match(/\b(\d{4})\b/)
  if (m) return Number(m[1]) * 10 + 4

  return 0
}

function yr(v) {
  const n = Number(v)
  return n < 100 ? 2000 + n : n
}