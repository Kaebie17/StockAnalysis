import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtCurrency, fmtNum } from '../../utils/format.js'

// ⓘ Info tooltip component
function InfoTip({ text }) {
  const [show, setShow] = useState(false)
  return (
    <span className="relative inline-flex ml-1">
      <button
        onClick={e => { e.stopPropagation(); setShow(!show) }}
        className="w-4 h-4 rounded-full bg-navy-700 text-slate-400 text-xs flex items-center justify-center hover:bg-navy-600 hover:text-white transition-colors leading-none"
      >ⓘ</button>
      {show && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShow(false)} />
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
                          w-72 bg-navy-700 border border-navy-600 rounded-lg p-3
                          text-xs text-slate-300 leading-relaxed shadow-xl">
            {text}
            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4
                            border-transparent border-t-navy-700" />
          </div>
        </>
      )}
    </span>
  )
}

function GrowthBar({ impliedG, max = 40 }) {
  if (impliedG == null) return null
  const pct   = Math.min(Math.abs(impliedG) / max * 100, 100)
  const color  = impliedG > 35 ? 'bg-bear'
    : impliedG > 25 ? 'bg-orange-500'
    : impliedG > 15 ? 'bg-neutral'
    : 'bg-bull'
  const label  = impliedG > 35 ? 'Extreme'
    : impliedG > 25 ? 'Aggressive'
    : impliedG > 15 ? 'Moderate'
    : impliedG > 8  ? 'Conservative'
    : 'Very conservative'

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">Market implied growth</span>
        <span className={`font-semibold font-mono ${
          impliedG > 25 ? 'text-bear' : impliedG > 15 ? 'text-neutral' : 'text-bull'
        }`}>{impliedG.toFixed(1)}%/yr — {label}</span>
      </div>
      <div className="h-2 bg-navy-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function SanityTable({ rows, marketCap, cur }) {
  if (!rows?.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-navy-700">
            <th className="text-left py-1.5 text-slate-400 font-medium">Growth/yr</th>
            <th className="text-right py-1.5 text-slate-400 font-medium">Implied Mkt Cap</th>
            <th className="text-right py-1.5 text-slate-400 font-medium">vs Today</th>
            <th className="text-right py-1.5 text-slate-400 font-medium">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.growthRate}
              className={`border-b border-navy-800/30 ${row.isCurrentImplied ? 'bg-accent/10' : ''}`}>
              <td className={`py-1.5 font-mono font-semibold ${row.isCurrentImplied ? 'text-accent' : 'text-slate-300'}`}>
                {row.growthRate}% {row.isCurrentImplied ? '← current' : ''}
              </td>
              <td className="py-1.5 text-right font-mono text-slate-300">
                {cur}{fmtNum(row.impliedPV, 0)}
              </td>
              <td className={`py-1.5 text-right font-mono ${
                row.ratio > 1.1 ? 'text-bull' : row.ratio < 0.9 ? 'text-bear' : 'text-neutral'
              }`}>
                {row.ratio > 1 ? '+' : ''}{((row.ratio - 1) * 100).toFixed(0)}%
              </td>
              <td className={`py-1.5 text-right ${
                row.label === 'Undervalued' ? 'text-bull' :
                row.label === 'Fair' ? 'text-neutral' : 'text-bear'
              }`}>{row.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VariantBlock({ variant, name, cur, marketCap, onAssumptionChange, assumptions }) {
  const [showSanity, setShowSanity] = useState(false)
  const [localAssumptions, setLocalAssumptions] = useState({})

  if (!variant.applicable) {
    return (
      <div className="opacity-40 border border-navy-800 rounded-lg px-3 py-2 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-slate-400">{variant.label || name}</span>
          <span className="text-xs text-slate-600 ml-2">— {variant.reason}</span>
        </div>
        <span className="text-xs text-slate-600">N/A</span>
      </div>
    )
  }

  const update = (key, val) => {
    const next = { ...localAssumptions, [key]: val }
    setLocalAssumptions(next)
    onAssumptionChange?.(next)
  }

  return (
    <div className="card-sm space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-white">{variant.label}</span>
          <span className="text-xs text-slate-500 ml-2">{variant.note}</span>
        </div>
      </div>

      {/* Base metric */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">{variant.baseLabel}</span>
        <span className="font-mono text-white">{cur}{fmtNum(variant.base, 0)}</span>
      </div>

      {/* Implied growth bar */}
      <GrowthBar impliedG={variant.impliedGrowth} />

      {/* Editable assumptions */}
      <div className="space-y-2 pt-1 border-t border-navy-800/50">
        <div className="text-xs text-slate-500 font-medium">Assumptions</div>

        {/* Terminal multiple */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center text-xs text-slate-400">
            Terminal Multiple
            <InfoTip text={variant.assumptions.terminalMultiple.rationale} />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={name === 'fcf' ? 8 : name === 'sales' ? 1 : 8}
              max={name === 'fcf' ? 35 : name === 'sales' ? 10 : 40}
              step={0.5}
              value={localAssumptions.terminalMultiple ?? variant.assumptions.terminalMultiple.value}
              onChange={e => update('terminalMultiple', parseFloat(e.target.value))}
              className="w-20 accent-accent"
            />
            <span className="text-xs font-mono text-white w-10 text-right">
              {(localAssumptions.terminalMultiple ?? variant.assumptions.terminalMultiple.value).toFixed(1)}×
            </span>
          </div>
        </div>

        {/* Discount rate */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center text-xs text-slate-400">
            Discount Rate
            <InfoTip text={variant.assumptions.discountRate.rationale} />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range" min={8} max={25} step={0.5}
              value={(localAssumptions.discountRate ?? variant.assumptions.discountRate.value) * 100}
              onChange={e => update('discountRate', parseFloat(e.target.value) / 100)}
              className="w-20 accent-accent"
            />
            <span className="text-xs font-mono text-white w-10 text-right">
              {((localAssumptions.discountRate ?? variant.assumptions.discountRate.value) * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        {/* Horizon */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center text-xs text-slate-400">
            Horizon
            <InfoTip text={variant.assumptions.horizon.rationale} />
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range" min={5} max={15} step={1}
              value={localAssumptions.horizon ?? variant.assumptions.horizon.value}
              onChange={e => update('horizon', parseInt(e.target.value))}
              className="w-20 accent-accent"
            />
            <span className="text-xs font-mono text-white w-10 text-right">
              {localAssumptions.horizon ?? variant.assumptions.horizon.value}yr
            </span>
          </div>
        </div>
      </div>

      {/* Sanity check toggle */}
      <button
        onClick={() => setShowSanity(!showSanity)}
        className="text-xs text-accent hover:text-accent-light">
        {showSanity ? '▲ Hide' : '▼ Sanity check at different growth rates'}
      </button>

      {showSanity && variant.sanityTable && (
        <SanityTable rows={variant.sanityTable} marketCap={marketCap} cur={cur} />
      )}

      {/* Conclusion */}
      {variant.conclusion && (
        <div className="bg-navy-800/50 rounded-lg px-3 py-2">
          <div className="text-xs text-slate-500 font-medium mb-1">💡 Conclusion</div>
          <p className="text-xs text-slate-300 leading-relaxed">{variant.conclusion}</p>
        </div>
      )}
    </div>
  )
}

export default function MarketExpectationPanel({ open, onClose }) {
  const { state, runMarketExpectation: rerun } = useApp()
  const { marketExpectation, data, ratioResult } = state

  if (!open || !marketExpectation) return null

  const cur = data?.currency === 'INR' ? '₹' : '$'
  const { variants, marketCap } = marketExpectation

  // Summary: pick the most applicable variant for the strip
  const _isGrowth = state.stage === 'GROWTH' || state.stage === 'PRE_REVENUE'
  const _order = _isGrowth ? ['sales', 'fcf', 'earnings'] : ['earnings', 'fcf', 'sales']
  const primary = _order.map(k => variants[k]).find(v => v?.applicable) || null

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-white">🔮 Market Expectation</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            What growth rate is the market betting on?
          </p>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
      </div>

      {/* Current market cap context */}
      <div className="flex items-center gap-4 text-xs text-slate-400 bg-navy-800/40 px-3 py-2 rounded-lg">
        <span>Current Market Cap: <span className="text-white font-mono">{cur}{fmtNum(marketCap, 0)}</span></span>
        <span>Price: <span className="text-white font-mono">{cur}{ratioResult?.price?.toFixed(2)}</span></span>
      </div>

      {/* Three variants — applicable ones normal, N/A ones greyed at bottom */}
      <div className="space-y-3">
        {/* Applicable variants first */}
        {['sales', 'earnings', 'fcf']
          .filter(k => variants[k]?.applicable)
          .filter(k => {
            const isGrowth = state.stage === 'GROWTH' || state.stage === 'PRE_REVENUE'
            if (k === 'sales' && !isGrowth) return false      // hide Sales for established
            if (k === 'earnings' && isGrowth) return false     // hide Earnings for growth/pre-profit
            return true
          })
          .map(k => (
            <VariantBlock
              key={k}
              name={k}
              variant={variants[k]}
              cur={cur}
              marketCap={marketCap}
            />
          ))
        }

        {/* N/A variants greyed at bottom */}
        {['sales', 'earnings', 'fcf']
          .filter(k => !variants[k]?.applicable)
          .map(k => (
            <VariantBlock
              key={k}
              name={k}
              variant={variants[k]}
              cur={cur}
              marketCap={marketCap}
            />
          ))
        }
      </div>

      <div className="text-xs text-slate-600 border-t border-navy-800 pt-3">
        This analysis is forward-looking and based on assumptions. It shows what the market
        is implying, not what will happen. Use as a sanity check alongside the valuation models above.
      </div>
    </div>
  )
}
