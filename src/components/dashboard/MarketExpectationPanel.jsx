import React, { useState, useMemo, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { runMarketExpectation } from '../../engine/marketExpectation.js'
import { fmtCurrency, fmtNum } from '../../utils/format.js'
import ProvenanceTag from '../ProvenanceTag.jsx'

// ⓘ Info tooltip component
function InfoTip({ text }) {
  const [show, setShow] = useState(false)
  return (
    <span className="relative inline-flex ml-1">
      <button
        onClick={e => { e.stopPropagation(); setShow(!show) }}
        className="shrink-0 w-4 h-4 rounded-full bg-navy-700 text-slate-400 text-xs flex items-center justify-center hover:bg-navy-600 hover:text-white transition-colors leading-none"
      >ⓘ</button>
      {show && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShow(false)} />
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
                  w-72 max-w-[90vw] bg-navy-700 border border-navy-600 rounded-lg p-3
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
                {cur}{fmtNum(row.impliedPV, 0, cur === '₹' ? 'INR' : null)}
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

function VariantBlock({ variant, name, cur, marketCap, onAssumptionChange, terminalMultipleKey }) {
  const [showSanity, setShowSanity] = useState(false)

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
        <span className="font-mono text-white">{cur}{fmtNum(variant.base, 0, cur === '₹' ? 'INR' : null)}</span>
      </div>

      {/* Implied growth bar */}
      <GrowthBar impliedG={variant.impliedGrowth} />

      {/* Editable assumptions — the ⓘ rationale text says "increase if you
          believe…, decrease if…", which only means something if the field it
          sits next to actually takes the edit. It didn't: this used to render
          the same three values as plain read-only spans, with the update()
          function that would have wired an input up defined but never called
          by anything. */}
      <div className="space-y-2 pt-1 border-t border-navy-800/50">
        <div className="text-xs text-slate-500 font-medium">Assumptions</div>

        {/* Terminal Multiple (exit-multiple convention) OR Terminal Growth
            (perpetuity-growth convention, Reverse DCF) — a variant has one or
            the other, never both. Reading variant.assumptions.terminalMultiple
            unconditionally crashed on Reverse DCF, which has no such field. */}
        {variant.assumptions.terminalMultiple ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center text-slate-400">Terminal Multiple
              <InfoTip text={variant.assumptions.terminalMultiple.rationale} />
              <ProvenanceTag tier={variant.assumptions.terminalMultiple.tier} compact /></div>
            <div className="flex items-center gap-1">
              <input type="number" step="0.5" min="0.5" max="60"
                value={variant.assumptions.terminalMultiple.value}
                onChange={e => { const v = +e.target.value; if (isFinite(v) && v > 0) onAssumptionChange?.(terminalMultipleKey, v) }}
                className="w-16 bg-navy-800 border border-navy-700 rounded px-1.5 py-0.5 text-right font-mono text-slate-200 text-xs" />
              <span className="text-slate-500">×</span>
            </div>
          </div>
        ) : variant.assumptions.termGrowth ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center text-slate-400">Terminal Growth
              <InfoTip text={variant.assumptions.termGrowth.rationale} />
              <ProvenanceTag tier={variant.assumptions.termGrowth.tier} compact /></div>
            <div className="flex items-center gap-1">
              <input type="number" step="0.5" min="0" max="6"
                value={Math.round(variant.assumptions.termGrowth.value * 1000) / 10}
                onChange={e => { const v = +e.target.value; if (isFinite(v) && v >= 0) onAssumptionChange?.('reverseDcfTermGrowth', v / 100) }}
                className="w-16 bg-navy-800 border border-navy-700 rounded px-1.5 py-0.5 text-right font-mono text-slate-200 text-xs" />
              <span className="text-slate-500">%</span>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center text-slate-400">Discount Rate
            <InfoTip text={variant.assumptions.discountRate.rationale} />
            <ProvenanceTag tier={variant.assumptions.discountRate.tier} compact /></div>
          <div className="flex items-center gap-1">
            <input type="number" step="1" min="1" max="40"
              value={Math.round(variant.assumptions.discountRate.value * 100)}
              onChange={e => { const v = +e.target.value; if (isFinite(v) && v > 0) onAssumptionChange?.('discountRate', v / 100) }}
              className="w-14 bg-navy-800 border border-navy-700 rounded px-1.5 py-0.5 text-right font-mono text-slate-200 text-xs" />
            <span className="text-slate-500">%</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center text-slate-400">Horizon
            <InfoTip text={variant.assumptions.horizon.rationale} /></div>
          <div className="flex items-center gap-1">
            <input type="number" step="1" min="3" max="20"
              value={variant.assumptions.horizon.value}
              onChange={e => { const v = +e.target.value; if (isFinite(v) && v >= 1) onAssumptionChange?.('horizon', v) }}
              className="w-14 bg-navy-800 border border-navy-700 rounded px-1.5 py-0.5 text-right font-mono text-slate-200 text-xs" />
            <span className="text-slate-500">yr</span>
          </div>
        </div>
      </div>

      {/* Sanity check toggle — only for variants that HAVE one. Reverse DCF's
          perpetuity-growth convention doesn't translate to this exit-multiple
          table, so it carries no sanityTable at all rather than an empty one;
          showing an "expand" toggle that reveals nothing would be confusing. */}
      {variant.sanityTable && (
        <button
          onClick={() => setShowSanity(!showSanity)}
          className="text-xs text-accent hover:text-accent-light">
          {showSanity ? '▲ Hide' : '▼ Sanity check at different growth rates'}
        </button>
      )}

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

// Which top-level override key each variant's own terminal multiple maps to
// — discountRate/horizon are shared across all three (one required return,
// one horizon), but the terminal multiple is variant-specific.
const TERMINAL_KEY = { sales: 'terminalSalesMultiple', earnings: 'terminalPeMultiple', fcf: 'terminalFcfMultiple' }

export default function MarketExpectationPanel({ open, onClose }) {
  const { state } = useApp()
  const { data, ratioResult } = state
  // Edits recompute LOCALLY (runMarketExpectation is a pure function of its
  // inputs) rather than round-tripping through global state — this panel's
  // own "what if" exploration, not a committed change to the fair-value
  // pillar shown elsewhere.
  const [overrides, setOverrides] = useState({})
  const hasOverrides = Object.keys(overrides).length > 0

  // Fresh each time the panel opens (or the ticker changes underneath it) —
  // a leftover override from the last stock you looked at silently applying
  // to this one would be the same "stale state bleeds into a new ticker" bug
  // found elsewhere in the valuation assumptions.
  useEffect(() => { if (open) setOverrides({}) }, [open, state.ticker])

  const marketExpectation = useMemo(() => {
    if (!hasOverrides) return state.marketExpectation
    // Preserve whatever live-resolved defaults state.marketExpectation
    // already has (discountRate especially — CAPM-based, sourced from
    // AppContext's shared live risk-free rate) UNDERNEATH the user's local
    // slider edits. Without this, touching just ONE slider here recomputed
    // via getDefaultAssumptions()'s own non-live fallback for every OTHER
    // assumption the user didn't touch, silently reverting them.
    const liveBase = {
      discountRate: state.marketExpectation?.assumptions?.discountRate,
      // Without this, touching any slider here recomputed enterpriseDiscountRate
      // via getDefaultAssumptions()'s own computeWacc() call — but this call
      // site passes no opts (beta/ratioResult), so that recompute silently fell
      // back to Yahoo's reported beta instead of this app's live regression,
      // same class of bug discountRate above was already guarded against.
      enterpriseDiscountRate: state.marketExpectation?.assumptions?.enterpriseDiscountRate,
      terminalSalesMultiple: state.marketExpectation?.assumptions?.terminalSalesMultiple,
      terminalPeMultiple: state.marketExpectation?.assumptions?.terminalPeMultiple,
      terminalFcfMultiple: state.marketExpectation?.assumptions?.terminalFcfMultiple,
      horizon: state.marketExpectation?.assumptions?.horizon,
    }
    return runMarketExpectation(data, ratioResult, state.stage, state.sectorType, { ...liveBase, ...overrides })
  }, [overrides, hasOverrides, state.marketExpectation, data, ratioResult, state.stage, state.sectorType])

  if (!open || !marketExpectation) return null

  const onAssumptionChange = (key, val) => setOverrides(prev => ({ ...prev, [key]: val }))

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
        <div className="flex items-center gap-3 shrink-0">
          {hasOverrides && (
            <button onClick={() => setOverrides({})} className="text-xs text-accent hover:text-accent-light">
              ↺ reset to defaults
            </button>
          )}
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>
      </div>

      {/* Current market cap context */}
      <div className="flex items-center gap-4 text-xs text-slate-400 bg-navy-800/40 px-3 py-2 rounded-lg">
        <span>Current Market Cap: <span className="text-white font-mono">{cur}{fmtNum(marketCap, 0, cur === '₹' ? 'INR' : null)}</span></span>
        <span>Price: <span className="text-white font-mono">{cur}{ratioResult?.price?.toFixed(2)}</span></span>
      </div>

      {/* Four variants, three tiers:
            1. Primary — applicable AND the stage's preferred base metric.
            2. Secondary — applicable but stage-deprioritized (e.g. a GROWTH
               company that happens to already be profitable still computes
               a real "earnings" variant; it just isn't this stage's default
               read). Shown, not hidden — a computed real number silently
               disappearing was a genuine gap: it used to fail BOTH filters
               below (applicable, so excluded from N/A; stage-deprioritized,
               so excluded from primary) and vanish from the panel entirely.
            3. N/A — genuinely inapplicable (missing data), greyed at bottom.
          reverseDcf and fcf are stage-agnostic (no sales-vs-earnings
          preference applies to them). */}
      {(() => {
        const isGrowth = state.stage === 'GROWTH' || state.stage === 'PRE_REVENUE'
        const stageDeprioritized = k => (k === 'sales' && !isGrowth) || (k === 'earnings' && isGrowth)
        const keys = ['sales', 'earnings', 'fcf', 'reverseDcf']
        const primary   = keys.filter(k => variants[k]?.applicable && !stageDeprioritized(k))
        const secondary = keys.filter(k => variants[k]?.applicable && stageDeprioritized(k))
        const notApplicable = keys.filter(k => !variants[k]?.applicable)
        const block = k => (
          <VariantBlock
            key={k}
            name={k}
            variant={variants[k]}
            cur={cur}
            marketCap={marketCap}
            terminalMultipleKey={TERMINAL_KEY[k]}
            onAssumptionChange={onAssumptionChange}
          />
        )
        return (
          <div className="space-y-3">
            {primary.map(block)}

            {secondary.length > 0 && (
              <div className="space-y-3 opacity-70">
                <div className="text-xs text-slate-500">
                  Also computed (secondary for this stage):
                </div>
                {secondary.map(block)}
              </div>
            )}

            {notApplicable.map(block)}
          </div>
        )
      })()}

      <div className="text-xs text-slate-600 border-t border-navy-800 pt-3">
        This analysis is forward-looking and based on assumptions. It shows what the market
        is implying, not what will happen. Use as a sanity check alongside the valuation models above.
      </div>
    </div>
  )
}
