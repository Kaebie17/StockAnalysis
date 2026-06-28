import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'

const EXAMPLES = ['AAPL', 'RELIANCE.NS', 'TCS.NS', 'MSFT', 'INFY.NS', 'GOOGL']

export default function Header() {
  const { state, load } = useApp()
  const [input, setInput] = useState('')

  const submit = (e) => {
    e?.preventDefault()
    const t = input.trim()
    if (t) load(t)
  }

  const isLoading = state.status === 'loading'

  return (
    <header className="sticky top-0 z-50 bg-navy-950/95 backdrop-blur border-b border-navy-800">
      <div className="max-w-7xl mx-auto px-4 py-3">
        {/* Logo + Search row */}
        <div className="flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-sm">
              SV
            </div>
            <span className="font-semibold text-white hidden sm:block">StockVal</span>
          </div>

          {/* Search */}
          <form onSubmit={submit} className="flex-1 flex gap-2 max-w-lg">
            <div className="relative flex-1">
              <input
                className="input-field pr-10 uppercase"
                placeholder="Ticker: AAPL, RELIANCE.NS, TCS.NS…"
                value={input}
                onChange={e => setInput(e.target.value.toUpperCase())}
                disabled={isLoading}
              />
              {isLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <button
              type="submit"
              className="btn-primary shrink-0"
              disabled={isLoading || !input.trim()}
            >
              Analyse
            </button>
          </form>
        </div>

        {/* Progress bar */}
        {isLoading && state.progress && (
          <div className="mt-2">
            <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
              <span className="text-accent">●</span>
              {state.progress.msg}
            </div>
            <div className="h-0.5 bg-navy-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-500"
                style={{ width: `${(state.progress.step / 2) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Stock identity bar */}
        {state.status === 'success' && state.data && (
          <IdentityBar data={state.data} ratios={state.ratios} />
        )}

        {/* Example tickers */}
        {state.status === 'idle' && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EXAMPLES.map(t => (
              <button
                key={t}
                onClick={() => { setInput(t); load(t) }}
                className="text-xs px-2 py-0.5 rounded-md bg-navy-800 text-slate-400 hover:text-white hover:bg-navy-700 transition-colors font-mono"
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  )
}

function IdentityBar({ data, ratios }) {
  const priceChange = data.priceHistory?.length >= 2
    ? ((data.priceHistory[data.priceHistory.length - 1].close -
        data.priceHistory[data.priceHistory.length - 2].close) /
        data.priceHistory[data.priceHistory.length - 2].close) * 100
    : null

  const isUp = priceChange >= 0

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <div>
        <span className="font-mono font-bold text-white">{data.ticker}</span>
        {data.name && data.name !== data.ticker && (
          <span className="text-slate-400 ml-2 text-xs">{data.name}</span>
        )}
      </div>
      {ratios?.price && (
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">
            {data.currency === 'INR' ? '₹' : '$'}{ratios.price?.toFixed(2)}
          </span>
          {priceChange != null && (
            <span className={isUp ? 'text-bull text-xs' : 'text-bear text-xs'}>
              {isUp ? '▲' : '▼'} {Math.abs(priceChange).toFixed(2)}%
            </span>
          )}
        </div>
      )}
      {data.meta?.sector && (
        <span className="text-xs text-slate-500">{data.meta.sector}</span>
      )}
      <span className="text-xs text-slate-600 capitalize">{data.source === "merged" ? "yahoo+screener" : data.source}</span>
    </div>
  )
}
