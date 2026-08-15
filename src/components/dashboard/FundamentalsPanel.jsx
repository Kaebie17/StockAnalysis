import React, { useState } from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip as RTooltip,
         ResponsiveContainer, CartesianGrid } from 'recharts'
import { useApp } from '../../store/AppContext.jsx'
import { useEstimate } from '../../store/useEstimate.js'
import { fmtPctPlain, fmtMultiple, fmtCurrency, resolutionBadge, fmtTagged } from '../../utils/format.js'

// Small tooltip showing formula/resolution on hover
function ResTag({ tagged }) {
  const badge = resolutionBadge(tagged)
  if (!badge || tagged?.status === 'source') return null
  return (
    <span className="relative group ml-1 cursor-help">
      <span className={`text-xs ${badge.color}`}>{badge.icon}</span>
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-navy-700
                       text-xs text-slate-200 whitespace-nowrap z-50 invisible group-hover:visible
                       border border-navy-600 shadow-lg max-w-xs text-center">
        {badge.tooltip}
      </span>
    </span>
  )
}

function RatioCard({ label, tagged, fmt }) {
  const display = tagged?.value != null ? fmt(tagged.value) : '—'
  const badge   = resolutionBadge(tagged)
  return (
    <div className="card-sm group relative">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="font-mono text-white text-sm font-semibold flex items-center gap-1">
        {display}
        <ResTag tagged={tagged} />
      </div>
      {tagged?.value == null && tagged?.status === 'unavailable' && (
        <div className="text-xs text-slate-600 mt-0.5">Not available</div>
      )}
    </div>
  )
}

// Progress bar row for quality predictor
function PredictorRow({ predictor }) {
  const { label, value, pass, weight, key, threshold, tagged } = predictor
  const isPass = pass === true, isFail = pass === false
  const valStr = value != null
    ? (['revenueGrowth','grossMargin','ebitdaMargin','netMargin','roe','roce','fcfConversion']
        .includes(key) ? fmtPctPlain(value) : value.toFixed(2))
    : '—'
  const pct = threshold ? Math.min((Math.abs(value || 0) / (threshold * 2)) * 100, 100) : 50

  return (
    <div className="space-y-1 py-1.5 border-b border-navy-800/40 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`text-sm w-5 shrink-0 ${isPass ? 'text-bull' : isFail ? 'text-bear' : 'text-slate-500'}`}>
          {isPass ? '✓' : isFail ? '✗' : '—'}
        </span>
        <span className="text-xs text-slate-300 flex-1">{label}</span>
        <span className="text-xs font-mono text-slate-300 w-16 text-right">{valStr}</span>
        {tagged && <ResTag tagged={tagged} />}
      </div>
      {value != null && (
        <div className="flex items-center gap-2 pl-7">
          <div className="flex-1 h-1.5 bg-navy-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${isPass ? 'bg-bull' : 'bg-bear'}`} style={{ width: `${pct}%` }} />
          </div>
          {threshold && (
            <span className="text-xs text-slate-600 shrink-0 w-20 text-right">
              target {threshold}{key === 'de' ? '×' : '%'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// Scoring weights — moved here from the old Scoring Studio gear. Fundamentals
// scoring is a fundamentals concern, so it lives in the fundamentals block.
const FUNDAMENTAL_WEIGHTS = [
  { key: 'revenueGrowth',    label: 'Revenue Growth (5yr CAGR)', defaultW: 1.5 },
  { key: 'grossMargin',      label: 'Gross Margin',              defaultW: 1 },
  { key: 'ebitdaMargin',     label: 'EBITDA Margin',             defaultW: 1 },
  { key: 'netMargin',        label: 'Net Margin',                defaultW: 1 },
  { key: 'fcfConversion',    label: 'FCF Conversion',            defaultW: 1.5 },
  { key: 'debtTrend',        label: 'Debt Management',           defaultW: 1 },
  { key: 'roe',              label: 'Return on Equity',          defaultW: 1.5 },
  { key: 'interestCoverage', label: 'Interest Coverage',         defaultW: 1 },
  { key: 'consistency',      label: 'Earnings Consistency',      defaultW: 1 },
]

export default function FundamentalsPanel({ open, onClose }) {
  const { state, recalc } = useApp()
  const { data, quality } = state
  const ratios = state.ratioResult?.ratios  // tagged ratios
  const r      = state.ratioResult          // scalar values
  const weights = state.scoreWeights || {}
  const [showWeights, setShowWeights] = useState(false)

  if (!open || !data) return null

  const updateWeight = (key, value) => recalc({}, { [key]: parseFloat(value) })
  const resetWeights = () => recalc({}, Object.fromEntries(FUNDAMENTAL_WEIGHTS.map(w => [w.key, w.defaultW])))

  const cur     = data.currency === 'INR' ? '₹' : '$'
  // The 5-year CAGR uses min(5, available), so on a short history it spans
  // fewer years than its name suggests. The label follows the actual span.
  const cagrYears = Math.min(5, Math.max(1, (data.incomeHistory || []).length - 1))
  const div     = data.currency === 'INR' ? 1e7 : 1e6
  const unit    = data.currency === 'INR' ? 'Cr' : 'M'

  const incomeChart = data.incomeHistory.map(row => ({
    year:      row.year,
    Revenue:   row.revenue?.value     != null ? +(row.revenue.value     / div).toFixed(0) : null,
    NetProfit: row.netProfit?.value   != null ? +(row.netProfit.value   / div).toFixed(0) : null,
    OpProfit:  row.operatingProfit?.value != null ? +(row.operatingProfit.value / div).toFixed(0) : null,
  })).filter(r => r.Revenue != null)

  const marginChart = data.incomeHistory.map(row => {
    const rev = row.revenue?.value
    const np  = row.netProfit?.value
    const op  = row.operatingProfit?.value
    const eb  = row.ebitda?.value
    return {
      year:       row.year,
      'Op Margin %':    rev && op  ? +((op / rev) * 100).toFixed(1) : null,
      'EBITDA %':       rev && eb  ? +((eb / rev) * 100).toFixed(1) : null,
      'Net Margin %':   rev && np  ? +((np / rev) * 100).toFixed(1) : null,
    }
  })

  const ttip = {
    contentStyle: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 },
    labelStyle: { color: '#94a3b8' }
  }

  const ps = data.parserStatus || state.data?.parserStatus
  const showParserWarning = ps?.degraded

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">📊 Fundamentals Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
      </div>

      {showParserWarning && (
        <div className="card-sm border-neutral/30 bg-neutral/5 text-xs text-neutral">
          ⚠️ {ps.message}
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-slate-500">
        <span><span className="text-accent/70">⚙</span> Calculated by StockAnalyzr</span>
        <span><span className="text-neutral/70">T</span> TTM from source</span>
        <span><span className="text-neutral/70">~</span> Proxy value</span>
        <span><span className="text-accent/70">↔</span> Cross-source fill</span>
      </div>

      {/* Quality predictors */}
      {quality?.predictors && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Quality Score — {quality.score}/10
            </span>
            <span className={`badge ${quality.label === 'EXCELLENT' || quality.label === 'HEALTHY' ? 'badge-bull' : quality.label === 'WEAK' ? 'badge-bear' : 'badge-neutral'}`}>
              {quality.label}
            </span>
          </div>
          <div>
            {quality.predictors.map(p => (
              <PredictorRow key={p.key} predictor={p} />
            ))}
          </div>

          {/* Scoring weights — how much each predictor counts toward the score */}
          <div className="mt-2 flex items-center gap-3">
            <button onClick={() => setShowWeights(!showWeights)}
              className="text-xs text-accent hover:text-accent-light">
              {showWeights ? '▲ Hide scoring weights' : '▼ Adjust scoring weights ✎'}
            </button>
            {showWeights && (
              <button onClick={resetWeights} className="text-xs text-slate-500 hover:text-slate-300">↺ Reset</button>
            )}
          </div>
          {showWeights && (
            <div className="mt-2 space-y-2 bg-navy-800/40 rounded-lg p-3">
              <p className="text-[10px] text-slate-500">How much each predictor contributes to the quality score (0–3).</p>
              {FUNDAMENTAL_WEIGHTS.map(({ key, label, defaultW }) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-xs text-slate-300 flex-1">{label}</span>
                  <input type="range" min={0} max={3} step={0.5}
                    value={weights[key] ?? defaultW}
                    onChange={e => updateWeight(key, e.target.value)}
                    className="w-24 accent-accent" />
                  <span className="text-xs text-white font-mono w-6 text-right">
                    {(weights[key] ?? defaultW).toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Revenue chart */}
      {incomeChart.length > 1 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Revenue & Profits ({unit})
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={incomeChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={50} />
              <RTooltip {...ttip} />
              <Bar dataKey="Revenue"   fill="#6366f1" radius={[3,3,0,0]} />
              <Bar dataKey="OpProfit"  fill="#f59e0b" radius={[3,3,0,0]} />
              <Bar dataKey="NetProfit" fill="#22c55e" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Margin chart */}
      {marginChart.filter(r => r['Net Margin %'] != null).length > 1 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Margin Trends (%)</div>
          <ResponsiveContainer width="100%" height={130}>
            <LineChart data={marginChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={35} />
              <RTooltip {...ttip} />
              <Line type="monotone" dataKey="Op Margin %"  stroke="#6366f1" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="EBITDA %"     stroke="#f59e0b" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="Net Margin %" stroke="#22c55e" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Key ratios grid */}
      {ratios && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Key Ratios</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <RatioCard label="ROE"             tagged={ratios.roe}          fmt={v => fmtPctPlain(v)} />
            <RatioCard label="ROCE"            tagged={ratios.roce}         fmt={v => fmtPctPlain(v)} />
            <RatioCard label="ROA"             tagged={ratios.roa}          fmt={v => fmtPctPlain(v)} />
            <RatioCard label="Op. Margin"      tagged={ratios.operatingMargin} fmt={v => fmtPctPlain(v)} />
            <RatioCard label="EBITDA Margin"   tagged={ratios.ebitdaMargin} fmt={v => fmtPctPlain(v)} />
            <RatioCard label="Net Margin"      tagged={ratios.netMargin}    fmt={v => fmtPctPlain(v)} />
            {/* The underlying calculation uses min(5, available), so on a short
                history this is a 2- or 3-year figure. Labelling it "5Y"
                regardless states something untrue about the data. */}
            <RatioCard label={`Rev CAGR (${cagrYears}Y)`} tagged={ratios.revCagr5y} fmt={v => fmtPctPlain(v)} />
            <RatioCard label="Debt / Equity"   tagged={ratios.de}           fmt={v => fmtMultiple(v)} />
            <RatioCard label="Interest Cover"  tagged={ratios.icr}          fmt={v => fmtMultiple(v)} />
            <RatioCard label="FCF Conversion"  tagged={ratios.fcfConversion} fmt={v => fmtPctPlain(v)} />
            <RatioCard label="EPS"             tagged={ratios.eps}          fmt={v => `${cur}${v.toFixed(2)}`} />
            <RatioCard label="Book Value/Sh"   tagged={ratios.bookPerShare}  fmt={v => `${cur}${v.toFixed(2)}`} />
          </div>

          {/* Growth window. Placed here rather than in an estimate's popover
              because it drives far more than one number — both estimates, the
              health bars, the exit triggers and market expectation all read this
              rate. The choice belongs with the evidence it's made from. */}
          <GrowthWindowPicker />
        </div>
      )}
    </div>
  )
}


/**
 * Which stretch of history the growth rate is measured over.
 *
 * Stores the YEAR COUNT, not the rate. A window is a standing preference about
 * which history to trust, so it is re-derived from current data each time —
 * pinning the rate instead would freeze a number that silently goes stale as new
 * years arrive.
 *
 * Options come from what this stock actually has, since "long run" means eight
 * years on one company and twelve on another.
 */
function GrowthWindowPicker() {
  const { state } = useApp()
  const { growthWindow, setGrowthWindow, estimate } = useEstimate(state)

  const years = (state.data?.incomeHistory || [])
    .map(r => String(r?.year ?? '').match(/(?:19|20)\d{2}/)?.[0])
    .filter(Boolean).length
  if (years < 3) return null

  // Only windows the history can actually support, plus the full span.
  const options = [3, 5, 7, 10].filter(y => y <= years - 1)
  if (years - 1 > 10) options.push(years - 1)
  if (options.length < 2) return null

  const activeRate = estimate?.growthPct

  return (
    <div className="mt-3 pt-3 border-t border-navy-800">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[11px] text-slate-500">Growth measured over</span>
        {options.map(y => (
          <button key={y}
            onClick={() => setGrowthWindow(growthWindow === y ? null : y)}
            className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
              growthWindow === y
                ? 'border-accent/60 text-accent bg-navy-800'
                : 'border-navy-700 text-slate-500 hover:text-slate-300'}`}>
            {y}yr
          </button>
        ))}
        {growthWindow && (
          <button onClick={() => setGrowthWindow(null)}
            className="text-[10px] text-slate-600 hover:text-slate-400">default</button>
        )}
        {activeRate != null && (
          <span className="text-[11px] text-slate-400 ml-auto">
            {activeRate}% {estimate?.growthLabel ? `· ${estimate.growthLabel}` : ''}
          </span>
        )}
      </div>
      <p className="text-[10px] text-slate-600 mt-1">
        Changes both estimates, the health bars and the exit levels. Where the history is
        shorter than the window, everything available is used and the label says so.
      </p>
    </div>
  )
}
