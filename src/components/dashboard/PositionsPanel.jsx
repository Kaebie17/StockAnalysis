import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions, positionMath, removePosition } from '../../store/usePositions.js'

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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl bg-navy-900 border border-navy-700 rounded-2xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700">
          <h2 className="font-semibold text-white">📊 My positions</h2>
          <div className="flex items-center gap-3">
            <button onClick={() => setAddOpen(true)} className="text-xs text-accent hover:text-accent-light">+ Add</button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
          </div>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto space-y-3">
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
      <PositionModal open={sellTarget !== null} mode="sell" position={sellTarget}
        onClose={() => setSellTarget(null)} onSaved={refresh} />
    </div>
  )
}

function Lot({ pos, price, closed, onSell, onOpen, onDelete }) {
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

      {pos.snapshot?.isLate && (
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
