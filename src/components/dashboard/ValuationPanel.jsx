import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPct, fmtPctPlain } from '../../utils/format.js'
import DCFScenarioPanel from './DCFScenarioPanel.jsx'
import { buildEstimate } from '../../engine/estimate.js'
import { useEstimate } from '../../store/useEstimate.js'
import FactInputModal from './FactInputModal.jsx'
import { useNewsFacts, keyOf, leverOf } from '../../store/useNewsFacts.js'
import { computeFact } from '../../engine/factImpact.js'
import { extractSegmentShares } from '../../engine/segmentShare.js'

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
      <TwoEstimates state={state} />

      <EstimateExplainer ratioResult={state.ratioResult} data={state.data} assumptions={state.assumptions} />

      {/* Revisions live next to the working, not in a separate screen: the
          number, how it was derived, and what has been changed about it are one
          subject. */}
      <EstimateRevisions state={state} />

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
        lever: imp.lever, oldValue: imp.from ?? null, newValue: imp.to,
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
  React.useEffect(() => {
    if (actionable.length === 0) return
    let cancelled = false
    ;(async () => {
      for (const a of actionable) {
        if (cancelled) return
        // A conflict has no defensible automatic answer — it's the one case
        // where the app has done all it legitimately can and the choice is real.
        if (a.impact?.conflict) continue
        await applyItem(a, true)
      }
    })()
    return () => { cancelled = true }
  }, [actionable, applyItem])

  // Undo appends a reverting entry rather than deleting: the log is append-only,
  // and "this was applied then undone" is worth keeping.
  const undo = (x) => commit({
    lever: x.lever, oldValue: x.newValue, newValue: x.oldValue,
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
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await commit({
        lever: quarterlySuggestion.lever,
        oldValue: quarterlySuggestion.from, newValue: quarterlySuggestion.to,
        disposition: 'revised', trigger: 'quarterly-auto',
        steps: quarterlySuggestion.steps, reason: quarterlySuggestion.reason,
      })
    })()
    return () => { cancelled = true }
    // Once committed, the override exists and growthDriftSuggestion returns null
    // (it is gated on !overrides.growth), so this cannot re-fire.
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
 * Both estimates, side by side.
 *
 * Estimate 1 asks what the fundamentals justify; Estimate 2 asks what the market
 * has been paying. They answer different questions, so they are shown rather
 * than reconciled — a persistent gap is the cheap/expensive reading arrived at
 * two independent ways, not an error in either.
 *
 * The form picker sits under Estimate 1 because several forms can be
 * simultaneously valid for one company. The sector default is a rule rather than
 * a score, so it can be inspected and overridden; switching it recomputes
 * locally and triggers nothing else.
 */
function TwoEstimates({ state }) {
  const { estimate, justified, form, setForm, sanity, riskFree } = useEstimate(state)
  const cur = state.data?.currency === 'INR' ? '₹' : '$'
  const n = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'))

  if (!estimate && !justified) return null

  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-2.5 text-xs">
      {/* Estimate 1 */}
      <div>
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="text-slate-500 shrink-0">Estimate 1</span>
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
            ? `${justified.multipleLabel} ${justified.multiples.base}× · ${justified.requiredReturnLabel}`
            : (justified?.note || 'Fundamentals-based')}
          {riskFree?.asOf && justified?.ok && (
            <span className="text-slate-700"> · rate as of {riskFree.asOf}</span>
          )}
        </div>
        {riskFree?.stale && (
          <div className="text-[10px] text-neutral mt-0.5">{riskFree.note}</div>
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
      </div>

      {/* Estimate 2 */}
      <div className="pt-2 border-t border-navy-800">
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <span className="text-slate-500 shrink-0">Estimate 2</span>
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
