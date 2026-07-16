
/**
 * src/engine/arExtract.js
 *
 * Pure, deterministic extraction over already-extracted annual-report page text.
 * No PDF parsing, no OCR, no AI here — this only takes an array of page texts and
 * finds candidate passages by keyword/heading, windows a readable snippet around
 * each, dedupes overlaps, and groups by the guidance field the passage routes to.
 *
 * The PDF text-layer extraction itself happens in ARReader.jsx (pdf.js, in-browser).
 */

// Target sections → the guidance field each routes into. Order = display order.
export const SECTION_CONFIG = [
  { field: 'rpt', label: 'Related-party transactions', structured: true,
    keywords: [/related[\s-]?part(?:y|ies)/i] },
  { field: 'pledge', label: 'Promoter pledge / encumbrance', structured: true,
    keywords: [/pledg(?:e|ed|ing)/i, /encumber/i, /shares?\s+pledged/i] },
  { field: 'outlook', label: 'Outlook / MD&A',
    keywords: [/management discussion/i, /\boutlook\b/i, /\bguidance\b/i, /going forward/i,
               /way forward/i, /medium[\s-]?term/i, /growth (?:trajectory|momentum|drivers?|prospects?)/i,
               /strategic priorit/i, /demand environment/i, /order book/i] },
  { field: 'pli', label: 'PLI / government schemes',
    keywords: [/production[\s-]?linked/i, /\bPLI\b/, /incentive scheme/i, /government scheme/i, /\bsubsid(?:y|ies|ised)\b/i] },
  { field: 'initiatives', label: 'Capex / capacity / new initiatives',
    keywords: [/\bcapex\b/i, /capital expenditure/i, /capacity expansion/i, /green ?field/i, /brown ?field/i, /new (?:plant|facility|segment|product)/i, /diversif/i, /joint venture/i, /acquisition of/i, /commissioned/i, /expansion (?:of|plan)/i] },
  { field: 'runway', label: 'Market opportunity / growth runway',
    keywords: [/addressable market/i, /market opportunity/i, /\bTAM\b/, /market potential/i,
               /\bopportunity\b/i, /penetrat/i, /per capita/i, /under[\s-]?penetrat/i, /head ?room/i,
               /large(?:st)? market/i, /growing market/i, /demand potential/i, /market size/i] },
  // Derivation inputs — captured as NUMBERS (user confirms via keep/discard), then
  // used to fill/derive a missing metric (e.g. gross margin from material cost).
  // NOTE: no hard-coded number fields any more. `materialCost` used to live here
  // and it was the ONLY figure the AR reader ever hunted for — not because it was
  // the only one worth having, but because nothing could tell this file what else
  // was missing. buildArConfig() below now appends a number field per actual gap,
  // with that metric's annual-report phrasings from the dictionary.
]

const WIN_BEFORE = 120
const WIN_AFTER = 340
const MAX_PER_FIELD = 6
const OVERLAP_CHARS = 200

/** @param {{page:number, text:string}[]} pages */
/**
 * The AR reader's config for THIS ticker: the standing narrative sections, plus a
 * number field for every metric still missing after Yahoo and the deep source.
 *
 * This is the residue, not a first-load list. If Screener already supplied cash,
 * the reader doesn't waste a pass hunting for it.
 *
 * @param arTargets from findMissingBaseMetrics(...).arTargets
 */
export function buildArConfig(arTargets = []) {
  return [
    ...SECTION_CONFIG,
    ...arTargets.map(t => ({
      field:    t.field,
      label:    `${t.label} (needed for: ${t.needs})`,
      input:    'number',
      keywords: t.keywords,
    })),
  ]
}

export function extractSections(pages, config = SECTION_CONFIG) {
  const blocks = []
  for (const { page, text } of pages) {
    if (!text) continue
    for (const cfg of config) {
      for (const re of cfg.keywords) {
        const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
        const rx = new RegExp(re.source, flags)
        let m
        while ((m = rx.exec(text)) !== null) {
          blocks.push({
            field: cfg.field, label: cfg.label, page,
            idx: m.index, keyword: m[0],
            snippet: windowAround(text, m.index, m[0].length),
            basis: detectBasis(text, m.index),
          })
          if (m.index === rx.lastIndex) rx.lastIndex++   // avoid zero-length loop
        }
      }
    }
  }

  const deduped = dedupe(blocks)

  // Group by field, cap per field, tag structured (RPT) with any % / amount found.
  const groups = config.map(cfg => {
    const fieldBlocks = deduped
      .filter(b => b.field === cfg.field)
      .slice(0, MAX_PER_FIELD)
      .map(b => {
        if (cfg.field === 'rpt') return { ...b, rpt: sniffRpt(b.snippet) }
        if (cfg.field === 'pledge') return { ...b, pledge: sniffPledge(b.snippet) }
        if (cfg.input === 'number') return { ...b, amount: sniffAmount(b.snippet) }
        return b
      })
    return { field: cfg.field, label: cfg.label, structured: !!cfg.structured, blocks: fieldBlocks }
  }).filter(g => g.blocks.length > 0)

  return { groups, totalHits: deduped.length }
}

/** Little/no text layer ⇒ scanned PDF ⇒ caller falls back to manual paste. */
export function detectScanned(pages) {
  if (!pages.length) return true
  const totalChars = pages.reduce((s, p) => s + (p.text?.length || 0), 0)
  return totalChars / pages.length < 50
}

// ── helpers ───────────────────────────────────────────────────────────────────
function windowAround(text, idx, kwLen) {
  let start = Math.max(0, idx - WIN_BEFORE)
  let end = Math.min(text.length, idx + kwLen + WIN_AFTER)
  // Snap start to the sentence just before the hit.
  const bStart = text.lastIndexOf('. ', idx)
  if (bStart > idx - WIN_BEFORE - 40 && bStart !== -1) start = bStart + 2
  // Snap end DOWN to the last sentence boundary inside the window (keeps the
  // following sentence(s) — where amounts/details often live — rather than
  // cutting at the first period after the keyword).
  const bEnd = text.lastIndexOf('. ', end)
  if (bEnd > idx + kwLen) end = bEnd + 1
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

// Merge hits that land in the same field on the same page within OVERLAP_CHARS,
// and drop globally identical snippets.
function dedupe(blocks) {
  blocks.sort((a, b) => a.page - b.page || a.idx - b.idx)
  const kept = []
  const seen = new Set()
  for (const b of blocks) {
    const norm = b.snippet.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)
    if (seen.has(norm)) continue
    const near = kept.find(k => k.field === b.field && k.page === b.page && Math.abs(k.idx - b.idx) < OVERLAP_CHARS)
    if (near) continue
    seen.add(norm)
    kept.push(b)
  }
  return kept
}

// Best-effort structured read for related-party: look for a "% of revenue/turnover"
// or a rupee/amount figure near the hit. Presence is the reliable signal; the
// amount is opportunistic and may be null.
// Nearest financial-statement basis to a hit: scan a window around the match for
// "consolidated" / "standalone". Context only — the user decides; we never drop.
function detectBasis(text, idx) {
  // Look BACKWARD only — a statement's heading ("Consolidated Statement of
  // Profit and Loss") precedes its line items; text after the hit may belong to
  // the next statement and would mislead.
  const around = text.slice(Math.max(0, idx - 1500), idx).toLowerCase()
  const con = around.lastIndexOf('consolidated')
  const alo = around.lastIndexOf('standalone')
  if (con === -1 && alo === -1) return 'unclear'
  if (con === -1) return 'standalone'
  if (alo === -1) return 'consolidated'
  return con > alo ? 'consolidated' : 'standalone'   // whichever heading is nearer
}

export function sniffRpt(snippet) {
  const pctM = snippet.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(?:total\s*)?(?:revenue|turnover|sales|income)/i)
  const pctOfRevenue = pctM ? parseFloat(pctM[1]) : null
  return { present: true, pctOfRevenue }
}

// Promoter pledge: the snippet is already windowed around a pledge/encumber hit,
// so the first % figure in it is almost always the pledged proportion.
export function sniffPledge(snippet) {
  const m = snippet.match(/(\d+(?:\.\d+)?)\s*%/)
  return { pct: m ? parseFloat(m[1]) : null }
}

// Numeric amount near an input keyword (e.g. cost of materials consumed). Handles
// Indian/international comma grouping; takes the first figure (current year in a
// "current (PY prior)" line). Unit (crore vs absolute) is resolved at derive time.
export function sniffAmount(snippet) {
  // skip a leading number that is part of a note reference like "Note 21"
  const cleaned = snippet.replace(/note\s*\d+/ig, ' ')
  const m = cleaned.match(/(\d{1,3}(?:[,\s]\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/)
  if (!m) return { value: null }
  const value = parseFloat(m[1].replace(/[,\s]/g, ''))
  return { value: isFinite(value) ? value : null }
}