import React from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPct, fmtMultiple, signalColor, signalBadgeClass } from '../../utils/format.js'

const VERDICTS = {
  UNDERVALUED_BULLISH_EXCELLENT: 'Strong buy candidate — undervalued price, excellent fundamentals, and bullish momentum all aligning.',
  UNDERVALUED_BULLISH_HEALTHY:   'Attractive setup — undervalued with solid fundamentals and bullish technical trend.',
  UNDERVALUED_NEUTRAL_EXCELLENT: 'Fundamentally strong and undervalued; technicals are neutral — patient investors may find value here.',
  UNDERVALUED_BEARISH_EXCELLENT: 'Fundamentally excellent and undervalued, but near-term technicals are bearish — consider a phased entry.',
  UNDERVALUED_BULLISH_CONCERNS:  'Undervalued with bullish momentum, but watch the fundamental weaknesses before sizing up.',
  UNDERVALUED_BULLISH_WEAK:      'Price looks cheap, but weak fundamentals are a concern — high risk/reward situation.',
  FAIRLY_VALUED_BULLISH_EXCELLENT: 'Fairly priced quality business with bullish momentum — hold or accumulate on dips.',
  FAIRLY_VALUED_NEUTRAL_HEALTHY:   'Fair price, healthy business, neutral trend — decent long-term hold, no urgency.',
  OVERVALUED_BULLISH_EXCELLENT:    'Premium-quality business with momentum, but valuation looks stretched — existing holders hold; new buyers wait for a pullback.',
  OVERVALUED_BEARISH_WEAK:         'Overvalued, bearish trend, weak fundamentals — avoid or consider exit.',
  OVERVALUED_BEARISH_HEALTHY:      'Overvalued and technically bearish — consider taking profits even with solid fundamentals.',
  DEFAULT: 'Mixed signals across valuation, fundamentals, and technicals — review each pillar below before deciding.'
}

function getVerdict(valuation, quality, technicals) {
  if (!valuation || !quality || !technicals?.available) return VERDICTS.DEFAULT
  const key = `${valuation.signal}_${technicals.label}_${quality.label}`
  return VERDICTS[key] || VERDICTS.DEFAULT
}

export default function SummaryStrip({ onExpand }) {
  const { state } = useApp()
  const { valuation, quality, technicals, ratios } = state

  if (!valuation) return null

  return (
    <div className="space-y-4">
      {/* Verdict */}
      <div className="card border-accent/30 bg-accent/5">
        <p className="text-sm text-slate-300 leading-relaxed">
          {getVerdict(valuation, quality, technicals)}
        </p>
      </div>

      {/* 3 Pillars */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Valuation */}
        <PillarCard
          title="Valuation"
          badge={valuation.signal}
          score={valuation.upside != null ? fmtPct(valuation.upside) : '—'}
          scoreLabel="vs fair value"
          lines={[
            valuation.fairValue && ratios?.price
              ? `Fair: ${ratios?.price >= 100 ? '₹' : '$'}${valuation.fairValue.toFixed(2)}`
              : null,
            ratios?.pe != null  ? `P/E: ${fmtMultiple(ratios.pe)}` : null,
            ratios?.evEbitda != null ? `EV/EBITDA: ${fmtMultiple(ratios.evEbitda)}` : null
          ].filter(Boolean)}
          onExpand={() => onExpand('valuation')}
        />

        {/* Fundamentals */}
        <PillarCard
          title="Fundamentals"
          badge={quality?.label}
          score={quality ? quality.score.toFixed(1) + '/10' : '—'}
          scoreLabel="quality score"
          lines={[
            ratios?.roe != null     ? `ROE: ${ratios.roe.toFixed(1)}%` : null,
            ratios?.netMargin != null ? `Net Margin: ${ratios.netMargin.toFixed(1)}%` : null,
            ratios?.revCagr != null ? `Rev CAGR: ${ratios.revCagr.toFixed(1)}%` : null
          ].filter(Boolean)}
          onExpand={() => onExpand('fundamentals')}
        />

        {/* Technicals */}
        <PillarCard
          title="Technicals"
          badge={technicals?.available ? technicals.label : 'NO DATA'}
          score={technicals?.available ? technicals.score.toFixed(1) + '/10' : '—'}
          scoreLabel="technical score"
          lines={technicals?.available ? [
            `RSI: ${technicals.indicators.rsi}`,
            technicals.signals.goldenCross ? 'Golden Cross ✓' : technicals.signals.deathCross ? 'Death Cross ✗' : null,
            technicals.patterns?.[0]?.name || null
          ].filter(Boolean) : ['Price history unavailable']}
          onExpand={() => onExpand('technicals')}
        />
      </div>
    </div>
  )
}

function PillarCard({ title, badge, score, scoreLabel, lines, onExpand }) {
  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{title}</span>
        {badge && <span className={`badge ${signalBadgeClass(badge)}`}>{badge.replace(/_/g, ' ')}</span>}
      </div>

      <div>
        <div className={`text-2xl font-bold font-mono ${signalColor(badge)}`}>{score}</div>
        <div className="text-xs text-slate-500">{scoreLabel}</div>
      </div>

      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={i} className="text-xs text-slate-400 flex items-center gap-1">
            <span className="text-navy-700">·</span>{l}
          </li>
        ))}
      </ul>

      <button
        onClick={onExpand}
        className="mt-auto text-xs text-accent hover:text-accent-light transition-colors text-left"
      >
        Explore ▼
      </button>
    </div>
  )
}
