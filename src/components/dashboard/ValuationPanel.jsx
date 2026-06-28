import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPrice, fmtPct, fmtPctPlain, fmtMultiple } from '../../utils/format.js'

export default function ValuationPanel({ open, onClose }) {
  const { state, recalc } = useApp()
  const { valuation, ratios, data } = state

  const [assumptions, setAssumptions] = useState(valuation?.assumptions || {})

  if (!open || !valuation) return null

  const cur = data?.currency || 'USD'
  const sym = cur === 'INR' ? '₹' : '$'

  const update = (key, value) => {
    const next = { ...assumptions, [key]: value }
    setAssumptions(next)
    recalc(next, {})
  }

  const modelRows = [
    { name: 'DCF (10yr)',        key: 'dcf',          weight: 'High' },
    { name: 'P/E Based',         key: 'pe',           weight: 'Medium' },
    { name: 'EV/EBITDA',         key: 'evEbitda',     weight: 'Medium' },
    { name: 'Price / Book',      key: 'pb',           weight: 'Low' },
    { name: 'Price / Sales',     key: 'ps',           weight: 'Low' },
    { name: 'Graham Number',     key: 'graham',       weight: 'Low' },
    { name: 'EV / Gross Profit', key: 'evGrossProfit',weight: 'Low' }
  ]

  return (
    <div className="card space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Valuation Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg">✕</button>
      </div>

      {/* Model Table */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Model Estimates</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700">
                <th className="text-left py-2 text-slate-400 font-medium">Model</th>
                <th className="text-right py-2 text-slate-400 font-medium">Fair Value</th>
                <th className="text-right py-2 text-slate-400 font-medium">Upside</th>
                <th className="text-right py-2 text-slate-400 font-medium">Weight</th>
              </tr>
            </thead>
            <tbody>
              {modelRows.map(row => {
                const fv = valuation.models[row.key]
                const up = fv && ratios?.price ? ((fv - ratios.price) / ratios.price) * 100 : null
                return (
                  <tr key={row.key} className="border-b border-navy-800/50">
                    <td className="py-2 text-slate-300">{row.name}</td>
                    <td className="py-2 text-right font-mono text-white">
                      {fv ? sym + fv.toFixed(2) : '—'}
                    </td>
                    <td className={`py-2 text-right font-mono ${up == null ? 'text-slate-500' : up >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {up != null ? fmtPct(up) : '—'}
                    </td>
                    <td className="py-2 text-right text-slate-500 text-xs">{row.weight}</td>
                  </tr>
                )
              })}
              {/* Consensus */}
              <tr className="bg-navy-800/40">
                <td className="py-2 text-white font-semibold">Weighted Consensus</td>
                <td className="py-2 text-right font-mono font-bold text-white">
                  {valuation.fairValue ? sym + valuation.fairValue.toFixed(2) : '—'}
                </td>
                <td className={`py-2 text-right font-mono font-bold ${(valuation.upside || 0) >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {valuation.upside != null ? fmtPct(valuation.upside) : '—'}
                </td>
                <td className="py-2 text-right text-slate-400 text-xs">All</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Reverse DCF */}
      {valuation.impliedGrowth != null && (
        <div className="card-sm">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Reverse DCF</div>
          <p className="text-sm text-slate-300">
            At the current price of <span className="text-white font-mono">{sym}{ratios?.price?.toFixed(2)}</span>,
            the market is pricing in a FCF growth rate of{' '}
            <span className="text-accent font-semibold font-mono">{valuation.impliedGrowth.toFixed(1)}%/yr</span> over the next 10 years.
          </p>
        </div>
      )}

      {/* Assumption Sliders */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Adjust Assumptions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Slider
            label="WACC"
            value={(assumptions.wacc ?? 0.10) * 100}
            min={5} max={20} step={0.5}
            display={v => v.toFixed(1) + '%'}
            onChange={v => update('wacc', v / 100)}
          />
          <Slider
            label="Terminal Growth"
            value={(assumptions.termGrowth ?? 0.03) * 100}
            min={1} max={6} step={0.5}
            display={v => v.toFixed(1) + '%'}
            onChange={v => update('termGrowth', v / 100)}
          />
          <Slider
            label="FCF Growth Rate"
            value={(assumptions.growthRate ?? 0.10) * 100}
            min={-10} max={40} step={1}
            display={v => v.toFixed(0) + '%'}
            onChange={v => update('growthRate', v / 100)}
          />
          <Slider
            label="Sector P/E"
            value={assumptions.sectorPe ?? 20}
            min={5} max={50} step={1}
            display={v => v.toFixed(0) + '×'}
            onChange={v => update('sectorPe', v)}
          />
        </div>
      </div>

      {/* Key valuation ratios */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Key Ratios</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'P/E', value: fmtMultiple(ratios?.pe) },
            { label: 'P/B', value: fmtMultiple(ratios?.pb) },
            { label: 'EV/EBITDA', value: fmtMultiple(ratios?.evEbitda) },
            { label: 'P/S', value: fmtMultiple(ratios?.ps) },
            { label: 'Graham', value: ratios?.grahamNumber ? sym + ratios.grahamNumber.toFixed(2) : '—' },
            { label: 'FCF Yield', value: fmtPctPlain(ratios?.fcfYield) },
            { label: 'EV/Rev', value: fmtMultiple(ratios?.evRevenue) },
            { label: 'Market Cap', value: ratios?.marketCap ? formatLarge(ratios.marketCap, cur) : '—' }
          ].map(r => (
            <div key={r.label} className="card-sm">
              <div className="text-xs text-slate-400">{r.label}</div>
              <div className="font-mono text-white font-semibold">{r.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Slider({ label, value, min, max, step, display, onChange }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{label}</span>
        <span className="text-white font-mono">{display(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  )
}

function formatLarge(v, currency) {
  const sym = currency === 'INR' ? '₹' : '$'
  if (v >= 1e12) return sym + (v / 1e12).toFixed(1) + 'T'
  if (v >= 1e9)  return sym + (v / 1e9).toFixed(1)  + 'B'
  if (v >= 1e7)  return sym + (v / 1e7).toFixed(1)  + 'Cr'
  if (v >= 1e6)  return sym + (v / 1e6).toFixed(1)  + 'M'
  return sym + v.toFixed(0)
}
