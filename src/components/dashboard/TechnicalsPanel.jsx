import React, { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import { useApp } from '../../store/AppContext.jsx'

const STATUS_COLOR = {
  Bullish: 'text-bull', Bearish: 'text-bear', Mixed: 'text-neutral', Neutral: 'text-slate-400',
}

const pct = v => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
const smaLine = (above, pctVal) =>
  above == null || pctVal == null ? '—' : `${above ? 'Above' : 'Below'} by ${Math.abs(pctVal).toFixed(1)}% ${above ? '↑' : '↓'}`

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

  const {
    series, indicators, signals, patterns, groups, regime, bias, score,
    smaDistances, sma50vs200, rsiZone, volumeClass, divergence, volatility, week52, levels,
  } = technicals
  const cur = state.data?.currency === 'INR' ? '₹' : '$'
  const ttip = {
    contentStyle: { background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 11 },
    labelStyle: { color: '#94a3b8' }
  }

  const priceData  = series.dates.map((d, i) => ({ date: d.slice(5), Price: series.closes[i], SMA50: series.sma50[i], SMA200: series.sma200[i], BBU: series.bbUpper[i], BBL: series.bbLower[i] }))
  const rsiData    = series.dates.map((d, i) => ({ date: d.slice(5), RSI: series.rsi[i] })).filter(d => d.RSI != null)
  const macdData   = series.dates.map((d, i) => ({ date: d.slice(5), MACD: series.macd[i], Signal: series.signal[i] })).filter(d => d.MACD != null)

  // A one-line, plain-language read of the four group cards below — not a
  // prediction, just what the current alignment says.
  const trendPhrase = signals.aboveSma50 && signals.aboveSma200 ? 'Price is above both major moving averages'
    : !signals.aboveSma50 && !signals.aboveSma200 ? 'Price is below both major moving averages'
    : 'Price is mixed against its major moving averages'
  const proximityPhrase = levels?.nearestSupport && Math.abs(levels.nearestSupport.distancePct) < 3 ? '; price is close to support'
    : levels?.nearestResistance && Math.abs(levels.nearestResistance.distancePct) < 3 ? '; price is close to resistance'
    : ''
  const summaryLine = `${trendPhrase}; momentum is ${groups.momentum.status.toLowerCase()}; participation is ${groups.participation.status.toLowerCase()}${proximityPhrase}.`

  const zoneSuffix = l => {
    if (!l.range || !l.price || (l.range[1] - l.range[0]) / l.price < 0.005) return null
    return <span className="text-slate-600"> · zone {cur}{l.range[0]}–{cur}{l.range[1]}</span>
  }

  return (
    <div className="card space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">📈 Technicals Detail</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-lg">✕</button>
      </div>

      {/* Technical bias — a fair 0-10 read (5.0 = no net directional evidence,
          not "everything's bearish"), plus the plain-language summary below.
          The four group cards are the real content; this is just the headline. */}
      <div className="flex items-center gap-3">
        <div className="w-16 h-16 rounded-full border-2 border-accent flex items-center justify-center shrink-0">
          <span className="text-lg font-bold text-white">{score}</span>
        </div>
        <div>
          <div className={`text-lg font-bold ${bias === 'Bullish-leaning' ? 'text-bull' : bias === 'Bearish-leaning' ? 'text-bear' : 'text-neutral'}`}>
            {bias === 'Neutral' ? 'Neutral' : `Technical bias: ${bias}`}
          </div>
          <div className="text-xs text-slate-400">{score}/10 — from trend, momentum, participation &amp; structure below</div>
        </div>
      </div>
      <p className="text-xs text-slate-500 -mt-3">{summaryLine}</p>

      {/* Four groups — the real content, in place of one opaque score */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <GroupCard title="Trend" status={groups.trend.status}>
          <MetricRow label="SMA50"  value={smaLine(signals.aboveSma50, smaDistances.sma50Pct)} />
          <MetricRow label="SMA200" value={smaLine(signals.aboveSma200, smaDistances.sma200Pct)} />
          <MetricRow label="SMA50 vs SMA200" value={sma50vs200 === 'above' ? 'Above ↑' : sma50vs200 === 'below' ? 'Below ↓' : '—'} />
          <MetricRow label="Regime" value={regime || '—'} />
          {signals.goldenCross && <MetricRow label="Cross" value="Golden cross just occurred" tone="bull" />}
          {signals.deathCross  && <MetricRow label="Cross" value="Death cross just occurred" tone="bear" />}
        </GroupCard>

        <GroupCard title="Momentum" status={groups.momentum.status}>
          <MetricRow label="RSI" value={`${indicators.rsi} · ${rsiZone}`} />
          <MetricRow label="MACD" value={
            `${signals.macdAboveSignal ? 'Bullish' : 'Bearish'} · histogram ${
              signals.macdHistRising == null ? '—' : signals.macdHistRising ? 'rising' : 'falling'} · ${
              signals.macdAboveZero ? 'above zero' : 'below zero'}`
          } />
        </GroupCard>

        <GroupCard title="Participation" status={groups.participation.status}>
          <MetricRow label="Volume" value={`${indicators.volume.ratio.toFixed(1)}× avg${volumeClass ? ` · ${volumeClass}` : ''}`} />
          <MetricRow label="OBV" value={signals.obvRising ? 'Rising ↑' : 'Falling ↓'} />
          {divergence && (
            <MetricRow
              label="Price/OBV"
              tone={divergence === 'bearish' ? 'bear' : 'bull'}
              value={divergence === 'bearish' ? 'Negative divergence — price up, OBV down' : 'Positive divergence — price down, OBV up'}
            />
          )}
        </GroupCard>

        <GroupCard title="Structure" status={groups.structure.status}>
          <MetricRow label="Pattern" value={patterns?.length ? `${patterns[0].name} (${patterns[0].type})` : 'No major pattern —'} />
          {levels?.nearestSupport && <MetricRow label="Nearest support" value={`${cur}${levels.nearestSupport.price} · ${pct(levels.nearestSupport.distancePct)}`} />}
          {levels?.nearestResistance && <MetricRow label="Nearest resistance" value={`${cur}${levels.nearestResistance.price} · ${pct(levels.nearestResistance.distancePct)}`} />}
          {volatility && <MetricRow label="Typical daily move" value={`${cur}${volatility.atr} · ${volatility.atrPct}%`} />}
          {week52 && <MetricRow label="52W position" value={`${week52.positionPct}% of range (${cur}${week52.low}–${cur}${week52.high})`} />}
        </GroupCard>
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

      {levels && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-300">Support &amp; Resistance</h3>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="space-y-1">
              <div className="text-slate-500 uppercase tracking-wide">Resistance (above)</div>
              {(levels.nearResistances || []).map(l => (
                <div key={`res-${l.price}`} className="text-red-400">{cur}{l.price}{zoneSuffix(l)}
                  <span className="text-slate-500"> (+{l.distancePct}%, {l.touches}×)</span></div>
              ))}
              {!levels.nearResistances?.length && (
                <div className="text-slate-600">None nearby</div>
              )}
              {levels.majorResistance &&
               !levels.nearResistances?.some(l => l.price === levels.majorResistance.price) && (
                <div className="text-red-400/60">Major historical {cur}{levels.majorResistance.price}
                  <span className="text-slate-500"> (+{levels.majorResistance.distancePct}%, {levels.majorResistance.touches}×)</span></div>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-slate-500 uppercase tracking-wide">Support (below)</div>
              {(levels.nearSupports || []).map(l => (
                <div key={`sup-${l.price}`} className="text-emerald-400">{cur}{l.price}{zoneSuffix(l)}
                  <span className="text-slate-500"> ({l.distancePct}%, {l.touches}×)</span></div>
              ))}
              {!levels.nearSupports?.length && (
                <div className="text-slate-600">None nearby</div>
              )}
              {levels.majorSupport &&
               !levels.nearSupports?.some(l => l.price === levels.majorSupport.price) && (
                <div className="text-emerald-400/60">Major historical {cur}{levels.majorSupport.price}
                  <span className="text-slate-500"> ({levels.majorSupport.distancePct}%, {levels.majorSupport.touches}×)</span></div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function GroupCard({ title, status, children }) {
  return (
    <div className="card-sm space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-300">{title}</span>
        <span className={`text-xs font-semibold ${STATUS_COLOR[status] || 'text-slate-400'}`}>{status}</span>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function MetricRow({ label, value, tone }) {
  const toneClass = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-slate-400'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-slate-500 w-28 shrink-0">{label}</span>
      <span className={`flex-1 ${toneClass}`}>{value}</span>
    </div>
  )
}
