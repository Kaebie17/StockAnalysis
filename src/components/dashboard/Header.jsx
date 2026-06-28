// Header.jsx
import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPrice, fmtPct, fmtCompact } from '../../utils/format.js'
import { STAGES, getStageConfig } from '../../engine/stage.js'
import { SOURCE_STATUS } from '../../api/orchestrator.js'

export default function Header() {
  const { state, actions } = useApp()
  const [ticker, setTicker]     = useState('')
  const [showKey, setShowKey]   = useState(false)
  const [keyInput, setKeyInput] = useState(state.apiKey)

  const { data, status, error, source, sourceProgress } = state
  const isLoading = status === 'loading'

  function handleSearch(e) {
    e.preventDefault()
    if (ticker.trim()) actions.fetchTicker(ticker.trim().toUpperCase())
  }

  function handleSaveKey(e) {
    e.preventDefault()
    actions.setApiKey(keyInput.trim())
    setShowKey(false)
  }

  const stage = state.stage ? getStageConfig(state.stageOverride ?? state.stage) : null

  return (
    <header className="sticky top-0 z-40 bg-surface-900/90 backdrop-blur border-b border-slate-700/50">
      <div className="max-w-6xl mx-auto px-4 py-3 space-y-2">

        {/* Top bar */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-accent-cyan font-display font-bold text-lg tracking-tight">StockVal</span>
          </div>

          {/* Search */}
          <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 max-w-sm">
            <input
              type="text"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              placeholder={state.apiKey ? 'Ticker — e.g. AAPL, RELIANCE' : 'Add API key first ↓'}
              disabled={!state.apiKey}
              className="w-full bg-surface-800 border border-slate-600 rounded-xl px-3 py-2 text-sm text-slate-100
                         placeholder-slate-500 focus:outline-none focus:border-accent-cyan transition-colors font-mono
                         disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={isLoading || !ticker.trim() || !state.apiKey}
              className="btn-primary whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <span className="flex items-center gap-1.5">
                  <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Fetching
                </span>
              ) : 'Analyze'}
            </button>
          </form>

          {/* API Key indicator */}
          <button
            onClick={() => setShowKey(s => !s)}
            className="btn-ghost text-xs flex items-center gap-1.5 flex-shrink-0"
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0
              ${state.apiKey ? 'bg-accent-green' : 'bg-accent-red'}`}
            />
            <span className="hidden sm:block">{state.apiKey ? 'API Key ✓' : 'Add API Key'}</span>
          </button>
        </div>

        {/* API Key form */}
        {showKey && (
          <form onSubmit={handleSaveKey} className="flex items-center gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="FMP API key — free at financialmodelingprep.com"
              className="flex-1 bg-surface-800 border border-slate-600 rounded-xl px-3 py-2 text-sm
                         text-slate-100 placeholder-slate-500 focus:outline-none focus:border-accent-cyan"
              autoFocus
            />
            <button type="submit" className="btn-primary">Save</button>
            <button type="button" onClick={() => setShowKey(false)} className="btn-ghost">Cancel</button>
          </form>
        )}

        {/* Source progress — shown while loading */}
        {isLoading && (
          <SourceProgress progress={sourceProgress} />
        )}

        {/* Error */}
        {(status === 'error') && error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-accent-red flex items-start gap-2">
            <span className="flex-shrink-0 mt-0.5">⚠</span>
            <div>
              <span>{error}</span>
              {!state.apiKey && (
                <button onClick={() => setShowKey(true)} className="ml-2 underline text-accent-cyan">
                  Add API key
                </button>
              )}
            </div>
          </div>
        )}

        {/* Needs upload — all sources failed */}
        {status === 'needs_upload' && (
          <div className="px-3 py-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs flex items-start gap-2">
            <span className="flex-shrink-0 mt-0.5 text-accent-amber">⚡</span>
            <div className="space-y-1 flex-1">
              <p className="text-accent-amber font-medium">Automatic sources failed — upload required</p>
              <SourceProgress progress={sourceProgress} compact />
              <p className="text-slate-400">
                Upload an annual report, balance sheet, or financial statement below to continue.
                {!state.apiKey && (
                  <> Or <button onClick={() => setShowKey(true)} className="underline text-accent-cyan">add an FMP API key</button> for automatic data.</>
                )}
              </p>
            </div>
          </div>
        )}

        {/* Stock identity bar */}
        {data && status === 'success' && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-1">
            <div className="flex items-baseline gap-2">
              <span className="font-display font-bold text-lg text-slate-100">{data.name}</span>
              <span className="font-mono text-sm text-slate-400">{data.ticker}</span>
            </div>

            <div className="flex items-baseline gap-1.5">
              <span className="font-mono font-semibold text-slate-100">
                {fmtPrice(data.price, data.currency)}
              </span>
              {data.changePct1d != null && (
                <span className={`text-xs font-mono ${data.changePct1d >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                  {fmtPct(data.changePct1d)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-400">
              {data.marketCap && <span>Mkt Cap <span className="text-slate-200">{fmtCompact(data.marketCap, data.currency)}</span></span>}
              {data.sector    && <span className="hidden sm:inline">{data.sector}</span>}
              {data.exchange  && <span className="hidden sm:inline">{data.exchange}</span>}
            </div>

            {stage && <StageSelector stage={state.stage} stageOverride={state.stageOverride} />}

            <div className="ml-auto text-xs text-slate-600 hidden sm:block">
              via {source} · {new Date().toLocaleTimeString()}
            </div>
          </div>
        )}
      </div>
    </header>
  )
}

// ── Source progress indicator ─────────────────────────────

function SourceProgress({ progress, compact }) {
  const sources = [
    { key: 'fmp',      label: 'FMP API' },
    { key: 'screener', label: 'Screener.in' },
    { key: 'upload',   label: 'Upload' },
  ]

  return (
    <div className={`flex items-center gap-3 ${compact ? '' : 'py-1'}`}>
      {sources.map(({ key, label }) => {
        const st = progress[key]
        return (
          <div key={key} className="flex items-center gap-1.5">
            <StatusDot status={st} />
            <span className={`text-xs ${
              st === SOURCE_STATUS.SUCCESS ? 'text-accent-green' :
              st === SOURCE_STATUS.FAILED  ? 'text-accent-red' :
              st === SOURCE_STATUS.TRYING  ? 'text-accent-cyan' :
              st === SOURCE_STATUS.SKIPPED ? 'text-slate-600' :
              'text-slate-600'
            }`}>{label}</span>
          </div>
        )
      })}
    </div>
  )
}

function StatusDot({ status }) {
  if (status === SOURCE_STATUS.TRYING) {
    return <svg className="animate-spin h-3 w-3 text-accent-cyan" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
    </svg>
  }
  const colors = {
    [SOURCE_STATUS.SUCCESS]: 'bg-accent-green',
    [SOURCE_STATUS.FAILED]:  'bg-accent-red',
    [SOURCE_STATUS.SKIPPED]: 'bg-slate-700',
    [SOURCE_STATUS.IDLE]:    'bg-slate-700',
  }
  return <span className={`w-2 h-2 rounded-full ${colors[status] ?? 'bg-slate-700'}`} />
}

// ── Stage selector ────────────────────────────────────────

function StageSelector({ stage, stageOverride }) {
  const { actions } = useApp()
  const [open, setOpen] = useState(false)
  const cfg = getStageConfig(stageOverride ?? stage)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="chip chip-cyan flex items-center gap-1 cursor-pointer"
      >
        <span>{cfg.emoji}</span>
        <span>{cfg.label}</span>
        {stageOverride && <span className="text-slate-400 text-xs">(override)</span>}
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-surface-800 border border-slate-600 rounded-xl py-1 z-50 min-w-max shadow-xl">
          {Object.values(STAGES).map(s => (
            <button
              key={s.id}
              onClick={() => { actions.setStageOverride(s.id); setOpen(false) }}
              className={`w-full text-left px-4 py-2 text-sm hover:bg-surface-700 transition-colors
                ${(stageOverride ?? stage) === s.id ? 'text-accent-cyan' : 'text-slate-300'}`}
            >
              {s.emoji} {s.label}
            </button>
          ))}
          {stageOverride && (
            <button
              onClick={() => { actions.setStageOverride(null); setOpen(false) }}
              className="w-full text-left px-4 py-2 text-xs text-slate-500 hover:bg-surface-700 border-t border-slate-700 mt-1"
            >
              ↺ Restore auto-detected
            </button>
          )}
        </div>
      )}
    </div>
  )
}
