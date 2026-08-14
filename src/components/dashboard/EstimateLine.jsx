import React, { useState } from 'react'
import { useEstimate } from '../../store/useEstimate.js'

/**
 * EstimateLine — our own estimate, as its own line on the dashboard.
 *
 * Sits alongside Fair value and Analyst target rather than replacing either:
 * three comparable ranges stacked, each from a different method, so they can be
 * read against one another.
 *
 * Display discipline (the dashboard has to stay crisp):
 *   • the line itself carries ONLY the range, the upside, and — when something
 *     has fallen back to a weaker basis — one small amber dot.
 *   • the ⓘ carries the basis in three short lines. Nothing else.
 *   • the full working lives in Valuation Detail.
 *
 * The dot shows NOTHING when every input is on its best basis. A warning that's
 * always on gets ignored, so silence is the normal state and the dot means
 * something specific: an input degraded.
 */
export default function EstimateLine({ currency, state, which = 'market' }) {
  const [open, setOpen] = useState(false)

  // One source of truth with ValuationPanel: the same hook resolves guidance,
  // applies stored revisions and fetches peers, so the dashboard line and the
  // detail screen can never disagree about what the estimate currently is.
  const { estimate, justified, overrides, sanity, riskFree } = useEstimate(state)

  // Which of the two this line shows. They answer different questions —
  // Estimate 1 what the fundamentals justify, Estimate 2 what the market has
  // been paying — so both belong on the dashboard rather than one being
  // reachable only through the detail panel.
  // Two different questions, so two different names. "Estimate 1 / 2" implied a
  // ranking of the same thing; these are a valuation and a projection.
  const isJustified = which === 'justified'
  const est = isJustified ? justified : estimate
  const label = isJustified ? 'Justified Multiples' : 'App Target'

  const cur = symbolFor(currency)

  if (!est?.ok) {
    return (
      <span className="inline-flex items-center gap-1">
        <span>{label}: </span>
        <span className="font-mono font-bold text-slate-500 ml-1">—</span>
        <Dot open={open} setOpen={setOpen} degraded>
          <span className="block text-[11px] text-slate-400">
            {est?.note || 'Not enough data to build an estimate.'}
          </span>
          {isJustified && riskFree?.rate == null && (
            <span className="block text-[11px] text-slate-500 mt-1">
              The risk-free rate needs an AI key — set one in the AI verdict panel.
            </span>
          )}
        </Dot>
      </span>
    )
  }

  const { target, upside, degraded } = est
  const isDegraded = degraded.length > 0

  return (
    <span className="inline-flex items-center gap-1 flex-wrap min-w-0">
      <span>{label}: </span>
      <span className={`font-mono font-bold ml-1 ${
        // sanityCheck only evaluates the market-based estimate, so its verdict
        // must not strike through Estimate 1, which it never examined.
        (!isJustified && sanity?.severity === 'high')
          ? 'text-slate-500 line-through decoration-neutral/60' : 'text-white'}`}>
        {cur}{fmt(target.low)} – {cur}{fmt(target.high)}
      </span>
      {upside?.base != null && (
        <span className={`text-xs font-mono ${upside.base >= 0 ? 'text-bull' : 'text-bear'}`}>
          ({upside.base >= 0 ? '+' : ''}{upside.base}%)
        </span>
      )}
      <Dot open={open} setOpen={setOpen} degraded={isDegraded || sanity?.severity === 'high'}>
        {sanity && (
          <span className="block text-[11px] text-neutral border-b border-navy-800 pb-1.5 mb-1.5">
            ⚠ {sanity.banner}
            {sanity.issues.map((x, i) => <span key={i} className="block text-slate-500">{x}</span>)}
          </span>
        )}
        <span className="block space-y-1 text-[11px]">
          {/* Three lines. Enough to know what the number rests on, short enough
              to read at a glance — the working itself is in Valuation Detail. */}
          <BasisRow label="Growth"   value={est.growthLabel} pct={`${est.growthPct}%`} />
          <BasisRow label="Margin"
                    value={est.marginLabel}
                    pct={est.marginPct != null ? `${est.marginPct}%` : null} />
          <BasisRow label="Multiple" value={est.multipleLabel}
                    pct={`${est.multiples.low}–${est.multiples.high}×`} />
          {est.growthAlternatives?.length > 0 && est.growthSpreadPts >= 5 && (
            <span className="block text-[11px] text-slate-500">
              Other bases: {est.growthAlternatives.map(a => `${a.pct}% ${a.label}`).join(' · ')}
            </span>
          )}
          {est.dilutionPct > 0.1 && (
            <BasisRow label="Dilution" value={est.dilutionLabel} pct={null} />
          )}
          {Object.keys(overrides || {}).length > 0 && (
            <BasisRow label="Revised" pct={null}
              value={`${Object.keys(overrides).join(', ')} — ${est.growthLabel || 'revised'}`} />
          )}
          {isDegraded && (
            <span className="block border-t border-navy-800 pt-1 mt-1 text-neutral">
              {degraded.map((d, i) => <span key={i} className="block">• {d}</span>)}
            </span>
          )}
          {est.financeability && (
            <span className="block border-t border-navy-800 pt-1 mt-1 text-neutral">
              ⚠ {est.financeability.note}
            </span>
          )}
        </span>
      </Dot>
    </span>
  )
}

function BasisRow({ label, value, pct }) {
  return (
    <span className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-slate-500 w-14 shrink-0">{label}</span>
      {pct && <span className="font-mono text-slate-300 shrink-0 tabular-nums">{pct}</span>}
      <span className="text-slate-500 truncate min-w-0">{value}</span>
    </span>
  )
}

/**
 * The marker + its popover. Amber when an input degraded, a plain ⓘ otherwise.
 * Opens on hover for a mouse and on tap for touch — hover-only would make this
 * unreachable on a phone, which is where the app mostly gets used.
 */
function Dot({ open, setOpen, degraded, children }) {
  return (
    <span className="relative inline-flex"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}>
      <button type="button"
        title={degraded ? 'Built on a weaker basis — tap for detail' : 'What this is based on'}
        aria-label={degraded ? 'Built on a weaker basis' : 'What this is based on'}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className={`w-4 h-4 rounded-full border text-[10px] leading-none flex items-center
                    justify-center shrink-0 transition-colors ${
          degraded ? 'border-neutral/60 text-neutral hover:border-neutral'
                   : 'border-navy-600 text-slate-400 hover:text-accent hover:border-accent/60'}`}>
        {degraded ? '!' : 'i'}
      </button>
      {open && (
        <span className="absolute z-50 left-1/2 -translate-x-1/2 top-5 w-64 max-w-[80vw]
                         bg-navy-900 border border-navy-700 rounded-lg shadow-2xl p-2.5
                         text-left font-normal normal-case cursor-default"
              onClick={e => e.stopPropagation()}>
          {children}
        </span>
      )}
    </span>
  )
}

const fmt = v => (v == null ? '' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: v < 100 ? 1 : 0 }))
function symbolFor(code) {
  return ({ INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[code]) || (code ? `${code} ` : '')
}
