import React from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { fmtPctPlain, signalColor, signalBadgeClass } from '../../utils/format.js'

const VERDICTS = {
  UNDERVALUED_BULLISH_EXCELLENT: 'Strong buy candidate — undervalued price, excellent fundamentals, and bullish momentum all aligning.',
  UNDERVALUED_BULLISH_HEALTHY:   'Attractive setup — undervalued with solid fundamentals and bullish technical trend.',
  UNDERVALUED_BULLISH_CONCERNS:  'Undervalued with bullish momentum, but watch the fundamental weaknesses before sizing up.',
  UNDERVALUED_BULLISH_WEAK:      'Price looks cheap but weak fundamentals are a concern — high risk/reward.',
  UNDERVALUED_NEUTRAL_EXCELLENT: 'Fundamentally excellent and undervalued; technicals neutral — patient investors may find value.',
  UNDERVALUED_NEUTRAL_HEALTHY:   'Undervalued with solid business; technicals are neutral — worth monitoring for momentum entry.',
  UNDERVALUED_NEUTRAL_CONCERNS:  'Undervalued but fundamental concerns persist; technicals neutral — approach cautiously.',
  UNDERVALUED_BEARISH_EXCELLENT: 'Fundamentally excellent and undervalued but near-term technicals are bearish — consider phased entry.',
  UNDERVALUED_BEARISH_HEALTHY:   'Undervalued with healthy fundamentals but bearish momentum — wait for technical stabilization.',
  UNDERVALUED_BEARISH_CONCERNS:  'Undervalued on paper but bearish trend and fundamental issues — high risk.',
  UNDERVALUED_BEARISH_WEAK:      'Cheap for a reason — bearish trend and weak fundamentals. Avoid until clear reversal.',
  FAIRLY_VALUED_BULLISH_EXCELLENT: 'Fairly priced quality business with bullish momentum — worth accumulating on dips.',
  FAIRLY_VALUED_BULLISH_HEALTHY:   'Decent setup — fairly valued with solid fundamentals and positive momentum.',
  FAIRLY_VALUED_BULLISH_CONCERNS:  'Fairly valued with bullish momentum but fundamental issues temper enthusiasm.',
  FAIRLY_VALUED_NEUTRAL_EXCELLENT: 'Fairly valued, excellent fundamentals, neutral technicals — solid long-term hold.',
  FAIRLY_VALUED_NEUTRAL_HEALTHY:   'Fair price, healthy business, neutral trend — decent long-term hold, no urgency.',
  FAIRLY_VALUED_NEUTRAL_CONCERNS:  'Fair value but fundamental concerns and neutral technicals — wait for clarity.',
  FAIRLY_VALUED_BEARISH_EXCELLENT: 'Quality business at fair price but technically bearish — existing holders hold, new buyers wait.',
  FAIRLY_VALUED_BEARISH_HEALTHY:   'Fairly valued with bearish technicals — not the time to add; wait for stabilization.',
  FAIRLY_VALUED_BEARISH_CONCERNS:  'Fairly valued but bearish trend and business concerns — reduce or avoid.',
  OVERVALUED_BULLISH_EXCELLENT:    'Premium-quality business with momentum but valuation is stretched — existing holders hold; new buyers wait.',
  OVERVALUED_BULLISH_HEALTHY:      'Overvalued with bullish momentum and decent fundamentals — consider trimming on strength.',
  OVERVALUED_BULLISH_CONCERNS:     'Overvalued and fundamentally stretched despite bullish price action — exit on strength.',
  OVERVALUED_NEUTRAL_EXCELLENT:    'Excellent business but clearly overvalued with neutral momentum — wait for better entry.',
  OVERVALUED_NEUTRAL_HEALTHY:      'Overvalued at current levels despite healthy fundamentals — not the time to buy.',
  OVERVALUED_NEUTRAL_CONCERNS:     'Overvalued with business concerns — avoid.',
  OVERVALUED_BEARISH_EXCELLENT:    'Great business but overvalued and technically weak — avoid new positions.',
  OVERVALUED_BEARISH_HEALTHY:      'Overvalued and bearish — consider taking profits even with solid fundamentals.',
  OVERVALUED_BEARISH_CONCERNS:     'Avoid or exit — expensive, weakening trend, and business quality flags.',
  OVERVALUED_BEARISH_WEAK:         'Strong sell — overvalued, bearish trend, weak fundamentals.',
  DEFAULT: 'Mixed signals across valuation, fundamentals, and technicals — review each pillar below before deciding.'
}

function getVerdict(valuation, quality, technicals) {
  if (!valuation || !quality) return VERDICTS.DEFAULT
  const techLabel = technicals?.available ? technicals.label : 'NEUTRAL'
  const key = `${valuation.signal}_${techLabel}_${quality.label}`
  return VERDICTS[key] || VERDICTS.DEFAULT
}

export default function SummaryStrip({ onExpand, expanded }) {
  const { state } = useApp()
  const { valuation, quality, technicals, ratioResult } = state
  const ratios = ratioResult?.ratios
  if (!valuation) return null

  const cur = state.data?.currency === 'INR' ? '₹' : '$'
  const verdict = getVerdict(valuation, quality, technicals)

  return (
    <div className="space-y-4">
      {/* 3 Pillars */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <PillarCard
          title="⚖️ Valuation"
          badge={valuation.signal}
          headline={valuation.fairValue ? `${cur}${valuation.fairValue.toFixed(2)} fair value` : 'Insufficient data'}
          lines={[
            valuation.upside != null ? `${valuation.upside > 0 ? '+' : ''}${valuation.upside.toFixed(1)}% vs CMP` : null,
            ratios?.pe?.value    != null ? `P/E: ${ratios.pe.toFixed(1)}×` : null,
            ratios?.evEbitda?.value != null ? `EV/EBITDA: ${ratios.evEbitda.toFixed(1)}×` : null
          ].filter(Boolean)}
          isExpanded={expanded === 'valuation'}
          onExpand={() => onExpand('valuation')}
        />
        <PillarCard
          title="📊 Fundamentals"
          badge={quality?.label}
          headline={quality ? `Quality score ${quality.score}/10` : '—'}
          lines={[
            ratios?.roe?.value      != null ? `ROE: ${ratios.roe.toFixed(1)}%` : null,
            ratios?.netMargin?.value != null ? `Net Margin: ${ratios.netMargin.toFixed(1)}%` : null,
            ratioResult?.fcf      != null ? (ratios.fcf > 0 ? 'FCF positive' : 'FCF negative') : null
          ].filter(Boolean)}
          isExpanded={expanded === 'fundamentals'}
          onExpand={() => onExpand('fundamentals')}
        />
        <PillarCard
          title="📈 Technicals"
          badge={technicals?.available ? technicals.label : 'NO DATA'}
          headline={technicals?.available ? `Trend: ${technicals.label === 'BULLISH' ? 'Upward' : technicals.label === 'BEARISH' ? 'Downward' : 'Sideways'}` : 'Price history unavailable'}
          lines={technicals?.available ? [
            `RSI: ${technicals.indicators.rsi}`,
            technicals.signals.goldenCross ? 'Golden Cross ✓' : technicals.signals.deathCross ? 'Death Cross ✗' : `SMA50 ${technicals.signals.aboveSma50 ? '>' : '<'} SMA200`,
            `Vol: ${technicals.indicators.volume.ratio > 1.2 ? 'Above' : technicals.indicators.volume.ratio < 0.8 ? 'Below' : 'Avg'} avg`
          ] : ['Add .NS for Indian stocks']}
          isExpanded={expanded === 'technicals'}
          onExpand={() => onExpand('technicals')}
        />
      </div>

      {/* Verdict */}
      <div className="card border-navy-700 bg-navy-900/60">
        <div className="flex items-start gap-3">
          <div className="text-xl mt-0.5">💡</div>
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Combined Verdict</div>
            <p className="text-sm text-slate-200 leading-relaxed">{verdict}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function PillarCard({ title, badge, headline, lines, isExpanded, onExpand }) {
  const badgeClass = signalBadgeClass(badge)
  const headlineColor = signalColor(badge)

  return (
    <div className={`card flex flex-col gap-3 cursor-pointer transition-all ${isExpanded ? 'border-accent/50 bg-accent/5' : 'hover:border-navy-600'}`}
         onClick={onExpand}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-300">{title}</span>
        {badge && <span className={`badge ${badgeClass} text-xs`}>{badge.replace(/_/g,' ')}</span>}
      </div>
      <div className={`text-base font-semibold ${headlineColor}`}>{headline}</div>
      <ul className="space-y-1 flex-1">
        {lines.map((l, i) => (
          <li key={i} className="text-xs text-slate-400 flex items-center gap-1.5">
            <span className="text-slate-600">·</span>{l}
          </li>
        ))}
      </ul>
      <div className="text-xs text-accent mt-auto">{isExpanded ? 'Collapse ▲' : 'Explore ▼'}</div>
    </div>
  )
}
