import React, { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import { useApp } from '../../store/AppContext.jsx'

export default function TechnicalsPanel({ open, onClose }) {
  const { state } = useApp()
  const { technicals } = state
  const [showChart, setShowChart] = useState(false)

  if (!open) return null

  if (!technicals?.available) {
    return (
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">📈 Technicals Detail</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
        </div>
        <p className="text-slate-400 text-sm">{technicals?.reason || 'Price history unavailable from this data source.'}</p>
      </div>
    )
  }

  const { series, indicators, signals, patterns } = technicals
  const ttip = {
    contentStyle: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 },
    labelStyle: { color: '#94a3b8' }
  }

  const priceData  = series.dates.map((d, i) => ({ date: d.slice(5), Price: series.closes[i], SMA50: series.sma50[i], SMA200: series.sma200[i], BBU: series.bbUpper[i], BBL: series.bbLower[i] }))
  const rsiData    = series.dates.map((d, i) => ({ date: d.slice(5), RSI: series.rsi[i] })).filter(d => d.RSI != null)
  const macdData   = series.dates.map((d, i) => ({ date: d.slice(5), MACD: series.macd[i], Signal: series.signal[i] })).filter(d => d.MACD != null)

  const signalRows = [
    { label: 'Price vs SMA50',   value: signals.aboveSma50,   good: true,  text: signals.aboveSma50 ? 'Above SMA50 ✓' : 'Below SMA50 ✗' },
    { label: 'Price vs SMA200',  value: signals.aboveSma200,  good: true,  text: signals.aboveSma200 ? 'Above SMA200 ✓' : 'Below SMA200 ✗' },
    { label: 'Cross Signal',     value: signals.goldenCross || signals.deathCross, good: signals.goldenCross,
      text: signals.goldenCross ? 'Golden Cross ✓' : signals.deathCross ? 'Death Cross ✗' : 'No cross signal' },
    { label: 'RSI',              value: indicators.rsi, good: indicators.rsi < 70 && indicators.rsi > 30,
      text: indicators.rsi > 70 ? `RSI ${indicators.rsi} — Overbought` : indicators.rsi < 30 ? `RSI ${indicators.rsi} — Oversold` : `RSI ${indicators.rsi} — Neutral ✓` },
    { label: 'MACD',             value: indicators.macd.histogram > 0, good: indicators.macd.histogram > 0,
      text: indicators.macd.histogram > 0 ? 'MACD bullish crossover ✓' : 'MACD bearish ✗' },
    { label: 'Volume',           value: indicators.volume.ratio > 1, good: indicators.volume.ratio > 1,
      text: `${indicators.volume.ratio.toFixed(1)}× avg vol — ${indicators.volume.ratio > 1.2 ? 'OBV rising ✓' : indicators.volume.ratio < 0.8 ? 'Low volume ✗' : 'Normal'}` },
    { label: 'Pattern',          value: patterns?.length > 0, good: patterns?.[0]?.type === 'bullish',
      text: patterns?.length > 0 ? `${patterns[0].name} (${patterns[0].type})` : 'No major pattern today ➖' }
  ]

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">📈 Technicals Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
      </div>

      {/* Score */}
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded-full border-2 border-accent flex items-center justify-center">
          <span className="text-xl font-bold text-white">{technicals.score}</span>
        </div>
        <div>
          <div className={`text-lg font-bold ${technicals.label === 'BULLISH' ? 'text-bull' : technicals.label === 'BEARISH' ? 'text-bear' : 'text-neutral'}`}>
            {technicals.label}
          </div>
          <div className="text-xs text-slate-400">out of 10</div>
        </div>
      </div>

      {/* Signal rows — like the spec */}
      <div className="space-y-2">
        {signalRows.map(row => (
          <div key={row.label} className="flex items-center gap-3 py-1 border-b border-navy-800/50">
            <span className="text-slate-500 text-xs w-20 shrink-0">{row.label}</span>
            <span className={`text-xs flex-1 ${
              row.good === true  ? 'text-bull' :
              row.good === false ? 'text-bear' : 'text-slate-400'
            }`}>{row.text}</span>
          </div>
        ))}
      </div>

      {/* Toggle chart */}
      <button onClick={() => setShowChart(!showChart)}
        className="text-xs text-accent hover:text-accent-light flex items-center gap-1">
        {showChart ? '▲ Hide Chart' : '▼ View Chart ▼'}
      </button>

      {showChart && (
        <div className="space-y-4">
          {/* Price */}
          <div>
            <div className="text-xs text-slate-400 mb-1">Price & Moving Averages</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={priceData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} interval={19} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} width={50} domain={['auto','auto']} />
                <Tooltip {...ttip} />
                <Line type="monotone" dataKey="Price"  stroke="#e2e8f0" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="SMA50"  stroke="#6366f1" dot={false} strokeWidth={1} strokeDasharray="3 2" />
                <Line type="monotone" dataKey="SMA200" stroke="#f59e0b" dot={false} strokeWidth={1} strokeDasharray="3 2" />
                <Line type="monotone" dataKey="BBU"    stroke="#334155" dot={false} strokeWidth={0.8} />
                <Line type="monotone" dataKey="BBL"    stroke="#334155" dot={false} strokeWidth={0.8} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {/* RSI */}
          <div>
            <div className="text-xs text-slate-400 mb-1">RSI (14)</div>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={rsiData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} interval={19} />
                <YAxis domain={[0,100]} tick={{ fontSize: 9, fill: '#64748b' }} width={28} />
                <Tooltip {...ttip} />
                <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" />
                <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="RSI" stroke="#818cf8" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {/* MACD */}
          <div>
            <div className="text-xs text-slate-400 mb-1">MACD</div>
            <ResponsiveContainer width="100%" height={100}>
              <LineChart data={macdData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} interval={19} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} width={38} />
                <Tooltip {...ttip} />
                <ReferenceLine y={0} stroke="#475569" />
                <Line type="monotone" dataKey="MACD"   stroke="#6366f1" dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="Signal" stroke="#f59e0b" dot={false} strokeWidth={1} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {technicals.levels && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-300">Support &amp; Resistance</h3>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <div className="text-slate-500 uppercase tracking-wide">Resistance (above)</div>
              {technicals.levels.nearestResistance && (
                <div className="text-red-400">Nearest ₹{technicals.levels.nearestResistance.price}
                  <span className="text-slate-500"> (+{technicals.levels.nearestResistance.distancePct}%, {technicals.levels.nearestResistance.touches}×)</span></div>
              )}
              {technicals.levels.strongestResistance && (
                <div className="text-red-400/80">Strongest ₹{technicals.levels.strongestResistance.price}
                  <span className="text-slate-500"> (+{technicals.levels.strongestResistance.distancePct}%, {technicals.levels.strongestResistance.touches}×)</span></div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-slate-500 uppercase tracking-wide">Support (below)</div>
              {technicals.levels.nearestSupport && (
                <div className="text-emerald-400">Nearest ₹{technicals.levels.nearestSupport.price}
                  <span className="text-slate-500"> ({technicals.levels.nearestSupport.distancePct}%, {technicals.levels.nearestSupport.touches}×)</span></div>
              )}
              {technicals.levels.strongestSupport && (
                <div className="text-emerald-400/80">Strongest ₹{technicals.levels.strongestSupport.price}
                  <span className="text-slate-500"> ({technicals.levels.strongestSupport.distancePct}%, {technicals.levels.strongestSupport.touches}×)</span></div>
              )}
            </div>
          </div>
        </div>
      )}
      
      {/* Edit Settings link */}
      <div className="text-xs text-slate-500">
        Adjust indicator weights in <span className="text-accent cursor-pointer">⚙ Scoring Studio</span>
      </div>
    </div>
  )
}
