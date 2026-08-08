
/**
 * src/engine/parseHoldings.js
 *
 * Parses a pasted Screener "Shareholding Pattern" table into a quarterly PROMOTER
 * HOLDING series. Pledge is NOT parsed here — Screener shows pledge as a single
 * snapshot, so pledge (and its trend) is sourced from documents instead
 * (see arExtract.js / reconcileDocs.js). Promoter holding stays Screener-sourced
 * because Screener gives it quarter-by-quarter already.
 *
 * Tolerant to tab/space pastes and "Mar 2023" / "Mar'23" headers.
 * Returns { ok, quarters, promoterSeries:[{q,pct}], note }.
 */

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
const QUARTER_RE = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s*['\\s]?\\s*(\\d{2,4})\\b`, 'gi')
const NUM_RE = /-?\d+(?:\.\d+)?/g

export function parseHoldings(text) {
  if (!text || !text.trim()) return fail('Nothing pasted.')

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

  // Header line = the one with the most quarter tokens (≥2).
  let quarters = [], headerIdx = -1
  lines.forEach((line, i) => {
    const qs = matchQuarters(line)
    if (qs.length >= 2 && qs.length > quarters.length) { quarters = qs; headerIdx = i }
  })
  if (headerIdx === -1) {
    return fail('Could not find a quarter header (e.g. "Mar 2023  Jun 2023 …"). Paste the shareholding table including the date row.')
  }

  // Find the promoter row, plus the institutional rows sitting alongside it.
  // FII/DII are read from the SAME paste — Screener prints them directly under
  // Promoters, so this costs one extra pass over lines already in hand and no
  // extra work for the user. They're context, not a trigger: the series is
  // quarterly, so it can only move four times a year and can never be the thing
  // that flags something today. Displayed as a trend panel, never scored.
  let promoterSeries = [], fiiSeries = [], diiSeries = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const label = lines[i].toLowerCase()
    if (/pledg/.test(label)) continue          // pledge comes from documents, not here

    // Screener's own labels: "FIIs"/"Foreign Institutions", "DIIs"/"Domestic
    // Institutions". Match on the distinguishing token, not the exact string,
    // since the wording differs between the classic and newer table layouts.
    const isPromoter = /promoter/.test(label)
    const isFii      = /\bfiis?\b|foreign\s*institution/.test(label)
    const isDii      = /\bdiis?\b|domestic\s*institution/.test(label)
    if (!isPromoter && !isFii && !isDii) continue

    const nums = extractNums(lines[i])
    if (!nums.length) continue
    const series = zip(quarters, nums)
    if (isPromoter && !promoterSeries.length) promoterSeries = series
    else if (isFii  && !fiiSeries.length)     fiiSeries      = series
    else if (isDii  && !diiSeries.length)     diiSeries      = series
  }

  if (promoterSeries.length === 0) {
    return fail('Found the date row but no "Promoters" line. Include the promoter holding row.', { quarters })
  }

  const extras = [
    fiiSeries.length ? 'FII' : null,
    diiSeries.length ? 'DII' : null,
  ].filter(Boolean)

  return {
    ok: true,
    quarters,
    promoterSeries,
    fiiSeries,
    diiSeries,
    note: `Parsed ${promoterSeries.length} quarters of promoter holding`
        + (extras.length ? ` (plus ${extras.join(' + ')}).` : '.'),
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

// Align numbers to quarters from the RIGHT (most recent quarters are rightmost).
function zip(quarters, nums) {
  const n = Math.min(quarters.length, nums.length)
  const qs = quarters.slice(quarters.length - n)
  const vs = nums.slice(nums.length - n)
  return qs.map((q, i) => ({ q, pct: vs[i] }))
}

function fail(note, extra = {}) {
  return { ok: false, quarters: extra.quarters || [], promoterSeries: [], fiiSeries: [], diiSeries: [], note }
}

