import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions, positionMath, removePosition, backfillSnapshot } from '../../store/usePositions.js'
import { getCached } from '../../utils/db.js'
import { fetchQuotes } from '../../api/quotesClient.js'
import { analyzeMany } from '../../store/analyzeTicker.js'
import { evaluateTriggers, assessStopPrice } from '../../engine/exitTriggers.js'
import { saveExitPlan } from '../../store/usePositions.js'
import { positionHealth } from '../../engine/positionHealth.js'
import { buildEstimate } from '../../engine/estimate.js'
import { assessFromQuarterly } from '../../engine/quarterlyBridge.js'
import { fetchMarketRegime } from '../../api/marketRegime.js'

const sym = c => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[c]) || ''
const money = (v, c) => (v == null ? '—' : sym(c) + Math.round(v).toLocaleString('en-IN'))
const dateStr = t => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')

/**
 * PositionsPanel — everything the user owns, and everything they used to.
 *
 * Closed lots are kept and shown separately rather than deleted: a sold holding
 * is the only record that says whether a decision worked out, which is the point
 * of tracking any of this. Deleting one is possible but deliberate — it's for a
 * mis-entry, not for tidying up after a loss.
 *
 * The health bars (item 19) land here. For now this is the ledger they'll hang
 * off: lots, cost, current value, and the note explaining why each was bought.
 */
export default function PositionsPanel({ open, onClose }) {
  const { state, load } = useApp()
  const { positions, loading, refresh } = usePositions()
  const [sellTarget, setSellTarget] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  // One regime read for the whole panel — it's a market-wide number, identical
  // for every position, so fetching it per row would repeat the same request.
  const [regime, setRegime] = useState(null)
  React.useEffect(() => {
    if (!open) return
    let dead = false
    fetchMarketRegime({ indian: /\.(NS|BO)$/i.test(state.ticker || '') })
      .then(r => { if (!dead) setRegime(r) }).catch(() => {})
    return () => { dead = true }
  }, [open, state.ticker])

  // Cached analysis + live price for EVERY held ticker, not just the one loaded.
  //
  // The bars used to compute only for `state.ticker`, which made them invisible
  // in the case that matters: this panel opens from the landing page, where no
  // ticker is loaded, so every row said "open this stock" and clicking it
  // navigated away and closed the panel. The health of a portfolio isn't
  // something you should have to visit twelve pages to read.
  //
  // Every owned stock already has a full cached analysis — you had to look it up
  // to buy it — so ratioResult, quality and technicals are all on disk. Only the
  // price is stale, and the batch quote endpoint fixes that in one request.
  const [analyses, setAnalyses] = useState({})
  const [quotes, setQuotes] = useState({})
  const [fetching, setFetching] = useState(0)
  React.useEffect(() => {
    if (!open || positions.length === 0) return
    let dead = false
    ;(async () => {
      const tickers = [...new Set(positions.filter(p => p.status !== 'closed').map(p => p.ticker))]

      // Cached first, so rows that can render do so immediately.
      const out = {}
      const missing = []
      for (const t of tickers) {
        try { const c = await getCached(t); if (c) out[t] = c; else missing.push(t) }
        catch { missing.push(t) }
      }
      if (dead) return
      setAnalyses(out)

      try { const q = await fetchQuotes(tickers); if (!dead) setQuotes(q) } catch { /* optional */ }

      // Anything with no saved analysis is fetched here rather than waiting for
      // the user to open it. Adding holdings you already own is the normal way
      // in, so on a fresh install NOTHING is cached — leaving the whole
      // portfolio blank exactly when the bars are most wanted. Rows fill in as
      // each lands.
      if (missing.length > 0 && !dead) {
        setFetching(missing.length)
        await analyzeMany(missing, {
          onEach: async (t, res) => {
            if (dead) return
            setAnalyses(prev => ({ ...prev, [t]: res }))
            setFetching(n => Math.max(0, n - 1))
            // Lots entered in bulk have no purchase snapshot, so the
            // estimate-vs-price bar would never have a baseline to compare
            // against. Give them one now, flagged as starting from today.
            for (const p of positions) {
              if (p.ticker === t && p.status !== 'closed' && !p.snapshot?.estimate) {
                try { await backfillSnapshot(p, res) } catch { /* non-fatal */ }
              }
            }
            if (!dead) refresh()
          },
        })
        if (!dead) setFetching(0)
      }
    })()
    return () => { dead = true }
  }, [open, positions])

  if (!open) return null

  const held   = positions.filter(p => p.status !== 'closed')
  const closed = positions.filter(p => p.status === 'closed')

  // Only the ticker currently loaded has a live price. Everything else shows
  // cost and waits — inventing a price for an unloaded ticker would be worse
  // than admitting we don't have one.
  const livePrice = t =>
    (state.ticker && t === state.ticker && state.ratioResult?.price != null)
      ? state.ratioResult.price : null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center
                    p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      {/* Same column layout as PositionModal: cap the sheet, scroll only the
          body, so a long list can't push the title off the top of the screen. */}
      <div className="w-full sm:max-w-2xl bg-navy-900 border border-navy-700
                      rounded-t-2xl sm:rounded-2xl shadow-2xl
                      flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700 shrink-0">
          <h2 className="font-semibold text-white">📊 My positions</h2>
          <div className="flex items-center gap-3">
            <button onClick={() => setAddOpen(true)} className="text-xs text-accent hover:text-accent-light">+ Add</button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-3
                        pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : held.length === 0 && closed.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <p className="text-slate-400 text-sm">Nothing tracked yet.</p>
              <button onClick={() => setAddOpen(true)} className="btn-primary text-sm">Add a holding</button>
            </div>
          ) : (
            <>
              {fetching > 0 && (
                <p className="text-[11px] text-slate-500">
                  Analysing {fetching} stock{fetching > 1 ? 's' : ''} you haven't opened yet…
                </p>
              )}
              {held.map(p => (
                <Lot key={p.id} pos={p} price={livePrice(p.ticker)}
                     health={healthFor(p, state, regime, analyses, quotes)}
                     triggers={triggersFor(p, state, analyses, quotes, held)}
                     onSavePlan={async plan => { await saveExitPlan(p.id, plan); refresh() }}
                     onSell={() => setSellTarget(p)}
                     onOpen={() => { load(p.ticker); onClose() }}
                     onDelete={async () => { await removePosition(p.id); refresh() }} />
              ))}

              {closed.length > 0 && (
                <div className="pt-2">
                  <button onClick={() => setShowClosed(s => !s)}
                    className="text-xs text-slate-500 hover:text-slate-300">
                    {showClosed ? '▲' : '▼'} {closed.length} closed position{closed.length > 1 ? 's' : ''}
                  </button>
                  {showClosed && (
                    <div className="space-y-3 mt-2 opacity-70">
                      {closed.map(p => (
                        <Lot key={p.id} pos={p} price={null} closed
                             onDelete={async () => { await removePosition(p.id); refresh() }} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <PositionModal open={addOpen} mode="bulk"
        onClose={() => setAddOpen(false)} onSaved={refresh} />
      {/* Selling is per TICKER, not per lot: FIFO decides which shares go, so
          tapping any lot of a stock opens the same sale form for that stock. */}
      <PositionModal open={sellTarget !== null} mode="sell"
        lots={sellTarget ? held.filter(p => p.ticker === sellTarget.ticker) : []}
        onClose={() => setSellTarget(null)} onSaved={refresh} />
    </div>
  )
}

/**
 * Bars can only be computed for the ticker currently loaded — everything else
 * has no ratioResult or price history in memory. Rather than show four empty
 * bars for every other row, those collapse to a prompt to open the stock.
 */
/**
 * Health for one position, from whichever source has the fuller picture:
 * live app state when this happens to be the loaded ticker, otherwise the
 * cached analysis written the last time it was analysed.
 */
function healthFor(pos, state, regime, analyses, quotes) {
  const isLoaded = state?.ticker === pos.ticker && state?.ratioResult
  const cached = analyses?.[pos.ticker]
  const src = isLoaded ? state : cached
  if (!src?.ratioResult) return null

  // Live price beats the cached one — the cache can be days old, and every bar
  // that compares against price would otherwise be reading a stale number.
  const livePrice = quotes?.[pos.ticker]?.price ?? src.ratioResult.price
  const ratioResult = livePrice != null && livePrice !== src.ratioResult.price
    ? { ...src.ratioResult, price: livePrice }
    : src.ratioResult

  const est = buildEstimate(ratioResult, {
    guidedGrowth: (state?.assumptions?.nearTermGrowth != null && isLoaded
      && isFinite(state.assumptions.nearTermGrowth)) ? state.assumptions.nearTermGrowth : null,
    priceHistory:   src.data?.priceHistory   || [],
    incomeHistory:  src.data?.incomeHistory  || [],
    balanceHistory: src.data?.balanceHistory || [],
  })
  // The beat/miss verdict from reported quarters. positionHealth has always
  // accepted this and nothing ever passed it, so the fundamental bar was moving
  // on the quality score alone and ignoring whether the company actually hit its
  // numbers — the single hardest fact available to it.
  const guidanceAssessment = assessFromQuarterly(isLoaded ? state.quarterlyData : null, {
    guidance: isLoaded ? state.guidance : null,
    modelGrowth: est?.growth ?? null,
    incomeHistory: src.data?.incomeHistory || [],
  })

  return positionHealth(pos, {
    currentEstimate: est,
    currentPrice: livePrice,
    qualityScore: src.quality?.score ?? null,
    marginTrendPct: est?.marginTrendPct ?? null,
    guidanceAssessment,
    technicals: src.technicals,
    regime: {
      ...(regime || {}),
      stockChangePct: quotes?.[pos.ticker]?.changePct ?? src.data?.meta?.change1d ?? null,
    },
    stale: !isLoaded,
  })
}

/**
 * Exit conditions for a lot. Deliberately built from absolute data — years of
 * financials and the price actually paid — so a holding added today has working
 * triggers immediately, rather than waiting weeks for a drift baseline.
 */
function triggersFor(pos, state, analyses, quotes, allHeld) {
  const isLoaded = state?.ticker === pos.ticker && state?.ratioResult
  const src = isLoaded ? state : analyses?.[pos.ticker]
  if (!src?.ratioResult) return null

  const price = quotes?.[pos.ticker]?.price ?? src.ratioResult.price
  const est = buildEstimate({ ...src.ratioResult, price }, {
    priceHistory:   src.data?.priceHistory   || [],
    incomeHistory:  src.data?.incomeHistory  || [],
    balanceHistory: src.data?.balanceHistory || [],
  })
  // Portfolio total priced the same way this lot is — live price where we have
  // one, cost where we don't — so concentration compares like with like.
  const portfolioValue = (allHeld || []).reduce((t, x) => {
    const px = quotes?.[x.ticker]?.price
    return t + (Number(x.shares) || 0) * (px > 0 ? px : (Number(x.buyPrice) || 0))
  }, 0)

  return evaluateTriggers(pos, {
    price, estimate: est, ratioResult: src.ratioResult,
    marketExpectation: src.marketExpectation,
    guidance: isLoaded ? state.guidance : null,
    guidanceAssessment: isLoaded
      ? assessFromQuarterly(state.quarterlyData, {
          guidance: state.guidance, modelGrowth: est?.growth ?? null,
          incomeHistory: src.data?.incomeHistory || [] })
      : null,
    priceHistory: src.data?.priceHistory || [],
    portfolioValue,
    plan: pos.plan,
  })
}

const BAR_LABELS = {
  estimate: 'Estimate vs price',
  fundamental: 'Fundamentals',
  technical: 'Technical',
  regime: 'Market regime',
}

/** Signal-strength bars. Four rungs, coloured by level, greyed when unavailable. */
function Bars({ level, tone }) {
  const heights = [6, 9, 12, 15]
  const colour = level == null ? 'bg-navy-700'
    : tone === 'neutral' ? 'bg-neutral'
    : level >= 3 ? 'bg-bull' : level <= 1 ? 'bg-bear' : 'bg-neutral'
  return (
    <span className="inline-flex items-end gap-[2px] h-4">
      {heights.map((h, i) => (
        <span key={i} style={{ height: h }}
          className={`w-[3px] rounded-sm ${level != null && i < level ? colour : 'bg-navy-700'}`} />
      ))}
    </span>
  )
}

function HealthBars({ health }) {
  if (!health) return null
  return (
    <div className="space-y-1 pt-1">
      {Object.entries(BAR_LABELS).map(([key, label]) => {
        const b = health[key]
        return (
          <div key={key} className="flex items-center gap-2 text-[11px]">
            <span className="text-slate-500 w-28 shrink-0">{label}</span>
            <Bars level={b?.available ? b.level : null} tone={key === 'regime' ? 'neutral' : null} />
            <span className={`truncate ${b?.available ? 'text-slate-400' : 'text-slate-600'}`}>
              {b?.available ? b.label : b?.reason}
            </span>
          </div>
        )
      })}
      {health.regime?.caution && (
        <p className="text-[10px] text-neutral pt-0.5">⚠ {health.regime.note}</p>
      )}
      {health.estimate?.lateSnapshot && (
        <p className="text-[10px] text-slate-600">
          Comparison runs from when this was added, not when it was bought.
        </p>
      )}
    </div>
  )
}

function Lot({ pos, price, closed, health, triggers, onSavePlan, onSell, onOpen, onDelete }) {
  const c = pos.snapshot?.currency
  const m = positionMath(pos, price)
  const up = m.pnl != null && m.pnl >= 0

  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* Opens the full ticker page. Labelled, because tapping a name and
              being navigated away — closing the panel you were reading — is not
              what anyone expects a name to do. The bars are already here; this
              is for when you want the whole analysis. */}
          <span className="font-mono text-sm text-white">
            {pos.ticker.replace(/\.(NS|BO)$/, '')}
          </span>
          {onOpen && (
            <button onClick={onOpen}
              className="text-[10px] text-slate-500 hover:text-accent ml-1.5 align-middle">
              analyse ↗
            </button>
          )}
          {pos.name && <span className="text-xs text-slate-500 ml-2 truncate">{pos.name}</span>}
          <div className="text-[11px] text-slate-500 mt-0.5">
            {pos.shares} × {money(pos.buyPrice, c)} on {dateStr(pos.buyDate)}
            {closed && pos.sellPrice != null && <> → sold {money(pos.sellPrice, c)} on {dateStr(pos.sellDate)}</>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm text-slate-300">{money(m.cost, c)}</div>
          {m.pnl != null ? (
            <div className={`text-xs font-mono ${up ? 'text-bull' : 'text-bear'}`}>
              {up ? '+' : ''}{money(m.pnl, c)} ({m.pnlPct >= 0 ? '+' : ''}{m.pnlPct.toFixed(1)}%)
            </div>
          ) : (
            <div className="text-[11px] text-slate-600">open this stock for live P/L</div>
          )}
        </div>
      </div>

      {pos.note && (
        <p className="text-[11px] text-slate-500 italic border-l-2 border-navy-700 pl-2">
          “{pos.note}”
        </p>
      )}

      {!closed && <HealthBars health={health} />}
      {!closed && triggers && (
        <ExitPlan pos={pos} triggers={triggers} price={price} onSave={onSavePlan} />
      )}
      {!closed && !health && (
        <p className="text-[10px] text-slate-600">
          Couldn't analyse this stock — check the ticker is right.
        </p>
      )}

      {pos.snapshot?.isLate && !health && (
        <p className="text-[10px] text-neutral">
          ⚠ Added after purchase — the starting point is the day it was entered, not the day it was bought.
        </p>
      )}

      <div className="flex items-center gap-3 pt-0.5">
        {!closed && onSell && (
          <button onClick={onSell} className="text-[11px] text-slate-400 hover:text-bear">Record sale</button>
        )}
        <button onClick={onDelete} className="text-[11px] text-slate-600 hover:text-bear ml-auto"
          title="Only for a mis-entry — selling should use Record sale, which keeps the history">
          Delete
        </button>
      </div>
    </div>
  )
}

/**
 * ExitPlan — the conditions worth reviewing this holding over, and the optional
 * price levels the user has set.
 *
 * Collapsed by default and silent when nothing has fired, because a section
 * that always shows something gets skimmed and then the one day it matters is
 * skimmed too. Fired conditions surface at the top row without expanding.
 *
 * The app never places a stop for you. It checks the one you chose against how
 * far this stock ordinarily moves in a day (ATR) and says whether that level
 * sits inside normal noise — the single most common reason a stop gets hit for
 * no reason. Where to place it depends on horizon and risk appetite the app
 * can't see.
 */
function ExitPlan({ pos, triggers, price, onSave }) {
  const [open, setOpen] = React.useState(false)
  const [stop, setStop] = React.useState(pos.plan?.stopPrice ?? '')
  const [target, setTarget] = React.useState(pos.plan?.targetPrice ?? '')
  const [saving, setSaving] = React.useState(false)

  const fired = triggers?.fired || []
  const profit = fired.filter(t => t.side === 'profit')
  const loss = fired.filter(t => t.side === 'loss' || t.side === 'risk')

  const stopCheck = stop > 0 && price > 0
    ? assessStopPrice(+stop, price, [], undefined) : null

  const save = async () => {
    setSaving(true)
    try {
      await onSave({
        stopPrice: stop === '' ? null : +stop,
        targetPrice: target === '' ? null : +target,
      })
    } finally { setSaving(false) }
  }

  return (
    <div className="pt-1">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 text-[11px] text-slate-500 hover:text-slate-300">
        <span>Exit plan</span>
        {profit.length > 0 && <span className="text-bull">● {profit.length} profit</span>}
        {loss.length > 0 && <span className="text-bear">● {loss.length} caution</span>}
        {fired.length === 0 && <span className="text-slate-600">nothing triggered</span>}
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

          {(triggers.watching || []).map(t => (
            <div key={t.id} className="text-[10px] text-slate-600">{t.title} {t.detail}</div>
          ))}
          {(triggers.context || []).map(t => (
            <div key={t.id} className="text-[10px] text-slate-500">{t.title}</div>
          ))}

          {triggers.baselineFrom && (
            <p className="text-[10px] text-slate-600">
              Drift measured from {new Date(triggers.baselineFrom).toLocaleDateString('en-IN',
                { day: 'numeric', month: 'short' })}, when this was added — the conditions above
              use full history and work now.
            </p>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-navy-800">
            <label className="block">
              <span className="text-[10px] text-slate-500 block mb-0.5">Stop price</span>
              <input type="number" inputMode="decimal" value={stop}
                onChange={e => setStop(e.target.value)}
                className="input-field text-xs w-full" placeholder="optional" />
            </label>
            <label className="block">
              <span className="text-[10px] text-slate-500 block mb-0.5">Target price</span>
              <input type="number" inputMode="decimal" value={target}
                onChange={e => setTarget(e.target.value)}
                className="input-field text-xs w-full" placeholder="optional" />
            </label>
          </div>

          {triggers.stop?.assessment && (
            <p className={`text-[10px] ${triggers.stop.assessment.tooTight ? 'text-neutral' : 'text-slate-600'}`}>
              {triggers.stop.assessment.tooTight ? '⚠ ' : ''}{triggers.stop.assessment.note}
            </p>
          )}

          <button onClick={save} disabled={saving}
            className="text-[11px] text-accent hover:text-accent-light">
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      )}
    </div>
  )
}
