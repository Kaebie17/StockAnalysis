// EmptyState.jsx
import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'

export function EmptyState() {
  const { state, actions } = useApp()
  const [keyInput, setKeyInput] = useState(state.apiKey ?? '')
  const [saved, setSaved]       = useState(false)

  function handleSaveKey(e) {
    e.preventDefault()
    if (!keyInput.trim()) return
    actions.setApiKey(keyInput.trim())
    setSaved(true)
  }

  const hasKey = !!state.apiKey

  return (
    <div className="max-w-lg mx-auto mt-12 space-y-6 px-2">

      {/* Step 1 — API Key */}
      <div className={`card px-6 py-5 space-y-4 ${hasKey ? 'border-green-500/40' : 'border-accent-cyan/40'}`}>
        <div className="flex items-center gap-3">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0
            ${hasKey ? 'bg-accent-green text-surface-900' : 'bg-accent-cyan text-surface-900'}`}>
            {hasKey ? '✓' : '1'}
          </div>
          <div>
            <p className="font-medium text-slate-100">Set your FMP API Key</p>
            <p className="text-xs text-slate-400">Free at <a href="https://financialmodelingprep.com" target="_blank" rel="noreferrer" className="text-accent-cyan underline">financialmodelingprep.com</a> — 250 calls/day, no credit card</p>
          </div>
        </div>

        {hasKey ? (
          <div className="flex items-center justify-between bg-surface-700 rounded-xl px-4 py-2.5">
            <span className="text-xs text-accent-green">API key saved ✓</span>
            <button
              onClick={() => { actions.setApiKey(''); setSaved(false) }}
              className="text-xs text-slate-500 hover:text-accent-red transition-colors"
            >
              Remove
            </button>
          </div>
        ) : (
          <form onSubmit={handleSaveKey} className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="Paste your FMP API key here"
              className="flex-1 bg-surface-700 border border-slate-600 rounded-xl px-3 py-2.5 text-sm
                         text-slate-100 placeholder-slate-500 focus:outline-none focus:border-accent-cyan"
              autoFocus
            />
            <button type="submit" disabled={!keyInput.trim()} className="btn-primary disabled:opacity-50">
              Save
            </button>
          </form>
        )}
      </div>

      {/* Step 2 — Enter Ticker */}
      <div className={`card px-6 py-5 space-y-3 ${!hasKey ? 'opacity-40 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-3">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0
            ${hasKey ? 'bg-accent-cyan text-surface-900' : 'bg-surface-600 text-slate-400'}`}>
            2
          </div>
          <div>
            <p className="font-medium text-slate-100">Enter a stock ticker</p>
            <p className="text-xs text-slate-400">US stocks (AAPL, TSLA) or Indian stocks (RELIANCE, TCS)</p>
          </div>
        </div>
        <p className="text-xs text-slate-500 pl-10">
          Use the search bar above once your key is saved.
        </p>
      </div>

      {/* What you get */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { icon: '💎', label: 'Valuation', desc: 'DCF, P/E, EV/EBITDA, Graham' },
          { icon: '✅', label: 'Fundamentals', desc: 'Quality score, margin trends' },
          { icon: '📈', label: 'Technicals', desc: 'RSI, MACD, patterns, volume' },
        ].map(({ icon, label, desc }) => (
          <div key={label} className="card px-3 py-3 text-center space-y-1">
            <div className="text-xl">{icon}</div>
            <p className="text-xs font-medium text-slate-300">{label}</p>
            <p className="text-xs text-slate-600">{desc}</p>
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-600 text-center">
        No API key? Indian stocks are also attempted via Screener.in automatically.
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
