import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions } from '../../store/usePositions.js'

/**
 * PositionFab — floating buttons, rendered inside the app's existing FAB column
 * alongside 📎 and ⚙.
 *
 *   💼  my positions (with a count badge)
 *   📕  exit record — what happened after each sale
 *   ➕  record a purchase of the ticker on screen
 *   ➖  record a sale — only when the ticker on screen is actually held
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
  const [modal, setModal] = useState(null)          // null | 'buy' | 'sell' | 'list' | 'sold'
  const { positions, refresh } = usePositions()

  const hasTicker  = state.status === 'success' && !!state.ticker
  const openLots   = positions.filter(p => p.status !== 'closed')
  const tickerLots = openLots.filter(p => p.ticker === state.ticker)
  const hasClosed  = positions.some(p => p.status === 'closed')

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

      <button
        onClick={() => setModal('list')}
        title="My positions"
        aria-label="My positions"
        className="relative w-11 h-11 rounded-full bg-navy-800 border border-navy-600 shadow-lg
                   text-slate-400 hover:text-accent hover:border-accent/60
                   active:scale-95 transition-all flex items-center justify-center text-lg">
        💼
        {openLots.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full
                           bg-accent text-navy-900 text-[10px] font-bold
                           flex items-center justify-center">
            {openLots.length}
          </span>
        )}
      </button>

      {/* Only once there's something to review — an empty exit record is a
          button that teaches nothing. */}
      {hasClosed && (
        <button
          onClick={() => setModal('sold')}
          title="Exit record"
          aria-label="Exit record"
          className="w-11 h-11 rounded-full bg-navy-800 border border-navy-600 shadow-lg
                     text-slate-400 hover:text-accent hover:border-accent/60
                     active:scale-95 transition-all flex items-center justify-center text-lg">
          📕
        </button>
      )}

      <PositionModal open={modal === 'buy'} mode="buy"
        onClose={() => setModal(null)} onSaved={refresh} />
      <PositionModal open={modal === 'sell'} mode="sell" lots={tickerLots}
        onClose={() => setModal(null)} onSaved={refresh} />
      <PositionsPanelLazy open={modal === 'list'} onClose={() => setModal(null)} />
      <SoldPositionsLazy open={modal === 'sold'} onClose={() => setModal(null)} />
    </>
  )
}

/**
 * Loaded on demand: PositionsPanel imports the same modal this file does, so a
 * direct top-level import would close a cycle. It also keeps the panel out of
 * the initial bundle, which it has no reason to be in.
 */
const PositionsPanel = React.lazy(() => import('./PositionsPanel.jsx'))
const SoldPositions  = React.lazy(() => import('./SoldPositions.jsx'))
function SoldPositionsLazy({ open, onClose }) {
  if (!open) return null
  return (
    <React.Suspense fallback={null}>
      <SoldPositions open={open} onClose={onClose} />
    </React.Suspense>
  )
}
function PositionsPanelLazy({ open, onClose }) {
  if (!open) return null
  return (
    <React.Suspense fallback={null}>
      <PositionsPanel open={open} onClose={onClose} />
    </React.Suspense>
  )
}
