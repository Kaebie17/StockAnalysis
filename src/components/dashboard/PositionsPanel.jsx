import React, { useMemo, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions, positionMath, removePosition, saveExitPlan, updatePositionDate } from '../../store/usePositions.js'
import { positionHealth } from '../../engine/positionHealth.js'
import { buildEstimate } from '../../engine/estimate.js'
import { assessFromQuarterly } from '../../engine/quarterlyBridge.js'
import { fetchMarketRegime } from '../../api/marketRegime.js'
import { getCached } from '../../utils/db.js'
import { fetchQuotes } from '../../api/quotesClient.js'
import { analyzeMany } from '../../store/analyzeTicker.js'
import { evaluateTriggers, suggestLevels } from '../../engine/exitTriggers.js'
import { detectSetups } from '../../engine/setups.js'
import { forwardPeBand } from '../../engine/estimate.js'
import { yearlyObservations } from '../../engine/targetMultiple.js'
import { benchmarkReturn } from '../../engine/snapshotRebuild.js'
import { aggregateLots, holdingMath, summaryLevel } from '../../engine/positionAggregate.js'

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

  React.useEffect(() => {
    if (!open) return
    let dead = false
    fetchMarketRegime({ indian: /\.(NS|BO)$/i.test(state.ticker || '') })
      .then(r => { if (!dead) setRegime(r) }).catch(() => {})
    return () => { dead = true }
  }, [open, state.ticker])

  // Cached analysis + live price for every held ticker, fetching anything that
  // has never been analysed. Adding holdings you already own is the normal way
  // in, so on a fresh install nothing is cached — waiting for the user to visit
  // each stock would leave the whole portfolio blank exactly when it matters.
  React.useEffect(() => {
    if (!open || positions.length === 0) return
    let dead = false
    ;(async () => {
      const tickers = [...new Set(positions.filter(p => p.status !== 'closed').map(p => p.ticker))]
      const out = {}
      const missing = []
      for (const t of tickers) {
        try { const c = await getCached(t); if (c) out[t] = c; else missing.push(t) }
        catch { missing.push(t) }
      }
      if (dead) return
      setAnalyses(out)
      try { const q = await fetchQuotes(tickers); if (!dead) setQuotes(q) } catch { /* optional */ }

      if (missing.length > 0 && !dead) {
        setFetching(missing.length)
        await analyzeMany(missing, {
          onEach: (t, res) => {
            if (dead) return
            setAnalyses(prev => ({ ...prev, [t]: res }))
            setFetching(n => Math.max(0, n - 1))
          },
        })
        if (!dead) setFetching(0)
      }
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

  const totalValue = holdings.reduce((s, h) => s + h.shares * (priceOf(h.ticker) ?? h.avgPrice ?? 0), 0)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center
                    p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full sm:max-w-2xl bg-navy-900 border border-navy-700
                      rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700 shrink-0">
          <h2 className="font-semibold text-white">📊 My positions</h2>
          <div className="flex items-center gap-3">
            <button onClick={() => setAddOpen(true)} className="text-xs text-accent hover:text-accent-light">+ Add</button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-2
                        pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {loading ? (
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
                  Analysing {fetching} stock{fetching > 1 ? 's' : ''} you haven't opened yet…
                </p>
              )}

              {holdings.map(h => (
                <Holding key={h.ticker} agg={h}
                  price={priceOf(h.ticker)}
                  analysis={state.ticker === h.ticker && state.ratioResult ? state : analyses[h.ticker]}
                  isLive={state.ticker === h.ticker && !!state.ratioResult}
                  state={state} regime={regime} totalValue={totalValue}
                  expanded={expanded === h.ticker}
                  onToggle={() => setExpanded(e => (e === h.ticker ? null : h.ticker))}
                  onAnalyse={() => { load(h.ticker); onClose() }}
                  onSell={lot => setSellTarget(lot)}
                  onRefresh={refresh} />
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
        </div>
      </div>

      <PositionModal open={addOpen} mode="bulk"
        onClose={() => setAddOpen(false)} onSaved={refresh} />
      <PositionModal open={sellTarget !== null} mode="sell"
        lots={sellTarget ? held.filter(p => p.ticker === sellTarget.ticker) : []}
        onClose={() => setSellTarget(null)} onSaved={refresh} />
    </div>
  )
}

/**
 * One holding: a scannable row, expanding to the analysis and the lot ledger.
 */
function Holding({ agg, price, analysis, isLive, state, regime, totalValue,
                   expanded, onToggle, onAnalyse, onSell, onRefresh }) {
  const c = agg.lots[0]?.snapshot?.currency
  const m = holdingMath(agg, price)

  // Analysis is computed once for the holding, from live state when this is the
  // loaded ticker and from the saved analysis otherwise.
  const { estimate, health, triggers } = useMemo(() => {
    if (!analysis?.ratioResult) return {}
    const rr = price != null && price !== analysis.ratioResult.price
      ? { ...analysis.ratioResult, price } : analysis.ratioResult
    const est = buildEstimate(rr, {
      guidedGrowth: (isLive && state.assumptions?.nearTermGrowth != null
        && isFinite(state.assumptions.nearTermGrowth)) ? state.assumptions.nearTermGrowth : null,
      priceHistory:   analysis.data?.priceHistory   || [],
      incomeHistory:  analysis.data?.incomeHistory  || [],
      balanceHistory: analysis.data?.balanceHistory || [],
    })
    const ga = assessFromQuarterly(isLive ? state.quarterlyData : null, {
      guidance: isLive ? state.guidance : null,
      modelGrowth: est?.growth ?? null,
      incomeHistory: analysis.data?.incomeHistory || [],
    })
    // Leading conditions, from data already fetched — volume, the multiple's
    // position in its own band, the earnings-vs-multiple gap, sector divergence.
    const band = forwardPeBand(analysis.data?.priceHistory || [], analysis.data?.incomeHistory || [])
    const obs = yearlyObservations({
      priceHistory: analysis.data?.priceHistory || [],
      incomeHistory: analysis.data?.incomeHistory || [],
      balanceHistory: analysis.data?.balanceHistory || [], basis: 'pe' })
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
        portfolioValue: totalValue, plan: agg.lots[0]?.plan,
      }),
      { estimate: est,
        suggestions: suggestLevels({
          price, estimate: est, technicals: analysis.technicals,
          priceHistory: analysis.data?.priceHistory || [], buyPrice: agg.avgPrice }) })
    return { estimate: est, health: h, triggers: t }
  }, [analysis, price, isLive, state, regime, agg, totalValue])

  const level = summaryLevel(health)
  const firedCount = triggers?.fired?.length || 0

  return (
    <div className="bg-navy-800/40 rounded-lg overflow-hidden">
      {/* Collapsed row — the whole portfolio should read in one screen. */}
      <button onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left min-w-0">
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
        <div className="text-right w-24 shrink-0 tabular-nums">
          <div className="text-[13px] text-slate-200">{price > 0 ? money(price, c) : '—'}</div>
          {m?.pnl != null && (
            <div className={`text-[11px] ${m.pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
              {signed(m.pnl, c)}
            </div>
          )}
        </div>
        <span className="text-slate-600 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

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

          <LotLedger agg={agg} price={price} currency={c}
                     indexNow={regime?.indexLevel ?? null}
                     onSell={onSell} onRefresh={onRefresh} />

          {triggers && (
            <ExitPlan agg={agg} triggers={triggers} price={price} currency={c}
              onSave={async plan => { await saveExitPlan(agg.lots[0].id, plan); onRefresh() }} />
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
function LotLedger({ agg, price, currency, indexNow, onSell, onRefresh }) {
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
          set the real purchase dates to compare from when you actually bought
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
function ExitPlan({ agg, triggers, price, currency, onSave }) {
  const fired = triggers?.fired || []
  const plan = agg.lots[0]?.plan
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
