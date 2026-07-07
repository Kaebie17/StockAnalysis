import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { deleteCached } from '../../utils/db.js'
import { STAGES } from '../../engine/stage.js'

const EXAMPLES = ['RELIANCE', 'TCS', 'LICI', 'MARUTI', 'ZOMATO', 'HDFCBANK', 'AAPL', 'MSFT']

export default function Header() {
  const { state, load, reset } = useApp()
  const [input, setInput] = useState('')

  const submit = (e) => {
    e?.preventDefault()
    const t = input.trim()
    if (t) load(t)
  }

  return (
    <header className="sticky top-0 z-50 bg-navy-950/95 backdrop-blur border-b border-navy-800">
      <div className="max-w-5xl mx-auto px-4 py-3 space-y-2">
        {/* Search row */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { reset(); setInput('') }}
            title="Home"
            className="shrink-0 active:scale-95 transition-transform">
            <img src="/bull.png" alt="StockAnalyzr" className="h-9 w-9 object-contain" draggable="false" />
          </button>
          <form onSubmit={submit} className="flex-1 flex gap-2">
            <div className="relative flex-1">
              <input
                className="input-field uppercase pr-10 text-sm"
                placeholder="Enter ticker — RELIANCE, TCS, LICI, AAPL…"
                value={input}
                onChange={e => setInput(e.target.value.toUpperCase())}
                disabled={state.status === 'loading'}
              />
              {state.status === 'loading' && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              )}
            </div>
            <button type="submit" className="btn-primary text-sm shrink-0"
              disabled={state.status === 'loading' || !input.trim()}>
              Analyze
            </button>
          </form>
          {state.ticker && state.status === 'success' && (
            <button
              onClick={async () => {
                if (!window.confirm(`Delete saved data for ${state.ticker} (including pasted Screener history) and re-fetch fresh?`)) return
                await deleteCached(state.ticker)
                load(state.ticker)
              }}
              title="Delete this stock's saved & pasted data, then re-fetch"
              className="text-xs px-3 py-2 rounded-lg border border-navy-600 text-slate-400 hover:text-bear hover:border-bear/50 shrink-0 transition-colors">
              🗑 Reset data
            </button>
          )}
        </div>

        {/* Progress */}
        {state.status === 'loading' && state.progress && (
          <div className="space-y-1">
            <p className="text-xs text-accent">{state.progress.msg}</p>
            <div className="h-0.5 bg-navy-800 rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all duration-700"
                style={{ width: `${(state.progress.step / 2) * 100}%` }} />
            </div>
          </div>
        )}

        {/* Stock identity bar — CMP, Market Cap, Sector, Stage */}
        {state.status === 'success' && state.data && <IdentityBar />}

        {/* Example tickers */}
        {state.status === 'idle' && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <span className="text-xs text-slate-600">Try:</span>
            {EXAMPLES.map(t => (
              <button key={t} onClick={() => { setInput(t); load(t) }}
                className="text-xs px-2 py-0.5 rounded bg-navy-800 text-slate-400 hover:text-white hover:bg-navy-700 transition-colors font-mono">
                {t}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  )
}

function IdentityBar() {
  const { state, overrideStage } = useApp()
  const { data, ratioResult, stage, validation } = state
  const stageInfo = STAGES[stage] || STAGES.ESTABLISHED

  const price     = ratioResult?.price
  const marketCap = ratioResult?.marketCap
  const change    = data?.meta?.change1d
  const cur       = data?.currency === 'INR' ? '₹' : '$'

  const mcapStr = marketCap
    ? cur + (data.currency === 'INR'
        ? marketCap >= 1e12 ? (marketCap / 1e12).toFixed(1) + 'L Cr'
          : (marketCap / 1e7).toFixed(0) + ' Cr'
        : marketCap >= 1e12 ? (marketCap / 1e12).toFixed(1) + 'T'
          : (marketCap / 1e9).toFixed(1) + 'B')
    : null

  return (
    <div className="border-t border-navy-800 pt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {/* Left: ticker + CMP + change + mcap + sector */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-mono font-bold text-white text-base">
          {data.ticker}
        </span>
        {data.name && data.name !== data.ticker && (
          <span className="text-slate-400 text-xs">{data.name}</span>
        )}
        {/* CMP — prominent */}
        {price != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-white font-semibold text-base">
              CMP: {cur}{price.toFixed(2)}
            </span>
            {change != null && (
              <span className={change >= 0 ? 'text-bull text-xs' : 'text-bear text-xs'}>
                {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
              </span>
            )}
          </div>
        )}
        {mcapStr && <span className="text-xs text-slate-400">Mkt Cap: {mcapStr}</span>}
        {data.meta?.sector && <span className="text-xs text-slate-500">Sector: {data.meta.sector}</span>}
        <DataVintageBadge data={data} />
        {validation && !validation.passed && validation.failedMetrics?.length > 0 && (
          <span className="text-xs text-neutral" title={validation.message}>
            ⚠️ History limited
          </span>
        )}
      </div>

      {/* Right: stage */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">Stage:</span>
        <span className="badge badge-neutral text-xs">{stageInfo.emoji} {stageInfo.label}</span>
        <select
          className="text-xs bg-navy-800 border border-navy-700 text-slate-300 rounded px-1.5 py-0.5 cursor-pointer"
          value={stage || 'ESTABLISHED'}
          onChange={e => overrideStage(e.target.value)}>
          <option value="PRE_REVENUE">🌱 Pre-Revenue</option>
          <option value="GROWTH">🚀 Growth</option>
          <option value="TRANSITION">🔄 Transition</option>
          <option value="ESTABLISHED">🏛️ Established</option>
        </select>
      </div>
    </div>
  )
}

/**
 * Shows exactly which fiscal year the annual figures actually come from,
 * and how many years of history are available — computed from the real
 * data, not assumed. Indian companies report annual results within ~60
 * days of fiscal year end (March 31), so if the latest available year is
 * more than ~15 months old, that's a genuine data-lag worth flagging —
 * the company has almost certainly reported a newer year that data
 * providers (including Yahoo) simply haven't ingested yet.
 */
function DataVintageBadge({ data }) {
  const years = (data.incomeHistory || []).map(r => r.year).filter(Boolean).sort()
  if (years.length === 0) {
    return <span className="text-xs text-slate-600">📡 No annual data available</span>
  }

  const latestYear  = years[years.length - 1]
  const yearCount   = years.length
  const sourceLabel = data.source === 'merged' ? 'Yahoo + Screener' : 'Yahoo'

  // Indian fiscal year ends March 31 — results typically filed by ~May 31
  // If we're more than 14 months past that fiscal year-end, the data is stale
  const fyEnd       = new Date(`${latestYear}-03-31`)
  const monthsStale = (Date.now() - fyEnd.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
  const isStale     = monthsStale > 14

  return (
    <span
      className={`text-xs flex items-center gap-1 ${isStale ? 'text-neutral' : 'text-slate-600'}`}
      title={isStale
        ? `Latest annual data is FY${latestYear} — the company has likely reported a newer fiscal year that hasn't been ingested by the data source yet.`
        : `${yearCount} years of annual data, through FY${latestYear}`}>
      📡 {sourceLabel} · {yearCount}yr · through FY{latestYear}
      {isStale && <span>⚠️</span>}
    </span>
  )
}


