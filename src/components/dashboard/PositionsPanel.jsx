import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions, positionMath, removePosition, backfillSnapshot } from '../../store/usePositions.js'
import { getCached } from '../../utils/db.js'
import { fetchQuotes } from '../../api/quotesClient.js'
import { analyzeMany } from '../../store/analyzeTicker.js'
import { evaluateTriggers, assessStopPrice, suggestLevels } from '../../engine/exitTriggers.js'
import { saveExitPlan, updatePositionDate } from '../../store/usePositions.js'
import { benchmarkReturn } from '../../engine/snapshotRebuild.js'
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
  // Live price for ANY held ticker. This used to return a price only for the
  // stock currently loaded, so every other card rendered a bare "—" where the
  // price should be — which reads as a broken control rather than as missing
  // data. The batch quotes are already fetched above; they just weren't wired
  // to the display. Falls back to the cached analysis price, then to nothing.
  const livePrice = t => {
    if (state.ticker === t && state.ratioResult?.price != null) return state.ratioResult.price
    const q = quotes?.[t]?.price
    if (q > 0) return q
    return analyses?.[t]?.ratioResult?.price ?? null
  }

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
              {/* One market-wide reading, once. It was previously rendered on
                  every row, which repeats a single fact N times and invites
                  reading it as something about the stock. It isn't — it's a
                  caveat on how much weight the other bars deserve today. */}
              {regime?.vix != null && (
                <div className={`text-[11px] rounded-lg px-3 py-2 ${
                  regime.vix >= 20 ? 'bg-neutral/10 text-neutral' : 'bg-navy-800/50 text-slate-500'}`}>
                  India VIX {Math.round(regime.vix)}
                  {regime.vix >= 28 ? ' — stressed market'
                    : regime.vix >= 20 ? ' — elevated volatility'
                    : regime.vix < 15 ? ' — calm market' : ' — normal volatility'}
                  {regime.vix >= 20 && ' · single-stock signals are less reliable while everything moves together'}
                </div>
              )}

              {fetching > 0 && (
                <p className="text-[11px] text-slate-500">
                  Analysing {fetching} stock{fetching > 1 ? 's' : ''} you haven't opened yet…
                </p>
              )}
              {/* Grouped by ticker. Three lots of one stock share their
                  fundamentals, technicals and estimate — rendering those three
                  times says nothing new and buries what IS per-lot: what you
                  paid, when, and how it has done since. */}
              {groupByTicker(held).map(([ticker, lots]) => (
                <TickerGroup key={ticker} ticker={ticker} lots={lots}
                  price={livePrice(ticker)}
                  health={healthFor(lots[0], state, regime, analyses, quotes)}
                  estimate={triggersFor(lots[0], state, analyses, quotes, held)?.estimate}
                  indexNow={regime?.indexLevel ?? null}
                  onOpen={() => { load(ticker); onClose() }}
                  renderLot={p => (
                    <Lot key={p.id} pos={p} price={livePrice(ticker)}
                         health={healthFor(p, state, regime, analyses, quotes)}
                         triggers={triggersFor(p, state, analyses, quotes, held)}
                         indexNow={regime?.indexLevel ?? null}
                         onSavePlan={async plan => { await saveExitPlan(p.id, plan); refresh() }}
                         onSetDate={async ms => { await updatePositionDate(p.id, ms); refresh() }}
                         onSell={() => setSellTarget(p)}
                         onDelete={async () => { await removePosition(p.id); refresh() }} />
                  )} />
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

  const suggestions = suggestLevels({
    price, estimate: est, technicals: src.technicals,
    priceHistory: src.data?.priceHistory || [], buyPrice: pos.buyPrice,
  })

  return Object.assign(evaluateTriggers(pos, {
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
  }), { suggestions, estimate: est })
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

function Lot({ pos, price, closed, health, triggers, indexNow,
               onSavePlan, onSetDate, onSell, onDelete }) {
  const c = pos.snapshot?.currency
  const m = positionMath(pos, price)
  const up = m.pnl != null && m.pnl >= 0
  const [editingDate, setEditingDate] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  // What the company did, separated from what the market did. Up 18% while the
  // index rose 11% is a 7% contribution from the business — and the raw number
  // alone would have flattered it.
  const bench = benchmarkReturn(pos.snapshot, price, indexNow)

  return (
    <div className="bg-navy-900/40 rounded-lg p-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-slate-400">
            {pos.shares} × {money(pos.buyPrice, c)}
            <button onClick={() => setEditingDate(e => !e)}
              className="text-slate-500 hover:text-accent ml-1.5">
              {dateStr(pos.buyDate)} ✎
            </button>
            {closed && pos.sellPrice != null && <> → sold {money(pos.sellPrice, c)} {dateStr(pos.sellDate)}</>}
          </div>
          {pos.snapshot?.estimate?.base > 0 && (
            <div className="text-[10px] text-slate-600">
              {pos.snapshot.reconstructed ? 'When you bought (rebuilt): ' : 'When you bought: '}
              price {money(pos.snapshot.price, c)}, estimate mid {money(pos.snapshot.estimate.base, c)}
            </div>
          )}
          {pos.snapshot?.backfilled && (
            <div className="text-[10px] text-neutral">
              baseline starts from when this was added — set the real purchase date to fix
            </div>
          )}
          {pos.snapshot?.missing?.length > 0 && (
            <div className="text-[10px] text-slate-600">
              not available for that date: {pos.snapshot.missing.join(', ')}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">{money(m.cost, c)}</div>
          {m.pnl != null && (
            <div className={`text-xs font-mono ${up ? 'text-bull' : 'text-bear'}`}>
              {up ? '+' : ''}{money(m.pnl, c)} ({m.pnlPct >= 0 ? '+' : ''}{m.pnlPct.toFixed(1)}%)
            </div>
          )}
        </div>
      </div>

      {editingDate && !closed && (
        <DateEditor current={pos.buyDate}
          onCancel={() => setEditingDate(false)}
          onSet={async ms => { setEditingDate(false); await onSetDate(ms) }} />
      )}

      {bench && (
        <div className="text-[10px] text-slate-500">
          {bench.alphaPct != null ? (
            <>stock {sign(bench.stockPct)}% · index {sign(bench.indexPct)}% ·{' '}
              <span className={bench.alphaPct >= 0 ? 'text-bull' : 'text-bear'}>
                {sign(bench.alphaPct)}% from the company
              </span>
              {bench.vixThen != null && <span className="text-slate-600"> · bought at VIX {Math.round(bench.vixThen)}</span>}
            </>
          ) : <span className="text-slate-600">{bench.note}</span>}
        </div>
      )}

      {/* Only the estimate bar is per-lot — it depends on what you paid and
          when. The rest live on the ticker header above. */}
      {!closed && health?.estimate?.available && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-slate-500 w-24 shrink-0">vs your entry</span>
          <Bars level={health.estimate.level} />
          <span className="text-slate-400 truncate">{health.estimate.label}</span>
        </div>
      )}

      {pos.note && (
        <p className="text-[11px] text-slate-500 italic border-l-2 border-navy-700 pl-2">
          “{pos.note}”
        </p>
      )}

      {!closed && triggers && (
        <ExitPlan pos={pos} triggers={triggers} price={price} onSave={onSavePlan} />
      )}


      {pos.snapshot?.isLate && !health && (
        <p className="text-[10px] text-neutral">
          ⚠ Added after purchase — the starting point is the day it was entered, not the day it was bought.
        </p>
      )}

      {/* Delete sits on its own line rather than beside the exit-plan toggle:
          the two were a few pixels apart, and one is an expand while the other
          destroys a record permanently. It also asks first — an accidental tap
          previously wiped a lot with no way back, and a position carries a
          purchase price and date that can't be recovered from anywhere. */}
      <div className="flex items-center gap-3 pt-0.5">
        {!closed && onSell && (
          <button onClick={onSell} className="text-[11px] text-slate-400 hover:text-bear">
            Record sale
          </button>
        )}
      </div>
      <div className="flex justify-end pt-1 border-t border-navy-800/60">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-bear">Delete this lot permanently?</span>
            <button onClick={() => { setConfirmDelete(false); onDelete() }}
              className="text-[10px] px-2 py-0.5 rounded border border-bear/60 text-bear hover:bg-bear/10">
              Delete
            </button>
            <button onClick={() => setConfirmDelete(false)}
              className="text-[10px] text-slate-500 hover:text-slate-300">cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)}
            className="text-[10px] text-slate-600 hover:text-bear"
            title="Only for a mis-entry — a sale should use Record sale, which keeps the history">
            Delete lot
          </button>
        )}
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

          {/* Suggested levels, each from a different basis and each carrying
              its reasoning. Empty boxes asked the user to produce a number the
              app is better placed to propose — and a level you can't justify is
              one you abandon the first time it's tested. Still editable: these
              are starting points, not instructions. */}
          {triggers.suggestions?.stops?.length > 0 && (
            <div className="pt-1 border-t border-navy-800 space-y-1">
              <div className="text-[10px] text-slate-500">Where a stop could sit</div>
              {triggers.suggestions.stops.map(sg => (
                <button key={sg.id} onClick={() => setStop(String(sg.price))}
                  className="w-full text-left rounded px-2 py-1 hover:bg-navy-800/60 transition-colors">
                  <div className="text-[11px] text-slate-300">
                    {money(sg.price, pos.snapshot?.currency)}
                    <span className="text-slate-500 ml-1.5">{sg.label}</span>
                    {price > 0 && <span className="text-slate-600 ml-1.5">
                      {Math.round(((sg.price - price) / price) * 100)}%</span>}
                  </div>
                  <div className="text-[10px] text-slate-600">{sg.why}</div>
                </button>
              ))}
            </div>
          )}

          {triggers.suggestions?.targets?.length > 0 && (
            <div className="pt-1 border-t border-navy-800 space-y-1">
              <div className="text-[10px] text-slate-500">Where to consider booking</div>
              {triggers.suggestions.targets.map(sg => (
                <button key={sg.id} onClick={() => setTarget(String(sg.price))}
                  className="w-full text-left rounded px-2 py-1 hover:bg-navy-800/60 transition-colors">
                  <div className="text-[11px] text-slate-300">
                    {money(sg.price, pos.snapshot?.currency)}
                    <span className="text-slate-500 ml-1.5">{sg.label}</span>
                    {price > 0 && <span className="text-bull ml-1.5">
                      +{Math.round(((sg.price - price) / price) * 100)}%</span>}
                  </div>
                  <div className="text-[10px] text-slate-600">{sg.why}</div>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-navy-800">
            <label className="block">
              <span className="text-[10px] text-slate-500 block mb-0.5">Stop price</span>
              <input type="number" inputMode="decimal" value={stop}
                onChange={e => setStop(e.target.value)}
                className="input-field text-xs w-full" placeholder="tap a level above" />
            </label>
            <label className="block">
              <span className="text-[10px] text-slate-500 block mb-0.5">Target price</span>
              <input type="number" inputMode="decimal" value={target}
                onChange={e => setTarget(e.target.value)}
                className="input-field text-xs w-full" placeholder="tap a level above" />
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

/**
 * TickerGroup — everything true of the STOCK, once, with its lots beneath.
 *
 * Fundamentals, technicals and the estimate range are properties of the company:
 * three lots of the same stock have identical values for all three. Rendering
 * them per lot padded the page with repetition and made a multi-lot holding
 * harder to read than a single one, which is backwards.
 */
function TickerGroup({ ticker, lots, price, health, estimate, indexNow, onOpen, renderLot }) {
  const c = lots[0]?.snapshot?.currency
  const totalShares = lots.reduce((t, p) => t + (Number(p.shares) || 0), 0)
  const totalCost = lots.reduce((t, p) => t + (Number(p.shares) || 0) * (Number(p.buyPrice) || 0), 0)
  const avgCost = totalShares > 0 ? totalCost / totalShares : null
  const value = price > 0 ? totalShares * price : null
  const pnl = value != null ? value - totalCost : null

  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono text-sm text-white">{ticker.replace(/\.(NS|BO)$/, '')}</span>
          <button onClick={onOpen} className="text-[10px] text-slate-500 hover:text-accent ml-1.5">
            analyse ↗
          </button>
          <div className="text-[11px] text-slate-500">
            {totalShares} shares · avg {money(avgCost, c)}
            {lots.length > 1 && <span className="text-slate-600"> · {lots.length} lots</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm text-slate-300">
            {price > 0 ? money(price, c)
              : <span className="text-[10px] text-slate-600">price unavailable</span>}
          </div>
          {pnl != null && (
            <div className={`text-xs font-mono ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
              {pnl >= 0 ? '+' : ''}{money(pnl, c)}
            </div>
          )}
        </div>
      </div>

      {/* Where the stock stands now, once — the same for every lot. The
          per-lot rows below compare against what each ENTRY was, which is a
          different question and lives with the lot it belongs to. */}
      {estimate?.ok && (
        <div className="text-[11px] text-slate-500 pt-1 border-t border-navy-800">
          Estimate {money(estimate.target.low, c)}–{money(estimate.target.high, c)}
          {price > 0 && (
            <span className={estimate.target.base >= price ? 'text-bull ml-1.5' : 'text-bear ml-1.5'}>
              ({estimate.upside?.base >= 0 ? '+' : ''}{estimate.upside?.base}% to mid)
            </span>
          )}
        </div>
      )}

      {/* Stock-level bars: the same for every lot, so shown once. */}
      {health && (
        <div className="space-y-1 pt-1 border-t border-navy-800">
          {['fundamental', 'technical'].map(key => {
            const b = health[key]
            return (
              <div key={key} className="flex items-center gap-2 text-[11px]">
                <span className="text-slate-500 w-24 shrink-0">{BAR_LABELS[key]}</span>
                <Bars level={b?.available ? b.level : null} />
                <span className={`truncate ${b?.available ? 'text-slate-400' : 'text-slate-600'}`}>
                  {b?.available ? b.label : b?.reason}
                </span>
              </div>
            )
          })}
          {health.regime?.idiosyncratic && (
            <p className="text-[10px] text-neutral">{health.regime.detail}</p>
          )}
          {health.stale && (
            <p className="text-[10px] text-slate-600">from the last saved analysis</p>
          )}
        </div>
      )}

      <div className="space-y-1.5 pt-1">
        {lots.map(renderLot)}
      </div>
    </div>
  )
}

/**
 * Set a purchase date, in the terms people actually remember it. Changing it
 * rebuilds the baseline from that date's prices and filings, so the comparison
 * genuinely starts where the money did.
 */
function DateEditor({ current, onSet, onCancel }) {
  const [val, setVal] = React.useState(
    current ? new Date(current).toISOString().slice(0, 10) : '')
  const AGO = [['1 month', 30], ['3 months', 91], ['6 months', 182],
               ['1 year', 365], ['2 years', 730]]
  return (
    <div className="bg-navy-800/60 rounded p-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {AGO.map(([label, days]) => (
          <button key={label} type="button"
            onClick={() => onSet(Date.now() - days * 86400000)}
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
      <p className="text-[10px] text-slate-600">
        Rebuilds the baseline from that date — anything unavailable for it is named rather than
        guessed.
      </p>
    </div>
  )
}

function groupByTicker(lots) {
  const map = new Map()
  for (const p of lots) {
    if (!map.has(p.ticker)) map.set(p.ticker, [])
    map.get(p.ticker).push(p)
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.buyDate || 0) - (b.buyDate || 0))
  return [...map.entries()]
}

const sign = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v)
