

import React, { useState } from 'react'
import PositionModal from './PositionModal.jsx'
import { usePositions } from '../../store/usePositions.js'
import { useApp } from '../../store/AppContext.jsx'
import { deleteCached } from '../../utils/db.js'
import { STAGES } from '../../engine/stage.js'
import FormulasPanel from '../FormulasPanel.jsx'
import SyncControls from '../../sync/SyncControls.jsx'

const EXAMPLES = ['RELIANCE', 'TCS', 'LICI', 'MARUTI', 'ZOMATO', 'HDFCBANK', 'AAPL', 'MSFT']

export default function Header({ onOpenPositions }) {
  const { state, load, reset } = useApp()
  const [input, setInput] = useState('')
  const [fxOpen, setFxOpen] = useState(false)

  // Keep the box showing whatever ticker is actually loaded. Without this the
  // input is local state that starts empty and is never written back to, so
  // after a successful load the box sits blank while a ticker IS loaded — on
  // mobile that reads as "did my old entry get cleared or not?", with no way to
  // tell. Mirroring state.ticker makes the current selection visible, and the
  // select-on-focus below turns "type over it" into a single tap.
  React.useEffect(() => {
    if (state.ticker && state.status === 'success') setInput(state.ticker)
  }, [state.ticker, state.status])

  const submit = (e) => {
    e?.preventDefault()
    const t = input.trim()
    if (t) load(t)
  }

  return (
    <>
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
                onFocus={e => e.target.select()}
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
          {/* Positions is the opposite case from Formulas below: checking what
              you hold isn't tied to the ticker on screen, so it stays reachable
              everywhere. Icon-only to keep the mobile row short. */}
          {onOpenPositions && (
            <button onClick={onOpenPositions} title="My positions"
              className="text-sm px-2.5 py-2 rounded-lg border border-navy-600 text-slate-400
                         hover:text-accent hover:border-accent/50 shrink-0 transition-colors">
              📊
            </button>
          )}

          {/* Formula overrides are GLOBAL — one set shared by every ticker — so
              this belongs on the landing page, not in the per-ticker row. On
              mobile that row was carrying logo + input + Analyze + Formulas +
              Reset all at once, which is what made it unusable. */}
          {state.status !== 'success' && (
            <button onClick={() => setFxOpen(true)} title="Edit metric formulas"
              className="text-xs px-3 py-2 rounded-lg border border-navy-600 text-slate-400 hover:text-accent hover:border-accent/50 shrink-0 transition-colors">
              ƒ Formulas
            </button>
          )}
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

        {/* Sync row — own line so the email box never overflows on mobile */}
        <div className="flex"><SyncControls /></div>

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
    <FormulasPanel open={fxOpen} onClose={() => setFxOpen(false)} />
    </>
  )
}

function IdentityBar() {
  const { state, overrideStage } = useApp()
  const { data, ratioResult, stage } = state
  const [refreshing, setRefreshing] = React.useState(false)
  // Buy/sell for the ticker on screen. Sell only appears when a lot actually
  // exists — offering it otherwise is a dead button.
  const [posModal, setPosModal] = React.useState(null)   // null | 'buy' | 'sell'
  const { positions, refresh } = usePositions(state.ticker)
  const openLots = positions.filter(p => p.status !== 'closed')
  const stageInfo = STAGES[stage] || STAGES.ESTABLISHED

  const price     = ratioResult?.price
  const marketCap = ratioResult?.marketCap
  const change    = data?.meta?.change1d
  const cur       = data?.currency === 'INR' ? '₹' : '$'

  const handleRefreshPrice = async () => {
    const ticker = state?.data?.ticker || state?.ticker
    if (!ticker || refreshing) return
    setRefreshing(true)
    try {
      // Lightweight fetch: hits backend quote endpoint directly instead of full pipeline
      const res = await fetch(`/api/yahoo?endpoint=all&ticker=${encodeURIComponent(ticker)}`)
      if (res.ok) {
        const json = await res.json()
        const newPrice = json?.quote?.regularMarketPrice
        const newChange = json?.quote?.regularMarketChangePercent

        if (newPrice != null) {
          ratioResult.price = newPrice
          if (data?.meta) data.meta.change1d = newChange ?? data.meta.change1d
        }
      }
    } catch (err) {
      console.warn('Failed to refresh CMP:', err)
    } finally {
      setTimeout(() => setRefreshing(false), 500)
    }
  }

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
        {/* CMP — prominent with lightweight refresh spinner */}
        {price != null && (
          <div className="flex items-center gap-1.5">
            <span className="text-white font-semibold text-base flex items-center gap-1.5">
              CMP: {cur}{price.toFixed(2)}
              <button 
                type="button"
                onClick={handleRefreshPrice} 
                disabled={refreshing}
                title="Refresh CMP"
                style={{ background: 'transparent', border: 'none', padding: 0, boxShadow: 'none' }}
                className="cursor-pointer focus:outline-none p-0.5 group">
                <svg 
                  className={`w-3.5 h-3.5 text-slate-400 group-hover:text-accent transition-transform ${refreshing ? 'animate-spin text-accent' : ''}`}
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2" 
                  viewBox="0 0 24 24" 
                  xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
              </button>
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
      </div>

      {/* Right: buy/sell + stage. Sits next to CMP because that's the number
          the purchase form pre-fills from. */}
      <div className="flex items-center gap-2">
        <button onClick={() => setPosModal('buy')}
          title="Record a purchase of this stock"
          className="text-xs px-2 py-1 rounded-md border border-navy-600 text-slate-400
                     hover:text-bull hover:border-bull/50 transition-colors">
          + Bought
        </button>
        {openLots.length > 0 && (
          <button onClick={() => setPosModal('sell')}
            title="Record a sale"
            className="text-xs px-2 py-1 rounded-md border border-navy-600 text-slate-400
                       hover:text-bear hover:border-bear/50 transition-colors">
            − Sold
          </button>
        )}
        {openLots.length > 0 && (
          <span className="text-[10px] text-slate-500">
            {openLots.length} lot{openLots.length > 1 ? 's' : ''} held
          </span>
        )}
        <PositionModal
          open={posModal !== null}
          mode={posModal === 'sell' ? 'sell' : 'buy'}
          position={posModal === 'sell' ? openLots[0] : null}
          onClose={() => setPosModal(null)}
          onSaved={refresh} />
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
        <DividendLine data={data} ratioResult={ratioResult} cur={cur} />
      </div>
    </div>
  )
}

/**
 * Dividend expressed as CASH on a real investment — a percentage alone doesn't
 * convey much ("2%" of what?). Shows the annual dividend on ₹10,000 invested.
 *
 * Source priority (most reliable first):
 *   1. Payout % (Screener paste) × EPS → dividend/share → × (invest / price)
 *   2. Yahoo's dividend yield (a FRACTION, e.g. 0.0045) × invest
 * Screener's key-stat yield is a PERCENT, so it's scaled by source.
 */
function DividendLine({ data, ratioResult, cur }) {
  const INVEST = 10000
  const price = ratioResult?.price
  if (!price) return null

  const val = t => (t && typeof t === 'object' ? t.value : t)
  const rows = data?.incomeHistory || []
  const latest = rows[rows.length - 1] || {}
  const payoutPct = val(latest.dividendPayout)
  const eps = val(latest.eps) ?? ratioResult?.eps

  let dps = null, basis = null
  if (payoutPct != null && payoutPct > 0 && eps != null && eps > 0) {
    dps = eps * (payoutPct / 100)
    basis = `${payoutPct.toFixed(0)}% payout`
  } else {
    const y = ratioResult?.ratios?.divYield?.value
    if (y != null && y > 0) {
      // Yahoo → fraction; Screener key-stats → percent.
      const frac = data?.source === 'screener' ? y / 100 : y
      dps = frac * price
      basis = `${(frac * 100).toFixed(2)}% yield`
    }
  }

  if (dps == null || !(dps > 0)) {
    return <span className="text-xs text-slate-600" title="No dividend data available">💰 No dividend data</span>
  }

  const annual = (INVEST / price) * dps       // cash per year on ₹10,000 invested
  const yieldPct = (dps / price) * 100

  return (
    <span className="text-xs text-slate-400"
      title={`Based on ${basis}. Approx ${cur}${annual.toFixed(0)} a year on ${cur}${INVEST.toLocaleString('en-IN')} invested at the current price (${yieldPct.toFixed(2)}% yield). Past dividends are not a promise of future ones.`}>
      💰 <span className="text-slate-200">{cur}{annual.toFixed(0)}</span>
      <span className="text-slate-500">/yr per {cur}{(INVEST / 1000).toFixed(0)}k</span>
    </span>
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
  const sourceLabel = data.source === 'merged' ? data.deepSource === 'sec' ? 'Yahoo + SEC EDGAR' : 'Yahoo + Screener' : 'Yahoo'

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

