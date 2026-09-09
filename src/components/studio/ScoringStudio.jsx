import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import Modal from '../Modal.jsx'

/**
 * Guidance input (formerly Scoring Studio).
 * Management guidance is a forward VIEW, so it lives here — a single global input
 * that feeds the DCF near-term window AND the expectations comparison (guidance vs
 * market-implied vs recent). Session-only: nothing is persisted to disk.
 *
 * Only revenue guidance maps cleanly to the maths (growth drives the DCF and the
 * comparison), so that's the structured field. Everything else management says —
 * margins, capex, new ventures, order book — is captured as a free-text NOTE you
 * read and fold in yourself, rather than a number the app applies silently.
 */
export default function ScoringStudio({ open, onClose }) {
  const { state, recalc } = useApp()
  const r = state.ratioResult

  const [mode, setMode]       = useState('growth')      // 'growth' | 'target'
  const [growthPct, setGrowthPct] = useState('')        // e.g. "20"
  const [targetRev, setTargetRev] = useState('')        // absolute target in display unit (Cr / M)
  const [horizon, setHorizon] = useState('multi')       // 'next' | 'multi' | 'unspecified'
  const [years, setYears]     = useState(1)
  const [notes, setNotes]     = useState('')

  if (!open) return null

  const cur  = state.data?.currency === 'INR' ? '₹' : '$'
  const div  = state.data?.currency === 'INR' ? 1e7 : 1e6
  const unit = state.data?.currency === 'INR' ? 'Cr' : 'M'

  // Effective explicit-window length. Unspecified information deserves the
  // SHORTEST assumed persistence, not the longest — a vaguer claim is weaker
  // evidence, so it earns less runway before fading to terminal, not more.
  // "Over N years" remains the only way a longer window is ever used, and
  // only when the user explicitly says so.
  const effYears = horizon === 'next' ? 1 : (horizon === 'unspecified' ? 1 : Math.max(1, +years || 1))

  // Resolve guidance to a single growth rate (decimal).
  const currentRev = r?.revenue
  let guidedGrowth = null
  if (mode === 'growth' && growthPct !== '' && !isNaN(+growthPct)) {
    guidedGrowth = +growthPct / 100
  } else if (mode === 'target' && targetRev !== '' && !isNaN(+targetRev) && currentRev > 0) {
    const targetAbs = +targetRev * div
    if (targetAbs > 0) guidedGrowth = Math.pow(targetAbs / currentRev, 1 / effYears) - 1
  }

  // Push guidance into the engine (merges — leaves other assumptions untouched).
  const commit = (g, yrs) => {
    if (!state.data) return
    recalc({ nearTermGrowth: g, nearTermYears: g != null ? yrs : 0 }, {})
  }
  const apply = (over = {}) => {
    const m  = over.mode      ?? mode
    const gp = over.growthPct ?? growthPct
    const tr = over.targetRev ?? targetRev
    const h  = over.horizon   ?? horizon
    const y  = over.years     ?? years
    const yy = h === 'next' ? 1 : (h === 'unspecified' ? 1 : Math.max(1, +y || 1))
    let g = null
    if (m === 'growth' && gp !== '' && !isNaN(+gp)) g = +gp / 100
    else if (m === 'target' && tr !== '' && !isNaN(+tr) && currentRev > 0) {
      const ta = +tr * div; if (ta > 0) g = Math.pow(ta / currentRev, 1 / yy) - 1
    }
    commit(g, yy)
  }
  const clearGuidance = () => {
    setGrowthPct(''); setTargetRev('')
    commit(null, 0)
  }

  // Reference: what the market is pricing, for context while typing.
  const marketImplied = state.valuation?.impliedGrowth
    ?? state.marketExpectation?.variants?.sales?.impliedGrowth
    ?? state.marketExpectation?.variants?.earnings?.impliedGrowth
  const recentGrowth = r?.ratios?.revCagr?.value

  const effPct = guidedGrowth != null ? (guidedGrowth * 100) : null

  return (
    <Modal open={open} onClose={onClose} title="Guidance" icon="🧭">
          <p className="text-xs text-slate-400">
            Enter management's forward guidance. Revenue guidance drives the DCF near-term
            window and is compared against what the market is pricing. Session only.
          </p>

          {/* Reference line */}
          {(marketImplied != null || recentGrowth != null) && (
            <div className="text-xs bg-navy-800/50 rounded-lg px-3 py-2 text-slate-400 space-x-3">
              {marketImplied != null && <span>Market pricing ≈ <span className="text-accent font-mono">{marketImplied.toFixed(0)}%</span></span>}
              {recentGrowth != null && <span>Recent ≈ <span className="text-slate-300 font-mono">{recentGrowth.toFixed(0)}%</span></span>}
            </div>
          )}

          {/* Mode toggle */}
          <div className="flex gap-2">
            {[['growth', 'Growth %'], ['target', `Revenue target (${unit})`]].map(([m, lbl]) => (
              <button key={m}
                onClick={() => { setMode(m); apply({ mode: m }) }}
                className={`flex-1 py-1.5 rounded-lg text-xs border ${mode === m ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400'}`}>
                {lbl}
              </button>
            ))}
          </div>

          {/* Value input */}
          {mode === 'growth' ? (
            <div>
              <label className="text-xs text-slate-400">Guided annual revenue growth</label>
              <div className="flex items-center gap-2 mt-1">
                <input type="number" inputMode="decimal" placeholder="e.g. 20"
                  value={growthPct}
                  onChange={e => { setGrowthPct(e.target.value); apply({ growthPct: e.target.value }) }}
                  className="input-field text-sm w-28" />
                <span className="text-slate-400 text-sm">% / yr</span>
              </div>
            </div>
          ) : (
            <div>
              <label className="text-xs text-slate-400">Revenue target ({cur}, in {unit})</label>
              <div className="flex items-center gap-2 mt-1">
                <input type="number" inputMode="decimal" placeholder={`e.g. 50000`}
                  value={targetRev}
                  onChange={e => { setTargetRev(e.target.value); apply({ targetRev: e.target.value }) }}
                  className="input-field text-sm w-36" />
                <span className="text-slate-500 text-xs">{unit}</span>
              </div>
              {currentRev > 0 && (
                <p className="text-[10px] text-slate-600 mt-1">
                  Current revenue {cur}{Math.round(currentRev / div).toLocaleString('en-IN')} {unit} — target converts to an implied growth over the horizon.
                </p>
              )}
            </div>
          )}

          {/* Horizon */}
          <div>
            <label className="text-xs text-slate-400">Horizon</label>
            <div className="flex gap-2 mt-1">
              {[['next', 'Next year'], ['multi', 'Over N years'], ['unspecified', 'Unspecified']].map(([h, lbl]) => (
                <button key={h}
                  onClick={() => { setHorizon(h); apply({ horizon: h }) }}
                  className={`flex-1 py-1.5 rounded-lg text-xs border ${horizon === h ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400'}`}>
                  {lbl}
                </button>
              ))}
            </div>
            {horizon === 'multi' && (
              <div className="flex items-center gap-2 mt-2">
                <input type="range" min={1} max={7} step={1} value={years}
                  onChange={e => { setYears(+e.target.value); apply({ years: +e.target.value }) }}
                  className="flex-1 accent-accent" />
                <span className="text-xs text-white font-mono w-10 text-right">{years} yr</span>
              </div>
            )}
            {horizon === 'unspecified' && (
              <p className="text-[10px] text-neutral mt-1">⚠ No period given — assuming a 1-year window (fades to terminal after). Pick "Over N years" if you have a longer view.</p>
            )}
          </div>

          {/* Resolved effect */}
          {effPct != null && (
            <div className="text-xs bg-navy-800/50 rounded-lg px-3 py-2 text-slate-300">
              Applying <span className="text-accent font-mono">{effPct.toFixed(1)}%</span> growth for{' '}
              <span className="font-mono">{effYears}</span> yr{effYears > 1 ? 's' : ''}, then fading to terminal.
              {marketImplied != null && (
                <span className="text-slate-500">
                  {' '}({(effPct - marketImplied) >= 0 ? '+' : ''}{(effPct - marketImplied).toFixed(0)} pts vs market)
                </span>
              )}
            </div>
          )}

          <button onClick={clearGuidance} className="text-xs text-slate-500 hover:text-slate-300">↺ Clear guidance</button>

          {/* Other guidance — captured, not auto-applied */}
          <div className="border-t border-navy-800 pt-3">
            <label className="text-xs text-slate-400">Other guidance (margins, capex, ventures, order book…)</label>
            <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Paste or note anything else management said. For your reference — not auto-applied to the maths."
              className="input-field text-xs w-full mt-1 resize-y" />
            <p className="text-[10px] text-slate-600 mt-1">
              Only revenue growth/target flows into the model. Margin, capex and cash-flow guidance can be wired in later.
            </p>
          </div>
    </Modal>
  )
}
