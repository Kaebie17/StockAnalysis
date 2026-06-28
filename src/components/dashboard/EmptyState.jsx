import React from 'react'
import { useApp } from '../../store/AppContext.jsx'

export default function EmptyState({ onUpload }) {
  const { state } = useApp()

  if (state.status === 'loading') return <LoadingSkeleton />
  if (state.status === 'error')   return <ErrorState onUpload={onUpload} />

  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
      <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mb-4 text-3xl">
        📈
      </div>
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
