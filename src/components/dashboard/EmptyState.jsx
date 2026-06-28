// EmptyState.jsx
import React from 'react'

export function EmptyState() {
  return (
    <div className="max-w-lg mx-auto mt-12 space-y-6 px-2">

      <div className="card px-6 py-6 text-center space-y-3">
        <div className="text-4xl">📊</div>
        <h2 className="font-display font-semibold text-slate-100 text-lg">
          Enter any stock ticker above to begin
        </h2>
        <p className="text-sm text-slate-400 leading-relaxed">
          No API key needed. Data is fetched automatically from Yahoo Finance
          (global coverage) with Screener.in as fallback for Indian stocks.
        </p>
        <div className="grid grid-cols-3 gap-2 pt-2">
          {[
            { ticker: 'RELIANCE.NS', label: 'Reliance (NSE)' },
            { ticker: 'TCS.NS',      label: 'TCS (NSE)'      },
            { ticker: 'AAPL',        label: 'Apple (NASDAQ)'  },
          ].map(({ ticker, label }) => (
            <div key={ticker} className="card-inner px-3 py-2 text-center">
              <p className="font-mono text-xs text-accent-cyan">{ticker}</p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { icon: '💎', label: 'Valuation',     desc: 'DCF, P/E, EV/EBITDA, Graham' },
          { icon: '✅', label: 'Fundamentals',  desc: 'Quality score, trends'        },
          { icon: '📈', label: 'Technicals',    desc: 'RSI, MACD, patterns, volume'  },
        ].map(({ icon, label, desc }) => (
          <div key={label} className="card px-3 py-3 text-center space-y-1">
            <div className="text-xl">{icon}</div>
            <p className="text-xs font-medium text-slate-300">{label}</p>
            <p className="text-xs text-slate-600">{desc}</p>
          </div>
        ))}
      </div>
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
