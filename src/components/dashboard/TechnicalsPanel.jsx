// TechnicalsPanel.jsx
import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmt, fmtVolume, fmtPctAbs, fmtPrice } from '../../utils/format.js'
import {
  ResponsiveContainer, ComposedChart, LineChart, BarChart,
  Line, Bar, XAxis, YAxis, Tooltip, ReferenceLine, Area
} from 'recharts'

export default function TechnicalsPanel() {
  const { state } = useApp()
  const { technicals, techScore, data } = state
  const [chartRange, setChartRange] = useState(90)

  if (!techScore || !data) return null
  if (state.expandedPanel !== 'technicals') return null

  const currency = data.currency ?? 'USD'
  const price    = data.price

  const hasData = technicals && !technicals.error
  const lat     = technicals?.latest ?? {}

  // Build chart series — slice to requested range
  const priceHistory = data.priceHistory ?? []
  const sliced       = priceHistory.slice(-chartRange)
  const rsiSeries    = (technicals?.series?.rsi ?? []).slice(-chartRange)
  const macdSeries   = (technicals?.series?.macdLine ?? []).slice(-chartRange)
  const histSeries   = (technicals?.series?.histogram ?? []).slice(-chartRange)
  const sma50series  = (technicals?.series?.sma50?.values ?? []).slice(-chartRange)
  const sma200series = (technicals?.series?.sma200?.values ?? []).slice(-chartRange)

  const priceChartData = sliced.map((d, i) => ({
    date:   d.date?.slice(5),  // MM-DD
    close:  d.close,
    volume: d.volume,
    sma50:  sma50series[i]  ?? null,
    sma200: sma200series[i] ?? null,
    rsi:    rsiSeries[i]    ?? null,
    macd:   macdSeries[i]   ?? null,
    hist:   histSeries[i]   ?? null,
  }))

  return (
    <div className="card px-5 py-4 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-display font-semibold text-slate-100">Technical Detail</h3>
        <div className="flex items-center gap-1">
          {[30, 90, 180, 365].map(d => (
            <button
              key={d}
              onClick={() => setChartRange(d)}
              className={`px-2.5 py-1 rounded-lg text-xs transition-colors
                ${chartRange === d ? 'bg-accent-cyan text-surface-900 font-medium' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {d}D
            </button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <div className="text-slate-500 text-sm py-4 text-center">
          {technicals?.error ?? 'No price history available for technical analysis.'}
        </div>
      ) : (
        <>
          {/* Signal grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SignalTile
              label="Trend"
              value={lat.goldenCross ? 'Uptrend' : lat.deathCross ? 'Downtrend' : 'Mixed'}
              sub={lat.recentCross
                ? `${lat.recentCross.type === 'GOLDEN' ? '⚡ Golden' : '☠️ Death'} Cross ${lat.recentCross.daysAgo}d ago`
                : `SMA50 ${lat.sma50 ? fmtPrice(lat.sma50, currency) : '—'}`}
              positive={lat.goldenCross}
              negative={lat.deathCross}
            />
            <SignalTile
              label={`RSI (14)`}
              value={lat.rsi != null ? lat.rsi.toFixed(1) : '—'}
              sub={lat.rsi > 70 ? 'Overbought' : lat.rsi < 30 ? 'Oversold' : lat.rsi >= 50 ? 'Bullish territory' : 'Bearish territory'}
              positive={lat.rsi >= 40 && lat.rsi <= 70}
              negative={lat.rsi > 80 || lat.rsi < 25}
            />
            <SignalTile
              label="MACD"
              value={lat.macd != null ? (lat.macd >= lat.macdSignal ? 'Bullish' : 'Bearish') : '—'}
              sub={`Hist ${lat.macdHist != null ? lat.macdHist.toFixed(3) : '—'}`}
              positive={lat.macd != null && lat.macd > lat.macdSignal}
              negative={lat.macd != null && lat.macd < lat.macdSignal}
            />
            <SignalTile
              label="Volume"
              value={lat.volumeRatio != null ? `${lat.volumeRatio.toFixed(1)}x avg` : '—'}
              sub={`OBV ${lat.obvTrend === 'RISING' ? '↑ Accumulation' : '↓ Distribution'}`}
              positive={lat.volumeRatio > 1.2 && lat.obvTrend === 'RISING'}
              negative={lat.obvTrend === 'FALLING'}
            />
          </div>

          {/* Divergence alert */}
          {(lat.divergence?.bullish || lat.divergence?.bearish) && (
            <div className={`card-inner px-4 py-3 border ${lat.divergence.bullish ? 'border-green-500/30' : 'border-red-500/30'}`}>
              <p className="text-sm font-medium text-slate-200">
                {lat.divergence.bullish ? '🔍 Bullish RSI Divergence Detected' : '🔍 Bearish RSI Divergence Detected'}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                {lat.divergence.bullish
                  ? 'Price making lower lows while RSI makes higher lows — potential upside reversal ahead.'
                  : 'Price making higher highs while RSI makes lower highs — potential downside reversal ahead.'}
              </p>
            </div>
          )}

          {/* Candlestick patterns */}
          {lat.patterns && lat.patterns.length > 0 && (
            <div>
              <p className="label mb-2">Recent Candlestick Patterns</p>
              <div className="flex flex-wrap gap-2">
                {lat.patterns.map((p, i) => (
                  <div key={i} className={`card-inner px-3 py-2 flex items-center gap-2
                    ${p.signal === 'BULLISH' ? 'border-green-500/30' : p.signal === 'BEARISH' ? 'border-red-500/30' : ''}`}>
                    <span className="text-sm">
                      {p.signal === 'BULLISH' ? '🟢' : p.signal === 'BEARISH' ? '🔴' : '🟡'}
                    </span>
                    <div>
                      <p className="text-xs font-medium text-slate-200">{p.name}</p>
                      <p className="text-xs text-slate-500">{p.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Predictor detail */}
          <div>
            <p className="label mb-2">Technical Predictor Breakdown</p>
            <div className="space-y-2">
              {techScore.results.map(r => (
                <div key={r.id} className="card-inner px-4 py-2.5 flex items-center gap-3">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-xs
                    ${r.pass ? 'bg-green-500/20 text-accent-green' : 'bg-red-500/20 text-accent-red'}`}>
                    {r.pass ? '✓' : '✗'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-300">{r.label}</p>
                    <p className="text-xs text-slate-600">{r.desc}</p>
                  </div>
                  {r.value != null && (
                    <span className="font-mono text-xs text-slate-400">
                      {typeof r.value === 'number' ? r.value.toFixed(2) : r.value}
                      {r.unit ? ` ${r.unit}` : ''}
                    </span>
                  )}
                  <span className="text-xs text-slate-600 w-14 text-right">wt {r.weight}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Price + SMA chart */}
          {priceChartData.length > 0 && (
            <div>
              <p className="label mb-2">Price Action</p>
              <div className="card-inner px-3 py-3">
                <ResponsiveContainer width="100%" height={160}>
                  <ComposedChart data={priceChartData}>
                    <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#475569' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis hide domain={['auto','auto']} />
                    <Tooltip content={<PriceTooltip currency={currency} />} />
                    <Area type="monotone" dataKey="close" stroke="#22d3ee" fill="#22d3ee10" strokeWidth={1.5} dot={false} name="Price" />
                    <Line type="monotone" dataKey="sma50"  stroke="#818cf8" dot={false} strokeWidth={1} strokeDasharray="4 2" name="SMA50" />
                    <Line type="monotone" dataKey="sma200" stroke="#fbbf24" dot={false} strokeWidth={1} strokeDasharray="4 2" name="SMA200" />
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="flex gap-4 mt-1">
                  <Legend color="bg-accent-cyan"   label="Price" />
                  <Legend color="bg-accent-indigo" label="SMA50" />
                  <Legend color="bg-accent-amber"  label="SMA200" />
                </div>
              </div>
            </div>
          )}

          {/* RSI chart */}
          {priceChartData.length > 0 && (
            <div className="card-inner px-3 py-3">
              <p className="text-xs text-slate-500 mb-2">RSI (14)</p>
              <ResponsiveContainer width="100%" height={80}>
                <LineChart data={priceChartData}>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#475569' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis hide domain={[0, 100]} />
                  <Tooltip formatter={(v) => v?.toFixed(1)} />
                  <ReferenceLine y={70} stroke="#f87171" strokeDasharray="3 3" />
                  <ReferenceLine y={30} stroke="#4ade80" strokeDasharray="3 3" />
                  <ReferenceLine y={50} stroke="#334155" />
                  <Line type="monotone" dataKey="rsi" stroke="#22d3ee" dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Volume chart */}
          {priceChartData.length > 0 && (
            <div className="card-inner px-3 py-3">
              <p className="text-xs text-slate-500 mb-2">Volume</p>
              <ResponsiveContainer width="100%" height={60}>
                <BarChart data={priceChartData}>
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#475569' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis hide />
                  <Tooltip formatter={(v) => fmtVolume(v)} />
                  <Bar dataKey="volume" fill="#334155" radius={[1,1,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SignalTile({ label, value, sub, positive, negative }) {
  const color = positive ? 'text-accent-green' : negative ? 'text-accent-red' : 'text-accent-amber'
  return (
    <div className="card-inner px-3 py-3">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`font-mono font-semibold text-sm ${color}`}>{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
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

function PriceTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-800 border border-slate-600 rounded-lg px-2 py-1.5 text-xs shadow-xl">
      <p className="text-slate-400 mb-1">{label}</p>
      {payload.map(p => p.value != null && (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {typeof p.value === 'number' ? fmtPrice(p.value, currency) : p.value}
        </p>
      ))}
    </div>
  )
}


