import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import Modal from '../Modal.jsx'
import { usePositions, positionMath, removePosition, saveExitPlan, updatePositionDate, backfillSnapshot, rebuildAllSnapshots } from '../../store/usePositions.js'
import { positionHealth } from '../../engine/positionHealth.js'
import { buildEstimate } from '../../engine/estimate.js'
import { assessFromQuarterly, quarterlyRowsFor } from '../../engine/quarterlyBridge.js'
import { fetchMarketRegime } from '../../api/marketRegime.js'
import { getCached, getCachedAge, FINANCIALS_TTL, loadExitPlanForTicker, listRevisions } from '../../utils/db.js'
import { activeOverrides } from '../../store/useEstimate.js'
import { fetchQuotes } from '../../api/quotesClient.js'
import { analyzeMany } from '../../store/analyzeTicker.js'
import { evaluateTriggers, suggestLevels } from '../../engine/exitTriggers.js'
import { adviseOnPosition } from '../../engine/positionAdvice.js'
import { assessMoatQuality } from '../../engine/moatQuality.js'
import { fetchPeerCandidates } from '../../api/peersClient.js'
import { peerBand } from '../../engine/peerBands.js'
import { peerBandFrom } from '../../engine/rerating.js'
import { financialsFromRatioResult } from '../../engine/peerCompatibility.js'
import { detectSetups } from '../../engine/setups.js'
import { forwardPeBand } from '../../engine/estimate.js'
import { yearlyObservations } from '../../engine/targetMultiple.js'
import { benchmarkReturn } from '../../engine/snapshotRebuild.js'
import { aggregateLots, holdingMath, summaryLevel } from '../../engine/positionAggregate.js'

// Loaded on demand, same as EmptyState.jsx does for it.
const SoldPositions = React.lazy(() => import('./SoldPositions.jsx'))

const sym = c => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[c]) || '₹'
const money = (v, c) => (v == null ? '—' : sym(c) + Math.abs(Math.round(v)).toLocaleString('en-IN'))
const signed = (v, c) => (v == null ? '—' : (v >= 0 ? '+' : '−') + money(v, c))
const dstr = t => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')

/**
 * PositionsPanel — holdings, one row each, opened for detail.
 *
 * The organising decision: analysis belongs to the HOLDING, not to each lot. You
 * sell FIFO and you decide on the whole position, so per-lot bars were splitting
 * one judgement into three and repeating the two thirds of it (fundamentals,
 * technicals) that are identical across lots. The entry baseline is
 * share-weighted instead — which moves the way a cost basis actually moves — and
 * lots become a plain ledger of how the holding was built.
 *
 * Collapsed by default so a twelve-stock portfolio is readable in one screen,
 * with a marker only on the ones where something has fired.
 */
export default function PositionsPanel({ open, onClose }) {
  const { state, load } = useApp()
  const { positions, loading, refresh } = usePositions()
  const [sellTarget, setSellTarget] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [regime, setRegime] = useState(null)
  const [analyses, setAnalyses] = useState({})
  const [quotes, setQuotes] = useState({})
  const [fetching, setFetching] = useState(0)
  const [exitPlans, setExitPlans] = useState({})   // ticker -> {stopPrice, targetPrice}
  const [rebuilding, setRebuilding] = useState(null)   // { done, total } while running, or a result summary
  const [soldOpen, setSoldOpen] = useState(false)

  React.useEffect(() => {
    if (!open) return
    let dead = false
    fetchMarketRegime({ indian: /\.(NS|BO)$/i.test(state.ticker || '') })
      .then(r => { if (!dead) setRegime(r) }).catch(() => {})
    return () => { dead = true }
  }, [open, state.ticker])

  // Cached analysis + live price for every held ticker, fetching anything
  // that's never been analysed AND refreshing anything analysed more than
  // FINANCIALS_TTL ago. Adding holdings you already own is the normal way in,
  // so on a fresh install nothing is cached — waiting for the user to visit
  // each stock would leave the whole portfolio blank exactly when it matters.
  // Without the age check, a stock analysed once stayed on that snapshot
  // forever: nothing ever re-triggered analyzeTicker for a ticker that
  // already had SOME cached record, however old, so a position could sit on
  // month-old fundamentals indefinitely.
  // Give any bulk-added lot a baseline it never got. backfillSnapshot exists
  // in usePositions.js specifically for this ("A lot added through bulk entry
  // has no snapshot"), but nothing ever called it — a lot added without its
  // ticker open in the dashboard stayed on a permanently unavailable "vs your
  // entry" bar forever, exactly the case the function's own comment names.
  const backfillMissing = async (ticker, analysis) => {
    if (!analysis?.ratioResult) return
    const need = positions.filter(p => p.ticker === ticker && p.status !== 'closed' && !p.snapshot?.estimate)
    if (need.length === 0) return
    for (const p of need) { try { await backfillSnapshot(p, analysis) } catch { /* best effort */ } }
    refresh()
  }

  React.useEffect(() => {
    if (!open || positions.length === 0) return
    let dead = false
    ;(async () => {
      const tickers = [...new Set(positions.filter(p => p.status !== 'closed').map(p => p.ticker))]
      const out = {}
      const needsRefresh = []
      for (const t of tickers) {
        try {
          const c = await getCached(t)
          if (c) out[t] = c
          const age = await getCachedAge(t)
          if (!c || age == null || age > FINANCIALS_TTL) needsRefresh.push(t)
        }
        catch { needsRefresh.push(t) }
      }
      if (dead) return
      setAnalyses(out)
      for (const [t, a] of Object.entries(out)) backfillMissing(t, a)
      try { const q = await fetchQuotes(tickers, { force: true }); if (!dead) setQuotes(q) } catch { /* optional */ }

      if (needsRefresh.length > 0 && !dead) {
        setFetching(needsRefresh.length)
        await analyzeMany(needsRefresh, {
          force: true,
          onEach: (t, res) => {
            if (dead) return
            setAnalyses(prev => ({ ...prev, [t]: res }))
            setFetching(n => Math.max(0, n - 1))
            backfillMissing(t, res)
          },
        })
        if (!dead) setFetching(0)
      }
    })()
    return () => { dead = true }
  }, [open, positions])

  // Exit plans, per ticker — independent of which lot IDs currently exist, so
  // a partial sale or a backdated add can't silently drop the alert.
  React.useEffect(() => {
    if (!open || positions.length === 0) return
    let dead = false
    ;(async () => {
      const tickers = [...new Set(positions.filter(p => p.status !== 'closed').map(p => p.ticker))]
      const out = {}
      for (const t of tickers) {
        try { const p = await loadExitPlanForTicker(t); if (p) out[t] = p } catch { /* no plan set */ }
      }
      if (!dead) setExitPlans(out)
    })()
    return () => { dead = true }
  }, [open, positions])

  const held = positions.filter(p => p.status !== 'closed')
  const closed = positions.filter(p => p.status === 'closed')

  const holdings = useMemo(() => {
    const byTicker = new Map()
    for (const p of held) {
      if (!byTicker.has(p.ticker)) byTicker.set(p.ticker, [])
      byTicker.get(p.ticker).push(p)
    }
    return [...byTicker.values()].map(aggregateLots).filter(Boolean)
  }, [held])

  const priceOf = t => {
    if (state.ticker === t && state.ratioResult?.price != null) return state.ratioResult.price
    const q = quotes?.[t]?.price
    if (q > 0) return q
    return analyses?.[t]?.ratioResult?.price ?? null
  }

  // Manual, per-ticker refresh. The hourly TTL refresh above only re-fires on
  // panel open / a position-list change — leave the panel open on one ticker
  // for a while and every OTHER holding's price and analysis just sit there,
  // with no way to ask for a fresh read short of closing and reopening the
  // whole panel. This gives that a button instead of a clock.
  const refreshOneTicker = async (ticker) => {
    try {
      const q = await fetchQuotes([ticker], { force: true })
      if (q) setQuotes(prev => ({ ...prev, ...q }))
    } catch { /* optional */ }
    try {
      await analyzeMany([ticker], {
        force: true,
        onEach: (t, res) => setAnalyses(prev => ({ ...prev, [t]: res })),
      })
    } catch { /* best effort */ }
  }

  // exitTriggers.js's concentration check is explicit that both sides must be
  // measured the same way — comparing one lot's market VALUE against a
  // portfolio total that's silently part cost (whichever holdings happened to
  // be missing a live quote) overstates or understates every OTHER holding's
  // share of the book. totalValue is now only ever a clean, fully-priced
  // figure — null the moment any holding lacks a quote — and totalCost is
  // always available as the consistent fallback basis for both sides.
  const allPriced = holdings.every(h => priceOf(h.ticker) != null)
  const totalValue = allPriced ? holdings.reduce((s, h) => s + h.shares * priceOf(h.ticker), 0) : null
  const totalCost  = holdings.reduce((s, h) => s + h.shares * (h.avgPrice ?? 0), 0)

  // Rebuilds every position's frozen purchase baseline against today's engine
  // (see rebuildAllSnapshots) — for snapshots taken before a routing/estimate
  // fix, which otherwise stay wrong forever since nothing recomputes them on
  // its own.
  const handleRebuildSnapshots = async () => {
    if (rebuilding?.done != null) return
    setRebuilding({ done: 0, total: positions.length })
    try {
      const result = await rebuildAllSnapshots((done, total) => setRebuilding({ done, total }))
      setRebuilding({ result })
      refresh()
    } catch {
      setRebuilding({ result: { total: positions.length, updated: 0, failed: true } })
    }
  }

  if (!open) return null

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="My positions"
      icon="📊"
      widthClass="sm:max-w-2xl"
      bodyClassName="space-y-2"
      actions={
        <>
          {closed.length > 0 && (
            <button onClick={() => setSoldOpen(true)} className="text-xs text-slate-500 hover:text-slate-300">
              📕 Exit record
            </button>
          )}
          <button onClick={handleRebuildSnapshots} disabled={rebuilding?.done != null}
            title="Rebuild every position's purchase baseline against today's estimate logic"
            className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50">
            {rebuilding?.done != null ? `↻ ${rebuilding.done}/${rebuilding.total}` : '↻ Rebuild baselines'}
          </button>
          <button onClick={() => setAddOpen(true)} className="text-xs text-accent hover:text-accent-light">+ Add</button>
        </>
      }
    >
          {/* Only the genuine first load (nothing in state yet) replaces the
              whole list with this — usePositions()'s own refresh() sets
              loading back to true on every re-sync (e.g. a background pull
              landing, or backfillMissing calling it after a snapshot
              backfill), not just the initial mount. Gating on loading alone
              unmounted every <Holding> — and every bit of state it holds,
              including an open advice popup, the expanded row, an in-flight
              peer fetch — on every one of those background refreshes, not
              just the first. The list itself only needs to exist once; a
              background reload updating its contents in place doesn't need
              to destroy and recreate every row to do that. */}
          {loading && positions.length === 0 ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : holdings.length === 0 && closed.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <p className="text-slate-400 text-sm">Nothing tracked yet.</p>
              <button onClick={() => setAddOpen(true)} className="btn-primary text-sm">Add a holding</button>
            </div>
          ) : (
            <>
              {/* One market-wide reading, once — a caveat on how much weight the
                  bars below deserve today, not a fact about any stock. */}
              {regime?.vix >= 20 && (
                <div className="text-[11px] rounded-lg px-3 py-2 bg-neutral/10 text-neutral">
                  India VIX {Math.round(regime.vix)} — {regime.vix >= 28 ? 'stressed market' : 'elevated volatility'} ·
                  single-stock signals are less reliable while everything moves together
                </div>
              )}

              {fetching > 0 && (
                <p className="text-[11px] text-slate-500">
                  Refreshing {fetching} stock{fetching > 1 ? 's' : ''}…
                </p>
              )}

              {rebuilding?.result && (
                <p className="text-[11px] text-slate-500">
                  {rebuilding.result.failed
                    ? 'Rebuild failed partway through — existing baselines were left as they were.'
                    : `Rebuilt ${rebuilding.result.updated} of ${rebuilding.result.total} baseline${rebuilding.result.total === 1 ? '' : 's'}.`}
                  <button onClick={() => setRebuilding(null)} className="ml-2 text-slate-600 hover:text-slate-400">dismiss</button>
                </p>
              )}

              {holdings.map(h => (
                <Holding key={h.ticker} agg={h}
                  price={priceOf(h.ticker)}
                  analysis={state.ticker === h.ticker && state.ratioResult ? state : analyses[h.ticker]}
                  isLive={state.ticker === h.ticker && !!state.ratioResult}
                  state={state} regime={regime} totalValue={totalValue} totalCost={totalCost}
                  exitPlan={exitPlans[h.ticker]}
                  expanded={expanded === h.ticker}
                  onToggle={() => setExpanded(e => (e === h.ticker ? null : h.ticker))}
                  onAnalyse={() => { load(h.ticker); onClose() }}
                  onSell={lot => setSellTarget(lot)}
                  onRefresh={refresh}
                  onManualRefresh={() => refreshOneTicker(h.ticker)}
                  onSaveExitPlan={async plan => {
                    const rec = await saveExitPlan(h.ticker, plan)
                    setExitPlans(prev => ({ ...prev, [h.ticker]: rec }))
                  }} />
              ))}

              {closed.length > 0 && (
                <div className="pt-2">
                  <button onClick={() => setShowClosed(s => !s)}
                    className="text-xs text-slate-500 hover:text-slate-300">
                    {showClosed ? '▲' : '▼'} {closed.length} closed position{closed.length > 1 ? 's' : ''}
                  </button>
                  {showClosed && (
                    <div className="space-y-1.5 mt-2 opacity-70">
                      {closed.map(p => (
                        <div key={p.id} className="bg-navy-800/40 rounded-lg px-3 py-2 text-[11px]">
                          <span className="font-mono text-slate-300">{p.ticker.replace(/\.(NS|BO)$/, '')}</span>
                          <span className="text-slate-500 ml-2">
                            {p.shares} × {money(p.buyPrice, p.snapshot?.currency)} → {money(p.sellPrice, p.snapshot?.currency)} {dstr(p.sellDate)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
    </Modal>

    <PositionModal open={addOpen} mode="bulk"
      onClose={() => setAddOpen(false)} onSaved={refresh} />
    <PositionModal open={sellTarget !== null} mode="sell"
      lots={sellTarget ? held.filter(p => p.ticker === sellTarget.ticker) : []}
      onClose={() => setSellTarget(null)} onSaved={refresh} />
    <React.Suspense fallback={null}>
      {soldOpen && <SoldPositions open onClose={() => setSoldOpen(false)} />}
    </React.Suspense>
    </>
  )
}

/**
 * One holding: a scannable row, expanding to the analysis and the lot ledger.
 */
function Holding({ agg, price, analysis, isLive, state, regime, totalValue, totalCost, exitPlan,
                   expanded, onToggle, onAnalyse, onSell, onRefresh, onManualRefresh, onSaveExitPlan }) {
  const c = agg.lots[0]?.snapshot?.currency
  const m = holdingMath(agg, price)
  const [refreshing, setRefreshing] = useState(false)
  const [verdictOpen, setVerdictOpen] = useState(false)
  const [peerInfo, setPeerInfo] = useState(null)
  const [peerLoading, setPeerLoading] = useState(false)
  // Growth/margin/multiple corrections the user has actually accepted for
  // THIS ticker (a news item applied, a quarterly-driven revision, a
  // re-rating accepted) — buildEstimate's target range moves on these the
  // same way the live Valuation dashboard's App Target does. Without this,
  // a held position whose ticker has an accepted re-rating (exactly the
  // case that dragged App Target down elsewhere this session) silently
  // recomputed the OLD, unrevised range here instead, next to a Verdict
  // that's supposed to be reading the same number.
  const [revisions, setRevisions] = useState([])
  useEffect(() => {
    let dead = false
    listRevisions({ ticker: agg.ticker }).then(r => { if (!dead) setRevisions(r) }).catch(() => {})
    return () => { dead = true }
  }, [agg.ticker])
  const handleManualRefresh = async (e) => {
    e.stopPropagation()
    if (refreshing) return
    setRefreshing(true)
    try { await onManualRefresh() } finally { setRefreshing(false) }
  }

  // Analysis is computed once for the holding, from live state when this is the
  // loaded ticker and from the saved analysis otherwise.
  const { estimate, health, triggers, quality, moatQuality, marketExpectation, ownPe, ownRoe } = useMemo(() => {
    if (!analysis?.ratioResult) return {}
    const rr = price != null && price !== analysis.ratioResult.price
      ? { ...analysis.ratioResult, price } : analysis.ratioResult
    // buildEstimate/forwardPeBand/yearlyObservations/assessFromQuarterly all
    // resolve the reported/normalized toggle internally now (estimate.js,
    // targetMultiple.js, quarterlyBridge.js), so every one of them below is
    // called with the ticker's raw stored history plus `basis`/`normBasis`,
    // not a copy this component pre-corrects itself.
    const rawIncomeHistory = analysis.data?.reportedIncomeHistory || []
    const rawBalanceHistory = analysis.data?.balanceHistory || []
    // Growth/margin/multiple overrides from accepted revisions (news, a
    // quarterly-driven correction, an accepted re-rating) — the exact same
    // resolver useEstimate.js uses for the live Valuation dashboard's App
    // Target. Without this, a ticker with a real accepted revision showed
    // one target range here and a completely different one on its own
    // Valuation page, both claiming to be "the" App Target for the same
    // stock.
    const overrides = activeOverrides(revisions)
    const est = buildEstimate(rr, {
      sectorType: analysis.sectorType,
      guidedGrowth: (isLive && state.assumptions?.nearTermGrowth != null
        && isFinite(state.assumptions.nearTermGrowth)) ? state.assumptions.nearTermGrowth : null,
      growthOverride:   overrides.growth   ?? null,
      marginOverride:   overrides.margin   ?? null,
      multipleOverride: overrides.multiple ?? null,
      priceHistory:   analysis.data?.priceHistory   || [],
      incomeHistory:  rawIncomeHistory,
      balanceHistory: rawBalanceHistory,
      quarterlyHistory: analysis.data?.quarterlyHistory || [],
      basis: analysis.data?.basis,
      // Confirmed-peer cross-check, once the Verdict button has fetched it —
      // null (no effect on the ladder) until then, same as it is on first
      // paint of the live dashboard before ITS peer fetch resolves.
      peerBand: peerInfo?.forEstimate ?? null,
      peerWeight: analysis.data?.peerWeight ?? 0,
    })
    const ga = assessFromQuarterly(isLive ? quarterlyRowsFor(analysis.data, state.quarterlyData) : null, {
      guidance: isLive ? state.guidance : null,
      modelGrowth: est?.growth ?? null,
      incomeHistory: rawIncomeHistory,
      basis: analysis.data?.basis,
    })
    // Leading conditions, from data already fetched — volume, the multiple's
    // position in its own band, the earnings-vs-multiple gap, sector divergence.
    const bandRaw = forwardPeBand(analysis.data?.priceHistory || [], rawIncomeHistory, { normBasis: analysis.data?.basis })
    const band = bandRaw?.insufficient ? null : bandRaw
    const obs = yearlyObservations({
      priceHistory: analysis.data?.priceHistory || [],
      incomeHistory: rawIncomeHistory,
      balanceHistory: rawBalanceHistory, basis: 'pe', normBasis: analysis.data?.basis })
    const epsTrend = obs.length >= 2
      ? (obs[obs.length - 1].eps > obs[obs.length - 2].eps ? 'improving' : 'deteriorating') : null
    const setups = detectSetups({
      priceHistory: analysis.data?.priceHistory || [],
      currentMultiple: rr.ratios?.pe?.value ?? (rr.price / rr.eps),
      band, observations: obs, earningsTrend: epsTrend,
      relative: null,
    })

    const h = positionHealth(agg, {
      setups,
      currentEstimate: est, currentPrice: price,
      qualityScore: analysis.quality?.score ?? null,
      marginTrendPct: est?.marginTrendPct ?? null,
      guidanceAssessment: ga,
      technicals: analysis.technicals,
      regime: { ...(regime || {}), stockChangePct: quotesChange(analysis) },
      stale: !isLive,
    })
    const t = Object.assign(
      evaluateTriggers(agg, {
        price, estimate: est, ratioResult: rr,
        marketExpectation: analysis.marketExpectation,
        guidance: isLive ? state.guidance : null, guidanceAssessment: ga,
        priceHistory: analysis.data?.priceHistory || [],
        incomeHistory: rawIncomeHistory, basis: analysis.data?.basis,
        portfolioValue: totalValue, portfolioCost: totalCost, plan: exitPlan,
      }),
      { estimate: est,
        suggestions: suggestLevels({
          price, estimate: est, technicals: analysis.technicals,
          priceHistory: analysis.data?.priceHistory || [], buyPrice: agg.avgPrice }) })
    // Ratios-only (no holdings/AR data on a saved position analysis, same as
    // MoatQualityPanel/SummaryStrip run before either is present) — moat/
    // quality tiers are still fully computed from financials already here,
    // just without the governance overlay that needs those two documents.
    const mq = assessMoatQuality(analysis.data, rr, { sectorType: analysis.sectorType })
    return {
      estimate: est, health: h, triggers: t,
      quality: analysis.quality, moatQuality: mq, marketExpectation: analysis.marketExpectation,
      ownPe: rr.ratios?.pe?.value ?? null, ownRoe: rr.ratios?.roe?.value ?? null,
    }
  }, [analysis, price, isLive, state, regime, agg, totalValue, totalCost, exitPlan, revisions, peerInfo])

  const level = summaryLevel(health)
  const firedCount = triggers?.fired?.length || 0
  // One verdict, not one per hypothetical action — the position doesn't
  // know or care whether you're about to average up, average down, or
  // exit, and asking it three separate times just reproduced the same
  // Valuation/Quality facts three times over. Peers is the one genuinely
  // async piece (fetchPeerCandidates below) — null until it resolves,
  // which positionAdvice.js treats as "not available yet," not "no peers."
  const adviceCtx = { estimate, price, triggers, technicals: analysis?.technicals, quality, moatQuality, marketExpectation, peers: peerInfo }
  const advice = verdictOpen ? adviseOnPosition(adviceCtx) : null

  // Fetched once per open, not pre-loaded for every holding on render — this
  // is exactly the kind of on-demand cost a user-triggered feature is
  // supposed to absorb instead of paying for every holding whether or not
  // anyone ever opens it.
  const openVerdict = async () => {
    setVerdictOpen(true)
    setPeerInfo(null)
    setPeerLoading(true)
    try {
      const candidates = await fetchPeerCandidates({
        ticker: agg.ticker, meta: analysis?.data?.meta, sectorType: analysis?.sectorType, classification: null,
      })
      const peBand = peerBand(candidates, 'pe')
      const roeBand = peerBand(candidates, 'roe')
      // Same input App Target's own peer rung uses (estimate.js's peerBand
      // option, via useEstimate.js's peerBandFrom) — CONFIRMED peers only,
      // screened against this ticker's own financials, not the full
      // candidate pool peBand/roeBand above read for the Verdict's own
      // "trading at Nx vs peer median" fact. Without this, buildEstimate's
      // target range here never reflected any peer cross-check at all, so
      // it could disagree with the live Valuation dashboard's App Target
      // for a ticker whose peer band pulls the fitted multiple meaningfully.
      const confirmedSet = new Set(analysis?.data?.confirmedPeers || [])
      const confirmedCandidates = candidates.filter(p => confirmedSet.has(p.symbol))
      const forEstimate = analysis?.ratioResult
        ? peerBandFrom(confirmedCandidates, financialsFromRatioResult(analysis.ratioResult)) : null
      setPeerInfo({ peBand, roeBand, ownPe, ownRoe, count: peBand?.count ?? roeBand?.count ?? candidates.length, forEstimate })
    } catch {
      setPeerInfo({ error: true })
    } finally {
      setPeerLoading(false)
    }
  }

  return (
    <div className="bg-navy-800/40 rounded-lg overflow-hidden">
      {/* Collapsed row — the whole portfolio should read in one screen. A
          plain div (not a button) here, since it now holds a real nested
          refresh button — a button-in-a-button is invalid HTML and makes the
          refresh click also fire the outer toggle. */}
      <div onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onToggle()}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left min-w-0 cursor-pointer">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">
            {agg.ticker.replace(/\.(NS|BO)$/, '')}
            {firedCount > 0 && <span className="text-neutral ml-1.5 text-xs">⚠</span>}
          </div>
          <div className="text-[11px] text-slate-500">
            {agg.shares} sh · {money(agg.avgPrice, c)}
          </div>
        </div>
        <Bars level={level} />
        {/* Manual refresh — the hourly TTL refresh only re-fires on panel
            open, so a holding left sitting on screen for a while has no other
            way to ask for a current price/analysis short of closing and
            reopening the whole panel. */}
        <button onClick={handleManualRefresh} disabled={refreshing}
          title="Refresh price & analysis" aria-label="Refresh price and analysis"
          className="text-slate-500 hover:text-accent shrink-0 text-xs px-0.5 disabled:opacity-50">
          {refreshing ? '…' : '↻'}
        </button>
        <div className="text-right w-24 shrink-0 tabular-nums">
          <div className="text-[13px] text-slate-200">{price > 0 ? money(price, c) : '—'}</div>
          {m?.pnl != null && (
            <div className={`text-[11px] ${m.pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
              {signed(m.pnl, c)}
            </div>
          )}
        </div>
        <span className="text-slate-600 text-xs">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] pt-1 border-t border-navy-800">
            <span className="text-slate-500">
              {money(m?.value, c)} value · {money(agg.cost, c)} cost
            </span>
            <button onClick={onAnalyse} className="text-accent hover:text-accent-light">analyse ↗</button>
          </div>

          {estimate?.ok && (
            <div className="text-[12px] text-slate-300">
              <span className="text-slate-500">Estimate today </span>
              {money(estimate.target.low, c)}–{money(estimate.target.high, c)}
              {price > 0 && (
                <span className={estimate.upside?.base >= 0 ? 'text-bull ml-1.5' : 'text-bear ml-1.5'}>
                  {estimate.upside?.base >= 0 ? '+' : ''}{estimate.upside?.base}% from {money(price, c)}
                </span>
              )}
            </div>
          )}

          {/* Four bars, all holding-level. Named, because an unlabelled bar is a
              shape rather than a reading. */}
          {health && (
            <div className="space-y-1">
              <BarRow label="Fundamentals" bar={health.fundamental} />
              <BarRow label="Technical" bar={health.technical} />
              {health.rerate?.available && (
                <BarRow label="Re-rating" bar={health.rerate} mode="direction" />
              )}
              <BarRow label="vs your entry" bar={health.estimate} mode="direction" />
            </div>
          )}
          {health?.stale && (
            <p className="text-[10px] text-slate-600">from the last saved analysis</p>
          )}

          {/* positionAdvice.js produces a Buy/Hold/Sell/Wait decision for
              all three intents (average up/down, exit) at once — Valuation
              and Quality don't even depend on intent, so one button opening
              one popup with all three outcomes is both simpler and less
              repetitive than three separate buttons each reopening the
              same shared analysis. Reuses exactly the triggers/health/
              quality/moat/market-expectation already computed above plus a
              fresh, on-demand peer fetch shared across all three — it
              doesn't decide anything or get saved anywhere, and every point
              behind each lean is shown, same disclosure standard as the
              bars above. */}
          {health && (
            <div className="pt-1 border-t border-navy-800">
              <button disabled={peerLoading}
                onClick={e => { e.stopPropagation(); openVerdict() }}
                className="text-[11px] px-2 py-1 rounded border border-navy-700 bg-navy-900 text-slate-300
                           hover:border-accent hover:text-accent disabled:opacity-50">
                {peerLoading ? 'Gathering verdict…' : 'Verdict'}
              </button>
              <AdviceDetailModal open={verdictOpen} onClose={() => { setVerdictOpen(false); setPeerInfo(null) }}
                ticker={agg.ticker} advice={advice} peerLoading={peerLoading} />
            </div>
          )}
          {/* evaluateTriggers() computes this but nothing read it, so a holding
              with no analysis available looked identical to one that was
              checked and came back clean. */}
          {triggers?.empty && (
            <p className="text-[10px] text-slate-600">not enough data to evaluate exit conditions yet</p>
          )}

          <LotLedger agg={agg} price={price} currency={c}
                     indexNow={regime?.indexLevel ?? null}
                     baselineFrom={triggers?.baselineFrom}
                     onSell={onSell} onRefresh={onRefresh} />

          {triggers && (
            <ExitPlan plan={exitPlan} triggers={triggers} price={price} currency={c}
              onSave={onSaveExitPlan} />
          )}
        </div>
      )}
    </div>
  )
}

function quotesChange(analysis) {
  return analysis?.data?.meta?.change1d ?? null
}

/**
 * One reading. Bars where the measure is a LEVEL (how strong), arrows where it
 * is a DIRECTION (which way).
 *
 * Fundamentals and Technical describe a state — "quality steady", "below both
 * moving averages" — and forcing an arrow onto those means inventing a direction
 * for something that genuinely has none. Re-rating and estimate-drift are the
 * opposite: they resolve to up, down or contradictory, and a 0-4 level buries
 * exactly the part that matters. Neither notation suits both, so each row uses
 * the one that fits it.
 */
function BarRow({ label, bar, mode = 'level' }) {
  return (
    <div className="flex items-center gap-2 text-[11px] min-w-0">
      <span className="text-slate-500 w-24 shrink-0">{label}</span>
      {mode === 'direction'
        ? <Arrow direction={bar?.available ? bar.direction : null}
                 magnitude={bar?.magnitudePct} />
        : <Bars level={bar?.available ? bar.level : null} />}
      {/* min-w-0 is what makes truncate work at all inside a flex row — without
          it the span refuses to shrink and pushes the row wider than its card. */}
      <span className={`truncate min-w-0 ${bar?.available ? 'text-slate-400' : 'text-slate-600'}`}>
        {bar?.available ? bar.label : bar?.reason}
      </span>
      {/* estimateBar() computes this but nothing rendered it — a baseline
          captured today (not at purchase) drifting was shown with the same
          confidence as a genuine purchase-day reading. */}
      {bar?.available && bar?.lateSnapshot && (
        <span className="text-neutral shrink-0" title="Baseline wasn't captured at purchase — this drift reading starts from a later date">⚠</span>
      )}
    </div>
  )
}

const DECISION_STYLE = {
  Buy:  { text: 'text-bull',    bg: 'bg-bull/10' },
  Hold: { text: 'text-slate-300', bg: 'bg-navy-800' },
  Sell: { text: 'text-bear',    bg: 'bg-bear/10' },
  Wait: { text: 'text-neutral', bg: 'bg-neutral/10' },
}

/**
 * positionAdvice.js's own section order, followed exactly: Valuation ->
 * Quality -> Technical -> Conflict -> Decision (last, computed from the
 * other three, not first). Three separate questions shown as three separate
 * sections on purpose — a good business at a rich price with a confirming
 * uptrend and a weak business at a cheap price with unconfirmed technicals
 * are different situations a single collapsed score can't tell apart. One
 * verdict overall, though — not one per hypothetical action.
 */
function AdviceDetailModal({ open, onClose, ticker, advice, peerLoading }) {
  if (!advice) return null
  const { valuation, quality, technical, conflict, decision } = advice
  const style = DECISION_STYLE[decision.action] || DECISION_STYLE.Hold
  return (
    <Modal open={open} onClose={onClose}
      title={`${ticker.replace(/\.(NS|BO)$/, '')} — Verdict`}
      subtitle="What the current price, business quality, and price action together support">
      {peerLoading && (
        <p className="text-[11px] text-accent">Gathering peer comparison — the rest of this is ready now.</p>
      )}

      <div className={`rounded-lg p-3 space-y-1 ${style.bg}`}>
        <p className={`font-semibold text-sm ${style.text}`}>{decision.action}</p>
        <p className="text-xs text-slate-400">{decision.reason}</p>
      </div>

      <AdviceSection title="Valuation — what price is the market assuming?" verdict={valuation.verdict}
        facts={valuation.facts} available={valuation.available} />
      <AdviceSection title="Business quality — is the underlying business supporting that price?"
        verdict={quality.verdict} facts={quality.facts} narrative={quality.narrative} available={quality.available} />
      <AdviceSection title="Technical — is the market confirming this?" verdict={technical.verdict}
        facts={technical.facts} narrative={technical.narrative ? [technical.narrative] : []} available={technical.available} />

      {(conflict.supporting.length > 0 || conflict.against.length > 0) && (
        <div className="space-y-1 pt-1">
          {conflict.supporting.length > 0 && (
            <ul className="text-xs text-slate-400 space-y-0.5">
              {conflict.supporting.map((s, i) => <li key={`s${i}`} className="text-bull">+ {s}</li>)}
            </ul>
          )}
          {conflict.against.length > 0 && (
            <ul className="text-xs text-slate-400 space-y-0.5">
              {conflict.against.map((s, i) => <li key={`a${i}`} className="text-bear">− {s}</li>)}
            </ul>
          )}
          <p className="text-xs text-slate-300 pt-0.5"><span className="text-slate-500">Central issue — </span>{conflict.centralIssue}</p>
        </div>
      )}

      {(decision.strengthen?.length > 0 || decision.weaken?.length > 0) && (
        <div className="grid grid-cols-2 gap-2 pt-1">
          {decision.strengthen?.length > 0 && (
            <div>
              <p className="text-[11px] text-slate-500">Would strengthen</p>
              <ul className="text-[11px] text-slate-500 space-y-0.5">
                {decision.strengthen.map((s, i) => <li key={i}>· {s}</li>)}
              </ul>
            </div>
          )}
          {decision.weaken?.length > 0 && (
            <div>
              <p className="text-[11px] text-slate-500">Would weaken</p>
              <ul className="text-[11px] text-slate-500 space-y-0.5">
                {decision.weaken.map((s, i) => <li key={i}>· {s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-600 pt-2 border-t border-navy-800">
        This is a synthesis of the same signals shown elsewhere on this holding — it doesn't decide
        anything, save anything, or act on anything by itself.
      </p>
    </Modal>
  )
}

function AdviceSection({ title, verdict, facts = [], narrative = [], available }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-slate-300 font-medium text-sm">{title}</p>
        <span className="text-xs text-accent shrink-0">{verdict}</span>
      </div>
      {!available ? (
        <p className="text-xs text-slate-600">Not enough data for this section.</p>
      ) : (
        <>
          <ul className="text-xs text-slate-500 space-y-0.5">
            {facts.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
          {narrative.map((n, i) => <p key={i} className="text-xs text-slate-400 pt-0.5">{n}</p>)}
        </>
      )}
    </div>
  )
}

/**
 * Direction glyph. `←→` for mixed, which is the one state bars cannot express
 * at all — a contradictory reading rendered as a mid-level bar is
 * indistinguishable from a weak but coherent one.
 */
function Arrow({ direction, magnitude }) {
  const map = {
    up:      { glyph: '↑',  cls: 'text-bull' },
    down:    { glyph: '↓',  cls: 'text-bear' },
    mixed:   { glyph: '←→', cls: 'text-neutral' },
    neutral: { glyph: '→',  cls: 'text-slate-500' },
  }
  const d = map[direction] || { glyph: '·', cls: 'text-navy-700' }
  return (
    <span className={`inline-flex items-center gap-0.5 shrink-0 ${d.cls}`}
          style={{ minWidth: 26 }}>
      <span className="text-xs leading-none">{d.glyph}</span>
      {magnitude > 0 && <span className="text-[10px] tabular-nums">{magnitude}%</span>}
    </span>
  )
}

/** Signal-strength bars. Four rungs, coloured by level, grey when unavailable. */
function Bars({ level }) {
  const heights = [5, 8, 11, 14]
  const colour = level == null ? 'bg-navy-700'
    : level >= 3 ? 'bg-bull' : level <= 1 ? 'bg-bear' : 'bg-neutral'
  return (
    <span className="inline-flex items-end gap-[2px] h-4 shrink-0">
      {heights.map((h, i) => (
        <span key={i} style={{ height: h }}
          className={`w-[3px] rounded-sm ${level != null && i < level ? colour : 'bg-navy-700'}`} />
      ))}
    </span>
  )
}

/**
 * The lots, as a ledger. No analysis here — that lives above, on the holding.
 * These rows say how the position was built and let each entry be corrected.
 */
function LotLedger({ agg, price, currency, indexNow, baselineFrom, onSell, onRefresh }) {
  const [editing, setEditing] = useState(null)
  const [menu, setMenu] = useState(null)
  const bench = benchmarkReturn(agg.snapshot, price, indexNow)
  const heldDays = agg.firstBuy ? Math.floor((Date.now() - agg.firstBuy) / 86400000) : 0

  return (
    <div className="bg-navy-900/50 rounded-lg p-2.5 space-y-1.5">
      {agg.lots.map(p => {
        const lm = positionMath(p, price)
        return (
          <div key={p.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[11px] min-w-0">
              <div className="min-w-0 truncate">
                <button onClick={() => setEditing(editing === p.id ? null : p.id)}
                  className="text-slate-400 hover:text-accent">
                  {dstr(p.buyDate)} ✎
                </button>
                <span className="text-slate-500 ml-2">
                  {p.shares} × {money(p.buyPrice, currency)}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {lm?.pnl != null && (
                  <span className={lm.pnl >= 0 ? 'text-bull' : 'text-bear'}>{signed(lm.pnl, currency)}</span>
                )}
                <button onClick={() => setMenu(menu === p.id ? null : p.id)}
                  className="text-slate-600 hover:text-slate-300 px-1">⋯</button>
              </div>
            </div>

            {p.note && <p className="text-[10px] text-slate-600 italic">“{p.note}”</p>}

            {editing === p.id && (
              <DateEditor current={p.buyDate}
                onCancel={() => setEditing(null)}
                onSet={async ms => { setEditing(null); await updatePositionDate(p.id, ms); onRefresh() }} />
            )}

            {menu === p.id && (
              <LotMenu onSell={() => { setMenu(null); onSell(p) }}
                onDelete={async () => { setMenu(null); await removePosition(p.id); onRefresh() }}
                onCancel={() => setMenu(null)} />
            )}
          </div>
        )
      })}

      {/* Entry baseline for the HOLDING — share-weighted, so a small top-up
          barely moves it and a large one properly does. */}
      {agg.entryEstimate && (
        <div className="text-[10px] text-slate-600 pt-1 border-t border-navy-800">
          Range at entry {money(agg.entryEstimate.low, currency)}–{money(agg.entryEstimate.high, currency)}
          {agg.entryEstimate.coverage < 100 && <> · from {agg.entryEstimate.coverage}% of shares</>}
          {agg.spansYears && (
            <> · averaged across purchases from {dstr(agg.firstBuy)} to {dstr(agg.lastBuy)}</>
          )}
        </div>
      )}

      {/* Only when time has passed and the gap is worth a line. */}
      {bench?.alphaPct != null && heldDays >= 30 && Math.abs(bench.alphaPct) >= 3 && (
        <div className="text-[10px] text-slate-500">
          <span className={bench.alphaPct >= 0 ? 'text-bull' : 'text-bear'}>
            {bench.alphaPct >= 0 ? '+' : ''}{bench.alphaPct}% vs the index
          </span>
          <span className="text-slate-600"> since you bought</span>
        </div>
      )}

      {agg.snapshot?.backfilled && (
        <p className="text-[10px] text-neutral">
          baseline starts {baselineFrom ? dstr(baselineFrom) : 'today'} — set the real purchase dates to compare from when you actually bought
        </p>
      )}
      {/* Computed by positionAggregate.js but never rendered — a mechanically
          rebuilt baseline (financials/prices as of the purchase date, not a
          live capture) looked identical to a real one with nothing to say so. */}
      {agg.snapshot?.reconstructed && !agg.snapshot?.backfilled && (
        <p className="text-[10px] text-neutral">
          baseline rebuilt from that date's financials and prices — a mechanical estimate, not one observed live
        </p>
      )}
    </div>
  )
}

function LotMenu({ onSell, onDelete, onCancel }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div className="flex items-center gap-3 bg-navy-800/60 rounded px-2 py-1.5">
      {confirm ? (
        <>
          <span className="text-[10px] text-bear">Delete this lot permanently?</span>
          <button onClick={onDelete}
            className="text-[10px] px-2 py-0.5 rounded border border-bear/60 text-bear hover:bg-bear/10">
            Delete
          </button>
          <button onClick={() => setConfirm(false)} className="text-[10px] text-slate-500">cancel</button>
        </>
      ) : (
        <>
          <button onClick={onSell} className="text-[11px] text-slate-300 hover:text-bear">Record sale</button>
          <button onClick={() => setConfirm(true)} className="text-[11px] text-slate-600 hover:text-bear ml-auto"
            title="Only for a mis-entry — a sale should use Record sale, which keeps the history">
            Delete lot
          </button>
          <button onClick={onCancel} className="text-[11px] text-slate-600">close</button>
        </>
      )}
    </div>
  )
}

/**
 * Set a purchase date in the terms people remember it. Changing it rebuilds the
 * baseline from that date's prices and filings.
 */
function DateEditor({ current, onSet, onCancel }) {
  const [val, setVal] = useState(current ? new Date(current).toISOString().slice(0, 10) : '')
  const AGO = [['1m', 30], ['3m', 91], ['6m', 182], ['1y', 365], ['2y', 730]]
  return (
    <div className="bg-navy-800/60 rounded p-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {AGO.map(([label, days]) => (
          <button key={label} onClick={() => onSet(Date.now() - days * 86400000)}
            className="text-[10px] px-2 py-0.5 rounded-full border border-navy-700
                       text-slate-500 hover:text-accent hover:border-accent/50">
            {label} ago
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input type="date" value={val} onChange={e => setVal(e.target.value)}
          className="input-field text-xs flex-1" />
        <button onClick={() => { const t = Date.parse(val); if (isFinite(t)) onSet(t) }}
          className="text-[11px] text-accent hover:text-accent-light">Set</button>
        <button onClick={onCancel} className="text-[11px] text-slate-500">cancel</button>
      </div>
    </div>
  )
}

/**
 * Exit plan for the holding. Tapping a level sets the alert — choosing a level
 * and wanting to be told when it's reached are the same intent, so a separate
 * save step only obscured that anything was being watched.
 */
function ExitPlan({ plan, triggers, price, currency, onSave }) {
  const fired = triggers?.fired || []
  const stops = triggers?.suggestions?.stops || []
  const targets = triggers?.suggestions?.targets || []
  // Open by default once you've expanded the holding. It used to start
  // collapsed behind an 11px grey line, so the suggested levels — the part with
  // the most work behind them — were two taps deep and effectively invisible.
  // Anyone who has opened a position wants to see where to get out of it.
  const [open, setOpen] = useState(true)

  if (fired.length === 0 && stops.length === 0 && targets.length === 0) return null

  return (
    <div className="pt-1 border-t border-navy-800">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 text-[11px] text-slate-400 hover:text-slate-200">
        <span className="font-medium">Exit plan</span>
        {/* Say what's inside, so the row is worth opening even when nothing has
            fired. It previously read just "Exit plan" on a healthy holding,
            which gave no reason to look. */}
        {fired.length > 0
          ? <span className="text-neutral">{fired.length} to look at</span>
          : (stops.length + targets.length) > 0 &&
            <span className="text-slate-600">
              {stops.length} stop{stops.length === 1 ? '' : 's'} · {targets.length} booking level{targets.length === 1 ? '' : 's'}
            </span>}
        {plan?.stopPrice > 0 && <span className="text-accent">alert {money(plan.stopPrice, currency)}</span>}
        <span className="ml-auto">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-1.5 space-y-2">
          {fired.map(t => (
            <div key={t.id}
              className={`text-[11px] rounded px-2 py-1.5 ${
                t.side === 'profit' ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
              <div>{t.title}</div>
              {t.detail && <div className="text-slate-400 mt-0.5">{t.detail}</div>}
            </div>
          ))}

          {triggers.suggestions?.stops?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500">Alert me if it falls below</div>
              {triggers.suggestions.stops.map(sg => (
                <LevelOption key={sg.id} sg={sg} price={price} side="below" currency={currency}
                  active={Number(plan?.stopPrice) === sg.price}
                  onPick={() => onSave({ stopPrice: sg.price })} />
              ))}
            </div>
          )}

          {triggers.suggestions?.targets?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500">Alert me if it rises above</div>
              {triggers.suggestions.targets.map(sg => (
                <LevelOption key={sg.id} sg={sg} price={price} side="above" currency={currency}
                  active={Number(plan?.targetPrice) === sg.price}
                  onPick={() => onSave({ targetPrice: sg.price })} />
              ))}
            </div>
          )}

          {(plan?.stopPrice > 0 || plan?.targetPrice > 0) && (
            <button onClick={() => onSave({ stopPrice: null, targetPrice: null })}
              className="text-[10px] text-slate-600 hover:text-bear">clear alerts</button>
          )}
        </div>
      )}
    </div>
  )
}

function LevelOption({ sg, price, side, currency, active, onPick }) {
  const pct = price > 0 ? Math.round(((sg.price - price) / price) * 100) : null
  return (
    <button onClick={onPick}
      className={`w-full text-left rounded px-2 py-1 transition-colors border ${
        active ? 'border-accent/50 bg-navy-800/60' : 'border-transparent hover:bg-navy-800/40'
      } ${sg.tooClose ? 'opacity-60' : ''}`}>
      <div className="text-[11px] text-slate-300">
        {active && <span className="text-accent mr-1">✓</span>}
        {money(sg.price, currency)}
        <span className={sg.tooClose ? 'text-neutral ml-1.5' : 'text-slate-500 ml-1.5'}>
          {sg.tooClose ? '⚠ ' : ''}{sg.label}
        </span>
        {pct != null && (
          <span className={side === 'above' ? 'text-bull ml-1.5' : 'text-slate-600 ml-1.5'}>
            {Math.abs(pct)}% {side}
          </span>
        )}
      </div>
      <div className="text-[10px] text-slate-600">{sg.why}</div>
    </button>
  )
}
