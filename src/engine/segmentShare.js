/**
 * src/engine/segmentShare.js — what share of revenue a segment represents.
 *
 * Needed whenever a forecast is about part of a business rather than all of it:
 * "15% loan growth" is not 15% company growth, and the difference is whatever
 * the rest of the book weighs.
 *
 * The rule this follows, in order:
 *
 *   1. DERIVE from the statements where the split is already reported. For a
 *      lender the P&L separates interest income from other income, so asking
 *      would be asking for something the app can compute.
 *   2. LOOK UP in annual-report text, where the segment note lives.
 *   3. USE what the user entered — most recent, least verifiable, so it wins on
 *      recency but the source it disagrees with is shown alongside.
 *   4. ASK, only when none of the above can supply it.
 *
 * The distinction that matters: the app asks only for facts that exist in a
 * document someone can look up AND that it genuinely cannot reach. Never for a
 * judgement wearing a fact's clothing, and never for something derivable.
 */

const val = t => (t && typeof t === 'object' ? t.value : t)
const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

/** Segments whose share can be computed straight from a lender's P&L. */
const LENDER_SEGMENTS = {
  loans: {
    match: /\b(loan|advance|credit|lending|interest income|nii\b|book)\b/i,
    label: 'lending',
  },
  fee: {
    match: /\b(fee|other income|non-?interest|treasury|commission)\b/i,
    label: 'fee & other income',
  },
}

/**
 * Interest income as a share of total revenue.
 *
 * For a bank or NBFC, Screener's "Revenue" is total income and "Interest" is the
 * interest EXPENSE, so the lending share can't be read off directly. What can be
 * derived is the split between interest income and other income when both are
 * reported; where they aren't, this returns null rather than a guess.
 */
export function deriveLenderSplit(incomeHistory = []) {
  const rows = incomeHistory || []
  const last = rows[rows.length - 1]
  if (!last) return null

  const revenue = val(last.revenue)
  const otherIncome = val(last.otherIncome)
  if (!(revenue > 0) || otherIncome == null) return null

  const lendingShare = ((revenue - otherIncome) / revenue) * 100
  if (!(lendingShare > 0) || lendingShare > 100) return null

  return {
    loans: round(lendingShare),
    fee: round(100 - lendingShare),
    source: 'derived',
    basis: 'total income less other income, from the latest reported year',
    asOf: last.year ?? null,
  }
}

/**
 * Segment shares named in annual-report text.
 *
 * Reads the phrasing a segment note actually uses ("Retail contributed 42% of
 * revenue"), rather than trying to parse the table itself — the table's layout
 * varies far more than the sentence around it.
 */
export function extractSegmentShares(text = '') {
  const out = []
  const t = String(text || '')
  if (!t) return out

  const patterns = [
    /([A-Z][A-Za-z&\s]{2,28}?)\s+(?:segment\s+)?(?:contributed|accounted for|represented|comprised|formed|was)\s+(?:about\s+|around\s+|approximately\s+)?([\d.]+)\s*%\s*(?:of|to)\s*(?:the\s+)?(?:total\s+)?(?:revenue|income|sales|turnover)/gi,
    /([\d.]+)\s*%\s*of\s+(?:the\s+)?(?:total\s+)?(?:revenue|income|sales|turnover)\s+(?:came from|was from|derived from)\s+([A-Z][A-Za-z&\s]{2,28})/gi,
  ]

  for (const re of patterns) {
    let m
    while ((m = re.exec(t)) !== null) {
      const isNameFirst = isNaN(parseFloat(m[1]))
      const name = (isNameFirst ? m[1] : m[2]).trim().replace(/\s+/g, ' ')
      const pct = parseFloat(isNameFirst ? m[2] : m[1])
      if (name && pct > 0 && pct <= 100) out.push({ name, pct: round(pct), source: 'annual-report' })
    }
  }
  return out
}

/**
 * Resolve a share for the segment a piece of text is about.
 *
 * @param opts.segmentText   the announcement, e.g. "15% loan growth"
 * @param opts.sectorType    'bank' | 'nbfc' | …
 * @param opts.incomeHistory statements, for the derived path
 * @param opts.arSegments    from extractSegmentShares over AR text
 * @param opts.userShares    { [name]: pct } the user has entered before
 * @returns { pct, source, basis, alternatives[] } or { needs: true, ... }
 */
export function resolveSegmentShare(opts = {}) {
  const { segmentText = '', sectorType, incomeHistory = [], arSegments = [], userShares = {} } = opts
  const text = String(segmentText)
  const candidates = []

  // 1 — derived, for lenders
  if (sectorType === 'bank' || sectorType === 'nbfc') {
    const split = deriveLenderSplit(incomeHistory)
    if (split) {
      for (const [key, def] of Object.entries(LENDER_SEGMENTS)) {
        if (def.match.test(text) && split[key] != null) {
          candidates.push({ pct: split[key], source: 'derived', label: def.label,
                            basis: split.basis, asOf: split.asOf })
        }
      }
    }
  }

  // 2 — annual report
  for (const seg of arSegments) {
    if (mentions(text, seg.name)) {
      candidates.push({ pct: seg.pct, source: 'annual-report', label: seg.name,
                        basis: 'segment note in the annual report', asOf: seg.asOf ?? null })
    }
  }

  // 3 — user
  for (const [name, pct] of Object.entries(userShares)) {
    if (pct > 0 && mentions(text, name)) {
      candidates.push({ pct: round(pct), source: 'user', label: name,
                        basis: 'you entered this' })
    }
  }

  if (candidates.length === 0) {
    return { needs: true, reason: 'No segment split available for this business', candidates: [] }
  }

  // A user figure wins on recency — they may know something more current than
  // the last filing. The source it disagrees with is kept and shown, because a
  // wide gap usually means the two are measuring different things rather than
  // one being stale.
  const rank = { user: 0, derived: 1, 'annual-report': 2 }
  candidates.sort((a, b) => rank[a.source] - rank[b.source])
  const chosen = candidates[0]
  const others = candidates.slice(1)

  const conflict = others.find(o => Math.abs(o.pct - chosen.pct) >= 10) || null

  return {
    pct: chosen.pct,
    source: chosen.source,
    label: chosen.label,
    basis: chosen.basis,
    asOf: chosen.asOf ?? null,
    alternatives: others,
    conflict: conflict
      ? `You have ${chosen.pct}% and the ${conflict.source === 'derived' ? 'statements give' : 'annual report says'} ${conflict.pct}% — worth checking they mean the same segment.`
      : null,
  }
}

function mentions(text, name) {
  if (!name) return false
  const words = String(name).toLowerCase().split(/\s+/).filter(w => w.length >= 4)
  const t = String(text).toLowerCase()
  return words.length > 0 && words.some(w => t.includes(w))
}
