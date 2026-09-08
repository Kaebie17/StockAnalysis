/**
 * PeerWeightSlider — how much App Estimate's peer cross-check pulls this
 * stock's own fitted multiple.
 *
 * targetMultiple.js (src/engine) used to trigger this automatically past a
 * hardcoded 1.5x/0.5x divergence threshold and always pull exactly halfway
 * when it did — implementation choices with no real basis, applied silently.
 * Whether a specific set of confirmed peers is actually comparable to THIS
 * company is a judgment call no formula can make: RELIANCE's own NSE
 * "Oil Gas & Consumable Fuels" peers are real, verified index-mates, but
 * they don't capture Jio/Retail, so a wholesale 50% pull toward their much
 * lower multiples isn't a correction — it's a mismatch. A simpler,
 * single-segment business might legitimately deserve a 50/50 blend.
 *
 * Defaults to 0% (pure own-history) — peers only enter App Estimate's
 * multiple once this is moved deliberately, per ticker.
 */
import React from 'react'
import { useApp } from '../../store/AppContext.jsx'

export default function PeerWeightSlider({ peerBand }) {
  const { state, setPeerWeight } = useApp()

  const effective = state.data?.peerWeight ?? 0
  const [live, setLive] = React.useState(effective)
  React.useEffect(() => { setLive(effective) }, [effective])

  // No point showing a control for a blend that has nothing real to blend
  // with — same as GrowthWindowPicker declining when there isn't enough
  // history to build a window from.
  if (!(peerBand?.median > 0)) return null

  const commit = (v) => setPeerWeight(v)

  return (
    <div className="mt-2 pt-2 border-t border-navy-700/60">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] text-slate-500">
          Peer weight
        </span>
        <span className="text-[11px] font-mono text-accent">
          {Math.round(live * 100)}%
          {live === 0 && <span className="text-slate-600"> · pure own-history</span>}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={live}
        onChange={e => setLive(+e.target.value)}
        onMouseUp={e => commit(+e.target.value)}
        onTouchEnd={e => commit(+e.target.value)}
        className="w-full accent-accent h-1.5 rounded-full appearance-none bg-navy-700 cursor-pointer"
      />

      <div className="flex justify-between text-[10px] text-slate-600 mt-1 font-mono">
        <span>0% own-history</span>
        <span>100% peers</span>
      </div>

      <p className="text-[10px] text-slate-600 mt-1">
        How much confirmed peers' {peerBand.median}× median pulls this stock's own fitted multiple —
        a judgment call about whether those specific peers are actually comparable, not something
        the app infers on its own.
      </p>
    </div>
  )
}
