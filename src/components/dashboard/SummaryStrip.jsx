// SummaryStrip.jsx
// The crisp default view — 3 scores + combined verdict
// Each card expands inline via togglePanel

import React from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { signalEmoji, signalColor, signalChip, fmtPct, fmtPrice, fmt } from '../../utils/format.js'

export default function SummaryStrip() {
  const { state, actions } = useApp()
  const { valuation, fundScore, techScore, verdict, data } = state

  if (!data) return null

  const currency = data.currency ?? 'USD'

  return (
    <div className="space-y-4">
      {/* 3 pillar cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <PillarCard
          id="valuation"
          title="Valuation"
          signal={valuation?.signal}
          lines={[
            valuation?.consensusValue
              ? `Fair value ${fmtPrice(valuation.consensusValue, currency)}`
              : 'Fair value unavailable',
            valuation?.upside != null
              ? `${valuation.upside >= 0 ? '+' : ''}${valuation.upside.toFixed(1)}% upside`
              : null,
          ]}
        />
        <PillarCard
          id="fundamentals"
          title="Fundamentals"
          signal={fundScore?.label}
          score={fundScore?.score}
          lines={[
            fundScore?.score != null ? `Quality score ${fundScore.score.toFixed(1)}/10` : null,
            fundScore?.results?.filter(r => r.pass).length != null
              ? `${fundScore.results.filter(r => r.pass).length}/${fundScore.results.length} checks pass`
              : null,
          ]}
        />
        <PillarCard
          id="technicals"
          title="Technicals"
          signal={techScore?.label}
          score={techScore?.score}
          lines={[
            techScore?.label === 'INSUFFICIENT DATA' ? 'Need 30+ days price data' : null,
            state.technicals?.latest?.rsi != null
              ? `RSI ${state.technicals.latest.rsi.toFixed(0)}`
              : null,
            state.technicals?.latest?.recentCross
              ? `${state.technicals.latest.recentCross.type === 'GOLDEN' ? '⚡ Golden' : '☠️ Death'} Cross ${state.technicals.latest.recentCross.daysAgo}d ago`
              : null,
          ]}
        />
      </div>

      {/* Combined verdict */}
      {verdict && (
        <div className="card px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="text-2xl mt-0.5">
              {signalEmoji(valuation?.signal)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="label mb-1">Combined Verdict</p>
              <p className="text-slate-200 text-sm leading-relaxed">{verdict.text}</p>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-600">
            Not financial advice — signals are model outputs only. Always do your own research.
          </p>
        </div>
      )}
    </div>
  )
}

function PillarCard({ id, title, signal, score, lines }) {
  const { state, actions } = useApp()
  const isExpanded = state.expandedPanel === id

  const validLines = (lines ?? []).filter(Boolean)

  return (
    <div className={`card px-4 py-4 transition-all ${isExpanded ? 'border-accent-cyan/40' : ''}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <p className="label mb-1">{title}</p>
          <div className="flex items-center gap-2">
            <span className={`chip ${signalChip(signal)} text-sm font-semibold`}>
              {signalEmoji(signal)} {formatSignal(signal)}
            </span>
          </div>
        </div>
        {score != null && (
          <ScoreBadge score={score} />
        )}
      </div>

      <div className="space-y-0.5 mt-2 min-h-[2.5rem]">
        {validLines.map((line, i) => (
          <p key={i} className="text-xs text-slate-400">{line}</p>
        ))}
      </div>

      <button
        onClick={() => actions.togglePanel(id)}
        className="expand-btn mt-3"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        {isExpanded ? 'Collapse' : 'Explore detail'}
      </button>
    </div>
  )
}

function ScoreBadge({ score }) {
  const color = score >= 8 ? 'text-accent-green'
              : score >= 5 ? 'text-accent-amber'
              : 'text-accent-red'
  return (
    <div className="text-right">
      <span className={`font-mono font-bold text-xl ${color}`}>{score.toFixed(1)}</span>
      <span className="text-slate-600 text-xs">/10</span>
    </div>
  )
}

function formatSignal(signal) {
  if (!signal) return '—'
  return signal.replace(/_/g, ' ')
}
