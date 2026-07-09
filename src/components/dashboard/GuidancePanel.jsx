import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { parseHoldings } from '../../engine/parseHoldings.js'
import ARReader from './ARReader.jsx'

/**
 * GuidancePanel — qualitative context + governance inputs (step 3).
 *
 * Two parts:
 *  1. Free-text guidance fields (growth runway / tailwinds / PLI & schemes / new
 *     initiatives / notes). Context ONLY — never parsed into a score. The AR
 *     reader (step 4) will route extracted snippets into these same fields.
 *  2. Screener holdings paste → parsed promoter + pledge series into
 *     state.holdingsData. This is ONE half of the Block-5 governance gate; the
 *     annual report (step 4, state.arData) is the other. Both required.
 *
 * Persists via the store's setQualInputs({ guidance?, holdingsData?, arData? }).
 */

const FIELDS = [
  { key: 'runway',      label: 'Growth runway / TAM',      ph: 'Addressable market, penetration headroom…' },
  { key: 'tailwinds',   label: 'Secular tailwinds',        ph: 'Structural demand drivers, industry shift…' },
  { key: 'pli',         label: 'PLI / govt schemes',       ph: 'Scheme exposure, incentives, subsidies…' },
  { key: 'initiatives', label: 'New initiatives',          ph: 'New segments, capex, diversification…' },
  { key: 'notes',       label: 'Other notes',              ph: 'Anything else material to the thesis…' },
]

export default function GuidancePanel() {
  const { state, setQualInputs } = useApp()
  const savedGuidance = state.guidance || {}
  const holdingsData = state.holdingsData || null
  const arData = state.arData || null

  const [draft, setDraft] = useState(savedGuidance)
  const [paste, setPaste] = useState('')
  const [preview, setPreview] = useState(null)   // parseHoldings result before saving
  const [arOpen, setArOpen] = useState(false)

  // Re-seed local drafts when the ticker's saved guidance changes.
  useEffect(() => { setDraft(state.guidance || {}) }, [state.ticker]) // eslint-disable-line

  const saveField = (key) => {
    if ((draft[key] || '') === (savedGuidance[key] || '')) return
    setQualInputs({ guidance: { ...savedGuidance, [key]: draft[key] || '' } })
  }

  const runParse = () => setPreview(parseHoldings(paste))

  const saveHoldings = () => {
    if (preview?.ok) {
      setQualInputs({ holdingsData: {
        promoterSeries: preview.promoterSeries,
        pledgeSeries: preview.pledgeSeries,
        quarters: preview.quarters,
        savedAt: Date.now(),
      } })
      setPaste(''); setPreview(null)
    }
  }

  const clearHoldings = () => setQualInputs({ holdingsData: null })

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">📝 Guidance &amp; Quality Inputs</h2>
        <GateStatus holdings={!!holdingsData} ar={!!arData} />
      </div>

      {/* Qualitative free-text (context only) */}
      <div className="space-y-3">
        {FIELDS.map(f => (
          <div key={f.key}>
            <label className="text-xs text-slate-400 mb-1 block">{f.label}</label>
            <textarea
              value={draft[f.key] || ''}
              onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => saveField(f.key)}
              placeholder={f.ph}
              rows={2}
              className="input-field w-full text-sm resize-y" />
          </div>
        ))}
        <p className="text-[10px] text-slate-600">
          Qualitative context only — shown alongside the Quality &amp; Moat pillar, never scored.
        </p>
      </div>

      {/* Screener holdings paste */}
      <div className="border-t border-navy-800 pt-3 space-y-2">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Promoter holding &amp; pledge (Screener)
        </div>

        {holdingsData ? (
          <SavedHoldings data={holdingsData} onClear={clearHoldings} />
        ) : (
          <>
            <textarea
              value={paste}
              onChange={e => setPaste(e.target.value)}
              placeholder={'Paste the Screener "Shareholding Pattern" table (include the quarter date row and the Promoters / Pledged rows).'}
              rows={4}
              className="input-field w-full text-xs font-mono resize-y" />
            <div className="flex gap-2">
              <button onClick={runParse} disabled={!paste.trim()} className="btn-primary text-xs disabled:opacity-40">
                Parse
              </button>
              {preview?.ok && (
                <button onClick={saveHoldings} className="btn-primary text-xs">Save holdings</button>
              )}
            </div>
            {preview && (
              <div className={`text-xs ${preview.ok ? 'text-slate-400' : 'text-bear'}`}>
                {preview.note}
                {preview.ok && <PreviewSeries data={preview} />}
              </div>
            )}
          </>
        )}
        {arData ? (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">📄 Annual report: <span className="text-slate-200">{arData.sourceName}</span></span>
            <button onClick={() => setArOpen(true)} className="text-accent hover:text-accent-light">Re-scan</button>
          </div>
        ) : (
          <button onClick={() => setArOpen(true)} className="btn-primary text-xs">📄 Add annual report</button>
        )}
      </div>
      <ARReader open={arOpen} onClose={() => setArOpen(false)} />
    </div>
  )
}

// ── bits ──────────────────────────────────────────────────────────────────────
function GateStatus({ holdings, ar }) {
  const both = holdings && ar
  return (
    <span className={`text-[11px] ${both ? 'text-bull' : 'text-slate-500'}`}>
      {both ? '🔓 Governance unlocked' : `🔒 Holdings ${holdings ? '✓' : '✗'} · AR ${ar ? '✓' : '✗'}`}
    </span>
  )
}

function PreviewSeries({ data }) {
  const p = data.promoterSeries
  const pl = data.pledgeSeries
  const trend = (s) => s.length < 2 ? '' : (s[s.length - 1].pct > s[0].pct + 1 ? ' ↑' : s[s.length - 1].pct < s[0].pct - 1 ? ' ↓' : ' →')
  return (
    <div className="mt-1 space-y-0.5 text-slate-300">
      <div>Promoter: {p[0].pct}% → {p[p.length - 1].pct}%{trend(p)}</div>
      {pl.length > 0 && <div>Pledge: {pl[0].pct}% → {pl[pl.length - 1].pct}%{trend(pl)}</div>}
    </div>
  )
}

function SavedHoldings({ data, onClear }) {
  const p = data.promoterSeries || []
  const pl = data.pledgeSeries || []
  const last = arr => (arr.length ? arr[arr.length - 1].pct : null)
  return (
    <div className="bg-navy-800/50 rounded-lg px-3 py-2 text-xs space-y-1">
      <div className="flex justify-between">
        <span className="text-slate-400">Promoter (latest)</span>
        <span className="text-slate-100">{last(p)}%</span>
      </div>
      {pl.length > 0 && (
        <div className="flex justify-between">
          <span className="text-slate-400">Pledge (latest)</span>
          <span className={last(pl) > 20 ? 'text-bear' : 'text-slate-100'}>{last(pl)}%</span>
        </div>
      )}
      <div className="text-[10px] text-slate-600">{data.quarters?.length || 0} quarters saved</div>
      <button onClick={onClear} className="text-[11px] text-slate-500 hover:text-bear">Clear &amp; re-paste</button>
    </div>
  )
}
