import React from 'react'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPctPlain, fmtNum, fmtMultiple } from '../../utils/format.js'

export default function FundamentalsPanel({ open, onClose }) {
  const { state } = useApp()
  const { data, ratios, quality } = state

  if (!open || !data) return null

  const cur = data.currency || 'USD'
  const sym = cur === 'INR' ? '₹' : '$'
  const unit = cur === 'INR' ? 'Cr' : 'M'
  const divisor = cur === 'INR' ? 1e7 : 1e6

  const incomeChart = data.incomeHistory.map(r => ({
    year: r.year,
    Revenue: r.revenue ? +(r.revenue / divisor).toFixed(1) : 0,
    'Net Income': r.netIncome ? +(r.netIncome / divisor).toFixed(1) : 0
  }))

  const marginChart = data.incomeHistory.map(r => ({
    year: r.year,
    'Gross %': r.revenue && r.grossProfit ? +((r.grossProfit / r.revenue) * 100).toFixed(1) : null,
    'Net %':   r.revenue && r.netIncome   ? +((r.netIncome / r.revenue) * 100).toFixed(1) : null,
    'EBITDA %': r.revenue && r.ebitda     ? +((r.ebitda / r.revenue) * 100).toFixed(1) : null
  }))

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Fundamentals Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg">✕</button>
      </div>

      {/* Quality Predictors */}
      {quality?.predictors && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Quality Score: {quality.score}/10 — {quality.label}
          </h3>
          <div className="space-y-2">
            {quality.predictors.filter(p => p.value !== null || p.key === 'consistency').map(p => (
              <div key={p.key} className="flex items-center gap-3">
                <span className={`text-lg ${p.pass === true ? 'text-bull' : p.pass === false ? 'text-bear' : 'text-slate-500'}`}>
                  {p.pass === true ? '✓' : p.pass === false ? '✗' : '—'}
                </span>
                <span className="text-sm text-slate-300 flex-1">{p.label}</span>
                <span className="text-sm font-mono text-slate-400">
                  {p.value != null ? (p.key.includes('margin') || p.key === 'roe' || p.key === 'fcfConversion' || p.key === 'revenueGrowth'
                    ? p.value.toFixed(1) + '%'
                    : p.value.toFixed(2)) : '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revenue & Income Chart */}
      {incomeChart.length > 1 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Revenue vs Net Income ({unit})
          </h3>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={incomeChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={40} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#e2e8f0' }}
              />
              <Bar dataKey="Revenue"    fill="#6366f1" radius={[3,3,0,0]} />
              <Bar dataKey="Net Income" fill="#22c55e" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Margin Chart */}
      {marginChart.length > 1 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Margin Trends (%)</h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={marginChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={35} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              />
              <Line type="monotone" dataKey="Gross %"  stroke="#6366f1" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="EBITDA %" stroke="#f59e0b" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="Net %"    stroke="#22c55e" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Key Ratios Grid */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Key Ratios</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {[
            { label: 'ROE',             value: fmtPctPlain(ratios?.roe) },
            { label: 'ROCE',            value: fmtPctPlain(ratios?.roce) },
            { label: 'Gross Margin',    value: fmtPctPlain(ratios?.grossMargin) },
            { label: 'EBITDA Margin',   value: fmtPctPlain(ratios?.ebitdaMargin) },
            { label: 'Net Margin',      value: fmtPctPlain(ratios?.netMargin) },
            { label: 'Revenue 5yr CAGR',value: fmtPctPlain(ratios?.revCagr) },
            { label: 'Debt / Equity',   value: fmtMultiple(ratios?.de, 'x') },
            { label: 'Interest Cover',  value: fmtMultiple(ratios?.interestCoverage, 'x') },
            { label: 'FCF Conversion',  value: fmtPctPlain(ratios?.fcfConversion) },
            { label: 'Current Ratio',   value: fmtMultiple(data?.ttm?.currentRatio, 'x') },
            { label: 'EPS',             value: ratios?.eps != null ? sym + ratios.eps.toFixed(2) : '—' },
            { label: 'Book Value/Share',value: ratios?.bookPerShare != null ? sym + ratios.bookPerShare.toFixed(2) : '—' }
          ].map(r => (
            <div key={r.label} className="card-sm">
              <div className="text-xs text-slate-400">{r.label}</div>
              <div className="font-mono text-white font-semibold text-sm">{r.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
