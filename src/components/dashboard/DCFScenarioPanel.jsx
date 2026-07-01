import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { scenarioAssumptions } from '../../engine/valuation.js'

/**
 * Bear / Base / Bull scenario toggle + a growth × WACC sensitivity table for the
 * DCF. Scenarios ride the SAME recalc(assumptions) path the sliders use, so there
 * is one source of truth — clicking a scenario just moves growth / WACC / terminal
 * to sensible presets (anchored on the professional defaults). The sensitivity
 * grid re-centres on whatever assumptions are currently applied.
 */
export default function DCFScenarioPanel({ compact = false }) {
  const { state, recalc } = useApp()
  const { valuation, ratioResult, data } = state || {}
  const [active, setActive] = useState('base')

  if (!valuation) return null
  const { scenarios, sensitivity, defaults } = valuation
  if (!scenarios && !sensitivity) return null

  const cur   = data?.currency === 'INR' ? '₹' : '$'
  const price = ratioResult?.price
  const money = v => (v == null ? '—' : cur + Math.round(v).toLocaleString('en-IN'))

  const colorFor = v => {
    if (v == null || !price) return 'text-slate-400'
    if (v > price * 1.15) return 'text-bull'
    if (v < price * 0.85) return 'text-bear'
    return 'text-slate-300'
  }

  const applyScenario = (key) => {
    setActive(key)
    if (defaults) recalc(scenarioAssumptions(key, defaults), {})
  }

  const ScenarioButtons = (
    <div className="grid grid-cols-3 gap-2">
      {['bear', 'base', 'bull'].map(k => {
        const s = scenarios?.[k]
        if (!s) return null
        return (
          <button
            key={k}
            onClick={() => applyScenario(k)}
            className={`rounded-lg p-3 text-left border transition ${
              active === k ? 'border-accent bg-navy-800' : 'border-navy-700 hover:border-navy-600'
            }`}>
            <div className="text-xs text-slate-400">{s.label}</div>
            <div className={`text-lg font-semibold ${colorFor(s.fairValue)}`}>{money(s.fairValue)}</div>
            <div className="text-[10px] text-slate-500 mt-1">
              g {(s.assumptions.growthRate * 100).toFixed(0)}% · WACC {(s.assumptions.wacc * 100).toFixed(0)}% · term {(s.assumptions.termGrowth * 100).toFixed(0)}%
            </div>
            <div className="text-[10px] text-slate-500">DCF {money(s.dcf)}</div>
          </button>
        )
      })}
    </div>
  )

  // Compact = dashboard preset strip only (buttons + one-line hint).
  if (compact) {
    if (!scenarios) return null
    return (
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-slate-400">Valuation scenario</div>
        {ScenarioButtons}
      </div>
    )
  }

  // Full = strip + sensitivity table (valuation tab).
  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold text-white">📉 DCF Scenarios &amp; Sensitivity</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Growth anchored on the recent 5-yr median and faded toward the terminal rate.
          Bear / Base / Bull shift growth, discount rate and terminal growth together.
        </p>
      </div>

      {scenarios && ScenarioButtons}

      {price != null && (
        <p className="text-xs text-slate-500">
          Current price {money(price)} — green = ≥15% upside, red = ≥15% downside vs the blended fair value.
        </p>
      )}

      {/* Sensitivity table */}
      {sensitivity && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-300">DCF fair value — growth (rows) × WACC (columns)</div>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead>
                <tr>
                  <th className="text-left py-1 pr-2 text-slate-500">g \ WACC</th>
                  {sensitivity.waccAxis.map((w, i) => (
                    <th key={i} className="text-right py-1 px-2 text-slate-500">{(w * 100).toFixed(0)}%</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sensitivity.grid.map((row, ri) => (
                  <tr key={ri} className="border-t border-navy-800/50">
                    <td className="py-1 pr-2 text-slate-400">{(sensitivity.growthAxis[ri] * 100).toFixed(0)}%</td>
                    {row.map((v, ci) => {
                      const isCenter = ri === 2 && ci === 2   // current assumptions
                      return (
                        <td
                          key={ci}
                          className={`text-right py-1 px-2 font-mono ${colorFor(v)} ${isCenter ? 'bg-navy-800 rounded font-semibold' : ''}`}>
                          {v == null ? '—' : Math.round(v).toLocaleString('en-IN')}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-slate-600">
            Centre cell = current assumptions. Colour = upside / downside vs current price.
          </p>
        </div>
      )}
    </div>
  )
}
