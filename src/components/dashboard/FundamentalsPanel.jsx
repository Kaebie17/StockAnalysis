import React from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPctPlain, fmtMultiple } from '../../utils/format.js'

function ProgressBar({ value, max, color }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100)
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-2 bg-navy-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function FundamentalsPanel({ open, onClose }) {
  const { state } = useApp()
  const { data, ratios, quality } = state
  if (!open || !data) return null

  const cur      = data.currency === 'INR' ? '₹' : '$'
  const divisor  = data.currency === 'INR' ? 1e7 : 1e6
  const unit     = data.currency === 'INR' ? 'Cr' : 'M'

  const incomeChart = data.incomeHistory.map(r => ({
    year: r.year,
    Revenue:    r.revenue    ? +(r.revenue    / divisor).toFixed(0) : 0,
    NetIncome:  r.netIncome  ? +(r.netIncome  / divisor).toFixed(0) : 0
  }))

  const marginChart = data.incomeHistory.map(r => ({
    year: r.year,
    'Gross %':  r.grossProfit && r.revenue ? +((r.grossProfit / r.revenue) * 100).toFixed(1) : null,
    'EBITDA %': r.ebitda      && r.revenue ? +((r.ebitda      / r.revenue) * 100).toFixed(1) : null,
    'Net %':    r.netIncome   && r.revenue ? +((r.netIncome   / r.revenue) * 100).toFixed(1) : null
  }))

  const ttip = {
    contentStyle: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 },
    labelStyle: { color: '#94a3b8' }
  }

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">📊 Fundamentals Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
      </div>

      {/* Quality Predictors */}
      {quality?.predictors && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Quality Score — {quality.score}/10
            </div>
            <span className={`badge ${quality.label === 'EXCELLENT' ? 'badge-bull' : quality.label === 'HEALTHY' ? 'badge-bull' : quality.label === 'WEAK' ? 'badge-bear' : 'badge-neutral'}`}>
              {quality.label}
            </span>
          </div>
          <div className="space-y-2.5">
            {quality.predictors.filter(p => p.value !== null || p.key === 'consistency').map(p => {
              const isPass = p.pass === true
              const isFail = p.pass === false
              const valStr = p.value != null
                ? (p.key.includes('margin') || p.key === 'roe' || p.key === 'roce' || p.key === 'revenueGrowth' || p.key === 'fcfConversion'
                    ? p.value.toFixed(1) + '%'
                    : p.value.toFixed(2))
                : p.key === 'consistency' ? (p.pass ? 'Profitable 3+/5yr' : 'Inconsistent') : '—'
              const pctOfMax = p.threshold ? Math.min((Math.abs(p.value || 0) / (p.threshold * 2)) * 100, 100) : 50

              return (
                <div key={p.key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm w-5 ${isPass ? 'text-bull' : isFail ? 'text-bear' : 'text-slate-500'}`}>
                      {isPass ? '✓' : isFail ? '✗' : '—'}
                    </span>
                    <span className="text-xs text-slate-300 flex-1">{p.label}</span>
                    <span className="text-xs font-mono text-slate-300 w-16 text-right">{valStr}</span>
                  </div>
                  {p.value != null && (
                    <div className="flex items-center gap-2 pl-7">
                      <ProgressBar
                        value={Math.abs(p.value || 0)}
                        max={p.threshold ? p.threshold * 2 : 100}
                        color={isPass ? 'bg-bull' : 'bg-bear'}
                      />
                      {p.threshold && (
                        <span className="text-xs text-slate-600 shrink-0">target: {p.threshold}{p.key.includes('De') ? '×' : '%'}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Revenue & Income Chart */}
      {incomeChart.length > 1 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Revenue vs Net Income ({unit})
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={incomeChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={45} />
              <Tooltip {...ttip} />
              <Bar dataKey="Revenue"   fill="#6366f1" radius={[3,3,0,0]} />
              <Bar dataKey="NetIncome" fill="#22c55e" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Margin Trend */}
      {marginChart.filter(r => r['Net %'] != null).length > 1 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Margin Trend (%)</div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={marginChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={35} />
              <Tooltip {...ttip} />
              <Line type="monotone" dataKey="Gross %"  stroke="#6366f1" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="EBITDA %" stroke="#f59e0b" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="Net %"    stroke="#22c55e" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Key Ratios Grid */}
      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Key Ratios</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[
            { label: 'ROE',              value: fmtPctPlain(ratios?.roe) },
            { label: 'ROCE',             value: fmtPctPlain(ratios?.roce) },
            { label: 'Gross Margin',     value: fmtPctPlain(ratios?.grossMargin) },
            { label: 'EBITDA Margin',    value: fmtPctPlain(ratios?.ebitdaMargin) },
            { label: 'Net Margin',       value: fmtPctPlain(ratios?.netMargin) },
            { label: 'Revenue 5yr CAGR', value: fmtPctPlain(ratios?.revCagr) },
            { label: 'Debt / Equity',    value: ratios?.de        != null ? `${ratios.de.toFixed(2)}×`     : '—' },
            { label: 'Interest Cover',   value: ratios?.interestCoverage != null ? `${ratios.interestCoverage.toFixed(1)}×` : '—' },
            { label: 'FCF Conversion',   value: fmtPctPlain(ratios?.fcfConversion) },
            { label: 'Current Ratio',    value: data?.ttm?.currentRatio != null ? `${data.ttm.currentRatio.toFixed(2)}×` : '—' },
            { label: 'EPS',              value: ratios?.eps  != null ? `${cur}${ratios.eps.toFixed(2)}` : '—' },
            { label: 'Book Value/Share', value: ratios?.bookPerShare != null ? `${cur}${ratios.bookPerShare.toFixed(2)}` : '—' }
          ].map(r => (
            <div key={r.label} className="card-sm">
              <div className="text-xs text-slate-400">{r.label}</div>
              <div className="font-mono text-white text-sm font-semibold">{r.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
