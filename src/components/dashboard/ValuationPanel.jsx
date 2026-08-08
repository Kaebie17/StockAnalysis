import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPct, fmtPctPlain } from '../../utils/format.js'
import DCFScenarioPanel from './DCFScenarioPanel.jsx'
import { buildEstimate } from '../../engine/estimate.js'

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
  peg:          { name: 'PEG (growth)',      weight: '●●○' },
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
    recalc({}, {})   // empty → engine recomputes per-company derived defaults (CAPM WACC etc.)
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

      {/* How the Estimate line is built. Lives here rather than in the ⓘ next to
          the number: showing the working takes more room than a tooltip should
          occupy, and someone who has opened the valuation detail is the person
          who actually wants it. Collapsed by default so it doesn't push the
          model table down the page. */}
      <EstimateExplainer ratioResult={state.ratioResult} data={state.data} assumptions={state.assumptions} />

      {/* Model table — matches the spec exactly */}
      <div className="overflow-x-auto">
        <table className="w-auto sm:w-full text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs text-slate-400">
              <th className="text-left py-2 font-medium">Model</th>
              <th className="text-left sm:text-right py-2 font-medium">Fair Value</th>
              <th className="text-left sm:text-right py-2 font-medium">vs CMP</th>
              <th className="py-2 pl-2 font-medium hidden sm:table-cell"></th>
              <th className="text-right py-2 font-medium hidden sm:table-cell">Wt</th>
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
                  <td className="py-2 text-left sm:text-right font-mono text-white text-xs">
                    {fv != null ? cur + fv.toFixed(0) : isNA ? 'N/A' : '—'}
                  </td>
                  <td className={`py-2 text-left sm:text-right font-mono text-xs font-semibold
                    ${up == null ? 'text-slate-500' : up >= 0 ? 'text-bull' : 'text-bear'}`}>
                    {up != null ? fmtPct(up) : '—'}
                  </td>
                  <td className="py-2 pl-2 hidden sm:table-cell">
                    <DotBar upside={up} />
                  </td>
                  <td className="py-2 text-right text-slate-600 text-xs font-mono hidden sm:table-cell">
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
      <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 bg-navy-800/50 rounded-lg">
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
            const seed = assumptions[s.key] ?? valuation.defaults?.[s.key]
            const curVal = s.pct
              ? ((localAssumptions[s.key] ?? seed ?? s.def / 100) * 100)
              : (localAssumptions[s.key] ?? seed ?? s.def)
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
        </div>
      )}
    </div>
  )
}

/**
 * Plain-language walkthrough of the Estimate line.
 *
 * Four multiplications with the real numbers filled in, because "forward EPS
 * times a multiple band" is only obvious to someone who already knows what it
 * means. Anyone who can follow "it sells X, keeps Y% of it, split across Z
 * shares, and buyers pay N times that" can decide whether they agree with the
 * assumptions — which is the whole reason to show the working.
 */
function EstimateExplainer({ ratioResult, data, assumptions }) {
  const [open, setOpen] = useState(false)
  if (!ratioResult) return null

  const est = buildEstimate(ratioResult, {
    guidedGrowth: (assumptions?.nearTermGrowth != null && isFinite(assumptions.nearTermGrowth))
      ? assumptions.nearTermGrowth : null,
    priceHistory:   data?.priceHistory   || [],
    incomeHistory:  data?.incomeHistory  || [],
    balanceHistory: data?.balanceHistory || [],
  })

  const inr  = data?.currency === 'INR'
  const cur  = inr ? '₹' : '$'
  const unit = inr ? 'Cr' : 'M'
  const div  = inr ? 1e7 : 1e6
  const n  = v => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: v < 100 ? 1 : 0 }))
  const big = v => (v == null ? '—' : Number(v / div).toLocaleString('en-IN', { maximumFractionDigits: 0 }))

  return (
    <div className="bg-navy-800/40 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-300 hover:text-white">
        <span>🎯 How the Estimate is calculated</span>
        <span className="text-slate-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          {!est.ok ? (
            <p className="text-slate-400">{est.note}</p>
          ) : (
            <>
              <div className="space-y-2">
                {est.projRevenue != null ? (
                  <>
                    <Step n="1" title="What it sells next year">
                      Growing at <span className="text-accent">{est.growthPct}%</span> ({est.growthLabel}),
                      revenue reaches <span className="text-slate-300">{cur}{big(est.projRevenue)} {unit}</span>.
                    </Step>
                    <Step n="2" title="What it keeps as profit">
                      At a <span className="text-accent">{est.marginPct}%</span> margin ({est.marginLabel}),
                      that's <span className="text-slate-300">{cur}{big(est.projProfit)} {unit}</span> of profit.
                      {est.marginTrendPct != null && Math.abs(est.marginTrendPct) >= 1 && (
                        <span className={est.marginTrendPct < 0 ? 'text-bear' : 'text-bull'}>
                          {' '}Margin has moved {est.marginTrendPct > 0 ? '+' : ''}{est.marginTrendPct} pts over 3 years.
                        </span>
                      )}
                    </Step>
                    <Step n="3" title="Split across the shares">
                      {est.dilutionPct > 0.1
                        ? <>Share count is growing {est.dilutionPct}% a year, so profit is split more ways: </>
                        : <>Share count is steady, so that's </>}
                      <span className="text-slate-300">{cur}{n(est.forwardEps)}</span> per share.
                    </Step>
                  </>
                ) : (
                  <>
                    <Step n="1" title="What it earns now">
                      <span className="text-slate-300">{cur}{n(est.eps)}</span> of profit per share.
                    </Step>
                    <Step n="2" title="What it should earn next year">
                      Growing at <span className="text-accent">{est.growthPct}%</span> ({est.growthLabel}) →{' '}
                      <span className="text-slate-300">{cur}{n(est.forwardEps)}</span> per share.
                      <span className="text-neutral"> Margins assumed unchanged — no revenue/profit history to project them from.</span>
                    </Step>
                  </>
                )}
                <Step n={est.projRevenue != null ? '4' : '3'} title="What buyers pay for those earnings">
                  {est.multipleBasis === 'observed'
                    ? <>Historically people have paid between <span className="text-slate-300">{est.multiples.low}×</span> and{' '}
                       <span className="text-slate-300">{est.multiples.high}×</span> next year's earnings for this stock.</>
                    : <>Using {est.multipleLabel}: <span className="text-slate-300">{est.multiples.low}×</span> to{' '}
                       <span className="text-slate-300">{est.multiples.high}×</span>.</>}
                </Step>
              </div>

              <div className="bg-navy-900/60 rounded px-3 py-2 space-y-1 font-mono text-[11px]">
                <div className="text-slate-500">Multiply the last two together:</div>
                <div>{cur}{n(est.forwardEps)} × {est.multiples.low}× = <span className="text-white">{cur}{n(est.target.low)}</span></div>
                <div>{cur}{n(est.forwardEps)} × {est.multiples.base}× = <span className="text-white">{cur}{n(est.target.base)}</span> <span className="text-slate-500">← middle</span></div>
                <div>{cur}{n(est.forwardEps)} × {est.multiples.high}× = <span className="text-white">{cur}{n(est.target.high)}</span></div>
              </div>

              {est.multipleBasis === 'observed' && (
                <p className="text-slate-500">
                  The high and low ignore the most extreme 15% of days at each end — one panic
                  sell-off or one frenzy shouldn't set the range. These are <em>forward</em>
                  {' '}multiples: what buyers paid for earnings that hadn't arrived yet, which is
                  the only kind that can fairly be applied to a projection.
                </p>
              )}
              {est.multipleBasis === 'current' && (
                <p className="text-neutral">
                  ⚠ Not enough price history for this stock, so the range is today's P/E widened
                  25% either way. Weaker basis than a measured one.
                </p>
              )}
              {est.financeability && (
                <p className="text-neutral">⚠ {est.financeability.note}</p>
              )}

              <div className="border-t border-navy-700/60 pt-2 space-y-1.5">
                <p className="text-slate-400 font-medium">What can break this</p>
                <p className="text-slate-500">
                  <span className="text-slate-400">Margins move.</span>{' '}
                  {est.projRevenue != null
                    ? `We used ${est.marginPct}% because that's roughly what it's been keeping. If costs rise faster than sales, profit lands below ${cur}${big(est.projProfit)} ${unit} and the whole range shifts down.`
                    : 'We assumed profit grows exactly as fast as the business. If costs rise faster, it earns less and the range shifts down.'}
                </p>
                <p className="text-slate-500">
                  <span className="text-slate-400">Buyers can permanently change their mind.</span>{' '}
                  If something structural shifts — a rule change, a lost advantage — people may
                  simply stop paying {est.multiples.base}× and settle lower for good. The range would
                  keep saying "cheap" while the price kept falling, because it's built on how this
                  stock <em>used to be</em> valued.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Step({ n, title, children }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 w-4 h-4 rounded-full bg-navy-700 text-slate-300 text-[10px] flex items-center justify-center mt-0.5">{n}</span>
      <div>
        <div className="text-slate-400">{title}</div>
        <div className="text-slate-500">{children}</div>
      </div>
    </div>
  )
}
