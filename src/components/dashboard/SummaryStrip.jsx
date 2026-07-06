import React from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { signalColor, signalBadgeClass } from '../../utils/format.js'
import DCFScenarioPanel from './DCFScenarioPanel.jsx'
import { expectationInsight, primaryExpectation } from '../../engine/valuation.js'
import AIVerdict from './AIVerdict.jsx'

// 27-combination verdict matrix
const VERDICTS = {
  UNDERVALUED_BULLISH_EXCELLENT: 'Strong buy candidate — undervalued price, excellent fundamentals, and bullish momentum all aligning.',
  UNDERVALUED_BULLISH_HEALTHY:   'Attractive setup — undervalued with solid fundamentals and bullish technical trend.',
  UNDERVALUED_BULLISH_CONCERNS:  'Undervalued with bullish momentum, but fundamental weaknesses warrant caution before sizing up.',
  UNDERVALUED_BULLISH_WEAK:      'Price looks cheap but weak fundamentals are a concern — high risk/reward.',
  UNDERVALUED_NEUTRAL_EXCELLENT: 'Fundamentally excellent and undervalued; technicals are neutral — patient investors may find value here.',
  UNDERVALUED_NEUTRAL_HEALTHY:   'Undervalued with solid business; technicals neutral — worth monitoring for momentum entry.',
  UNDERVALUED_NEUTRAL_CONCERNS:  'Undervalued but fundamental concerns persist; technicals neutral — approach cautiously.',
  UNDERVALUED_NEUTRAL_WEAK:      'Appears cheap but weak fundamentals dominate — avoid until quality improves.',
  UNDERVALUED_BEARISH_EXCELLENT: 'Fundamentally excellent and undervalued but near-term technicals are bearish — consider phased entry.',
  UNDERVALUED_BEARISH_HEALTHY:   'Undervalued with healthy fundamentals but bearish momentum — wait for technical stabilization.',
  UNDERVALUED_BEARISH_CONCERNS:  'Undervalued on paper but bearish trend and fundamental issues — high risk.',
  UNDERVALUED_BEARISH_WEAK:      'Cheap for a reason — bearish trend and weak fundamentals. Avoid until reversal.',
  FAIRLY_VALUED_BULLISH_EXCELLENT:'Fairly priced quality business with bullish momentum — worth accumulating on dips.',
  FAIRLY_VALUED_BULLISH_HEALTHY:  'Decent setup — fairly valued with solid fundamentals and positive momentum.',
  FAIRLY_VALUED_BULLISH_CONCERNS: 'Fairly valued with bullish momentum but fundamental issues temper enthusiasm.',
  FAIRLY_VALUED_BULLISH_WEAK:     'Fairly valued with momentum but weak fundamentals — speculative hold only.',
  FAIRLY_VALUED_NEUTRAL_EXCELLENT:'Fairly valued, excellent fundamentals, neutral technicals — solid long-term hold.',
  FAIRLY_VALUED_NEUTRAL_HEALTHY:  'Fair price, healthy business, neutral trend — decent long-term hold, no urgency.',
  FAIRLY_VALUED_NEUTRAL_CONCERNS: 'Fair value but fundamental concerns and neutral technicals — wait for clarity.',
  FAIRLY_VALUED_NEUTRAL_WEAK:     'Fairly valued but weak fundamentals — avoid or exit.',
  FAIRLY_VALUED_BEARISH_EXCELLENT:'Quality business at fair price but technically bearish — existing holders hold, new buyers wait.',
  FAIRLY_VALUED_BEARISH_HEALTHY:  'Fairly valued with bearish technicals — not the time to add; wait for stabilization.',
  FAIRLY_VALUED_BEARISH_CONCERNS: 'Fairly valued but bearish trend and business concerns — reduce or avoid.',
  FAIRLY_VALUED_BEARISH_WEAK:     'Fairly valued but bearish and fundamentally weak — exit.',
  OVERVALUED_BULLISH_EXCELLENT:   'Premium-quality business with momentum but valuation is stretched — trim on strength.',
  OVERVALUED_BULLISH_HEALTHY:     'Overvalued with bullish momentum and decent fundamentals — consider reducing position.',
  OVERVALUED_BULLISH_CONCERNS:    'Overvalued and fundamentally stretched despite bullish price action — exit on strength.',
  OVERVALUED_BULLISH_WEAK:        'Overvalued, weak fundamentals, only momentum holding it up — exit.',
  OVERVALUED_NEUTRAL_EXCELLENT:   'Excellent business but clearly overvalued with neutral momentum — wait for better entry.',
  OVERVALUED_NEUTRAL_HEALTHY:     'Overvalued at current levels despite healthy fundamentals — not the time to buy.',
  OVERVALUED_NEUTRAL_CONCERNS:    'Overvalued with business concerns — avoid.',
  OVERVALUED_NEUTRAL_WEAK:        'Overvalued and weak — strong avoid.',
  OVERVALUED_BEARISH_EXCELLENT:   'Great business but overvalued and technically weak — avoid new positions.',
  OVERVALUED_BEARISH_HEALTHY:     'Overvalued and bearish — consider taking profits even with solid fundamentals.',
  OVERVALUED_BEARISH_CONCERNS:    'Avoid or exit — expensive, weakening trend, and business quality flags.',
  OVERVALUED_BEARISH_WEAK:        'Strong sell — overvalued, bearish trend, and weak fundamentals.',
  DEFAULT: 'Mixed signals across valuation, fundamentals, and technicals — review each pillar below before deciding.'
}

function getVerdict(valSignal, techLabel, qualLabel) {
  const key = `${valSignal}_${techLabel}_${qualLabel}`
  return VERDICTS[key] || VERDICTS.DEFAULT
}

export default function SummaryStrip({ onExpand, expanded }) {
  const { state } = useApp()
  const { valuation, quality, technicals, ratioResult, marketExpectation } = state
  
  // Primary variant for summary card
  // Same shared selector the insight uses, so pillar & verdict never disagree.
  const mePrimary = primaryExpectation(marketExpectation, state.stage)
  const me = { primary: mePrimary }
  const ratios = ratioResult?.ratios

  if (!valuation) return null

  const cur      = state.data?.currency === 'INR' ? '₹' : '$'
  const price    = ratioResult?.price
  const techLabel = technicals?.available ? technicals.label : 'NEUTRAL'
  const qualLabel = quality?.label ?? 'HEALTHY'
  const verdict   = getVerdict(valuation.signal, techLabel, qualLabel)

  return (
    <div className="space-y-3">
      {/* 3 Pillars */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">

        {/* ── VALUATION ──────────────────────────────────────────────────────── */}
        <PillarCard
          title="⚖️ VALUATION"
          badge={valuation.signal}
          onExpand={() => onExpand('valuation')}
          isExpanded={expanded === 'valuation'}>
          {valuation.fvRangeLow != null && price ? (
            <div className="space-y-1">
              <div className={`text-xl font-bold font-mono ${signalColor(valuation.signal)}`}>
                {valuation.signal.replace('_', ' ')}
              </div>
              <div className="text-xs text-slate-400">
                Fair value: <span className="text-white font-mono">
                  {cur}{Math.round(valuation.fvRangeLow).toLocaleString('en-IN')}
                  {valuation.fvRangeHigh !== valuation.fvRangeLow
                    ? ` – ${cur}${Math.round(valuation.fvRangeHigh).toLocaleString('en-IN')}` : ''}
                </span>
              </div>
              {valuation.topModels?.length > 0 && (
                <div className="text-xs text-slate-500">via {valuation.topModels.map(t => t.name).join(' & ')}</div>
              )}
              <div className="text-xs text-slate-500">CMP: {cur}{Math.round(price).toLocaleString('en-IN')}</div>
              {ratios?.pe?.value != null && <div className="text-xs text-slate-500">P/E: {ratios.pe.value.toFixed(1)}×</div>}
              {ratios?.evEbitda?.value != null && <div className="text-xs text-slate-500">EV/EBITDA: {ratios.evEbitda.value.toFixed(1)}×</div>}
            </div>
          ) : (
            <div className="text-sm text-slate-500">Insufficient data for valuation</div>
          )}
        </PillarCard>

        {/* ── FUNDAMENTALS ───────────────────────────────────────────────────── */}
        <PillarCard
          title="✅ FUNDAMENTALS"
          badge={quality?.label}
          onExpand={() => onExpand('fundamentals')}
          isExpanded={expanded === 'fundamentals'}>
          <div className="space-y-1">
            <div className={`text-xl font-bold ${signalColor(quality?.label)}`}>
              {quality ? `${quality.score}/10` : '—'}
            </div>
            <div className="text-xs text-slate-400">Quality score</div>
            {ratios?.roe?.value       != null && <div className="text-xs text-slate-500">ROE: {ratios.roe.value.toFixed(1)}%</div>}
            {ratios?.netMargin?.value  != null && <div className="text-xs text-slate-500">Net Margin: {ratios.netMargin.value.toFixed(1)}%</div>}
            {ratioResult?.fcf          != null && (
              <div className="text-xs text-slate-500">{ratioResult.fcf > 0 ? 'FCF positive' : 'FCF negative'}</div>
            )}
          </div>
        </PillarCard>

        {/* ── TECHNICALS ─────────────────────────────────────────────────────── */}
        <PillarCard
          title="📈 TECHNICALS"
          badge={technicals?.available ? technicals.label : 'NO DATA'}
          onExpand={() => onExpand('technicals')}
          isExpanded={expanded === 'technicals'}>
          {technicals?.available ? (
            <div className="space-y-1">
              <div className={`text-xl font-bold ${signalColor(technicals.label)}`}>
                {technicals.label}
              </div>
              <div className="text-xs text-slate-400">Score: {technicals.score}/10</div>
              <div className="text-xs text-slate-500">RSI: {technicals.indicators.rsi}</div>
              {technicals.signals.goldenCross && <div className="text-xs text-bull">Golden Cross ✓</div>}
              {technicals.signals.deathCross  && <div className="text-xs text-bear">Death Cross ✗</div>}
              <div className="text-xs text-slate-500">
                Vol: {technicals.indicators.volume.ratio > 1.2 ? 'Above avg' :
                      technicals.indicators.volume.ratio < 0.8 ? 'Below avg' : 'Avg'}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-500">Price history unavailable from this source</div>
          )}
        </PillarCard>

        {/* ── MARKET EXPECTATION ─────────────────────────────────────────── */}
        <PillarCard
          title="🔮 MARKET EXPECTATION"
          badge={me?.primary?.impliedGrowth != null
            ? me.primary.impliedGrowth > 25 ? 'AGGRESSIVE'
            : me.primary.impliedGrowth > 15 ? 'MODERATE'
            : 'CONSERVATIVE'
            : null}
          onExpand={() => onExpand('market-expectation')}
          isExpanded={expanded === 'market-expectation'}>
          {me?.primary?.applicable ? (
            <div className="space-y-1">
              <div className={`text-xl font-bold font-mono ${
                me.primary.impliedGrowth > 25 ? 'text-bear'
                : me.primary.impliedGrowth > 15 ? 'text-neutral' : 'text-bull'
              }`}>
                {me.primary.impliedGrowth?.toFixed(1)}%/yr
              </div>
              <div className="text-xs text-slate-400">implied growth</div>
              <div className="text-xs text-slate-500">{me.primary.label}</div>
              <div className="text-xs text-slate-500">
                {me.primary.impliedGrowth > 25 ? 'Aggressive market expectation'
                : me.primary.impliedGrowth > 15 ? 'Moderate market expectation'
                : 'Conservative market expectation'}
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-500">Insufficient data for expectation analysis</div>
          )}
        </PillarCard>
      </div>

      {/* Combined verdict */}
      <div className="card border-navy-700 bg-navy-900/60 py-3 px-4">
        <div className="flex items-start gap-3">
          <span className="text-xl mt-0.5">💡</span>
          <div>
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Combined Verdict</div>
            <p className="text-sm text-slate-200 leading-relaxed">{verdict}</p>
            <AIVerdict />
          </div>
        </div>
      </div>
      <DCFScenarioPanel compact />
    </div>
  )
}

function PillarCard({ title, badge, children, onExpand, isExpanded }) {
  return (
    <div
      onClick={onExpand}
      className={`card flex flex-col gap-2 cursor-pointer transition-all
        ${isExpanded ? 'border-accent/50 bg-accent/5' : 'hover:border-navy-600'}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-300">{title}</span>
        {badge && (
          <span className={`badge text-xs ${
            ['EXCELLENT','HEALTHY','BULLISH','UNDERVALUED'].includes(badge) ? 'badge-bull' :
            ['WEAK','BEARISH','OVERVALUED'].includes(badge) ? 'badge-bear' : 'badge-neutral'
          }`}>{badge.replace(/_/g,' ')}</span>
        )}
      </div>
      <div className="flex-1">{children}</div>
      <div className="text-xs text-accent mt-1">{isExpanded ? 'Collapse ▲' : 'Explore ▼'}</div>
    </div>
  )
}
