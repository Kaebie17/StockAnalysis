// EmptyState.jsx
import React from 'react'

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
      <div className="text-5xl mb-4 opacity-40">📊</div>
      <h2 className="font-display font-semibold text-slate-300 text-lg mb-2">
        Enter a ticker to begin
      </h2>
      <p className="text-slate-500 text-sm max-w-sm leading-relaxed">
        Type any stock ticker (e.g. AAPL, RELIANCE, TSLA) in the search bar above.
        Data is fetched from FMP API and analyzed across valuation, fundamentals, and technicals.
      </p>
      <div className="mt-8 grid grid-cols-3 gap-4 max-w-sm w-full">
        {['💎 Valuation', '✅ Fundamentals', '📈 Technicals'].map(label => (
          <div key={label} className="card px-3 py-3 text-center">
            <p className="text-xs text-slate-500">{label}</p>
          </div>
        ))}
      </div>
      <p className="mt-8 text-xs text-slate-600">
        Requires a free FMP API key · Set it via the API Key button above
      </p>
    </div>
  )
}

export function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-3 gap-3">
        {[0,1,2].map(i => (
          <div key={i} className="card px-4 py-4 space-y-3">
            <div className="h-3 bg-slate-700 rounded w-20" />
            <div className="h-5 bg-slate-700 rounded w-28" />
            <div className="h-3 bg-slate-700 rounded w-32" />
            <div className="h-3 bg-slate-700 rounded w-24" />
          </div>
        ))}
      </div>
      <div className="card px-5 py-4 space-y-3">
        <div className="h-3 bg-slate-700 rounded w-32" />
        <div className="h-4 bg-slate-700 rounded w-full" />
        <div className="h-4 bg-slate-700 rounded w-4/5" />
      </div>
    </div>
  )
}
