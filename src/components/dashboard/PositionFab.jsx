import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions } from '../../store/usePositions.js'

/**
 * PositionFab — floating circular actions for buy / sell / my-positions.
 *
 * These lived in the header row and IdentityBar, which put four or five controls
 * on one line and made the mobile ticker page unreadable. Floating them frees
 * that row entirely, and position actions are a natural fit for it: they're
 * available everywhere, unrelated to whatever panel is open, and used
 * occasionally rather than constantly.
 *
 * Collapsed to a single button by default. Buy and sell only appear once
 * expanded, and sell only when a lot actually exists — an action with nothing to
 * act on shouldn't occupy a button.
 */
export default function PositionFab() {
  const { state } = useApp()
  const [expanded, setExpanded] = useState(false)
  const [modal, setModal] = useState(null)          // null | 'buy' | 'sell' | 'list'
  const { positions, refresh } = usePositions()

  const hasTicker = state.status === 'success' && !!state.ticker
  const openLots  = positions.filter(p => p.status !== 'closed')
  const tickerLots = openLots.filter(p => p.ticker === state.ticker)

  const act = m => { setModal(m); setExpanded(false) }

  return (
    <>
      {/* Tap-away layer: on touch there's no hover-out, so without this the
          expanded cluster has no way to close except hitting the toggle again. */}
      {expanded && (
        <div className="fixed inset-0 z-30" onClick={() => setExpanded(false)} />
      )}

      {/* Renders INSIDE the app's existing FAB column (alongside 📎 and ⚙), not
          as its own fixed stack — a second fixed cluster in the same corner just
          lands on top of the first. Sizing matches those buttons (w-11 h-11). */}
      <div className="relative flex flex-col items-end gap-2">
        {expanded && (
          <>
            {hasTicker && (
              <FabButton label="Record a purchase" onClick={() => act('buy')}
                className="border-bull/40 text-bull hover:bg-bull/10">+</FabButton>
            )}
            {hasTicker && tickerLots.length > 0 && (
              <FabButton label="Record a sale" onClick={() => act('sell')}
                className="border-bear/40 text-bear hover:bg-bear/10">−</FabButton>
            )}
            <FabButton label="My positions" onClick={() => act('list')}
              className="border-accent/40 text-accent hover:bg-accent/10">📊</FabButton>
          </>
        )}

        <button
          onClick={() => setExpanded(e => !e)}
          title="Positions"
          aria-label="Positions"
          aria-expanded={expanded}
          className="relative w-11 h-11 rounded-full bg-navy-800 border border-navy-600 shadow-lg
                     text-slate-300 hover:text-accent hover:border-accent/50
                     flex items-center justify-center transition-all active:scale-95 text-lg">
          {expanded ? '✕' : '💼'}
          {/* Count badge: the one piece of state worth showing while collapsed. */}
          {!expanded && openLots.length > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full
                             bg-accent text-navy-900 text-[10px] font-bold
                             flex items-center justify-center">
              {openLots.length}
            </span>
          )}
        </button>
      </div>

      <PositionModal open={modal === 'buy'} mode="buy"
        onClose={() => setModal(null)} onSaved={refresh} />
      <PositionModal open={modal === 'sell'} mode="sell" position={tickerLots[0] || null}
        onClose={() => setModal(null)} onSaved={refresh} />
      <PositionsPanelLazy open={modal === 'list'} onClose={() => setModal(null)} />
    </>
  )
}

function FabButton({ children, label, onClick, className = '' }) {
  return (
    <button onClick={onClick} title={label} aria-label={label}
      className={`w-10 h-10 rounded-full bg-navy-800 border shadow-lg text-base
                  flex items-center justify-center transition-all active:scale-95 ${className}`}>
      {children}
    </button>
  )
}

/**
 * PositionsPanel imports this file's sibling modal, so importing it directly at
 * the top would close a cycle (Fab → Panel → Modal → …). Loading it on demand
 * breaks that and keeps the panel out of the initial bundle, which it doesn't
 * need to be in — it only renders once someone taps through.
 */
const PositionsPanel = React.lazy(() => import('./PositionsPanel.jsx'))
function PositionsPanelLazy({ open, onClose }) {
  if (!open) return null
  return (
    <React.Suspense fallback={null}>
      <PositionsPanel open={open} onClose={onClose} />
    </React.Suspense>
  )
}
