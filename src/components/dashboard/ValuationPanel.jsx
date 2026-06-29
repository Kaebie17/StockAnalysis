import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPct, fmtMultiple, fmtPctPlain } from '../../utils/format.js'

const MODEL_META = {
  dcf:          { name: 'DCF (10yr)',        weight: 'High' },
  pe:           { name: 'P/E Based',         weight: 'Medium' },
  evEbitda:     { name: 'EV/EBITDA',         weight: 'Medium' },
  pb:           { name: 'Price / Book',      weight: 'Low' },
  ps:           { name: 'Price / Sales',     weight: 'Low' },
  graham:       { name: 'Graham Number',     weight: 'Low' },
  evGrossProfit:{ name: 'EV / Gross Profit', weight: 'Low' }
}

function ProgressBar({ value, max, color = 'bg-accent' }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100)
  return (
    <div className="h-1.5 bg-navy-800 rounded-full overflow-hidden w-24">
      <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export default function ValuationPanel({ open, onClose }) {
  const { state, recalc } = useApp()
  const { valuation, ratioResult, data } = state
  const ratios = ratioResult?.ratios
  const [showSliders, setShowSliders] = useState(false)
  const [assumptions, setAssumptions] = useState(valuation?.assumptions || {})

  if (!open || !valuation) return null

  const cur = data?.currency === 'INR' ? '₹' : '$'
  const { models, modelMeta, fairValue, upside, impliedGrowth } = valuation

  const update = (key, value) => {
    const next = { ...assumptions, [key]: value }
    setAssumptions(next)
    recalc(next, {})
  }

  const maxUpside = 60 // for progress bar scaling

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">⚖️ Valuation Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
      </div>

      {/* Applicable models note */}
      {modelMeta?.note && (
        <div className="card-sm border-accent/20 bg-accent/5 text-xs text-slate-300">
          ℹ️ {modelMeta.note}
        </div>
      )}

      {/* Model Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-700">
              <th className="text-left py-2 text-slate-400 font-medium text-xs">Model</th>
              <th className="text-right py-2 text-slate-400 font-medium text-xs">Fair Value</th>
              <th className="text-right py-2 text-slate-400 font-medium text-xs">vs CMP</th>
              <th className="py-2 text-slate-400 font-medium text-xs pl-3">Range</th>
              <th className="text-right py-2 text-slate-400 font-medium text-xs">Weight</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(MODEL_META).map(([key, meta]) => {
              const fv  = models[key]
              const up  = fv && ratioResult?.price ? ((fv - ratios.price) / ratios.price) * 100 : null
              const isNA = modelMeta?.notApplicable?.includes(key)
              const isCaution = modelMeta?.caution?.includes(key)

              return (
                <tr key={key} className={`border-b border-navy-800/50 ${isNA ? 'opacity-30' : ''}`}>
                  <td className="py-2 text-slate-300 text-xs">
                    {isNA ? <span className="text-slate-600 line-through">{meta.name}</span>
                     : isCaution ? <span>{meta.name} <span className="text-neutral text-xs">⚠️</span></span>
                     : meta.name}
                  </td>
                  <td className="py-2 text-right font-mono text-white text-xs">
                    {fv ? cur + fv.toFixed(2) : isNA ? 'N/A' : '—'}
                  </td>
                  <td className={`py-2 text-right font-mono text-xs ${up == null ? 'text-slate-500' : up >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {up != null ? fmtPct(up) : '—'}
                  </td>
                  <td className="py-2 pl-3">
                    {up != null && (
                      <ProgressBar
                        value={Math.abs(up)}
                        max={maxUpside}
                        color={up >= 0 ? 'bg-bull' : 'bg-bear'}
                      />
                    )}
                  </td>
                  <td className="py-2 text-right text-slate-500 text-xs">{meta.weight}</td>
                </tr>
              )
            })}
            {/* Consensus row */}
            <tr className="bg-navy-800/30 border-t border-navy-700">
              <td className="py-2.5 text-white font-semibold text-sm">Consensus</td>
              <td className="py-2.5 text-right font-mono font-bold text-white">
                {fairValue ? cur + fairValue.toFixed(2) : '—'}
              </td>
              <td className={`py-2.5 text-right font-mono font-bold text-sm ${(upside || 0) >= 0 ? 'text-bull' : 'text-bear'}`}>
                {upside != null ? fmtPct(upside) : '—'}
              </td>
              <td className="py-2.5 pl-3">
                {upside != null && (
                  <ProgressBar value={Math.abs(upside)} max={maxUpside} color={upside >= 0 ? 'bg-bull' : 'bg-bear'} />
                )}
              </td>
              <td className="py-2.5 text-right text-slate-400 text-xs">All</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Reverse DCF */}
      {impliedGrowth != null && (
        <div className="card-sm">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Reverse DCF</div>
          <p className="text-sm text-slate-300">
            At CMP <span className="text-white font-mono">{cur}{ratioResult?.price?.toFixed(2)}</span>, the market prices in FCF growth of{' '}
            <span className="text-accent font-semibold">{impliedGrowth.toFixed(1)}%/yr</span> over 10 years.
            {impliedGrowth > 30 && <span className="text-bear"> (Very high expectation)</span>}
            {impliedGrowth < 0  && <span className="text-bull"> (Market expects contraction)</span>}
          </p>
        </div>
      )}

      {/* Assumption sliders toggle */}
      <div>
        <button onClick={() => setShowSliders(!showSliders)}
          className="text-xs text-accent hover:text-accent-light flex items-center gap-1">
          {showSliders ? '▲' : '▼'} {showSliders ? 'Hide' : 'Edit'} Assumptions ✎
        </button>
        {showSliders && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { key: 'wacc',       label: 'WACC',             min: 5, max: 20, step: 0.5, cur: (assumptions.wacc ?? 0.10)*100,   fmt: v => v.toFixed(1)+'%',   toVal: v => v/100 },
              { key: 'termGrowth', label: 'Terminal Growth',  min: 1, max: 6,  step: 0.5, cur: (assumptions.termGrowth ?? 0.03)*100, fmt: v => v.toFixed(1)+'%', toVal: v => v/100 },
              { key: 'growthRate', label: 'FCF Growth',       min:-5, max: 40, step: 1,   cur: (assumptions.growthRate ?? 0.08)*100, fmt: v => v.toFixed(0)+'%', toVal: v => v/100 },
              { key: 'sectorPe',   label: 'Sector P/E',       min: 5, max: 60, step: 1,   cur: assumptions.sectorPe ?? 20,       fmt: v => v.toFixed(0)+'×',   toVal: v => v },
              { key: 'sectorEvEb', label: 'Sector EV/EBITDA', min: 4, max: 30, step: 0.5, cur: assumptions.sectorEvEb ?? 12,     fmt: v => v.toFixed(1)+'×',   toVal: v => v }
            ].map(s => (
              <div key={s.key}>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>{s.label}</span>
                  <span className="text-white font-mono">{s.fmt(s.cur)}</span>
                </div>
                <input type="range" min={s.min} max={s.max} step={s.step} value={s.cur}
                  onChange={e => update(s.key, s.toVal(parseFloat(e.target.value)))}
                  className="w-full accent-accent" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Key ratios */}
      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Key Ratios</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'P/E',      value: ratios?.pe?.value        != null ? `${ratios.pe.toFixed(1)}×`        : '—' },
            { label: 'P/B',      value: ratios?.pb?.value        != null ? `${ratios.pb.toFixed(1)}×`        : '—' },
            { label: 'EV/EBITDA',value: ratios?.evEbitda?.value  != null ? `${ratios.evEbitda.toFixed(1)}×`  : '—' },
            { label: 'P/S',      value: ratios?.ps?.value        != null ? `${ratios.ps.toFixed(1)}×`        : '—' },
            { label: 'Graham',   value: ratioResult?.grahamNumber ? `${cur}${ratios.grahamNumber.toFixed(0)}` : '—' },
            { label: 'FCF Yield',value: ratios?.fcfYield?.value  != null ? fmtPctPlain(ratios.fcfYield)      : '—' },
            { label: '52W High', value: ratios?.high52?.value    != null ? `${cur}${ratios.high52.toFixed(0)}` : '—' },
            { label: '52W Low',  value: ratios?.low52?.value     != null ? `${cur}${ratios.low52.toFixed(0)}` : '—' }
          ].map(r => (
            <div key={r.label} className="card-sm">
              <div className="text-xs text-slate-400">{r.label}</div>
              <div className="font-mono text-white text-sm font-semibold">{r.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
