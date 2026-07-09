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
  { field: 'tailwinds', label: 'Outlook / MD&A',
    keywords: [/management discussion/i, /future outlook/i, /industry outlook/i, /business outlook/i, /\boutlook\b/i] },
  { field: 'pli', label: 'PLI / government schemes',
    keywords: [/production[\s-]?linked/i, /\bPLI\b/, /incentive scheme/i, /government scheme/i, /\bsubsid(?:y|ies|ised)\b/i] },
  { field: 'initiatives', label: 'Capex / capacity / new initiatives',
    keywords: [/\bcapex\b/i, /capital expenditure/i, /capacity expansion/i, /green ?field/i, /brown ?field/i, /new (?:plant|facility|segment|product)/i, /diversif/i, /joint venture/i, /acquisition of/i] },
  { field: 'runway', label: 'Market opportunity / TAM',
    keywords: [/addressable market/i, /market opportunity/i, /\bTAM\b/, /market potential/i] },
]

const WIN_BEFORE = 120
const WIN_AFTER = 340
const MAX_PER_FIELD = 6
const OVERLAP_CHARS = 200

/** @param {{page:number, text:string}[]} pages */
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
      .map(b => cfg.structured ? { ...b, rpt: sniffRpt(b.snippet) } : b)
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
function sniffRpt(snippet) {
  const pctM = snippet.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(?:total\s*)?(?:revenue|turnover|sales|income)/i)
  const pctOfRevenue = pctM ? parseFloat(pctM[1]) : null
  return { present: true, pctOfRevenue }
}
