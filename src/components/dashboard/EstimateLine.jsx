import React, { useState } from 'react'
import { buildEstimate } from '../../engine/estimate.js'

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
export default function EstimateLine({ currency, ratioResult, data, guidance, assumptions }) {
  const [open, setOpen] = useState(false)

  // Guided growth has two homes. The stored guidance record is a dated promise
  // about a named fiscal year and outranks everything; assumptions.nearTermGrowth
  // is what ScoringStudio is holding right now — session-level and untracked,
  // but it IS what the user just told the app to assume, so it beats a bare CAGR.
  const g = guidance?.revenueGuidance
  const guidanceLive = g && g.status !== 'resolved'
  const storedGuided = (guidanceLive && g.unit === 'growthPct' && g.value != null) ? g.value / 100 : null
  const liveGuided = (assumptions?.nearTermGrowth != null && isFinite(assumptions.nearTermGrowth))
    ? assumptions.nearTermGrowth : null

  const est = ratioResult ? buildEstimate(ratioResult, {
    guidedGrowth: storedGuided ?? liveGuided,
    guidanceFiscalYear: g?.fiscalYear || null,
    guidanceExpired: !!(g && g.status === 'resolved'),
    priceHistory:   data?.priceHistory   || [],
    incomeHistory:  data?.incomeHistory  || [],
    balanceHistory: data?.balanceHistory || [],
  }) : null

  const cur = symbolFor(currency)

  if (!est?.ok) {
    return (
      <span className="inline-flex items-center gap-1">
        <span>Estimate: </span>
        <span className="font-mono font-bold text-slate-500 ml-1">—</span>
        <Dot open={open} setOpen={setOpen} degraded>
          <span className="block text-[11px] text-slate-400">
            {est?.note || 'Not enough data to build an estimate.'}
          </span>
        </Dot>
      </span>
    )
  }

  const { target, upside, degraded } = est
  const isDegraded = degraded.length > 0

  return (
    <span className="inline-flex items-center gap-1">
      <span>Estimate: </span>
      <span className="font-mono font-bold text-white ml-1">
        {cur}{fmt(target.low)} – {cur}{fmt(target.high)}
      </span>
      {upside?.base != null && (
        <span className={`text-xs font-mono ${upside.base >= 0 ? 'text-bull' : 'text-bear'}`}>
          ({upside.base >= 0 ? '+' : ''}{upside.base}%)
        </span>
      )}
      <Dot open={open} setOpen={setOpen} degraded={isDegraded}>
        <span className="block space-y-1 text-[11px]">
          {/* Three lines. Enough to know what the number rests on, short enough
              to read at a glance — the working itself is in Valuation Detail. */}
          <BasisRow label="Growth"   value={est.growthLabel} pct={`${est.growthPct}%`} />
          <BasisRow label="Margin"
                    value={est.marginLabel}
                    pct={est.marginPct != null ? `${est.marginPct}%` : null} />
          <BasisRow label="Multiple" value={est.multipleLabel}
                    pct={`${est.multiples.low}–${est.multiples.high}×`} />
          {est.dilutionPct > 0.1 && (
            <BasisRow label="Dilution" value={est.dilutionLabel} pct={null} />
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
    <span className="flex items-baseline gap-1.5">
      <span className="text-slate-500 w-14 shrink-0">{label}</span>
      {pct && <span className="font-mono text-slate-300">{pct}</span>}
      <span className="text-slate-500 truncate">{value}</span>
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
