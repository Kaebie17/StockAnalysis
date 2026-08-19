

import React, { useState } from 'react'
import { usePositions } from '../../store/usePositions.js'
import { assessDataQuality } from '../../engine/dataQuality.js'
import { saveDataResolution, listDataResolutions } from '../../utils/db.js'
import { useApp } from '../../store/AppContext.jsx'
import { deleteCached } from '../../utils/db.js'
import { STAGES } from '../../engine/stage.js'
import FormulasPanel from '../FormulasPanel.jsx'
import SyncControls from '../../sync/SyncControls.jsx'
import NormalizeModal from './NormalizeModal.jsx'

const EXAMPLES = ['RELIANCE', 'TCS', 'LICI', 'MARUTI', 'ZOMATO', 'HDFCBANK', 'AAPL', 'MSFT']

export default function Header({ onOpenTable }) {
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
                className="input-field w-full uppercase pr-10 text-sm"
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
        {state.status === 'success' && state.data && <IdentityBar onOpenTable={onOpenTable} />}

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

function IdentityBar({ onOpenTable }) {
  const { state, overrideStage, setBasis } = useApp()
  const { data, ratioResult, stage } = state
  const [normOpen, setNormOpen] = React.useState(false)
  const basis = data?.basis || 'reported'
  const hasNorm = (data?.normalizedIncomeHistory?.length || 0) > 0
  const [refreshing, setRefreshing] = React.useState(false)
  // Just the held-lots label; the actions themselves live in PositionFab.
  const { positions } = usePositions(state.ticker)
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
    <div className="border-t border-navy-800 pt-2 space-y-1.5">
      {/* Row 1: ticker + name */}
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-mono font-bold text-white text-base whitespace-nowrap">
          {data.ticker}
        </span>
        {data.name && data.name !== data.ticker && (
          <span className="text-slate-400 text-xs truncate">{data.name}</span>
        )}
      </div>

      {/* Row 2: CMP + change + mcap */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        {price != null && (
          <span className="text-white font-semibold text-base flex items-center gap-1.5 whitespace-nowrap">
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
                fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
              </svg>
            </button>
          </span>
        )}
        {change != null && (
          <span className={`${change >= 0 ? 'text-bull' : 'text-bear'} text-xs whitespace-nowrap`}>
            {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
          </span>
        )}
        {mcapStr && <span className="text-xs text-slate-400 whitespace-nowrap">Mkt Cap: {mcapStr}</span>}
        {data.meta?.sector && <span className="text-xs text-slate-500 whitespace-nowrap">Sector: {data.meta.sector}</span>}
      </div>

      {/* Row 3: data vintage badge (its own line — it's long) */}
      <div className="flex flex-wrap">
        <DataVintageBadge data={data} state={state} onOpenTable={onOpenTable} />
      </div>

      {/* Row 4: stage + basis controls + dividend — wrap as whole units */}
      <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap">
        {openLots.length > 0 && (
          <span className="text-[10px] text-slate-500 whitespace-nowrap">
            {openLots.length} lot{openLots.length > 1 ? 's' : ''} held
          </span>
        )}
        <span className="text-xs text-slate-500 whitespace-nowrap">Stage:</span>
        <span className="badge badge-neutral text-xs whitespace-nowrap">{stageInfo.emoji} {stageInfo.label}</span>
        <select
          className="text-xs bg-navy-800 border border-navy-700 text-slate-300 rounded px-1.5 py-0.5 cursor-pointer max-w-[9rem]"
          value={stage || 'ESTABLISHED'}
          onChange={e => overrideStage(e.target.value)}>
          <option value="PRE_REVENUE">🌱 Pre-Revenue</option>
          <option value="GROWTH">🚀 Growth</option>
          <option value="TRANSITION">🔄 Transition</option>
          <option value="ESTABLISHED">🏛️ Established</option>
        </select>
        <button onClick={() => setNormOpen(true)} title="Normalize a one-off"
          className="text-xs px-2 py-0.5 rounded border border-navy-700 text-slate-400 hover:text-accent hover:border-accent/50 transition-colors whitespace-nowrap">
          ⚖ Normalize
        </button>
        {hasNorm && (
          <button onClick={() => setBasis(basis === 'normalized' ? 'reported' : 'normalized')}
            title="Switch between as-reported and normalized figures"
            className={`text-xs px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
              basis === 'normalized'
                ? 'border-accent bg-navy-800 text-white'
                : 'border-navy-700 text-slate-400 hover:text-accent'}`}>
            {basis === 'normalized' ? 'Normalized' : 'Reported'}
          </button>
        )}
        <DividendLine data={data} ratioResult={ratioResult} cur={cur} />
      </div>

      <NormalizeModal open={normOpen} onClose={() => setNormOpen(false)} />
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
function DataVintageBadge({ data, state, onOpenTable }) {
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

  // Everything the app knows about the quality of this history — adjustments it
  // applied, years it can't explain, breaks in comparability. Gathered in one
  // place rather than surfacing wherever a metric happens to look odd.
  const quality = assessDataQuality(data.incomeHistory || [])

  return (
    <span className={`text-xs flex items-center gap-1 ${isStale ? 'text-neutral' : 'text-slate-600'}`}>
      <span title={isStale
        ? `Latest annual data is FY${latestYear} — the company has likely reported a newer fiscal year that hasn't been ingested by the data source yet.`
        : `${yearCount} years of annual data, through FY${latestYear}`}>
        📡 {sourceLabel} · {yearCount}yr · through FY{latestYear}
      </span>
      {isStale && <span>⚠️</span>}
      {quality.hasIssues && (
        <DataQualityDot quality={quality} ticker={state.ticker} onOpenTable={onOpenTable} />
      )}
    </span>
  )
}

/**
 * The data-quality ⓘ.
 *
 * Adjustments the app made silently are shown alongside what it could not fix,
 * because a user reading a margin needs to know both — that FY24 has had an
 * exceptional item removed is as material as that FY26 looks odd.
 */
function DataQualityDot({ quality, ticker, onOpenTable }) {
  const [open, setOpen] = React.useState(false)
  const [resolutions, setResolutions] = React.useState([])

  // Past decisions, matched to current flags by (year, kind). A year flagged for
  // a margin spike and the same year previously resolved for a revenue step are
  // different problems — matching on year alone would offer one as a fix for
  // the other.
  React.useEffect(() => {
    if (!ticker) return
    let dead = false
    listDataResolutions(ticker)
      .then(r => { if (!dead) setResolutions(r) })
      .catch(() => {})
    return () => { dead = true }
  }, [ticker, open])

  const priorFor = (f) => resolutions.find(r => r.year === f.year && r.kind === f.kind)

  const resolve = async (f, disposition) => {
    await saveDataResolution({ ticker, year: f.year, kind: f.kind, disposition,
                               note: f.note, source: 'manual' })
    setResolutions(await listDataResolutions(ticker))
  }

  // A flag the user has already judged is shown as settled rather than hidden —
  // the reading is still unusual, and concealing that would misrepresent the
  // history.
  const open_ = quality.flags.filter(f => priorFor(f)?.disposition !== 'accepted')
  const hasWarning = open_.length > 0 || quality.gaps.length > 0

  return (
    <span className="relative inline-flex"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}>
      <button type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        aria-label="Data quality notes"
        className={`w-4 h-4 rounded-full border text-[10px] leading-none flex items-center
                    justify-center shrink-0 transition-colors ${
          hasWarning ? 'border-neutral/60 text-neutral hover:border-neutral'
                     : 'border-navy-600 text-slate-500 hover:text-accent hover:border-accent/60'}`}>
        {hasWarning ? '!' : 'i'}
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <span className="absolute z-[61] left-0 top-5 w-72 max-w-[86vw]
                           bg-navy-900 border border-navy-700 rounded-lg shadow-2xl p-3
                           text-left font-normal normal-case cursor-default space-y-2"
                onClick={e => e.stopPropagation()}>

            {quality.adjustments.length > 0 && (
              <span className="block">
                <span className="block text-[11px] text-slate-300 mb-1">Adjusted</span>
                {quality.adjustments.map(a => (
                  <span key={a.year} className="block text-[11px] text-slate-500">
                    FY{a.year}: {a.note} ({a.impactPct}% of profit)
                  </span>
                ))}
              </span>
            )}

            {quality.flags.length > 0 && (
              <span className="block">
                <span className="block text-[11px] text-neutral mb-1">Unusual years</span>
                {quality.flags.map(f => {
                  const prior = priorFor(f)
                  const settled = prior?.disposition === 'accepted'
                  return (
                    <span key={`${f.kind}-${f.year}`}
                          className="block text-[11px] mb-1.5 pb-1.5 border-b border-navy-800 last:border-0">
                      <span className={settled ? 'text-slate-600' : 'text-slate-400'}>
                        FY{f.year}: {f.note}
                        {settled && <span className="text-slate-600"> · you marked this as real</span>}
                      </span>
                      {!settled && (
                        <span className="flex items-center gap-3 mt-1">
                          {/* Routes to where the answer lives. A one-off is
                              usually inside Other income or an expense sub-line,
                              which Screener keeps collapsed — so a normal copy
                              misses it and re-pasting with those rows expanded
                              resolves it without anyone typing a figure. */}
                          <button onClick={() => { setOpen(false); onOpenTable?.(f.resolveHint || 'income') }}
                            className="text-accent hover:text-accent-light">
                            re-paste P&amp;L with sub-rows expanded
                          </button>
                          <button onClick={() => resolve(f, 'accepted')}
                            className="text-slate-500 hover:text-slate-300">
                            it's real
                          </button>
                        </span>
                      )}
                      {prior && prior.disposition !== 'accepted' && (
                        <span className="block text-[10px] text-slate-600 mt-0.5">
                          Previously: {prior.note}
                        </span>
                      )}
                    </span>
                  )
                })}
              </span>
            )}

            {quality.gaps.length > 0 && (
              <span className="block text-[11px] text-slate-500">
                Missing: FY{quality.gaps.join(', FY')}
              </span>
            )}

            <span className="block text-[10px] text-slate-600 pt-1 border-t border-navy-800">
              Adjustments are applied to every calculation. Unusual years are left exactly as
              reported — nothing is altered on a guess.
            </span>
          </span>
        </>
      )}
    </span>
  )
}

