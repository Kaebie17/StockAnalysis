import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions } from '../../store/usePositions.js'

// Loaded on demand — both pull in PositionModal, and neither is needed until
// someone taps through to them.
const PositionsPanel = React.lazy(() => import('./PositionsPanel.jsx'))
const SoldPositions  = React.lazy(() => import('./SoldPositions.jsx'))

export default function EmptyState() {
  const { state } = useApp()
  const [panel, setPanel] = useState(null)          // null | 'bulk' | 'list' | 'sold'
  const { positions, refresh } = usePositions()
  const held      = positions.filter(p => p.status !== 'closed')
  const hasClosed = positions.some(p => p.status === 'closed')

  if (state.status === 'loading') return <LoadingSkeleton />
  if (state.status === 'error')   return <ErrorState />

  return (
    <div className="flex flex-col items-center justify-center px-4 py-4 text-center">
      <img src="/logo.png" alt="StockAnalyzr"
           className="w-32 max-w-[45%] h-auto select-none" draggable="false" />
      <h2 className="text-xl font-semibold text-white mt-2 mb-1">
        Enter any stock ticker to begin
      </h2>
      <p className="text-slate-400 text-sm max-w-2xl">
        Works with US stocks (AAPL, MSFT), Indian stocks (RELIANCE.NS, TCS.NS),
        and most global markets. Add <code className="text-accent">.NS</code> for NSE
        or <code className="text-accent">.BO</code> for BSE listed stocks.
      </p>
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs text-slate-500 w-full max-w-4xl">
        {[
          ['Valuation', '7 models including DCF'],
          ['Peer comparison', 'Valuation bands from real peers'],
          ['AI verdict', 'Optional, your own API key'],
          ['Exit signals', 'Trade setups + exit triggers'],
          ['Offline', 'Installable, works offline'],
          ['No login required', 'Sync across devices is optional']
        ].map(([t, d]) => (
          <div key={t} className="card-sm text-left">
            <div className="text-slate-300 font-medium mb-0.5">{t}</div>
            <div>{d}</div>
          </div>
        ))}
      </div>

      {/* Portfolio entry point. On the landing page rather than buried in a menu
          because the natural moment to enter holdings you already own is when
          setting the app up — before you've looked up anything. */}
      <div className="mt-4 w-full max-w-4xl">
        {/* Portfolio lives here, not on the ticker pages: this is the screen you
            open to think about holdings as a whole rather than about one
            company. The ticker pages keep only buy and sell. */}
        {held.length > 0 || hasClosed ? (
          <div className="card-sm text-left flex items-center gap-3">
            {held.length > 0 && (
              <button onClick={() => setPanel('list')} className="flex-1 min-w-0 text-left group flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="text-slate-300 text-sm font-medium">
                    💼 {held.length} holding{held.length > 1 ? 's' : ''} tracked
                  </span>
                  <span className="block text-xs text-slate-500 mt-0.5 truncate">
                    {held.slice(0, 4).map(p => p.ticker.replace(/\.(NS|BO)$/, '')).join(' · ')}
                    {held.length > 4 ? ` +${held.length - 4}` : ''}
                  </span>
                </span>
                <span className="text-accent text-xs group-hover:text-accent-light shrink-0">View →</span>
              </button>
            )}
            <div className="flex items-center gap-3 pl-3 border-l border-navy-800 shrink-0">
              <button onClick={() => setPanel('bulk')}
                className="text-xs text-accent hover:text-accent-light whitespace-nowrap">+ Add holdings</button>
              {hasClosed && (
                <button onClick={() => setPanel('sold')}
                  className="text-xs text-slate-500 hover:text-slate-300 whitespace-nowrap">📕 Exit record</button>
              )}
            </div>
          </div>
        ) : (
          <button onClick={() => setPanel('bulk')}
            className="w-full card-sm text-left hover:border-accent/40 transition-colors flex items-center justify-between gap-3">
            <div>
              <div className="text-slate-300 text-sm font-medium">📥 Already own stocks?</div>
              <div className="text-xs text-slate-500 mt-0.5">
                Add them once and the app tracks how they're doing against what you paid.
              </div>
            </div>
          </button>
        )}
      </div>

      <PositionModal open={panel === 'bulk'} mode="bulk"
        onClose={() => setPanel(null)} onSaved={refresh} />
      <React.Suspense fallback={null}>
        {panel === 'list' && <PositionsPanel open onClose={() => setPanel(null)} />}
        {panel === 'sold' && <SoldPositions  open onClose={() => setPanel(null)} />}
      </React.Suspense>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-6 bg-navy-800 rounded w-1/3" />
      <div className="grid grid-cols-3 gap-3">
        {[0,1,2].map(i => (
          <div key={i} className="card h-36 bg-navy-800/50" />
        ))}
      </div>
      <div className="card h-48 bg-navy-800/50" />
    </div>
  )
}

function ErrorState() {
  const { state } = useApp()

  return (
    <div className="card border-bear/30 bg-bear/5 max-w-lg mx-auto text-center py-10 space-y-3">
      <div className="text-4xl">⚠️</div>
      <h3 className="font-semibold text-white">Could not fetch data</h3>
      <p className="text-sm text-slate-400">{state.error}</p>
      <p className="text-xs text-slate-500">
        Try adding <code className="text-accent">.NS</code> or <code className="text-accent">.BO</code> for Indian stocks
      </p>
    </div>
  )
}
