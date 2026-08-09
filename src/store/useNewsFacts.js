import { useCallback, useEffect, useState } from 'react'
import { fetchNews } from '../api/newsClient.js'
import { extractFacts } from '../engine/factExtract.js'
import { computeFact } from '../engine/factImpact.js'

/**
 * useNewsFacts — read the news feed for facts, automatically.
 *
 * This is the path the whole revision design assumed and which was missing: news
 * arrives, the app parses each item, computes the impact where the item carries
 * enough detail, and flags the rest with the one fact that would resolve it.
 * Manual paste is the fallback for something the feed missed, not the main way in.
 *
 * Three buckets, and the split matters:
 *
 *   ACTIONABLE — the item states everything needed. A suggested revision is
 *   ready; one tap applies it. The estimate still never moves on its own, but
 *   the work is done for you.
 *
 *   INCOMPLETE — the item names a real event but not its size ("RBI bars new
 *   customer onboarding"). These are the ones that hold a bar open, because
 *   something material happened and nobody can yet say how much.
 *
 *   IGNORED — nothing classifiable. Not shown; a feed full of "stock rallies on
 *   sentiment" would bury the two items that matter.
 */
export function useNewsFacts(ticker, company, ctx, handledKeys = new Set()) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const run = useCallback(async (signal) => {
    if (!ticker) { setItems([]); return }
    setLoading(true); setError(null)
    try {
      const { items: news, error: err } = await fetchNews(company || ticker, ticker, company, signal)
      if (err) setError(err)
      setItems(news || [])
    } catch (e) {
      if (e?.name !== 'AbortError') setError('fetch_failed')
    } finally { setLoading(false) }
  }, [ticker, company])

  useEffect(() => {
    const ctrl = new AbortController()
    run(ctrl.signal)
    // Same cadence the news panel already uses, and the server cache added
    // earlier is what makes polling this often affordable.
    const id = setInterval(() => { if (!document.hidden) run(ctrl.signal) }, 3 * 60 * 1000)
    return () => { ctrl.abort(); clearInterval(id) }
  }, [run])

  const analysed = []
  for (const item of items) {
    const key = keyOf(item)
    if (handledKeys.has(key)) continue          // already applied, dismissed or deferred
    const parsed = extractFacts(item.title, ctx)
    if (!parsed.typeId) continue                 // unclassifiable — not worth surfacing
    const impact = parsed.enough ? computeFact(parsed.typeId, parsed.fields, ctx) : null
    analysed.push({
      key, item, parsed,
      impact: (impact && !impact.error) ? impact : null,
      // A regulatory item with no stated size is exactly the case that should
      // hold a bar open rather than sit quietly in a list.
      severity: severityOf(parsed.typeId),
    })
  }

  const actionable = analysed.filter(a => a.impact?.lever)
  const incomplete = analysed.filter(a => !a.impact?.lever)

  // Which levers have something unresolved hanging over them. The bars read this.
  const pendingLevers = [...new Set(
    analysed.filter(a => !a.impact?.lever)
      .map(a => leverOf(a.parsed.typeId))
      .filter(Boolean)
  )]

  return { actionable, incomplete, pendingLevers, loading, error, refresh: run, raw: items }
}

/** Stable id for an item, so a handled headline doesn't come back next refresh. */
export function keyOf(item) {
  return String(item?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)
}

const LEVER_BY_TYPE = {
  contract: 'growth', capacity: 'growth', segment_loss: 'growth', growth_guidance: 'growth',
  capex: 'margin', subsidy: 'margin', input_cost: 'margin', nim_change: 'margin',
  margin_guidance: 'margin',
}
export const leverOf = typeId => LEVER_BY_TYPE[typeId] || null

// Regulatory and guidance items outrank commercial ones: a rule change can move
// the whole business, a single order usually can't.
const HIGH = new Set(['segment_loss', 'nim_change', 'growth_guidance', 'margin_guidance'])
const severityOf = typeId => (HIGH.has(typeId) ? 'high' : 'normal')
