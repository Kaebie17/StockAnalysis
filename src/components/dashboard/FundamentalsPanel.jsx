// FundamentalsPanel.jsx
import React from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtCompact, fmtPctAbs, fmt, fmtMultiple } from '../../utils/format.js'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ReferenceLine
} from 'recharts'

export default function FundamentalsPanel() {
  const { state } = useApp()
  const { fundScore, data, histRatios, ratios } = state

  if (!fundScore || !data) return null
  if (state.expandedPanel !== 'fundamentals') return null

  const currency = data.currency ?? 'USD'

  // Build chart data from historical ratios (oldest → newest)
  const chartData = (histRatios ?? []).map(h => ({
    year:         h.date?.slice(0, 4) ?? '',
    revenue:      h.revenue,
    netIncome:    h.netIncome,
    fcf:          h.fcf,
    grossMargin:  h.grossMargin,
    ebitdaMargin: h.ebitdaMargin,
    netMargin:    h.netMargin,
    deRatio:      h.deRatio,
  }))

  return (
    <div className="card px-5 py-4 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display font-semibold text-slate-100">Fundamental Quality</h3>
        <span className="text-xs text-slate-500">{fundScore.results.filter(r => r.pass).length}/{fundScore.results.length} checks pass</span>
      </div>

      {/* Predictor results */}
      <div className="space-y-2">
        {fundScore.results.map(r => (
          <div key={r.id} className="card-inner px-4 py-3 flex items-center gap-4">
            <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0
              ${r.pass ? 'bg-green-500/20 text-accent-green' : 'bg-red-500/20 text-accent-red'}`}>
              {r.pass ? '✓' : '✗'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-200">{r.label}</p>
              <p className="text-xs text-slate-500">{r.desc}</p>
            </div>
            <div className="text-right">
              {r.value != null ? (
                <span className="font-mono text-sm text-slate-300">
                  {r.unit === '%' ? fmtPctAbs(r.value) : r.unit === 'x' ? fmtMultiple(r.value) : fmt(r.value)}{' '}
                  {!['%','x',''].includes(r.unit) && <span className="text-slate-500">{r.unit}</span>}
                </span>
              ) : (
                <span className="text-slate-600 text-sm">—</span>
              )}
            </div>
            <div className="text-right w-14 text-xs text-slate-500">
              wt {r.weight}%
            </div>
          </div>
        ))}
      </div>

      {/* Key ratios snapshot */}
      {ratios && (
        <div>
          <p className="label mb-2">Key Ratios (Latest)</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Gross Margin', value: fmtPctAbs(ratios.grossMargin) },
              { label: 'EBITDA Margin', value: fmtPctAbs(ratios.ebitdaMargin) },
              { label: 'Net Margin', value: fmtPctAbs(ratios.netMargin) },
              { label: 'ROE', value: fmtPctAbs(ratios.roe) },
              { label: 'ROCE', value: fmtPctAbs(ratios.roce) },
              { label: 'D/E Ratio', value: fmtMultiple(ratios.deRatio) },
              { label: 'FCF Yield', value: fmtPctAbs(ratios.fcfYield) },
              { label: 'FCF Conversion', value: fmtPctAbs(ratios.fcfConversion) },
            ].map(({ label, value }) => (
              <div key={label} className="card-inner px-3 py-2">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="font-mono text-sm text-slate-200 mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5-year trend charts */}
      {chartData.length > 1 && (
        <div className="space-y-4">
          <p className="label">5-Year Trends</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ChartCard title="Revenue & Net Income" currency={currency}>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} barGap={2}>
                  <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <Tooltip content={<CompactTooltip currency={currency} isCompact />} />
                  <Bar dataKey="revenue"   fill="#818cf8" radius={[3,3,0,0]} name="Revenue" />
                  <Bar dataKey="netIncome" fill="#4ade80" radius={[3,3,0,0]} name="Net Income" />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex gap-4 mt-1">
                <Legend color="bg-accent-indigo" label="Revenue" />
                <Legend color="bg-accent-green"  label="Net Income" />
              </div>
            </ChartCard>

            <ChartCard title="Margins (%)" currency={currency}>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={chartData}>
                  <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <Tooltip content={<CompactTooltip suffix="%" />} />
                  <ReferenceLine y={0} stroke="#334155" />
                  <Line type="monotone" dataKey="grossMargin"  stroke="#22d3ee" dot={false} strokeWidth={1.5} name="Gross" />
                  <Line type="monotone" dataKey="ebitdaMargin" stroke="#818cf8" dot={false} strokeWidth={1.5} name="EBITDA" />
                  <Line type="monotone" dataKey="netMargin"    stroke="#4ade80" dot={false} strokeWidth={1.5} name="Net" />
                </LineChart>
              </ResponsiveContainer>
              <div className="flex gap-4 mt-1">
                <Legend color="bg-accent-cyan"   label="Gross" />
                <Legend color="bg-accent-indigo" label="EBITDA" />
                <Legend color="bg-accent-green"  label="Net" />
              </div>
            </ChartCard>

            <ChartCard title="Free Cash Flow" currency={currency}>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData}>
                  <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <Tooltip content={<CompactTooltip currency={currency} isCompact />} />
                  <ReferenceLine y={0} stroke="#334155" />
                  <Bar dataKey="fcf" name="FCF"
                    fill="#22d3ee"
                    radius={[3,3,0,0]}
                    // Negative FCF bars in red
                    label={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="D/E Ratio" currency={currency}>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={chartData}>
                  <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <Tooltip content={<CompactTooltip suffix="x" />} />
                  <Line type="monotone" dataKey="deRatio" stroke="#fbbf24" dot={false} strokeWidth={1.5} name="D/E" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  )
}

function ChartCard({ title, children }) {
  return (
    <div className="card-inner px-3 py-3">
      <p className="text-xs text-slate-500 mb-2">{title}</p>
      {children}
    </div>
  )
}

function Legend({ color, label }) {
  return (
    <div className="flex items-center gap-1">
      <div className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  )
}

function CompactTooltip({ active, payload, label, suffix, isCompact, currency }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-800 border border-slate-600 rounded-lg px-2 py-1.5 text-xs shadow-xl">
      <p className="text-slate-400 mb-1">{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {isCompact
            ? fmtCompact(p.value, currency)
            : `${p.value?.toFixed(1)}${suffix ?? ''}`}
        </p>
      ))}
    </div>
  )
}


