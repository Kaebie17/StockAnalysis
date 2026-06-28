// ValuationPanel.jsx
import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { MODEL_LABELS, DEFAULT_ASSUMPTIONS } from '../../engine/valuation.js'
import { fmtPrice, fmtPct, fmt, upsideColor, signalChip, signalEmoji } from '../../utils/format.js'

export default function ValuationPanel() {
  const { state, actions } = useApp()
  const { valuation, data, assumptions } = state
  const [showAssumptions, setShowAssumptions] = useState(false)

  if (!valuation || !data) return null
  if (state.expandedPanel !== 'valuation') return null

  const currency = data.currency ?? 'USD'
  const price    = data.price

  return (
    <div className="card px-5 py-4 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display font-semibold text-slate-100">Valuation Detail</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAssumptions(s => !s)} className="btn-outline text-xs">
            {showAssumptions ? 'Hide' : '✎ Edit'} Assumptions
          </button>
          <button onClick={actions.resetAssumptions} className="btn-ghost text-xs">↺ Reset</button>
        </div>
      </div>

      {/* Assumptions editor */}
      {showAssumptions && (
        <AssumptionsEditor assumptions={assumptions} onUpdate={actions.updateAssumptions} />
      )}

      {/* Model table */}
      <div className="space-y-2">
        {Object.entries(valuation.models).map(([key, model]) => {
          if (model.isGrowthRate) return null // show Reverse DCF separately
          const label   = MODEL_LABELS[key] ?? key
          const upside  = model.value && price ? ((model.value - price) / price) * 100 : null

          return (
            <div key={key} className={`card-inner px-4 py-3 flex items-center gap-4
              ${!model.applicable ? 'opacity-40' : ''}`}>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-200 font-medium">{label}</p>
                {!model.applicable && (
                  <p className="text-xs text-slate-500">{model.reason}</p>
                )}
              </div>

              {model.applicable && model.value != null ? (
                <>
                  <div className="text-right">
                    <p className="font-mono text-slate-100">{fmtPrice(model.value, currency)}</p>
                  </div>
                  <div className={`text-right w-20 font-mono text-sm ${upsideColor(upside)}`}>
                    {fmtPct(upside)}
                  </div>
                  <div className="w-24">
                    <UpsideBar upside={upside} />
                  </div>
                </>
              ) : (
                <span className="text-slate-600 text-sm font-mono ml-auto">N/A</span>
              )}
            </div>
          )
        })}
      </div>

      {/* Reverse DCF */}
      {valuation.models.reverseDCF?.applicable && (
        <div className="card-inner px-4 py-3">
          <p className="label mb-1">Reverse DCF — Implied Growth Rate</p>
          <p className="text-slate-300 text-sm">
            At the current price of{' '}
            <span className="font-mono text-slate-100">{fmtPrice(price, currency)}</span>,
            the market is pricing in a FCF growth rate of{' '}
            <span className={`font-mono font-semibold ${
              valuation.models.reverseDCF.value > 20 ? 'text-accent-red'
              : valuation.models.reverseDCF.value > 10 ? 'text-accent-amber'
              : 'text-accent-green'}`}>
              {fmt(valuation.models.reverseDCF.value)}%
            </span>{' '}
            per year — {valuation.models.reverseDCF.value > 20
              ? 'very high expectations baked in'
              : valuation.models.reverseDCF.value > 10
              ? 'moderate growth expected'
              : 'conservative growth assumed'}.
          </p>
        </div>
      )}

      {/* Consensus */}
      <div className="card-inner px-4 py-3 flex items-center justify-between gap-4">
        <div>
          <p className="label mb-0.5">Weighted Consensus</p>
          <p className="text-xs text-slate-500">Based on applicable models × weights</p>
        </div>
        <div className="text-right">
          <p className="font-mono font-bold text-lg text-slate-100">
            {fmtPrice(valuation.consensusValue, currency)}
          </p>
          <p className={`font-mono text-sm ${upsideColor(valuation.upside)}`}>
            {fmtPct(valuation.upside)} vs CMP
          </p>
        </div>
        <div>
          <span className={`chip ${signalChip(valuation.signal)} text-sm`}>
            {signalEmoji(valuation.signal)} {valuation.signal?.replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      <p className="text-xs text-slate-600">
        Model weights are configurable in Scoring Studio. Sector multiples can be adjusted in assumptions.
      </p>
    </div>
  )
}

function UpsideBar({ upside }) {
  if (upside == null) return null
  const capped = Math.max(-50, Math.min(50, upside))
  const width  = Math.abs(capped) * 2   // 0–100%
  const isPos  = upside >= 0

  return (
    <div className="h-1.5 bg-surface-900 rounded-full overflow-hidden relative">
      <div className="absolute inset-y-0 left-1/2 w-px bg-slate-600" />
      <div
        className={`absolute inset-y-0 ${isPos ? 'left-1/2' : 'right-1/2'} rounded-full
          ${isPos ? 'bg-accent-green' : 'bg-accent-red'}`}
        style={{ width: `${width / 2}%` }}
      />
    </div>
  )
}

function AssumptionsEditor({ assumptions, onUpdate }) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions }

  function field(label, key, suffix = '', min, max, step = 0.5) {
    return (
      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs text-slate-400">{label}</label>
          <span className="text-xs font-mono text-slate-200">{a[key]}{suffix}</span>
        </div>
        <input
          type="range" min={min} max={max} step={step}
          value={a[key]}
          onChange={e => onUpdate({ [key]: parseFloat(e.target.value) })}
          className="w-full h-1 bg-surface-700 rounded appearance-none accent-cyan-400"
        />
      </div>
    )
  }

  return (
    <div className="card-inner px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="space-y-4">
        <p className="label">DCF Assumptions</p>
        {field('WACC / Discount Rate', 'wacc', '%', 5, 20)}
        {field('Terminal Growth Rate', 'terminalGrowth', '%', 1, 8, 0.25)}
        {field('Projection Years', 'projectionYears', ' yr', 3, 10, 1)}
        {field('FCF Growth Rate Yr1', 'revenueGrowthYr1', '%', 0, 50)}
      </div>
      <div className="space-y-4">
        <p className="label">Sector Multiples</p>
        {field('Sector P/E', 'sectorPE', 'x', 5, 60, 1)}
        {field('Sector EV/EBITDA', 'sectorEVEBITDA', 'x', 3, 30, 0.5)}
        {field('Sector P/B', 'sectorPB', 'x', 0.5, 10, 0.25)}
        {field('Sector P/S', 'sectorPS', 'x', 0.5, 20, 0.5)}
      </div>
      <div className="space-y-4">
        <p className="label">Signal Brackets</p>
        {field('Undervalued if upside >', 'upsideBracket', '%', 5, 40, 1)}
        {field('Overvalued if downside >', 'downsideBracket', '%', 5, 30, 1)}
        {field('Margin of Safety', 'marginOfSafety', '%', 0, 40, 5)}
      </div>
    </div>
  )
}
