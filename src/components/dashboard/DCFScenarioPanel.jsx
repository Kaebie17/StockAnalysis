import React from 'react'
import { useApp } from '../../store/AppContext.jsx'

/**
 * DCF sensitivity table — growth × WACC, both axes swept around the currently
 * applied assumptions.
 *
 * This used to also offer a Bear/Base/Bull scenario toggle, shifting growth,
 * WACC and terminal growth by fixed presets. Removed: the growth shift had a
 * real per-company measurement behind it when there was enough history
 * (growthScenarioSpread), but the WACC and terminal-growth shifts never did
 * — flat, undefended constants applied to every company alike, with no more
 * basis than the Justified Multiples range this session already removed for
 * the same reason. Worse, on a low-beta stock those shifts could push the
 * WACC right next to the terminal-growth floor, where the Gordon-growth
 * denominator goes toward zero and the "Bull" case exploded to an absolute
 * fair value many multiples of the real price — a real, absurd example
 * (RELIANCE) is what surfaced this. Rather than invent a principled basis
 * for the WACC/terminal shift or ship a disclosed-as-arbitrary convention,
 * the feature is gone. The sensitivity grid below stays: it doesn't assert
 * any cell is "the bear case" or "the bull case," it just shows how the same
 * DCF formula moves across a range of inputs the user can see are inputs.
 */
export default function DCFScenarioPanel() {
  const { state } = useApp()
  const { valuation, ratioResult, data } = state || {}

  if (!valuation) return null
  const { sensitivity } = valuation
  if (!sensitivity) return null

  const cur   = data?.currency === 'INR' ? '₹' : '$'
  const price = ratioResult?.price
  const money = v => (v == null ? '—' : cur + Math.round(v).toLocaleString('en-IN'))

  const colorFor = v => {
    if (v == null || !price) return 'text-slate-400'
    if (v > price * 1.15) return 'text-bull'
    if (v < price * 0.85) return 'text-bear'
    return 'text-slate-300'
  }

  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold text-white">📉 DCF Sensitivity</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Growth anchored on the recent 5-yr median and faded toward the terminal rate.
        </p>
      </div>

      {price != null && (
        <p className="text-xs text-slate-500">
          Current price {money(price)} — green = ≥15% upside, red = ≥15% downside vs the blended fair value.
        </p>
      )}

      <p className="text-[10px] text-slate-600">
        {sensitivity.growthAxisMeasured
          ? "Growth steps sized from this stock's own historical YoY revenue swings."
          : 'Growth steps: a flat ±4% convention — too little revenue history to measure this stock\'s own volatility.'}
        {' '}WACC steps (±50–100bps) are a fixed convention, not a measurement — there\'s no equivalent
        per-company data (beta is a reported figure, not a regression this app runs itself) to derive one from.
      </p>

      {/* Sensitivity table */}
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
    </div>
  )
}