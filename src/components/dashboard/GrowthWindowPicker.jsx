/**
 * GrowthWindowPicker — choose the revenue-CAGR window as a labeled scale.
 *
 * Replaces the old year-button row + inline rate (which showed NaN because it
 * read the new numeric revCagr as if it were the old {growth} object). The
 * resolved % already shows on the Rev CAGR card, so this control shows only the
 * window length and drives the recompute. Range is bounded by the history the
 * stock actually has.
 */
import React from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { useEstimate } from '../../store/useEstimate.js'

export default function GrowthWindowPicker() {
  const { state, setGrowthWindowYears } = useApp()
  const { growthWindow, setGrowthWindow, estimate } = useEstimate(state)

  const years = (state.data?.incomeHistory || [])
    .map(r => String(r?.year ?? '').match(/(?:19|20)\d{2}/)?.[0])
    .filter(Boolean).length
  if (years < 3) return null

  const maxWin = years - 1                 // full span
  const minWin = 3
  if (maxWin < minWin) return null

  // Effective window shown on the scale: the user's pick, else the resolved
  // window the engine used, else the 5y default (capped by history).
  const effective = growthWindow
    ?? state.ratioResult?.ratios?.revCagrWindowYears
    ?? Math.min(5, maxWin)

  // Commit on release, not on every drag tick, to avoid a recompute per pixel.
  const commit = async (n) => {
    const v = n >= maxWin ? maxWin : n
    setGrowthWindowYears(v)
    await setGrowthWindow(v)
  }

  // A revision/guidance outranks any window, so the control is inert until cleared.
  const blockedBy = (estimate?.growthSource === 'revision' || estimate?.growthSource === 'guidance')
    ? estimate.growthLabel : null

  const [live, setLive] = React.useState(effective)
  React.useEffect(() => { setLive(effective) }, [effective])

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] text-slate-500">
          Revenue CAGR window
        </span>
        <span className="text-[11px] font-mono text-accent">
          {live} {live === 1 ? 'year' : 'years'}
          {live >= maxWin && <span className="text-slate-600"> · full history</span>}
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

      {blockedBy ? (
        <p className="text-[10px] text-slate-600 mt-1">
          Drives the CAGR, fundamentals score, stage, DCF and market expectation.
          (Estimate 2 is currently using {blockedBy} instead of this window.)
        </p>
      ) : (
        <p className="text-[10px] text-slate-600 mt-1">
          Changes both estimates, the health bars and the exit levels.
        </p>
      )}
    </div>
  )
}
