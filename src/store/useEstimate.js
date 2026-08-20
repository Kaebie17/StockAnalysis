import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { listRevisions, appendRevision, saveEstimate, currentEstimate } from '../utils/db.js'
import { queuePush } from '../sync/sync.js'
import { buildEstimate, buildJustifiedEstimate, scoreEstimate, sanityCheck } from '../engine/estimate.js'
import { assessFromQuarterly, growthDriftSuggestion } from '../engine/quarterlyBridge.js'
import { fetchPeers } from '../api/peersClient.js'
import { relativePerformance } from '../api/marketRegime.js'
import { getRiskFreeRate, refreshRiskFreeRate } from '../api/riskFreeClient.js'
import { getAiKey } from '../utils/aiKey.js'
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

/**
 * Module-level risk-free state, shared by every useEstimate instance.
 *
 * The rate is a property of the market, not of a ticker, and it changes monthly.
 * Holding it per-hook meant five components each fetching it — which is what
 * produced repeated API calls on a single page view.
 */
let rfState = null
let rfMarket = null
let rfPending = false
const rfListeners = new Set()

function subscribeRiskFree(fn) { rfListeners.add(fn); return () => rfListeners.delete(fn) }
function getRiskFreeSnapshot() { return rfState }
function emitRiskFree(v) { rfState = v; for (const fn of rfListeners) fn() }

async function ensureRiskFree(market, userKey, { force = false } = {}) {
  // Already have it for this market, and not an explicit refresh.
  if (!force && rfState?.rate > 0 && rfMarket === market) return
  if (rfPending) return
  rfPending = true
  try {
    const r = force
      ? await refreshRiskFreeRate({ market, userKey })
      : await getRiskFreeRate({ market, userKey })
    rfMarket = market
    emitRiskFree(r)
  } finally { rfPending = false }
}

export function useEstimate(state, opts = {}) {
  const [overrides, setOverrides] = useState({})
  const [peers, setPeers] = useState([])
  const [revisions, setRevisions] = useState([])
  const [stored, setStored] = useState(null)      // last frozen estimate, for scoring
  // Which justified form the user has chosen, if they've overridden the sector
  // default. Session-level: a preference about how to read a number, not data.
  const [form, setForm] = useState(null)
  // The growth window the user pinned, if any. Stored as a revision so it
  // survives reload and appears in the log — it is a decision about the company
  // like any other, and one that changes every derived number.
  const [growthWindow, setGrowthWindowState] = useState(null)
  // Risk-free rate for the justified multiple. Null until fetched, and null is a
  // valid outcome — Estimate 1 declines rather than falling back to a made-up
  // rate, since every justified multiple is sensitive to it.

  const version = useSyncExternalStore(subscribeVersion, getVersion, getVersion)

  const ticker = state?.ticker

  const reload = useCallback(async () => {
    if (!ticker) { setOverrides({}); setRevisions([]); setGrowthWindowState(null); return }

    // Declared outside the try so the growth-window lookup below can see it —
    // it was scoped to the block and referenced after, which throws.
    let rows = []
    try {
      rows = await listRevisions({ ticker })
      setRevisions(rows)
      setOverrides(activeOverrides(rows))
    } catch { setOverrides({}) }

    // The dated claim made earlier, so it can be checked against what the price
    // actually did.
    try { setStored(await currentEstimate(ticker)) } catch { setStored(null) }

    // Growth window is no longer restored from revisions — the store persists it
    // on cached `data` (data.growthWindowYears) and restores it on load.
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

  // One rate for the whole app, shared across every hook instance.
  //
  // useEstimate is mounted by five components, and each previously ran its own
  // effect — five requests a minute for a number that moves a few basis points
  // a month. The rate is also market-wide, so per-ticker fetching was wrong in
  // principle as well as wasteful: it only depends on whether the market is
  // Indian or US.
  const market = state?.data?.currency === 'INR' ? 'IN' : 'US'
  const riskFreeShared = useSyncExternalStore(subscribeRiskFree, getRiskFreeSnapshot, getRiskFreeSnapshot)

  useEffect(() => {
    ensureRiskFree(market, opts?.userKey || getAiKey())
  }, [market, opts?.userKey])

  const refreshRate = useCallback(async () => {
    await ensureRiskFree(market, opts?.userKey || getAiKey(), { force: true })
  }, [market, opts?.userKey])

  const peerBand = peerBandFrom(peers)

  // Quarterly results → guidance verdict. Both halves of this were built and
  // never joined: rows sat in `quarterlyData` and nothing read them, so a
  // company could miss guidance three quarters running with no bar moving.
  const guidanceAssessment = assessFromQuarterly(state?.quarterlyData, {
    guidance: state?.guidance,
    modelGrowth: guidedGrowthOf(state) ?? cagrOf(state),
    incomeHistory: state?.data?.incomeHistory || [],
  })

  // ESTIMATE 1 — what the fundamentals justify. Independent of price history,
  // so it stands where the market-based one can't.
  const justified = state?.ratioResult ? buildJustifiedEstimate(state.ratioResult, {
    sectorType: state.sectorType,
    form,
    // riskFreeShared, not riskFree — the per-hook state was replaced by shared
    // module state and this reference was left behind, so Estimate 1 received
    // null for the rate and reported a missing key even when one was set.
    riskFreeRate: opts?.riskFreeRate ?? riskFreeShared?.rate ?? null,
    beta: state.data?.meta?.beta ?? state.technicals?.beta ?? null,
    incomeHistory: state.data?.incomeHistory || [],
    cashflowHistory: state.data?.cashflowHistory || [],
  }) : null

  // ESTIMATE 2 — what the market has been paying.
  const estimate = state?.ratioResult ? buildEstimate(state.ratioResult, {
    guidedGrowth: guidedGrowthOf(state),
    guidedMargin: guidedMarginOf(state),
    guidanceFiscalYear: state.guidance?.revenueGuidance?.fiscalYear || null,
    guidanceExpired: state.guidance?.revenueGuidance?.status === 'resolved',
    growthWindowYears: growthWindow,
    growthOverride:   overrides.growth   ?? null,
    // Where the override came from. "Your revision" was shown even for a change
    // the app applied automatically from a news item, which reads as though the
    // user had typed it.
    overrideLabel: overrideSourceLabel(revisions, 'growth'),
    marginOverride:   overrides.margin   ?? null,
    multipleOverride: overrides.multiple ?? null,
    priceHistory:   state.data?.priceHistory   || [],
    incomeHistory:  state.data?.incomeHistory  || [],
    // The pre-normalisation series, so the multiple band is measured against
    // the figures the market actually saw.
    reportedIncomeHistory: state.data?.reportedIncomeHistory || [],
    balanceHistory: state.data?.balanceHistory || [],
    peerBand,
  }) : null

  // Re-rating check runs against the same band the estimate uses, so a proposal
  // and the number it would replace are always talking about the same thing.
  const bandRaw = forwardPeBand(state?.data?.priceHistory || [], state?.data?.incomeHistory || [])
  // forwardPeBand now returns a diagnostic object when it can't build a band;
  // treating that as a band would compare a multiple against undefined edges.
  const band = bandRaw?.insufficient ? null : bandRaw
  // Does anything explain the current deviation? A revision applied in the last
  // couple of months, or a quarterly verdict, is a cause — and a cause makes the
  // waiting period pointless, because it's the confirmation the wait was
  // substituting for.
  const RECENT_MS = 75 * 86400000
  const recentRevision = revisions.find(r =>
    r.disposition === 'revised' && (Date.now() - r.createdAt) < RECENT_MS)
  const cause = recentRevision
    ? { type: recentRevision.trigger || 'revision',
        label: recentRevision.reason || 'a revision you applied',
        at: recentRevision.createdAt }
    : (guidanceAssessment?.verdict === 'miss' || guidanceAssessment?.verdict === 'beat')
    ? { type: 'results',
        label: `results that ${guidanceAssessment.verdict === 'beat' ? 'beat' : 'missed'} the plan`,
        at: Date.now() }
    : null

  const rerating = (!overrides.multiple && band)
    ? detectRerating(state?.data?.priceHistory || [], state?.data?.incomeHistory || [], band,
        // growth passed so the current reading is put on the same FORWARD basis
        // as the band; without it the comparison is trailing-vs-forward.
        { peerBand, currentEps: state?.ratioResult?.eps, growth: estimate?.growth ?? null,
          relative, cause })
    : { detected: false, reason: overrides.multiple ? 'You have already set a multiple' : 'No band yet' }

  // How the last frozen estimate has fared. 'in-range' / 'above' / 'below',
  // plus whether its horizon has run out.
  // Standing check against the price, fair value and consensus. Every failure
  // so far was a model-choice error that was obvious once the number sat beside
  // the other two — this makes that comparison automatic rather than dependent
  // on someone noticing.
  const sanity = sanityCheck(estimate, {
    price: state?.ratioResult?.price,
        fairValue: state?.valuation?.rangeLow > 0
      ? { low: state.valuation.rangeLow, high: state.valuation.rangeHigh } : null,
    analystTarget: state?.analystTarget || null,
  })

  const score = (stored?.estimate && state?.ratioResult?.price)
    ? scoreEstimate(stored.estimate, state.ratioResult.price) : null

  // Mechanical revision proposal from reported results — a fact, so it can
  // propose a NUMBER rather than asking for one. Still one tap, never silent.
  const quarterlySuggestion = (!overrides.growth && guidanceAssessment)
    ? growthDriftSuggestion(guidanceAssessment, estimate?.growth ?? null) : null

  // Items already applied, dismissed or deferred — so a handled headline doesn't
  // resurface on the next poll.
  const handledKeys = new Set(revisions.map(r => r.sourceKey).filter(Boolean))

  /**
   * Pin a growth window. Stores the YEAR COUNT, not the rate it currently
   * produces — the rate is re-derived from whatever data exists at the time, so
   * a pinned window stays current as new years arrive rather than freezing a
   * number that silently goes stale.
   */
  const setGrowthWindow = useCallback(async (years) => {
    // Session/view control — the store persists it on `data` (cached per ticker).
    // No revision row: a slider position isn't a forecast revision, and appending
    // one per drag accumulated dead rows.
    setGrowthWindowState(years)
  }, [])

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
    guidanceAssessment, quarterlySuggestion, score, stored, relative, sanity,
    justified, form, setForm,
    growthWindow, setGrowthWindow,
    riskFree: riskFreeShared, refreshRate,
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
/** How an applied override should be described, from the log entry that set it. */
export function overrideSourceLabel(revisions = [], lever = 'growth') {
  const r = [...revisions]
    .filter(x => x.disposition === 'revised' && x.lever === lever)
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!r) return null
  switch (r.trigger) {
    case 'news-auto':      return 'applied automatically from news'
    case 'quarterly-auto': return 'applied automatically from results'
    case 'news':           return 'from a news item you applied'
    case 'quarterly':      return 'from quarterly results'
    case 'rerating':       return 'from a re-rating you accepted'
    default:               return 'set by you'
  }
}

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
  const pct = r.revCagr?.value
  return pct != null && isFinite(pct) ? pct / 100 : null
}

function guidedMarginOf(state) {
  const m = state?.guidance?.marginGuidance
  if (m && m.status !== 'resolved' && m.value != null) return m.value / 100
  return null
}
