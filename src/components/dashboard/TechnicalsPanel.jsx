import React from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import { useApp } from '../../store/AppContext.jsx'

export default function TechnicalsPanel({ open, onClose }) {
  const { state } = useApp()
  const { technicals } = state

  if (!open) return null

  if (!technicals?.available) {
    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-white">Technicals Detail</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg">✕</button>
        </div>
        <p className="text-slate-400 text-sm">
          {technicals?.reason || 'Technical analysis unavailable — no price history from this source.'}
        </p>
      </div>
    )
  }

  const { series, indicators, signals, patterns } = technicals

  // Build chart data
  const priceData = series.dates.map((d, i) => ({
    date: d,
    Price: series.closes[i],
    SMA50: series.sma50[i],
    SMA200: series.sma200[i],
    BBUpper: series.bbUpper[i],
    BBLower: series.bbLower[i]
  }))

  const rsiData = series.dates.map((d, i) => ({
    date: d,
    RSI: series.rsi[i]
  })).filter(d => d.RSI != null)

  const macdData = series.dates.map((d, i) => ({
    date: d,
    MACD: series.macd[i],
    Signal: series.signal[i],
    Histogram: series.histogram[i]
  })).filter(d => d.MACD != null)

  const ttip = {
    contentStyle: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 },
    labelStyle: { color: '#94a3b8' }
  }

  const signalList = [
    { label: 'Above SMA 50',    value: signals.aboveSma50,   good: true },
    { label: 'Above SMA 200',   value: signals.aboveSma200,  good: true },
    { label: 'Golden Cross',    value: signals.goldenCross,  good: true },
    { label: 'Death Cross',     value: signals.deathCross,   good: false },
    { label: 'MACD Bull Cross', value: signals.macdBullCross,good: true },
    { label: 'MACD Bear Cross', value: signals.macdBearCross,good: false },
    { label: 'RSI Oversold',    value: signals.rsiOversold,  good: true },
    { label: 'RSI Overbought',  value: signals.rsiOverbought,good: false },
    { label: 'Bull Divergence', value: signals.rsiBullDiv,   good: true },
    { label: 'Bear Divergence', value: signals.rsiBearDiv,   good: false }
  ].filter(s => s.value)

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Technicals Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg">✕</button>
      </div>

      {/* Key indicators */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <IndicatorCard label="RSI (14)" value={indicators.rsi}
          sub={indicators.rsi > 70 ? 'Overbought' : indicators.rsi < 30 ? 'Oversold' : 'Neutral'}
          color={indicators.rsi > 70 ? 'text-bear' : indicators.rsi < 30 ? 'text-bull' : 'text-neutral'} />
        <IndicatorCard label="MACD" value={indicators.macd.macd.toFixed(3)}
          sub={indicators.macd.histogram > 0 ? 'Bullish' : 'Bearish'}
          color={indicators.macd.histogram > 0 ? 'text-bull' : 'text-bear'} />
        <IndicatorCard label="BB Position" value={(indicators.bollinger.position * 100).toFixed(0) + '%'}
          sub={indicators.bollinger.position > 0.8 ? 'Near Upper' : indicators.bollinger.position < 0.2 ? 'Near Lower' : 'Mid Range'}
          color="text-slate-300" />
        <IndicatorCard label="Volume Ratio" value={indicators.volume.ratio.toFixed(2) + '×'}
          sub={indicators.volume.ratio > 1.5 ? 'High' : indicators.volume.ratio < 0.5 ? 'Low' : 'Normal'}
          color={indicators.volume.ratio > 1.5 ? 'text-accent' : 'text-slate-300'} />
      </div>

      {/* Price + MAs chart */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Price & Moving Averages</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={priceData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={d => d?.slice(5)} />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} width={50} domain={['auto','auto']} />
            <Tooltip {...ttip} />
            <Line type="monotone" dataKey="Price"  stroke="#e2e8f0" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="SMA50"  stroke="#6366f1" dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="SMA200" stroke="#f59e0b" dot={false} strokeWidth={1} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="BBUpper" stroke="#334155" dot={false} strokeWidth={1} />
            <Line type="monotone" dataKey="BBLower" stroke="#334155" dot={false} strokeWidth={1} />
          </LineChart>
        </ResponsiveContainer>
        <div className="flex gap-3 text-xs mt-1">
          <span className="flex items-center gap-1"><span style={{color:'#6366f1'}}>─ ─</span> SMA50</span>
          <span className="flex items-center gap-1"><span style={{color:'#f59e0b'}}>─ ─</span> SMA200</span>
          <span className="flex items-center gap-1"><span style={{color:'#334155'}}>──</span> Bollinger</span>
        </div>
      </div>

      {/* RSI */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">RSI (14)</h3>
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={rsiData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={d => d?.slice(5)} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#64748b' }} width={30} />
            <Tooltip {...ttip} />
            <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" />
            <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
            <Line type="monotone" dataKey="RSI" stroke="#818cf8" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* MACD */}
      <div>
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">MACD</h3>
        <ResponsiveContainer width="100%" height={120}>
          <LineChart data={macdData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} tickFormatter={d => d?.slice(5)} />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} width={40} />
            <Tooltip {...ttip} />
            <ReferenceLine y={0} stroke="#475569" />
            <Line type="monotone" dataKey="MACD"   stroke="#6366f1" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="Signal" stroke="#f59e0b" dot={false} strokeWidth={1} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Signals */}
      {signalList.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Active Signals</h3>
          <div className="flex flex-wrap gap-2">
            {signalList.map(s => (
              <span key={s.label} className={`badge ${s.good ? 'badge-bull' : 'badge-bear'}`}>
                {s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Patterns */}
      {patterns?.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Candlestick Patterns</h3>
          <div className="flex flex-wrap gap-2">
            {patterns.map((p, i) => (
              <span key={i} className={`badge ${p.type === 'bullish' ? 'badge-bull' : p.type === 'bearish' ? 'badge-bear' : 'badge-neutral'}`}>
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function IndicatorCard({ label, value, sub, color }) {
  return (
    <div className="card-sm">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`font-mono font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  )
}
