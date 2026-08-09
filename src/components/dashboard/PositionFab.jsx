import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions } from '../../store/usePositions.js'

/**
 * PositionFab — floating buttons, rendered inside the app's existing FAB column
 * alongside 📎 and ⚙.
 *
 *   ➕  record a purchase of the ticker on screen
 *   ➖  record a sale — only when the ticker on screen is actually held
 *
 * Ticker-scoped ONLY. Portfolio-level views (the holdings list, the exit record)
 * live on the landing page, which is where you go to think about the portfolio
 * rather than about one company. Keeping both here meant two routes to the same
 * screens and six buttons in a column shared with the app's own controls.
 *
 * Deliberately flat: no toggle, no buttons nested inside buttons.
 *
 * Selling never asks which lot. Shares are sold FIFO — oldest first, which is
 * both the convention and what capital-gains treatment assumes — so the
 * allocation is determined, not a choice. The user enters a quantity and a
 * price; the form shows which lots that consumes.
 */
export default function PositionFab() {
  const { state } = useApp()
  const [modal, setModal] = useState(null)          // null | 'buy' | 'sell'
  const { positions, refresh } = usePositions()

  const hasTicker  = state.status === 'success' && !!state.ticker
  const tickerLots = positions.filter(p => p.status !== 'closed' && p.ticker === state.ticker)

  return (
    <>
      {hasTicker && (
        <button
          onClick={() => setModal('buy')}
          title="Record a purchase"
          aria-label="Record a purchase"
          className="w-11 h-11 rounded-full bg-navy-800 border border-navy-600 shadow-lg
                     text-slate-400 hover:text-bull hover:border-bull/60
                     active:scale-95 transition-all flex items-center justify-center text-xl">
          ➕
        </button>
      )}

      {hasTicker && tickerLots.length > 0 && (
        <button
          onClick={() => setModal('sell')}
          title="Record a sale"
          aria-label="Record a sale"
          className="w-11 h-11 rounded-full bg-navy-800 border border-navy-600 shadow-lg
                     text-slate-400 hover:text-bear hover:border-bear/60
                     active:scale-95 transition-all flex items-center justify-center text-xl">
          ➖
        </button>
      )}

      <PositionModal open={modal === 'buy'} mode="buy"
        onClose={() => setModal(null)} onSaved={refresh} />
      <PositionModal open={modal === 'sell'} mode="sell" lots={tickerLots}
        onClose={() => setModal(null)} onSaved={refresh} />
    </>
  )
}
