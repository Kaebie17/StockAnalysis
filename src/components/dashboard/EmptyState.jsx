import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import PositionModal from './PositionModal.jsx'
import { usePositions } from '../../store/usePositions.js'

// Loaded on demand — both pull in PositionModal, and neither is needed until
// someone taps through to them.
const PositionsPanel = React.lazy(() => import('./PositionsPanel.jsx'))
const SoldPositions  = React.lazy(() => import('./SoldPositions.jsx'))

export default function EmptyState({ onUpload }) {
  const { state } = useApp()
  const [panel, setPanel] = useState(null)          // null | 'bulk' | 'list' | 'sold'
  const { positions, refresh } = usePositions()
  const held      = positions.filter(p => p.status !== 'closed')
  const hasClosed = positions.some(p => p.status === 'closed')

  if (state.status === 'loading') return <LoadingSkeleton />
  if (state.status === 'error')   return <ErrorState onUpload={onUpload} />

  return (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <img src="/logo.png" alt="StockAnalyzr"
           className="w-60 max-w-[78%] h-auto select-none" draggable="false" />
      <h2 className="text-xl font-semibold text-white mb-2">
        Enter any stock ticker to begin
      </h2>
      <p className="text-slate-400 text-sm max-w-md">
        Works with US stocks (AAPL, MSFT), Indian stocks (RELIANCE.NS, TCS.NS),
        and most global markets. Add <code className="text-accent">.NS</code> for NSE
        or <code className="text-accent">.BO</code> for BSE listed stocks.
      </p>
      <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs text-slate-500 max-w-sm">
        {[
          ['Valuation', '7 models including DCF'],
          ['Fundamentals', 'Quality score + ratios'],
          ['Technicals', 'RSI, MACD, patterns'],
          ['Indian stocks', 'Screener.in fallback'],
          ['Offline', 'PWA with 1hr cache'],
          ['No login', 'No API key needed']
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
      <div className="mt-6 w-full max-w-sm">
        {/* Portfolio lives here, not on the ticker pages: this is the screen you
            open to think about holdings as a whole rather than about one
            company. The ticker pages keep only buy and sell. */}
        {held.length > 0 || hasClosed ? (
          <div className="card-sm text-left space-y-2">
            {held.length > 0 && (
              <button onClick={() => setPanel('list')} className="w-full text-left group">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-sm font-medium">
                    💼 {held.length} holding{held.length > 1 ? 's' : ''} tracked
                  </span>
                  <span className="text-accent text-xs group-hover:text-accent-light">View →</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">
                  {held.slice(0, 4).map(p => p.ticker.replace(/\.(NS|BO)$/, '')).join(' · ')}
                  {held.length > 4 ? ` +${held.length - 4}` : ''}
                </div>
              </button>
            )}
            <div className="flex items-center gap-3 pt-1 border-t border-navy-800">
              <button onClick={() => setPanel('bulk')}
                className="text-xs text-accent hover:text-accent-light">+ Add holdings</button>
              {hasClosed && (
                <button onClick={() => setPanel('sold')}
                  className="text-xs text-slate-500 hover:text-slate-300 ml-auto">📕 Exit record</button>
              )}
            </div>
          </div>
        ) : (
          <button onClick={() => setPanel('bulk')}
            className="w-full card-sm text-left hover:border-accent/40 transition-colors">
            <div className="text-slate-300 text-sm font-medium">📥 Already own stocks?</div>
            <div className="text-xs text-slate-500 mt-0.5">
              Add them once and the app tracks how they're doing against what you paid.
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

function ErrorState({ onUpload }) {
  const { state } = useApp()

  if (state.uploadRequired) {
    return (
      <div className="card border-neutral/30 bg-neutral/5 max-w-lg mx-auto text-center py-10 space-y-4">
        <div className="text-4xl">📂</div>
        <h3 className="font-semibold text-white">Upload your financial data</h3>
        <p className="text-sm text-slate-400">
          Both Yahoo Finance and Screener.in were unavailable for this ticker.
          Upload a CSV with annual revenue, net income, and cash flow data.
        </p>
        <button onClick={onUpload} className="btn-primary">
          Upload CSV
        </button>
        <p className="text-xs text-slate-500">
          Expected columns: year, revenue, netIncome, freeCashFlow, totalDebt, totalEquity
        </p>
      </div>
    )
  }

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
