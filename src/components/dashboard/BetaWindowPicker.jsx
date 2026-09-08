/**
 * BetaWindowPicker — choose the regression window this app's own beta
 * (src/engine/beta.js) is computed over, as a labeled scale.
 *
 * Modeled directly on GrowthWindowPicker.jsx. Where that control exists
 * because the "right" CAGR window is genuinely a judgment call, this one
 * exists because a SINGLE fixed window (what every vendor beta figure
 * bakes in silently) can be dominated by one unusual multi-month episode
 * sitting inside it — real, checked case: RELIANCE's 2020 Jio-stake-sale
 * rally pulled Yahoo's 5yr beta to ~0.18 while shorter windows read near 1.
 * Letting the window move and showing r²/sample size alongside makes that
 * visible instead of hidden inside one vendor's number.
 */
import React from 'react'
import { useApp } from '../../store/AppContext.jsx'

export default function BetaWindowPicker() {
  const { state, setBetaWindowYears } = useApp()
  const cb = state.computedBeta

  if (!state.data?.priceHistory?.length) return null

  const minWin = 1
  const maxWin = 10
  const years = state.betaWindowYears ?? 5

  const [live, setLive] = React.useState(years)
  React.useEffect(() => { setLive(years) }, [years])

  const commit = (n) => setBetaWindowYears(n)

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] text-slate-500">
          Beta window (this app's own regression)
        </span>
        <span className="text-[11px] font-mono text-accent">
          {live} {live === 1 ? 'year' : 'years'}
        </span>
      </div>

      <input
        type="range"
        min={minWin}
        max={maxWin}
        step={1}
        value={live}
        onChange={e => setLive(+e.target.value)}
        onMouseUp={e => commit(+e.target.value)}
        onTouchEnd={e => commit(+e.target.value)}
        className="w-full accent-accent h-1.5 rounded-full appearance-none bg-navy-700 cursor-pointer"
      />

      <div className="flex justify-between text-[10px] text-slate-600 mt-1 font-mono">
        <span>{minWin}y</span>
        <span>{maxWin}y</span>
      </div>

      <p className="text-[10px] text-slate-600 mt-1">
        {cb == null
          ? 'Computing…'
          : cb.beta != null
          ? `${cb.label} — this beta now drives DCF's WACC, Justified Multiples and Market Expectation.`
          : `Regression unavailable: ${cb.insufficientReason} Falling back to Yahoo's reported beta.`}
      </p>
    </div>
  )
}
