import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions, positionMath, removePosition } from '../../store/usePositions.js'
import { positionHealth } from '../../engine/positionHealth.js'
import { buildEstimate } from '../../engine/estimate.js'
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
              {held.map(p => (
                <Lot key={p.id} pos={p} price={livePrice(p.ticker)}
                     health={healthFor(p, state, regime)}
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
function healthFor(pos, state, regime) {
  if (!state?.ticker || pos.ticker !== state.ticker || !state.ratioResult) return null
  const est = buildEstimate(state.ratioResult, {
    guidedGrowth: (state.assumptions?.nearTermGrowth != null && isFinite(state.assumptions.nearTermGrowth))
      ? state.assumptions.nearTermGrowth : null,
    priceHistory:   state.data?.priceHistory   || [],
    incomeHistory:  state.data?.incomeHistory  || [],
    balanceHistory: state.data?.balanceHistory || [],
  })
  return positionHealth(pos, {
    currentEstimate: est,
    currentPrice: state.ratioResult.price,
    qualityScore: state.quality?.score ?? null,
    marginTrendPct: est?.marginTrendPct ?? null,
    technicals: state.technicals,
    regime: {
      ...(regime || {}),
      stockChangePct: state.data?.meta?.change1d ?? null,
    },
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

function Lot({ pos, price, closed, health, onSell, onOpen, onDelete }) {
  const c = pos.snapshot?.currency
  const m = positionMath(pos, price)
  const up = m.pnl != null && m.pnl >= 0

  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button onClick={onOpen} disabled={!onOpen}
            className={`font-mono text-sm ${onOpen ? 'text-white hover:text-accent' : 'text-slate-400'}`}>
            {pos.ticker.replace(/\.(NS|BO)$/, '')}
          </button>
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
      {!closed && !health && (
        <p className="text-[10px] text-slate-600">Open this stock to see its health bars.</p>
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
