import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { listRevisions, appendRevision, saveEstimate, currentEstimate } from '../utils/db.js'
import { queuePush } from '../sync/sync.js'
import { buildEstimate, scoreEstimate } from '../engine/estimate.js'
import { assessFromQuarterly, growthDriftSuggestion } from '../engine/quarterlyBridge.js'
import { fetchPeers } from '../api/peersClient.js'
import { relativePerformance } from '../api/marketRegime.js'
import { peerBandFrom, detectRerating } from '../engine/rerating.js'
import { forwardPeBand } from '../engine/estimate.js'

/**
 * useEstimate — the live estimate, with your accepted revisions applied.
 *
 * This closes the loop the rest of the design assumed. Until now overrides were
 * function arguments, so a revision made today evaporated on reload: the app
 * could compute an estimate but never actually be corrected, which was the one
 * thing it existed to do.
 *
 * The current override for each lever is simply the most recent revision on it
 * that wasn't dismissed or deferred. Deriving it from the append-only log rather
 * than storing "current overrides" separately means the two can't disagree, and
 * the reasoning behind today's number is always one query away.
 */
/**
 * Cross-instance revision counter.
 *
 * useEstimate is called from more than one component (the dashboard line and the
 * valuation detail), and each call has its own useState. Without a shared signal,
 * committing a revision in one of them reloaded ONLY that copy: the detail screen
 * showed the new estimate while the dashboard kept the old number until a page
 * refresh made both re-read the database. Same data, two answers on screen.
 *
 * Every commit bumps this counter and every instance is subscribed, so they all
 * reload together.
 */
let revisionVersion = 0
const versionListeners = new Set()
function bumpRevisionVersion() {
  revisionVersion++
  for (const fn of versionListeners) fn()
}
function subscribeVersion(fn) {
  versionListeners.add(fn)
  return () => versionListeners.delete(fn)
}
const getVersion = () => revisionVersion

export function useEstimate(state) {
  const [overrides, setOverrides] = useState({})
  const [peers, setPeers] = useState([])
  const [revisions, setRevisions] = useState([])
  const [stored, setStored] = useState(null)      // last frozen estimate, for scoring
  const version = useSyncExternalStore(subscribeVersion, getVersion, getVersion)

  const ticker = state?.ticker

  const reload = useCallback(async () => {
    if (!ticker) { setOverrides({}); setRevisions([]); return }
    try {
      const rows = await listRevisions({ ticker })
      setRevisions(rows)
      setOverrides(activeOverrides(rows))
    } catch { setOverrides({}) }
    // The dated claim made earlier, so it can be checked against what the price
    // actually did. Without this the estimate has no track record at all —
    // scoreEstimate existed but nothing ever called it.
    try { setStored(await currentEstimate(ticker)) } catch { setStored(null) }
    // `version` participates so a commit anywhere re-runs this everywhere.
  }, [ticker, version])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (!ticker) return
    let dead = false
    fetchPeers(ticker).then(p => { if (!dead) setPeers(p) })
    return () => { dead = true }
  }, [ticker])

  // Stock against its sector and the market — the reading that separates an
  // industry-wide de-rating from a company-specific one.
  const [relative, setRelative] = useState(null)
  useEffect(() => {
    if (!ticker || !state?.data?.priceHistory?.length) return
    let dead = false
    relativePerformance({
      priceHistory: state.data.priceHistory,
      meta: state.data.meta, sectorType: state.sectorType,
    }).then(r => { if (!dead) setRelative(r) }).catch(() => {})
    return () => { dead = true }
  }, [ticker, state?.data?.priceHistory, state?.sectorType])

  const peerBand = peerBandFrom(peers)

  // Quarterly results → guidance verdict. Both halves of this were built and
  // never joined: rows sat in `quarterlyData` and nothing read them, so a
  // company could miss guidance three quarters running with no bar moving.
  const guidanceAssessment = assessFromQuarterly(state?.quarterlyData, {
    guidance: state?.guidance,
    modelGrowth: guidedGrowthOf(state) ?? cagrOf(state),
    incomeHistory: state?.data?.incomeHistory || [],
  })

  const estimate = state?.ratioResult ? buildEstimate(state.ratioResult, {
    guidedGrowth: guidedGrowthOf(state),
    guidedMargin: guidedMarginOf(state),
    guidanceFiscalYear: state.guidance?.revenueGuidance?.fiscalYear || null,
    guidanceExpired: state.guidance?.revenueGuidance?.status === 'resolved',
    growthOverride:   overrides.growth   ?? null,
    marginOverride:   overrides.margin   ?? null,
    multipleOverride: overrides.multiple ?? null,
    priceHistory:   state.data?.priceHistory   || [],
    incomeHistory:  state.data?.incomeHistory  || [],
    balanceHistory: state.data?.balanceHistory || [],
    peerBand,
  }) : null

  // Re-rating check runs against the same band the estimate uses, so a proposal
  // and the number it would replace are always talking about the same thing.
  const band = forwardPeBand(state?.data?.priceHistory || [], state?.data?.incomeHistory || [])
  const rerating = (!overrides.multiple && band)
    ? detectRerating(state?.data?.priceHistory || [], state?.data?.incomeHistory || [], band,
        // growth passed so the current reading is put on the same FORWARD basis
        // as the band; without it the comparison is trailing-vs-forward.
        { peerBand, currentEps: state?.ratioResult?.eps, growth: estimate?.growth ?? null,
          relative })
    : { detected: false, reason: overrides.multiple ? 'You have already set a multiple' : 'No band yet' }

  // How the last frozen estimate has fared. 'in-range' / 'above' / 'below',
  // plus whether its horizon has run out.
  const score = (stored?.estimate && state?.ratioResult?.price)
    ? scoreEstimate(stored.estimate, state.ratioResult.price) : null

  // Mechanical revision proposal from reported results — a fact, so it can
  // propose a NUMBER rather than asking for one. Still one tap, never silent.
  const quarterlySuggestion = (!overrides.growth && guidanceAssessment)
    ? growthDriftSuggestion(guidanceAssessment, estimate?.growth ?? null) : null

  // Items already applied, dismissed or deferred — so a handled headline doesn't
  // resurface on the next poll.
  const handledKeys = new Set(revisions.map(r => r.sourceKey).filter(Boolean))

  /** Record a revision and re-apply. `disposition` is 'revised' | 'dismissed' | 'deferred'. */
  const commit = useCallback(async (entry) => {
    if (!ticker) return null
    const rec = await appendRevision({ ...entry, ticker })
    queuePush(`revisions:${rec.id}`, rec)
    await reload()
    bumpRevisionVersion()      // every other instance reloads too
    return rec
  }, [ticker, reload])

  /** Freeze the current estimate as a dated claim. */
  const freeze = useCallback(async (trigger = 'manual') => {
    if (!ticker || !estimate?.ok) return null
    return saveEstimate(ticker, estimate, { trigger })
  }, [ticker, estimate])

  // Levers with an unresolved deferred item still hanging over them. A bar reads
  // this to show "under review" and clears only when every open item on that
  // lever has a disposition.
  const deferredLevers = [...new Set(
    revisions.filter(r => r.disposition === 'deferred' && r.lever).map(r => r.lever))]

  return {
    estimate, overrides, revisions, peers, peerBand, rerating,
    guidanceAssessment, quarterlySuggestion, score, stored, relative,
    handledKeys, deferredLevers,
    commit, freeze, reload,
  }
}

/**
 * Latest applied revision per lever. Dismissed and deferred rows are skipped for
 * VALUE purposes but stay in the log — a deferred item still holds its bar open,
 * and a dismissal is itself worth keeping ("someone looked and judged it
 * immaterial" is different from "nobody looked").
 */
export function activeOverrides(revisions = []) {
  const out = {}
  const sorted = [...revisions].sort((a, b) => b.createdAt - a.createdAt)
  for (const r of sorted) {
    if (r.disposition !== 'revised') continue
    if (!r.lever || out[r.lever] !== undefined) continue
    if (r.newValue == null || !isFinite(r.newValue)) continue
    out[r.lever] = r.newValue
  }
  return out
}

function guidedGrowthOf(state) {
  const g = state?.guidance?.revenueGuidance
  if (g && g.status !== 'resolved' && g.unit === 'growthPct' && g.value != null) return g.value / 100
  const n = state?.assumptions?.nearTermGrowth
  return (n != null && isFinite(n)) ? n : null
}

/** Trailing growth, for the model-basis comparison when nobody has guided. */
function cagrOf(state) {
  const r = state?.ratioResult?.ratios || {}
  const pct = r.revCagr5y?.value ?? r.revGrowthRecent?.value ?? r.revCagr?.value
  return pct != null && isFinite(pct) ? pct / 100 : null
}

function guidedMarginOf(state) {
  const m = state?.guidance?.marginGuidance
  if (m && m.status !== 'resolved' && m.value != null) return m.value / 100
  return null
}
