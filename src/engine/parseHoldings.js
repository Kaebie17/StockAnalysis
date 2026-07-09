/**
 * src/engine/parseHoldings.js
 *
 * Parses a pasted Screener "Shareholding Pattern" table into quarterly series for
 * promoter holding and (when present) promoter pledge. Deterministic, no AI.
 *
 * Screener copy/paste looks roughly like:
 *
 *   Shareholding Pattern
 *   Numbers in percentages
 *              Mar 2023  Jun 2023  Sep 2023  Dec 2023  Mar 2024
 *   Promoters   50.60%    50.60%    50.60%    50.60%    50.60%
 *   FIIs        22.49%    ...
 *   DIIs        ...
 *   Public      ...
 *   Pledged      1.20%     1.10%     0.90%     0.00%     0.00%
 *
 * Tolerant to tab- or space-separated pastes and to "Mar 2023" / "Mar'23" headers.
 * Returns { ok, quarters, promoterSeries:[{q,pct}], pledgeSeries:[{q,pct}], note }.
 */

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
const QUARTER_RE = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s*['\\s]?\\s*(\\d{2,4})\\b`, 'gi')
const NUM_RE = /-?\d+(?:\.\d+)?/g

export function parseHoldings(text) {
  if (!text || !text.trim()) return fail('Nothing pasted.')

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

  // 1) Find the header line — the one with the most quarter tokens (≥2).
  let quarters = [], headerIdx = -1
  lines.forEach((line, i) => {
    const qs = matchQuarters(line)
    if (qs.length >= 2 && qs.length > quarters.length) { quarters = qs; headerIdx = i }
  })
  if (headerIdx === -1) {
    return fail('Could not find a quarter header (e.g. "Mar 2023  Jun 2023 …"). Paste the shareholding table including the date row.')
  }

  // 2) Scan remaining lines for promoter and pledge rows.
  let promoterSeries = [], pledgeSeries = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    const label = line.toLowerCase()
    const nums = extractNums(line)
    if (!nums.length) continue

    if (pledgeSeries.length === 0 && /pledg/.test(label)) {
      pledgeSeries = zip(quarters, nums)
    } else if (promoterSeries.length === 0 && /promoter/.test(label) && !/pledg/.test(label)) {
      promoterSeries = zip(quarters, nums)
    }
  }

  if (promoterSeries.length === 0) {
    return fail('Found the date row but no "Promoters" line. Include the promoter holding row.', { quarters })
  }

  return {
    ok: true,
    quarters,
    promoterSeries,
    pledgeSeries,
    note: pledgeSeries.length
      ? `Parsed ${promoterSeries.length} quarters of promoter holding + pledge.`
      : `Parsed ${promoterSeries.length} quarters of promoter holding (no pledge row found).`,
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function matchQuarters(line) {
  const out = []
  let m
  QUARTER_RE.lastIndex = 0
  while ((m = QUARTER_RE.exec(line)) !== null) {
    const mon = m[1][0].toUpperCase() + m[1].slice(1, 3).toLowerCase()
    let yr = m[2]
    if (yr.length === 2) yr = (Number(yr) > 50 ? '19' : '20') + yr
    out.push(`${mon} ${yr}`)
  }
  return out
}

function extractNums(line) {
  const out = []
  let m
  NUM_RE.lastIndex = 0
  while ((m = NUM_RE.exec(line)) !== null) {
    const v = parseFloat(m[0])
    if (isFinite(v)) out.push(v)
  }
  return out
}

// Align numbers to quarters. If counts differ, align from the RIGHT (most recent
// quarters are rightmost and most reliable) and drop the overflow on the left.
function zip(quarters, nums) {
  const n = Math.min(quarters.length, nums.length)
  const qs = quarters.slice(quarters.length - n)
  const vs = nums.slice(nums.length - n)
  return qs.map((q, i) => ({ q, pct: vs[i] }))
}

function fail(note, extra = {}) {
  return { ok: false, quarters: extra.quarters || [], promoterSeries: [], pledgeSeries: [], note }
}
