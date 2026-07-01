import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPct, fmtPctPlain } from '../../utils/format.js'
import DCFScenarioPanel from './DCFScenarioPanel.jsx'

// Dot bar: 5 dots, filled based on upside magnitude
// Green dots = upside, red dots = downside
function DotBar({ upside, max = 40 }) {
  if (upside == null) return <span className="text-slate-600 text-xs">—</span>
  const filled = Math.round(Math.min(Math.abs(upside) / max * 5, 5))
  const isUp   = upside >= 0
  const col    = isUp ? 'text-bull' : 'text-bear'
  const dots   = Array.from({ length: 5 }, (_, i) =>
    <span key={i} className={i < filled ? col : 'text-navy-700'}>●</span>
  )
  return <span className="font-mono tracking-tight text-sm">{dots}</span>
}

const MODEL_DISPLAY = {
  dcf:          { name: 'DCF (10yr)',        weight: '●●●' },
  pe:           { name: 'P/E Based',         weight: '●●○' },
  evEbitda:     { name: 'EV/EBITDA',         weight: '●●○' },
  pb:           { name: 'P/B Based',         weight: '●○○' },
  ps:           { name: 'P/S Based',         weight: '●○○' },
  graham:       { name: 'Graham Number',     weight: '●○○' },
  evGrossProfit:{ name: 'EV/Op.Profit',      weight: '●○○' },
}

export default function ValuationPanel({ open, onClose }) {
  const { state, recalc } = useApp()
  const { valuation, ratioResult, data } = state
  const [showSliders, setShowSliders] = useState(false)
  const [localAssumptions, setLocalAssumptions] = useState({})

  if (!open || !valuation) return null

  const cur      = data?.currency === 'INR' ? '₹' : '$'
  const price    = ratioResult?.price
  const { models, modelMeta, fairValue, rangeLow, rangeHigh, upside,
          signal, impliedGrowth, assumptions } = valuation

  const DEFAULT_ASSUMPTIONS = { wacc: 0.10, termGrowth: 0.03, growthRate: 0.08, sectorPe: 20, sectorEvEb: 12 }

  const updateAssumption = (key, value) => {
    const next = { ...localAssumptions, [key]: value }
    setLocalAssumptions(next)
    recalc(next, {})
  }

  const restoreDefaults = () => {
    setLocalAssumptions({})
    recalc(DEFAULT_ASSUMPTIONS, {})
  }

  const signalColor = signal === 'UNDERVALUED' ? 'text-bull'
    : signal === 'OVERVALUED' ? 'text-bear' : 'text-neutral'

  // All model keys in display order
  const allModels = Object.keys(MODEL_DISPLAY)

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">⚖️ Valuation Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
      </div>

      {/* Sector/stage note */}
      {modelMeta?.note && (
        <div className="text-xs text-slate-400 bg-navy-800/60 px-3 py-2 rounded-lg">
          ℹ️ {modelMeta.note}
        </div>
      )}

      {/* Model table — matches the spec exactly */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs text-slate-400">
              <th className="text-left py-2 font-medium">Model</th>
              <th className="text-right py-2 font-medium">Fair Value</th>
              <th className="text-right py-2 font-medium">vs CMP</th>
              <th className="py-2 pl-2 font-medium"></th>
              <th className="text-right py-2 font-medium">Wt</th>
            </tr>
          </thead>
          <tbody>
            {allModels.map(key => {
              const meta   = MODEL_DISPLAY[key]
              const result = models[key]
              const fv     = result?.value
              const note   = result?.note
              const up     = fv != null && price ? ((fv - price) / price) * 100 : null
              const isNA   = modelMeta?.notApplicable?.includes(key)
              const isCaution = modelMeta?.caution?.includes(key)

              return (
                <tr key={key}
                  className={`border-b border-navy-800/40 ${isNA ? 'opacity-25' : ''}`}
                  title={note || ''}>
                  <td className="py-2 text-xs text-slate-300">
                    {isNA
                      ? <span className="line-through text-slate-600">{meta.name}</span>
                      : isCaution
                      ? <span>{key === 'dcf' ? `DCF (${assumptions?.projYears ?? 10}yr)` : meta.name} <span className="text-neutral text-xs">⚠</span></span>
                      : (key === 'dcf' ? `DCF (${assumptions?.projYears ?? 10}yr)` : meta.name)}
                  </td>
                  <td className="py-2 text-right font-mono text-white text-xs">
                    {fv != null ? cur + fv.toFixed(0) : isNA ? 'N/A' : '—'}
                  </td>
                  <td className={`py-2 text-right font-mono text-xs font-semibold
                    ${up == null ? 'text-slate-500' : up >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {up != null ? fmtPct(up) : '—'}
                  </td>
                  <td className="py-2 pl-2">
                    <DotBar upside={up} />
                  </td>
                  <td className="py-2 text-right text-slate-600 text-xs font-mono">
                    {meta.weight}
                  </td>
                </tr>
              )
            })}
            <DCFScenarioPanel />
          </tbody>
        </table>
      </div>

      {/* Consensus row */}
      <div className="flex items-center justify-between py-2 px-3 bg-navy-800/50 rounded-lg">
        <div>
          <div className="flex items-center text-xs text-slate-400">
            Range: {rangeLow && rangeHigh
              ? (rangeLow === rangeHigh
                  ? <span className="font-mono text-slate-300 ml-1">{cur}{rangeLow.toFixed(0)}</span>
                  : <span className="font-mono text-slate-300 ml-1">{cur}{rangeLow.toFixed(0)} – {cur}{rangeHigh.toFixed(0)}</span>)
              : <span className="ml-1">—</span>}
            <span className="text-slate-600 ml-1">(lowest to highest model)</span>
          </div>
          <div className="flex items-center text-xs text-slate-400 mt-1">
            <span>Fair Value: </span>
            <span className="font-mono font-bold text-white ml-1">
              {fairValue != null ? `${cur}${fairValue.toFixed(0)}` : '—'}
            </span>
            <span className="relative group ml-1 cursor-help">
              <span className="w-3.5 h-3.5 rounded-full bg-navy-700 text-slate-400 text-[10px] flex items-center justify-center hover:bg-navy-600 hover:text-white">ⓘ</span>
              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1.5 rounded bg-navy-700
                               text-xs text-slate-200 whitespace-normal z-50 invisible group-hover:visible
                               border border-navy-600 shadow-lg w-64 text-left">
                Fair Value is the <strong>weighted average</strong> of all applicable models —
                not the midpoint of the range. DCF and EV/EBITDA carry more weight (3× and 2×)
                than P/B or Graham (1-1.5×) since they're more reliable for established companies.
                The upside% below is calculated from this weighted value, not from the range.
              </span>
            </span>
          </div>
        </div>
        <div className="text-right">
          <span className={`font-bold text-sm ${signalColor}`}>
            {upside != null ? `${upside >= 0 ? '+' : ''}${upside.toFixed(1)}% upside` : signal}
          </span>
        </div>
      </div>

      {/* Reverse DCF */}
      {impliedGrowth != null && (
        <div className="text-xs text-slate-400 bg-navy-800/40 px-3 py-2 rounded-lg">
          <span className="text-slate-300">Reverse DCF: </span>
          At CMP {cur}{price?.toFixed(0)}, market prices in{' '}
          <span className="text-accent font-semibold">{impliedGrowth.toFixed(1)}%/yr</span> FCF growth over 10 years.
          {impliedGrowth > 30 && <span className="text-bear ml-1">(High expectation)</span>}
          {impliedGrowth < 0  && <span className="text-bull ml-1">(Market pricing contraction)</span>}
        </div>
      )}

      {/* Edit Assumptions / Restore Defaults */}
      <div className="flex items-center gap-3">
        <button onClick={() => setShowSliders(!showSliders)}
          className="text-xs text-accent hover:text-accent-light">
          {showSliders ? '▲ Hide' : '▼ Edit Assumptions ✎'}
        </button>
        {showSliders && (
          <button onClick={restoreDefaults}
            className="text-xs text-slate-500 hover:text-slate-300">
            ↺ Restore Defaults
          </button>
        )}
      </div>

      {showSliders && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
          {[
            { key: 'wacc',       label: 'WACC',             min: 5,  max: 20, step: 0.5, pct: true,  def: DEFAULT_ASSUMPTIONS.wacc * 100 },
            { key: 'termGrowth', label: 'Terminal Growth',  min: 1,  max: 6,  step: 0.5, pct: true,  def: DEFAULT_ASSUMPTIONS.termGrowth * 100 },
            { key: 'growthRate', label: 'FCF Growth',       min: -5, max: 40, step: 1,   pct: true,  def: DEFAULT_ASSUMPTIONS.growthRate * 100 },
            { key: 'sectorPe',   label: 'Sector P/E',       min: 5,  max: 60, step: 1,   pct: false, def: DEFAULT_ASSUMPTIONS.sectorPe },
            { key: 'sectorEvEb', label: 'Sector EV/EBITDA', min: 4,  max: 30, step: 0.5, pct: false, def: DEFAULT_ASSUMPTIONS.sectorEvEb },
          ].map(s => {
            const curVal = s.pct
              ? ((localAssumptions[s.key] ?? (assumptions[s.key] ?? s.def / 100)) * 100)
              : (localAssumptions[s.key] ?? assumptions[s.key] ?? s.def)
            const display = s.pct ? curVal.toFixed(1) + '%' : curVal.toFixed(s.key === 'sectorEvEb' ? 1 : 0) + '×'
            return (
              <div key={s.key}>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>{s.label}</span>
                  <span className="text-white font-mono">{display}</span>
                </div>
                <input type="range" min={s.min} max={s.max} step={s.step} value={curVal}
                  onChange={e => updateAssumption(s.key, s.pct ? parseFloat(e.target.value) / 100 : parseFloat(e.target.value))}
                  className="w-full accent-accent" />
              </div>
            )
          })}
          {(() => {
            const ntg = localAssumptions.nearTermGrowth ?? assumptions.nearTermGrowth ?? null
            const nty = localAssumptions.nearTermYears  ?? assumptions.nearTermYears  ?? 5
            return (
              <div className="sm:col-span-2 border-t border-navy-800 pt-3 mt-1 space-y-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" checked={ntg != null}
                    onChange={e => {
                      updateAssumption('nearTermGrowth', e.target.checked ? (assumptions.growthRate ?? 0.08) : null)
                      if (e.target.checked) updateAssumption('nearTermYears', nty)
                    }} />
                  Use company guidance (near-term growth)
                </label>
                {ntg != null && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>Near-term growth</span><span>{(ntg * 100).toFixed(0)}%</span>
                      </div>
                      <input type="range" min={0} max={40} step={1} value={ntg * 100}
                        onChange={e => updateAssumption('nearTermGrowth', +e.target.value / 100)} className="w-full" />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>For</span><span>{nty} yrs</span>
                      </div>
                      <input type="range" min={1} max={7} step={1} value={nty}
                        onChange={e => updateAssumption('nearTermYears', +e.target.value)} className="w-full" />
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-slate-600">Grows at this rate for the chosen years, then fades to terminal. Affects the DCF only — not P/E, EV/EBITDA or ratios.</p>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
