import React, { useState, useRef } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPct, fmtPctPlain } from '../../utils/format.js'
import DCFScenarioPanel from './DCFScenarioPanel.jsx'
import { useEstimate } from '../../store/useEstimate.js'
import FactInputModal from './FactInputModal.jsx'
import { useNewsFacts, keyOf, leverOf } from '../../store/useNewsFacts.js'
import { computeFact } from '../../engine/factImpact.js'
import { extractSegmentShares } from '../../engine/segmentShare.js'
import { TERMINAL_GROWTH_BY_MARKET } from '../../engine/requiredReturn.js'
import { TIER } from '../../engine/methodologyTier.js'
import ProvenanceTag from '../ProvenanceTag.jsx'

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
          signal, intrinsicValue, secondaryChecks, assumptions } = valuation

  // Last-resort display fallbacks only — real values come from valuation.defaults
  // (engine). wacc/growthRate still have genuine null paths (unmeasurable cost of
  // debt; no CAGR basis), so they're kept here. termGrowth/sectorPe/sectorEvEb no
  // longer have a null path in the engine, so their slider fallbacks below are
  // inline safety nets, not a fourth source of truth.
  const DEFAULT_ASSUMPTIONS = { wacc: 0.10, growthRate: 0.08 }

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
      <TwoEstimates state={state} />

      <EstimateExplainer state={state} />

      {/* Revisions live next to the working, not in a separate screen: the
          number, how it was derived, and what has been changed about it are one
          subject. */}
      <EstimateRevisions state={state} />

            {/* Model list — stacked cards on mobile, aligned columns on desktop */}
      <div className="space-y-0">
        {/* Header row — desktop only */}
        <div className="hidden sm:grid sm:grid-cols-[1fr_auto_auto_auto_auto] sm:gap-3 border-b border-navy-700 text-xs text-slate-400 py-2 font-medium">
          <span>Model</span>
          <span className="text-right w-20">Fair Value</span>
          <span className="text-right w-16">vs CMP</span>
          <span className="w-16"></span>
          <span className="text-right w-8">Wt</span>
        </div>

        {allModels.map(key => {
          const meta   = MODEL_DISPLAY[key]
          const result = models[key]
          const fv     = result?.value
          const note   = result?.note
          const up     = fv != null && price ? ((fv - price) / price) * 100 : null
          const isNA   = modelMeta?.notApplicable?.includes(key)
          const isCaution = modelMeta?.caution?.includes(key)

          const label = isNA
            ? <span className="line-through text-slate-600">{meta.name}</span>
            : isCaution
            ? <span>{key === 'dcf' ? `DCF (${assumptions?.projYears ?? 10}yr)` : meta.name} <span className="text-neutral">⚠</span></span>
            : (key === 'dcf' ? `DCF (${assumptions?.projYears ?? 10}yr)` : meta.name)

          const fvText = fv != null ? cur + fv.toFixed(0) : isNA ? 'N/A' : '—'
          const upText = up != null ? fmtPct(up) : '—'
          const upColor = up == null ? 'text-slate-500' : up >= 0 ? 'text-bull' : 'text-bear'

          return (
            <div key={key}
              title={note || ''}
              className={`border-b border-navy-800/40 py-2 text-xs
                          flex flex-col gap-1
                          sm:grid sm:grid-cols-[1fr_auto_auto_auto_auto] sm:gap-3 sm:items-center
                          ${isNA ? 'opacity-25' : ''}`}>
              {/* Mobile: name + weight dots on line 1 */}
              <div className="flex items-center justify-between sm:block">
                <span className="text-slate-300">{label}</span>
                <span className="text-slate-600 font-mono sm:hidden">{meta.weight}</span>
              </div>
              {/* Mobile: fair value + vs CMP on line 2 (full width, no wrap) */}
              <div className="flex items-center justify-between gap-3 sm:contents">
                <span className="font-mono text-white whitespace-nowrap tabular-nums sm:text-right sm:w-20 flex items-center justify-end gap-1">
                  {fvText}
                  <ProvenanceTag tier={result?.tier} compact />
                </span>
                <span className={`font-mono font-semibold whitespace-nowrap tabular-nums sm:text-right sm:w-16 ${upColor}`}>
                  {upText}
                </span>
                <span className="hidden sm:block sm:w-16"><DotBar upside={up} /></span>
                <span className="hidden sm:block sm:text-right sm:w-8 text-slate-600 font-mono">{meta.weight}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* DCF scenarios — moved OUT of the table (was invalid inside tbody) */}
      <DCFScenarioPanel />

      {/* Consensus row — Fair Value means ONE thing: peer/sector relative
          valuation (P/E, P/B, EV/EBITDA, P/S). DCF and Graham are genuinely
          different methods and are never blended into this number or its
          range — they get their own rows below instead. */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 bg-navy-800/50 rounded-lg">
        <div>
          <div className="flex items-center text-xs text-slate-400">
            Range: {rangeLow && rangeHigh
              ? (rangeLow === rangeHigh
                  ? <span className="font-mono text-slate-300 ml-1">{cur}{rangeLow.toFixed(0)}</span>
                  : <span className="font-mono text-slate-300 ml-1">{cur}{rangeLow.toFixed(0)} – {cur}{rangeHigh.toFixed(0)}</span>)
              : <span className="ml-1">—</span>}
            <span className="text-slate-600 ml-1">(lowest to highest peer/sector model)</span>
          </div>
        </div>
        <div className="text-right">
          <span className={`font-bold text-sm ${signalColor}`}>
            {upside != null ? `${upside >= 0 ? '+' : ''}${upside.toFixed(1)}% upside` : signal}
          </span>
        </div>
      </div>

      {/* Intrinsic Value (DCF) — a different question from Fair Value above
          ("what do peers/sector pay" vs "what do this company's own cash
          flows justify"), so it gets its own row rather than competing to be
          the headline number. */}
      {intrinsicValue && (
        <div className="flex items-center justify-between gap-2 py-2 px-3 bg-navy-800/30 rounded-lg">
          <span className="text-xs text-slate-400">Intrinsic Value <span className="text-slate-600">(DCF)</span></span>
          <span className="font-mono text-sm text-white flex items-center gap-1">
            {cur}{intrinsicValue.value.toFixed(0)}
            <ProvenanceTag tier={intrinsicValue.tier} compact />
          </span>
        </div>
      )}

      {/* Secondary heuristic checks — Graham and PEG are simple formulas with
          no required-return/CAPM rigor behind them (a fixed sanity ceiling;
          "fair P/E = growth rate"), shown as supporting reference points, not
          peers of DCF's or Fair Value's analysis. */}
      {(secondaryChecks?.graham || secondaryChecks?.peg) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 px-3 bg-navy-800/20 rounded-lg text-xs">
          <span className="text-slate-600">Heuristic checks:</span>
          {secondaryChecks.graham && (
            <span className="text-slate-400">Graham <span className="font-mono text-slate-300">{cur}{secondaryChecks.graham.value.toFixed(0)}</span>
              <ProvenanceTag tier={secondaryChecks.graham.tier} compact /></span>
          )}
          {secondaryChecks.peg && (
            <span className="text-slate-400">PEG <span className="font-mono text-slate-300">{cur}{secondaryChecks.peg.value.toFixed(0)}</span>
              <ProvenanceTag tier={secondaryChecks.peg.tier} compact /></span>
          )}
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
            { key: 'wacc',       label: 'WACC',             min: 5,  max: 34, step: 0.5, pct: true,  def: DEFAULT_ASSUMPTIONS.wacc * 100, tier: TIER.DERIVED },
            { key: 'termGrowth', label: 'Terminal Growth',  min: 1,  max: 6,  step: 0.5, pct: true,  def: TERMINAL_GROWTH_BY_MARKET.IN * 100, tier: TIER.DERIVED },
            { key: 'growthRate', label: 'FCF Growth',       min: -5, max: 40, step: 1,   pct: true,  def: DEFAULT_ASSUMPTIONS.growthRate * 100, tier: TIER.DERIVED },
            { key: 'sectorPe',   label: 'Sector P/E',       min: 5,   max: 60, step: 1,   pct: false, def: 20, tier: TIER.ASSUMED },
            { key: 'sectorEvEb', label: 'Sector EV/EBITDA', min: 4,   max: 30, step: 0.5, pct: false, def: 12, tier: TIER.ASSUMED },
            { key: 'sectorPs',   label: 'Sector EV/Sales',  min: 0.5, max: 10, step: 0.5, pct: false, def: 3, tier: TIER.ASSUMED },
          ].map(s => {
            const seed = assumptions[s.key] ?? valuation.defaults?.[s.key]
            const curVal = s.pct
              ? ((localAssumptions[s.key] ?? seed ?? s.def / 100) * 100)
              : (localAssumptions[s.key] ?? seed ?? s.def)
            const display = s.pct ? curVal.toFixed(1) + '%' : curVal.toFixed(s.key === 'sectorPe' ? 0 : 1) + '×'
            return (
              <div key={s.key}>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span className="flex items-center gap-1">{s.label}<ProvenanceTag tier={s.tier} compact /></span>
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
function EstimateExplainer({ state }) {
  const [open, setOpen] = useState(false)
  // Was hand-rolling its own buildEstimate() call with 4 of the ~14 options
  // TwoEstimates/useEstimate actually apply (growth window, accepted
  // revisions, peer band, guidance, the pre-normalisation history for the
  // multiple band) — so the moment a user committed any revision, this
  // walkthrough explained a DIFFERENT number than the one sitting right
  // above it. Sharing the same hook is the fix: same inputs, same number,
  // and it stays in sync with revisions the same way TwoEstimates does
  // (useEstimate's docblock: multiple call sites, one shared revision
  // counter, so a commit anywhere reloads all of them together).
  const { estimate: est } = useEstimate(state)
  const data = state?.data
  if (!state?.ratioResult || !est) return null

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
              {/* This message named the wrong cause and the wrong number: it
                  said "not enough price history" and "25%", but a 'current'
                  basis now comes from the band-rejection guard and widens by
                  20%. The engine already writes the accurate reason into
                  multipleLabel, so it is shown rather than re-described here —
                  a hardcoded explanation of a computed state goes stale the
                  moment the computation changes, which is what happened. */}
              {est.multipleBasis === 'current' && (
                <p className="text-neutral">
                  ⚠ {est.multipleLabel}. A weaker basis than a measured band, so the range is
                  wider and less certain.
                </p>
              )}
              {est.multipleBasis === 'peer' && (
                <p className="text-neutral">
                  ⚠ {est.multipleLabel}. Peers are a reasonable stand-in, but they are other
                  companies — this stock may deserve a different multiple.
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

/**
 * EstimateRevisions — the correction loop, and the log of what's been corrected.
 *
 * Without this the estimate could be computed but never actually revised:
 * overrides were function arguments that vanished on reload. Every entry here is
 * an append-only row, so today's number always carries its reasoning with it.
 */
function EstimateRevisions({ state }) {
  const [open, setOpen] = useState(false)
  const [factOpen, setFactOpen] = useState(false)
  const [seedItem, setSeedItem] = useState(null)
  const {
    estimate, overrides, revisions, rerating, commit, peerBand,
    guidanceAssessment, quarterlySuggestion, score, handledKeys, deferredLevers, relative,
  } = useEstimate(state)

  // growthDriftSuggestion() returns a fresh object on every render (never
  // memoized), so the auto-apply effect below saw its dependency "change" on
  // every render until overrides.growth caught up asynchronously — several
  // renders can happen in that window, each re-firing the effect and
  // committing the SAME suggestion again. This tracks the last suggestion
  // actually committed (by its content, not its object reference) so a
  // reference-different-but-value-identical re-render can't double-apply it.
  const lastAppliedSuggestionRef = useRef(null)
  // Same fix, for the news-fact auto-apply effect below: a.key is stable
  // per-headline (keyOf() in useNewsFacts.js), so tracking which keys this
  // session has already auto-applied blocks a duplicate commit for the same
  // item during the same async gap before handledKeys catches up.
  const autoAppliedKeysRef = useRef(new Set())

  const r = state.ratioResult
  const ctx = r ? {
    revenue: r.revenue, netProfit: r.netProfit, totalAssets: r.totalAssets,
    growth: estimate?.growth ?? null,
    margin: estimate?.marginPct != null ? estimate.marginPct / 100 : null,
    // Both lines, so a guided operating or gross margin can be converted to the
    // net figure the model runs on using this company's own ratio — rather than
    // being applied as if it were already net.
    netMargin: r.ratios?.netMargin?.value != null ? r.ratios.netMargin.value / 100 : null,
    opMargin:  r.ratios?.operatingMargin?.value != null ? r.ratios.operatingMargin.value / 100 : null,
    nim: r.ratios?.nim?.value ?? null,
    // For deriving a segment's share of revenue rather than asking for it.
    incomeHistory: state.data?.incomeHistory || [],
    // Segment percentages named in the annual report text — step 2 of the
    // precedence chain. Parsed here rather than stored, since the AR text is
    // already in state and the parse is cheap.
    arSegments: React.useMemo(
      () => extractSegmentShares(arTextOf(state.arData)), [state.arData]),
    userShares: state.guidance?.segmentShares || {},
    currency: state.data?.currency,
    // From state, not state.data: computeAll returns sectorType at the top
    // level and normalize never writes it onto `data`. Reading the wrong one
    // silently made every company look STANDARD — which hid the NIM fact type
    // for banks and let lender-specific classification fall through.
    sectorType: state.sectorType,
  } : null

  // News is read for facts automatically — this is the main path, not the paste
  // box. Items already handled are filtered out so a dealt-with headline doesn't
  // come back every three minutes.
  const { actionable, incomplete, loading } = useNewsFacts(
    state.ticker, state.data?.name, ctx, handledKeys)

  const applied = revisions.filter(x => x.disposition === 'revised')
  const levers = Object.keys(overrides)
  const pending = actionable.length + incomplete.length

  // A conflicting forecast is presented, not applied. Keeping the current
  // assumption is recorded too — "someone looked and stayed" is a different fact
  // from "nobody looked", and only the log can tell them apart later.
  const keepCurrent = (a) => commit({
    lever: 'growth', disposition: 'dismissed', trigger: 'news',
    factType: a.parsed.typeId, reason: `Kept current assumption over: ${a.item.title}`,
    sourceKey: a.key,
  })

  const applyItem = React.useCallback(async (a, auto = false) => {
    const entries = [a.impact, a.impact.second].filter(Boolean)
    for (const imp of entries) {
      await commit({
        lever: imp.lever, oldValue: imp.from ?? null, newValue: imp.to, years: imp.years ?? null,
        disposition: 'revised', trigger: auto ? 'news-auto' : 'news',
        factType: a.parsed.typeId, factFields: a.parsed.fields, steps: imp.steps,
        reason: a.item.title, sourceKey: a.key,
        sourceItem: { title: a.item.title, url: a.item.url, date: a.item.date },
      })
    }
  }, [commit])

  // An item that states everything needed is applied WITHOUT asking. Holding a
  // fully-specified fact behind a tap makes the user re-derive a decision the
  // arithmetic already made; the estimate is meant to keep itself current, not
  // wait to be told what it can already work out.
  //
  // What makes this safe is the guards, not the prompt: factImpact refuses
  // inputs that don't survive a sanity check against the company's own numbers
  // (a 26% "margin" on a 4.7% net-margin insurer is rejected, not applied), and
  // every auto-application is logged with an undo.
  //
  // `handledKeys` comes from the revision log, so a committed item drops out of
  // `actionable` on the next read — that's what stops this re-firing each poll.
  // That exclusion only takes effect once reload() completes, though, and
  // `actionable` is a freshly-built array every render regardless of whether
  // its contents actually changed — the same gap that let the quarterly-auto
  // effect above double-commit before its own gate closed. Guarded by key,
  // synchronously, for the same reason.
  React.useEffect(() => {
    if (actionable.length === 0) return
    let cancelled = false
    ;(async () => {
      for (const a of actionable) {
        if (cancelled) return
        // A conflict has no defensible automatic answer — it's the one case
        // where the app has done all it legitimately can and the choice is real.
        if (a.impact?.conflict) continue
        if (autoAppliedKeysRef.current.has(a.key)) continue
        autoAppliedKeysRef.current.add(a.key)
        await applyItem(a, true)
      }
    })()
    return () => { cancelled = true }
  }, [actionable, applyItem])

  // Undo appends a reverting entry rather than deleting: the log is append-only,
  // and "this was applied then undone" is worth keeping.
  const undo = (x) => commit({
    lever: x.lever, oldValue: x.newValue, newValue: x.oldValue, years: x.years ?? null,
    disposition: 'revised', trigger: 'undo',
    reason: `Undone: ${x.reason || 'auto-applied revision'}`,
    sourceKey: x.sourceKey ? `${x.sourceKey}:undone` : undefined,
  })

  // Dismiss and defer are logged, not just hidden. "Someone looked and judged it
  // immaterial" is a different fact from "nobody looked", and only the log can
  // tell them apart later.
  const disposeItem = (a, disposition) => commit({
    lever: leverOf(a.parsed.typeId), disposition, trigger: 'news',
    factType: a.parsed.typeId, reason: a.item.title, sourceKey: a.key,
    sourceItem: { title: a.item.title, url: a.item.url, date: a.item.date },
  })

  // Reported results are the most mechanical input there is — actual revenue
  // against a standing assumption, no interpretation anywhere in it. Asking
  // permission to act on arithmetic the app has already done, from numbers the
  // user pasted themselves, is the same mistake as the news prompt was.
  React.useEffect(() => {
    if (!quarterlySuggestion) return
    // Guard by CONTENT, checked synchronously before the async commit starts —
    // a content-identical suggestion re-rendered with a fresh object reference
    // (see lastAppliedSuggestionRef above) must not re-trigger commit() even
    // though the effect's own dependency array sees it as "changed".
    const signature = `${quarterlySuggestion.lever}:${quarterlySuggestion.from}:${quarterlySuggestion.to}`
    if (lastAppliedSuggestionRef.current === signature) return
    lastAppliedSuggestionRef.current = signature

    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await commit({
        lever: quarterlySuggestion.lever, years: quarterlySuggestion.years ?? null,
        oldValue: quarterlySuggestion.from, newValue: quarterlySuggestion.to,
        disposition: 'revised', trigger: 'quarterly-auto',
        steps: quarterlySuggestion.steps, reason: quarterlySuggestion.reason,
      })
    })()
    return () => { cancelled = true }
    // Once committed, the override exists and growthDriftSuggestion returns null
    // (it is gated on !overrides.growth), so this stops recomputing a truthy
    // suggestion at all once that catches up — the ref above only covers the
    // async gap until it does.
  }, [quarterlySuggestion, commit])

  return (
    <div className="bg-navy-800/40 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-slate-300 hover:text-white">
        <span>
          📌 Events &amp; revisions
          {levers.length > 0 && <span className="text-accent ml-1.5">{levers.length} applied</span>}
          {pending > 0 && <span className="text-neutral ml-1.5">· {pending} to review</span>}
          {deferredLevers.length > 0 && <span className="text-neutral ml-1.5">· {deferredLevers.join(', ')} under review</span>}
        </span>
        <span className="text-slate-500">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          {/* How the last frozen estimate has actually fared. */}
          {score && (
            <div className="bg-navy-900/60 rounded px-2.5 py-2 text-[11px]">
              <span className="text-slate-500">Last estimate, {score.elapsedDays}d ago: </span>
              <span className={score.outcome === 'below-range' ? 'text-bear'
                : score.outcome === 'above-range' ? 'text-bull' : 'text-slate-300'}>
                price is {score.outcome === 'in-range' ? 'inside the range'
                  : score.outcome === 'above-range' ? 'above the range' : 'below the range'}
              </span>
              <span className="text-slate-600"> ({score.vsBasePct >= 0 ? '+' : ''}{score.vsBasePct}% vs base)</span>
              {!score.matured && <span className="text-slate-600"> · still within its horizon</span>}
            </div>
          )}

          {/* Reported results — applied on arrival, shown here only in passing. */}
          {quarterlySuggestion && (
            <div className="border border-accent/40 rounded-lg p-2.5 space-y-1">
              <div className="text-[11px] text-slate-300">📊 {quarterlySuggestion.reason}</div>
              {quarterlySuggestion.steps.map((x, i) => (
                <div key={i} className="text-[11px] text-slate-500">{x}</div>
              ))}
              <div className="text-[11px] text-slate-500">
                applying — growth {(quarterlySuggestion.from * 100).toFixed(1)}% → {(quarterlySuggestion.to * 100).toFixed(1)}%
              </div>
            </div>
          )}

          {guidanceAssessment && !quarterlySuggestion && (
            <div className="text-[11px] text-slate-500">📊 {guidanceAssessment.note}</div>
          )}

          {/* Complete items are applied on arrival; this is only ever a brief
              flash before they move into the log below. */}
          {actionable.map(a => (
            a.impact?.conflict
              ? <ConflictFact key={a.key} a={a}
                  onUse={() => applyItem(a)} onKeep={() => keepCurrent(a)} />
              : <NewsFact key={a.key} a={a} applying
                  onDefer={() => disposeItem(a, 'deferred')}
                  onDismiss={() => disposeItem(a, 'dismissed')} />
          ))}

          {/* Items that matter but don't state their size — these hold a bar open. */}
          {incomplete.map(a => (
            <NewsFact key={a.key} a={a}
              onOpen={() => { setSeedItem(a.item); setFactOpen(true) }}
              onDefer={() => disposeItem(a, 'deferred')}
              onDismiss={() => disposeItem(a, 'dismissed')} />
          ))}

          {loading && pending === 0 && <p className="text-[11px] text-slate-600">Checking news…</p>}

          {relative?.sectorPct != null && (
            <div className="text-[11px] text-slate-500">
              Over {Math.round(relative.days / 30)} months: this stock {sign(relative.stockPct)}%
              {relative.sectorName && <> · {relative.sectorName} {sign(relative.sectorPct)}%</>}
              {relative.marketPct != null && <> · Nifty {sign(relative.marketPct)}%</>}
              {relative.vsSector != null && Math.abs(relative.vsSector) >= 3 && (
                <span className={relative.vsSector >= 0 ? 'text-bull' : 'text-bear'}>
                  {' '}({sign(relative.vsSector)}% vs its sector)
                </span>
              )}
            </div>
          )}

          {rerating?.detected && (
            <div className="text-[11px] text-neutral bg-neutral/10 rounded px-2 py-1.5">
              ⚑ {rerating.summary}
              {rerating.sectorContext && (
                <div className="text-slate-400 mt-0.5">{rerating.sectorContext.label}</div>
              )}
              <button onClick={() => setFactOpen(true)}
                className="text-accent hover:text-accent-light ml-1">review</button>
            </div>
          )}
          {peerBand && (
            <div className="text-[11px] text-slate-500">
              Peers trade at {peerBand.low}–{peerBand.high}× (median {peerBand.median}×, {peerBand.count} companies)
            </div>
          )}

          <button onClick={() => { setSeedItem(null); setFactOpen(true) }}
            className="text-[11px] text-accent hover:text-accent-light">
            + Record something else
          </button>

          {applied.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-navy-700/60">
              {applied.slice(0, 8).map(x => (
                <div key={x.id} className="text-[11px]">
                  <div className="flex items-baseline gap-2">
                    <span className="text-slate-400 capitalize">{x.lever}</span>
                    <span className="font-mono text-slate-500">
                      {fmtLever(x.lever, x.oldValue)} → {fmtLever(x.lever, x.newValue)}
                    </span>
                    <span className="text-slate-600 ml-auto shrink-0">
                      {new Date(x.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                  {x.reason && <div className="text-slate-600 truncate">{x.reason}</div>}
                  {(x.trigger === 'news-auto' || x.trigger === 'quarterly-auto') && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-600">applied automatically</span>
                      <button onClick={() => undo(x)}
                        className="text-[10px] text-slate-500 hover:text-bear">undo</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <FactInputModal
        open={factOpen} onClose={() => { setFactOpen(false); setSeedItem(null) }}
        ctx={ctx} rerating={rerating} onCommit={commit} sourceItem={seedItem} />
    </div>
  )
}

/**
 * One news-derived item. Actionable ones show the computed change and apply in a
 * tap; incomplete ones name the missing fact and open the form to supply it.
 */
function NewsFact({ a, applying, onOpen, onDefer, onDismiss }) {
  const high = a.severity === 'high'
  return (
    <div className={`rounded-lg p-2.5 space-y-1.5 border ${
      high ? 'border-neutral/40 bg-neutral/5' : 'border-navy-700'}`}>
      <div className="text-[11px] text-slate-300">{high && '⚑ '}{a.item.title}</div>

      {a.impact?.lever ? (
        <>
          {a.impact.steps.map((s, i) => <div key={i} className="text-[10px] text-slate-500">{s}</div>)}
          <div className="text-[11px]">
            <span className="text-slate-500 capitalize">{a.impact.lever}</span>{' '}
            <span className="font-mono text-slate-400">{fmtLever(a.impact.lever, a.impact.from)}</span>
            <span className="text-slate-600"> → </span>
            <span className={`font-mono ${a.impact.to > a.impact.from ? 'text-bull' : 'text-bear'}`}>
              {fmtLever(a.impact.lever, a.impact.to)}
            </span>
          </div>
        </>
      ) : (
        <div className="text-[10px] text-neutral">
          Needs {a.parsed.missing.map(m => m.ask).join(', ')} before it can be priced.
        </div>
      )}

      <div className="flex items-center gap-3 pt-0.5">
        {a.impact?.lever
          ? <span className="text-[11px] text-slate-500">applying…</span>
          : <button onClick={onOpen} className="text-[11px] text-accent hover:text-accent-light">Add the missing bit</button>}
        <button onClick={onDefer} className="text-[11px] text-slate-500 hover:text-slate-300">Defer</button>
        <button onClick={onDismiss} className="text-[11px] text-slate-600 hover:text-bear ml-auto">Not material</button>
      </div>
    </div>
  )
}

function fmtLever(lever, v) {
  if (v == null) return '—'
  return lever === 'multiple' ? `${(+v).toFixed(1)}×` : `${(v * 100).toFixed(1)}%`
}

/**
 * A forecast that contradicts the standing assumption.
 *
 * Shown rather than applied, because neither side wins on principle: the
 * assumption is measured history and stale by construction, the forecast is
 * forward-looking but from a party with no accountability. The app has extracted
 * both, identified that they collide, and computed what either would mean — the
 * remaining step is a judgement, and one tap either way records it.
 */
function ConflictFact({ a, onUse, onKeep }) {
  const cf = a.impact.conflict
  return (
    <div className="rounded-lg p-2.5 space-y-2 border border-neutral/40 bg-neutral/5">
      <div className="text-[11px] text-slate-300">{a.item.title}</div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={onKeep}
          className="text-left rounded px-2 py-1.5 border border-navy-700 hover:border-slate-500 transition-colors">
          <div className="text-[11px] text-slate-300">Keep {cf.currentPct}%</div>
          <div className="text-[10px] text-slate-600">{cf.currentLabel}</div>
        </button>
        <button onClick={onUse}
          className="text-left rounded px-2 py-1.5 border border-accent/50 hover:border-accent transition-colors">
          <div className="text-[11px] text-accent">Use {cf.proposedPct}%</div>
          <div className="text-[10px] text-slate-600">{cf.proposedLabel}</div>
        </button>
      </div>
      <div className="text-[10px] text-slate-600">{a.impact.steps[2]}</div>
    </div>
  )
}

const sign = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v)

/** Whatever AR text is available, flattened for segment extraction. */
function arTextOf(arData) {
  if (!arData) return ''
  if (typeof arData === 'string') return arData
  const parts = []
  if (arData.text) parts.push(arData.text)
  if (Array.isArray(arData.blocks)) {
    for (const b of arData.blocks) parts.push(typeof b === 'string' ? b : (b?.text || ''))
  }
  for (const v of Object.values(arData)) {
    if (typeof v === 'string' && v.length > 200) parts.push(v)
  }
  return parts.join('\n')
}

/**
 * Justified multiples and the app's own estimate.
 *
 * They answer different questions and are not two versions of one number:
 * justified multiples are a VALUATION — what the fundamentals say the business
 * is worth now, sitting alongside fair value as a second route to the same
 * question. The app target is a PROJECTION — where the price may go, from
 * what the market has paid applied to projected earnings.
 *
 * The form picker belongs to the valuation, because several forms can be
 * simultaneously valid for one company. The sector default is a rule rather than
 * a score, so it can be inspected and overridden; switching it recomputes
 * locally and triggers nothing else.
 */
function TwoEstimates({ state }) {
  const { estimate, justified, form, setForm, sanity, riskFree, refreshRate } = useEstimate(state)
  const cur = state.data?.currency === 'INR' ? '₹' : '$'
  const n = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'))
  const [showSteps, setShowSteps] = useState(false)

  if (!estimate && !justified) return null

  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-2.5 text-xs">
      {/* Estimate 1 */}
      <div>
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="text-slate-500 shrink-0 flex items-center gap-1">
            Justified Multiples
            {justified?.ok && <ProvenanceTag tier={justified.tier} compact />}
          </span>
          {justified?.ok ? (
            <span className="font-mono text-slate-200 text-right">
              {cur}{n(justified.target.low)} – {cur}{n(justified.target.high)}
              {justified.upside?.base != null && (
                <span className={`ml-1.5 text-[11px] ${justified.upside.base >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {justified.upside.base >= 0 ? '+' : ''}{justified.upside.base}%
                </span>
              )}
            </span>
          ) : <span className="text-slate-600 text-[11px] text-right">not available</span>}
        </div>
        <div className="text-[10px] text-slate-600 mt-0.5">
          {justified?.ok
            ? `${justified.multipleLabel} ${justified.multiples.base}× on current ${justified.baseLabel} · ${justified.requiredReturnLabel}`
            : (justified?.note || 'Fundamentals-based')}
          {riskFree?.asOf && justified?.ok && (
            <span className="text-slate-700"> · rate as of {riskFree.asOf}</span>
          )}
        </div>
        {(riskFree?.stale || riskFree?.rate == null) && (
          <div className="text-[10px] text-neutral mt-0.5">
            {riskFree?.note}
            <button onClick={() => refreshRate?.()}
              className="text-accent hover:text-accent-light ml-1.5">↻ refresh</button>
          </div>
        )}

        {/* Form picker — only where more than one form applies. */}
        {justified?.ok && justified.availableForms?.length > 1 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {justified.availableForms.map(f => (
              <button key={f} onClick={() => setForm(f === form ? null : f)}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  justified.form === f
                    ? 'border-accent/60 text-accent bg-navy-800'
                    : 'border-navy-700 text-slate-500 hover:text-slate-300'}`}>
                {FORM_SHORT[f] || f}
              </button>
            ))}
          </div>
        )}

        {/* The derivation was already computed (justified.multipleSteps) but
            never rendered anywhere — surfacing it here rather than adding a
            second, separate narrative. */}
        {justified?.ok && justified.multipleSteps?.length > 0 && (
          <div className="mt-1.5">
            <button onClick={() => setShowSteps(v => !v)}
              className="text-[10px] text-slate-500 hover:text-slate-300">
              {showSteps ? '▲' : '▼'} why
            </button>
            {showSteps && (
              <ul className="mt-1 space-y-0.5">
                {justified.multipleSteps.map((s, i) => (
                  <li key={i} className="text-[10px] text-slate-500">{s}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Estimate 2 */}
      <div className="pt-2 border-t border-navy-800">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="text-slate-500 shrink-0">App Target</span>
          {estimate?.ok ? (
            <span className={`font-mono text-right ${
              sanity?.reliable === false ? 'text-slate-500 line-through decoration-neutral/60' : 'text-slate-200'}`}>
              {cur}{n(estimate.target.low)} – {cur}{n(estimate.target.high)}
              {estimate.upside?.base != null && (
                <span className={`ml-1.5 text-[11px] ${estimate.upside.base >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {estimate.upside.base >= 0 ? '+' : ''}{estimate.upside.base}%
                </span>
              )}
            </span>
          ) : <span className="text-slate-600 text-[11px] text-right">not available</span>}
        </div>
        <div className="text-[10px] text-slate-600 mt-0.5">
          {estimate?.ok ? `Market-based · ${estimate.multipleLabel}` : (estimate?.note || 'Market-based')}
        </div>
      </div>
    </div>
  )
}

const FORM_SHORT = { pe: 'P/E', pb: 'P/B', evEbitda: 'EV/EBITDA', evSales: 'EV/Sales' }
