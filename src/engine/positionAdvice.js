/**
 * src/engine/positionAdvice.js — a leaning on a specific question you're
 * asking about a held position: average up, average down, or exit.
 *
 * Deliberately NOT a new scoring model. Every point here comes from an
 * analysis block the app already computes elsewhere — exitTriggers.js
 * (price/thesis facts), positionHealth.js (technical/fundamental/re-rating
 * bars), quality.js (the business's own operating record), moatQuality.js
 * (competitive positioning), marketExpectation.js (what growth the current
 * price already assumes), technicals.js's own deeper signals (MACD, OBV,
 * divergence, chart patterns — not just moving averages and RSI), and now a
 * live peer comparison (peerBands.js, peersClient.js). What's new here is
 * INTERPRETATION and, critically, CONNECTION: which of those facts argue for
 * or against the SPECIFIC action being asked about, and — since a single
 * point in isolation says less than several independent ones agreeing —
 * whether the different BLOCKS actually reinforce or contradict each other.
 * Every point is tagged with which block it came from; the lean for each
 * horizon reports not just a direction but how many of the independent
 * blocks that contributed at all actually agree with it, so "for, and
 * fundamentals/moat/market-pricing/peers all point the same way" reads
 * differently from "for, but only barely and by one thin signal" — both are
 * real outcomes this should be able to produce, not collapsed into the same
 * label.
 *
 * A lean is a synthesis of the evidence shown alongside it, never a bare
 * directive — every point that fed it is named and visible, same disclosure
 * standard as the rest of this app (see exitTriggers.js's own "nothing fires
 * an action" principle, which this respects: it answers a question you
 * asked, it doesn't decide anything or get saved anywhere). Computed fresh
 * every time it's asked; the peer fetch is the only genuinely async piece
 * (peersClient.js hits IndexedDB and, for a never-before-seen sector, the
 * NSE constituent endpoint) — PositionsPanel.jsx awaits it before opening
 * the detail popup, same as any other on-demand, user-triggered fetch in
 * this app; nothing here needs to be pre-computed just because the feature
 * itself is synchronous elsewhere.
 */

export const INTENTS = [
  { id: 'average-up',   label: 'Average up — buy more at a higher price' },
  { id: 'average-down', label: 'Average down — buy more at a lower price' },
  { id: 'exit',         label: 'Exit the position' },
]

// The three exitTriggers.js ids that represent the thesis itself moving
// against you, not just the price — the distinction "average down" logic
// below turns entirely on (a cheaper price is an opportunity; a broken
// thesis at a cheaper price is not).
const THESIS_BREAK_IDS = new Set(['margin-erosion', 'guidance-miss', 'estimate-cut'])

// technicalBar (positionHealth.js) collapses everything into label/detail
// via `parts.join(' · ')` — with only one contributing part (the common
// case), label and detail come out identical, so reusing tb.detail here just
// repeated the point back. Rebuilt from the same raw indicators
// technicalBar reads (technicals.indicators/smaDistances/regime) instead.
function trendDetail(technicals) {
  const ind = technicals?.indicators
  const dist = technicals?.smaDistances
  if (!(ind?.price > 0) || (dist?.sma50Pct == null && dist?.sma200Pct == null)) return null
  const parts = []
  if (dist.sma50Pct != null && ind.sma50 > 0) {
    parts.push(`${Math.abs(dist.sma50Pct)}% ${dist.sma50Pct < 0 ? 'below' : 'above'} its 50-day average (${Math.round(ind.sma50)})`)
  }
  if (dist.sma200Pct != null && ind.sma200 > 0) {
    parts.push(`${Math.abs(dist.sma200Pct)}% ${dist.sma200Pct < 0 ? 'below' : 'above'} its 200-day average (${Math.round(ind.sma200)})`)
  }
  if (parts.length === 0) return null
  const regimeNote = technicals?.regime ? `, classified as a ${technicals.regime.toLowerCase()}` : ''
  return `Price ${Math.round(ind.price)} is ${parts.join(' and ')}${regimeNote}. Historically, price tends to keep trending the same way until one of these averages is reclaimed.`
}

// Same reasoning as trendDetail: rerateBar's own detail collapses every
// contributing setup down to just its short label, discarding the setup's
// OWN much richer detail. Looked up directly from health.rerate.setups.
function setupDetail(rerate, direction) {
  return (rerate?.setups || []).find(s => s.direction === direction)?.detail
    ?? rerate?.detail ?? null
}

const round1 = v => (v == null ? v : Math.round(v * 10) / 10)

// ─────────────────────────────────────────────────────────────────────────
// LONG TERM (fundamental)
// ─────────────────────────────────────────────────────────────────────────

function priceVsRangePoints(intent, { triggers, health }) {
  const points = []
  const fired = triggers?.fired || []
  const watching = triggers?.watching || []
  const find = id => fired.find(t => t.id === id)
  const thesisBreaks = fired.filter(t => THESIS_BREAK_IDS.has(t.id))
  const fb = health?.fundamental
  const eb = health?.estimate
  const aboveRange = find('above-range')
  const upperThird = find('upper-third')
  const impliedVsGuidance = find('implied-vs-guidance')
  // evaluateTriggers() always resolves the price-vs-range question to
  // exactly one of these three: above-range (fired), upper-third (fired),
  // or upper-third (watching) — whenever an estimate exists, one is present.
  const withinRange = watching.find(t => t.id === 'upper-third')

  if (intent === 'exit') {
    for (const t of thesisBreaks) points.push({ for: true, block: 'triggers', text: t.title, detail: t.detail })
    if (aboveRange) points.push({ for: true, block: 'triggers', text: aboveRange.title, detail: aboveRange.detail })
    if (upperThird) points.push({ for: true, block: 'triggers', text: upperThird.title, detail: upperThird.detail })
    if (impliedVsGuidance) points.push({ for: true, block: 'triggers', text: impliedVsGuidance.title, detail: impliedVsGuidance.detail })
    if (withinRange) points.push({ for: false, block: 'triggers', text: `Still ${withinRange.detail?.toLowerCase() || 'below the top of your range'}` })
    if (fb?.available && fb.level >= 3) points.push({ for: false, block: 'fundamentals-drift', text: fb.label, detail: fb.detail })
    if (eb?.available && eb.direction === 'up') points.push({ for: false, block: 'fundamentals-drift', text: eb.label, detail: eb.detail })
  }

  if (intent === 'average-down') {
    for (const t of thesisBreaks) points.push({ for: false, block: 'triggers', text: t.title, detail: t.detail })
    if (fb?.available && fb.level >= 3) points.push({ for: true, block: 'fundamentals-drift', text: fb.label, detail: fb.detail })
    if (fb?.available && fb.level <= 1 && thesisBreaks.length === 0) points.push({ for: false, block: 'fundamentals-drift', text: fb.label, detail: fb.detail })
    if (eb?.available && eb.direction === 'up') points.push({ for: true, block: 'fundamentals-drift', text: eb.label, detail: eb.detail })
    if (eb?.available && eb.direction === 'down' && thesisBreaks.length === 0) {
      points.push({ for: false, block: 'fundamentals-drift', text: `${eb.label} — the discount has narrowed, not widened`, detail: eb.detail })
    }
    if (aboveRange || upperThird) {
      const t = aboveRange || upperThird
      points.push({ for: false, block: 'triggers', text: 'Already trading in the rich part of your own range — not obviously a discount', detail: t.detail })
    }
  }

  if (intent === 'average-up') {
    for (const t of thesisBreaks) points.push({ for: false, block: 'triggers', text: t.title, detail: t.detail })
    if (aboveRange) points.push({ for: false, block: 'triggers', text: aboveRange.title, detail: aboveRange.detail })
    if (impliedVsGuidance) points.push({ for: false, block: 'triggers', text: impliedVsGuidance.title, detail: impliedVsGuidance.detail })
    if (fb?.available && fb.level >= 3) points.push({ for: true, block: 'fundamentals-drift', text: fb.label, detail: fb.detail })
    if (!aboveRange && !upperThird && (withinRange || (fb?.available && fb.level >= 2))) {
      points.push({
        for: true, block: 'triggers', text: 'Thesis on track and price still below the top of your estimate range',
        detail: withinRange ? `${withinRange.title} — ${withinRange.detail || ''}`.trim() : (fb?.detail || null),
      })
    }
  }

  return points
}

// Moat/Quality tiers ranked so "is this combination favorable" is a
// comparison, not a hand-picked list — moatQuality.js's own implicationFor()
// already makes this judgment (its whole reason for existing), this just
// reads off the same two tiers it was given.
const MOAT_RANK = { 'Very Wide': 3, Wide: 2, Narrow: 1, None: 0 }
const QUALITY_RANK = { High: 2, Medium: 1, Low: 0 }

// Quality Score and Moat/Quality answer "is this a good business"
// independently of price — genuinely different from triggers' price-vs-
// cost/estimate signals, and relevant to every intent the same way (a
// durable, well-run business is a reason to stay invested regardless of
// which action is being asked about).
function businessQualityPoints(intent, { quality, moatQuality }) {
  const points = []

  if (quality?.label) {
    const good = quality.label === 'EXCELLENT' || quality.label === 'HEALTHY'
    points.push({ for: intent === 'exit' ? !good : good, block: 'quality', text: `Quality Score ${quality.score}/10 (${quality.label})` })
    // Every predictor's own value against its own threshold, not just the
    // failing ones — "how strong is this business, specifically, on the
    // ratios that made up that score" rather than only its red flags.
    const withValues = (quality.predictors || []).filter(p => p.value != null && p.threshold != null)
    if (withValues.length > 0) {
      const detail = withValues.map(p =>
        `${p.label}: ${p.value.toFixed(1)} (${p.pass ? 'above' : 'below'} the ${p.threshold} threshold)`).join('; ')
      const failing = withValues.filter(p => !p.pass)
      points.push({
        for: intent === 'exit' ? failing.length > withValues.length / 2 : failing.length <= withValues.length / 2,
        block: 'quality',
        text: failing.length > 0
          ? `${failing.length} of ${withValues.length} quality ratios below their own threshold`
          : `All ${withValues.length} measurable quality ratios clear their threshold`,
        detail,
      })
    }
  }

  if (moatQuality?.moat?.tier && moatQuality?.quality?.tier) {
    const mRank = MOAT_RANK[moatQuality.moat.tier] ?? 0
    const qRank = QUALITY_RANK[moatQuality.quality.tier] ?? 0
    const strong = mRank >= 2 && qRank >= 1
    const weak = qRank === 0 || (mRank === 0 && qRank <= 1)
    const text = `${moatQuality.moat.tier} moat, ${moatQuality.quality.tier} quality`
    // The underlying evidence lines (moatQuality's own {ok,text} pairs) are
    // real, specific reasons — ROCE consistency, margin trend, leverage —
    // not just the tier label restated.
    const evidence = [...(moatQuality.moat.evidence || []), ...(moatQuality.quality.evidence || [])]
      .filter(e => e.text).map(e => e.text).join(' ')
    if (strong) points.push({ for: intent !== 'exit', block: 'moat', text, detail: [moatQuality.implication, evidence].filter(Boolean).join(' ') })
    else if (weak) points.push({ for: intent === 'exit', block: 'moat', text, detail: [moatQuality.implication, evidence].filter(Boolean).join(' ') })
  }

  return points
}

function marketExpectationPoints(intent, { marketExpectation }) {
  const points = []
  const variant = ['earnings', 'sales', 'fcf', 'reverseDcf']
    .map(k => marketExpectation?.variants?.[k])
    .find(v => v?.applicable !== false && v?.impliedGrowth != null)
  if (!variant) return points

  const hc = variant.historicalComparison
  const currentRow = variant.sanityTable?.find(r => r.isCurrentImplied)
  if (currentRow?.label) {
    const rich = currentRow.label === 'Overvalued' || currentRow.label === 'Highly overvalued'
    const cheap = currentRow.label === 'Undervalued'
    if (rich) points.push({ for: intent === 'exit', block: 'market-expectation', text: `Market pricing: ${currentRow.label}`, detail: variant.conclusion })
    else if (cheap) points.push({ for: intent !== 'exit', block: 'market-expectation', text: `Market pricing: ${currentRow.label}`, detail: variant.conclusion })
  }
  if (hc?.available && Math.abs(hc.gapVsMedianYoY) >= 5) {
    const strained = hc.gapVsMedianYoY > 0
    points.push({
      for: strained ? intent === 'exit' : intent !== 'exit',
      block: 'market-expectation',
      text: strained
        ? `Priced for ${round1(variant.impliedGrowth)}% growth vs a ${round1(hc.medianYoY)}% historical median — asking a lot of the future`
        : `Priced for ${round1(variant.impliedGrowth)}% growth, below its own ${round1(hc.medianYoY)}% historical median — room to re-rate if it keeps delivering`,
      detail: variant.conclusion,
    })
  }
  return points
}

// Peer comparison — a genuinely different question from everything else
// here: not "is this cheap against its OWN history/estimate" but "is this
// cheap against what the market pays for comparable businesses right now."
// Fetched on demand by PositionsPanel.jsx when a question is asked (see
// this file's own top comment) — absent here just means it hasn't resolved
// yet or genuinely has too few peers, not that it was skipped by design.
function peerPoints(intent, { peers }) {
  const points = []
  if (!peers) return points
  const { peBand, roeBand, ownPe, ownRoe, count } = peers
  if (peBand?.median > 0 && ownPe > 0) {
    const ratio = ownPe / peBand.median
    if (ratio >= 1.25 || ratio <= 0.8) {
      const rich = ratio >= 1.25
      points.push({
        for: rich ? intent === 'exit' : intent !== 'exit',
        block: 'peers',
        text: `Trading at ${round1(ownPe)}× vs peer median ${peBand.median}× (${count} peers)`,
        detail: rich
          ? 'Priced above comparable companies — the market is already crediting this one with something extra.'
          : 'Priced below comparable companies — either a real discount, or the market sees a reason the peers don\'t share.',
      })
    }
  }
  if (roeBand?.median > 0 && ownRoe > 0) {
    const ratio = ownRoe / roeBand.median
    if (ratio >= 1.2 || ratio <= 0.8) {
      const better = ratio >= 1.2
      points.push({
        for: better ? intent !== 'exit' : intent === 'exit',
        block: 'peers',
        text: `ROE ${round1(ownRoe)}% vs peer median ${roeBand.median}%`,
        detail: better
          ? 'Converting capital into profit more efficiently than its comparable set.'
          : 'Converting capital into profit less efficiently than its comparable set — worth understanding why before paying up for it.',
      })
    }
  }
  return points
}

function longTermPoints(intent, ctx) {
  return [
    ...priceVsRangePoints(intent, ctx),
    ...businessQualityPoints(intent, ctx),
    ...marketExpectationPoints(intent, ctx),
    ...peerPoints(intent, ctx),
  ]
}

// ─────────────────────────────────────────────────────────────────────────
// SHORT TERM (technical)
// ─────────────────────────────────────────────────────────────────────────

// technicals.js's own headline read (score/label), backed by its 4-group
// breakdown — the one-line summary the Technicals panel itself leads with.
// NEUTRAL genuinely carries no directional information, so it contributes
// nothing rather than being forced into either side.
function technicalSummaryPoint(technicals) {
  if (!technicals?.available || (technicals.label !== 'BULLISH' && technicals.label !== 'BEARISH')) return null
  const bullish = technicals.label === 'BULLISH'
  const groupLines = Object.entries(technicals.groups || {})
    .map(([k, g]) => `${k[0].toUpperCase()}${k.slice(1)}: ${g.status}`)
    .join(', ')
  return {
    bullish,
    text: `Overall technical read: ${technicals.label} (${technicals.score}/10)`,
    detail: groupLines ? `Across the four groups this reads from — ${groupLines}.` : null,
  }
}

// MACD/OBV/divergence — momentum and participation evidence beyond plain
// trend (moving averages) and plain overbought/oversold (RSI alone). A
// MACD crossover or OBV trend can confirm or contradict what price action
// alone suggests; divergence specifically flags price making an extreme
// that volume/momentum doesn't confirm, a classic early-warning signal.
function momentumAndVolumePoints(intent, technicals) {
  const points = []
  const sig = technicals?.signals || {}
  const macd = technicals?.indicators?.macd
  const vol = technicals?.indicators?.volume
  // Bullish momentum supports owning more regardless of whether that's at a
  // higher or lower price than your own cost; bearish momentum supports the
  // opposite of that, and supports exiting. Only exit's polarity flips.
  const bullishArguesFor = intent !== 'exit'

  if (sig.macdBullCross) {
    points.push({ for: bullishArguesFor, block: 'technicals-momentum', text: 'MACD crossed up',
      detail: macd ? `MACD line ${macd.macd} crossed above its signal line ${macd.signal} — a standard bullish momentum shift, independent of where price sits relative to its moving averages.` : null })
  }
  if (sig.macdBearCross) {
    points.push({ for: !bullishArguesFor, block: 'technicals-momentum', text: 'MACD crossed down',
      detail: macd ? `MACD line ${macd.macd} crossed below its signal line ${macd.signal} — a standard bearish momentum shift.` : null })
  }
  if (sig.rsiBullDiv) {
    points.push({ for: bullishArguesFor, block: 'technicals-momentum', text: 'Bullish RSI divergence',
      detail: 'Price made a new low that momentum did not confirm — sellers pushing the price down with less underlying force than the last time, often (not always) a precursor to a reversal.' })
  }
  if (sig.rsiBearDiv) {
    points.push({ for: !bullishArguesFor, block: 'technicals-momentum', text: 'Bearish RSI divergence',
      detail: 'Price made a new high that momentum did not confirm — the advance is losing underlying force even as price still climbs, a classic warning sign before a top.' })
  }
  if (sig.obvRising != null && vol?.ratio != null) {
    // Volume is direction-agnostic on its own — elevated volume amplifies
    // whatever else is happening, it doesn't independently argue a side —
    // so it's only surfaced paired WITH the one directional volume signal
    // this engine actually computes (OBV trend), not as a bare number.
    points.push({
      for: sig.obvRising ? bullishArguesFor : !bullishArguesFor,
      block: 'technicals-volume',
      text: sig.obvRising ? 'On-balance volume rising' : 'On-balance volume falling',
      detail: (sig.obvRising
        ? 'Cumulative volume on up days is outpacing down days — accumulation, consistent with real buying interest rather than a thin, unconvincing bounce.'
        : 'Cumulative volume on down days is outpacing up days — distribution, consistent with real selling rather than routine profit-taking.')
        + (vol.ratio > 2 ? ` Volume is currently running ${vol.ratio}× its 20-day average, so today's move carries more conviction than a typical day's.` : ''),
    })
  }
  return points
}

// technicals.js's pattern objects carry only {name, type, evidenced} — no
// detail text of their own — so it's built here from what "evidenced"
// actually means for this app specifically (see positionHealth.js's own
// technicalBar comment: these are the candlestick patterns with published
// backtested support in INDIAN-market data — the same patterns test as
// noise on US indices, which is why only this small subset counts here).
const PATTERN_NOTES = {
  'Inverted Hammer': 'A small body near the day\'s low with a long upper wick, after a decline.',
  'Bullish Engulfing': 'A large up candle whose body fully covers the prior day\'s down candle.',
  'Bearish Engulfing': 'A large down candle whose body fully covers the prior day\'s up candle.',
  'Bullish Harami': 'A small candle contained entirely within the prior day\'s larger down candle.',
  'Bearish Harami': 'A small candle contained entirely within the prior day\'s larger up candle.',
}
const PATTERN_SUFFIX = ' A published, backtested signal in Indian-market data specifically — the same pattern tests as noise on US indices.'

// Evidenced chart patterns (technicals.js's own vetted subset — not every
// pattern the library can name) — positionHealth's technicalBar folds these
// into one collapsed label; read directly here so each shows up as its own
// named, dated piece of evidence instead of disappearing into "1 bullish
// pattern" or being lost entirely behind whichever other signal set the
// bar's single label.
function patternPoints(intent, technicals) {
  const evidenced = (technicals?.patterns || []).filter(p => p.evidenced)
  return evidenced.map(p => ({
    for: intent === 'exit' ? p.type === 'bearish' : p.type === 'bullish',
    block: 'technicals-patterns',
    text: `${p.name} (${p.type})`,
    detail: PATTERN_NOTES[p.name] ? PATTERN_NOTES[p.name] + PATTERN_SUFFIX : null,
  }))
}

function shortTermPoints(intent, { health, technicals, suggestions }) {
  const points = []
  const tb = health?.technical
  const rb = health?.rerate
  const sig = technicals?.signals || {}
  const rsi = technicals?.indicators?.rsi
  const supportStop = (suggestions?.stops || []).find(s => s.id === 'support')
  const resistanceTarget = (suggestions?.targets || []).find(t => t.id === 'resistance')
  const trend = trendDetail(technicals)
  const summary = technicalSummaryPoint(technicals)

  if (intent === 'exit') {
    if (summary) points.push({ for: !summary.bullish, block: 'technicals-trend', text: summary.text, detail: summary.detail })
    if (tb?.available && tb.level <= 1) points.push({ for: true, block: 'technicals-trend', text: tb.label, detail: trend })
    if (tb?.available && tb.level >= 3) points.push({ for: false, block: 'technicals-trend', text: tb.label, detail: trend })
    if (rb?.available && rb.direction === 'down') points.push({ for: true, block: 'setups', text: rb.label, detail: setupDetail(rb, 'bearish') })
    if (rb?.available && rb.direction === 'up') points.push({ for: false, block: 'setups', text: rb.label, detail: setupDetail(rb, 'bullish') })
    if (resistanceTarget) points.push({ for: true, block: 'levels', text: `Near resistance at ${resistanceTarget.price}`, detail: resistanceTarget.why })
  }

  if (intent === 'average-down') {
    if (summary) points.push({ for: summary.bullish, block: 'technicals-trend', text: summary.text, detail: summary.detail })
    if (sig.rsiOversold) {
      points.push({ for: true, block: 'technicals-momentum', text: 'RSI oversold', detail: rsi != null
        ? `RSI at ${rsi} — below the 30 line usually read as oversold, where selling pressure has historically been stretched and a bounce becomes more likely, though not guaranteed.` : null })
    }
    if (sig.rsiOverbought) {
      points.push({ for: false, block: 'technicals-momentum', text: 'RSI overbought — an unusual point to be adding', detail: rsi != null
        ? `RSI at ${rsi} — above the 70 line usually read as overbought, an unusual point to be adding to a position on a dip thesis.` : null })
    }
    if (supportStop && !supportStop.tooClose) {
      points.push({ for: true, block: 'levels', text: `Sitting near ${supportStop.label.toLowerCase()} (${supportStop.price})`, detail: supportStop.why })
    }
    if (sig.deathCross) {
      points.push({ for: false, block: 'technicals-trend', text: 'Death cross — the trend is still deteriorating',
        detail: 'The 50-day average has crossed below the 200-day average — a classic longer-term downtrend signal, historically associated with continued weakness rather than an imminent reversal.' })
    }
    if (tb?.available && tb.level <= 1 && !supportStop) {
      points.push({ for: false, block: 'technicals-trend', text: 'No nearby support and the trend is still weak — a real risk of catching a falling knife', detail: trend })
    }
  }

  if (intent === 'average-up') {
    if (summary) points.push({ for: summary.bullish, block: 'technicals-trend', text: summary.text, detail: summary.detail })
    if (tb?.available && tb.level >= 3) points.push({ for: true, block: 'technicals-trend', text: tb.label, detail: trend })
    if (tb?.available && tb.level <= 1) {
      points.push({ for: false, block: 'technicals-trend', text: `${tb.label} — not the confirmed strength averaging up usually relies on`, detail: trend })
    }
    if (rb?.available && rb.direction === 'up') points.push({ for: true, block: 'setups', text: rb.label, detail: setupDetail(rb, 'bullish') })
    if (rb?.available && rb.direction === 'down') points.push({ for: false, block: 'setups', text: rb.label, detail: setupDetail(rb, 'bearish') })
    if (sig.rsiOverbought) {
      points.push({ for: false, block: 'technicals-momentum', text: 'RSI overbought — already extended', detail: rsi != null
        ? `RSI at ${rsi} — above the 70 line usually read as overbought, meaning the recent move has already stretched further than this stock typically sustains without a pause.` : null })
    }
    if (resistanceTarget) points.push({ for: false, block: 'levels', text: `Approaching resistance at ${resistanceTarget.price}`, detail: resistanceTarget.why })
  }

  points.push(...momentumAndVolumePoints(intent, technicals))
  points.push(...patternPoints(intent, technicals))
  return points
}

// ─────────────────────────────────────────────────────────────────────────
// Synthesis
// ─────────────────────────────────────────────────────────────────────────

// Ties and empty lists are both genuinely "no signal" — a majority vote
// forced onto contradictory or absent evidence would manufacture a lean the
// evidence doesn't support, same reasoning positionHealth.js's rerateBar
// already applies to its own mixed-setup case.
function leanFrom(points) {
  if (points.length === 0) return 'unavailable'
  const forCount = points.filter(p => p.for).length
  const againstCount = points.length - forCount
  if (forCount === againstCount) return 'mixed'
  return forCount > againstCount ? 'for' : 'against'
}

// The actual "how it connects" answer: not just a lean, but how many
// INDEPENDENT blocks (not individual points — three points from the same
// block agreeing is one opinion said three ways, not three opinions)
// contributed at all, and how many of those land on the same side as the
// overall lean. "For, and 4 of 4 contributing blocks agree" is a
// materially stronger statement than "for, but only 1 of 3 blocks agrees
// and the rest are mixed or silent" — collapsing both into the same bare
// lean is exactly the shallowness this was built to fix.
function convergence(points, lean) {
  if (lean === 'unavailable' || lean === 'mixed') return null
  const byBlock = new Map()
  for (const p of points) {
    if (!byBlock.has(p.block)) byBlock.set(p.block, { for: 0, against: 0 })
    byBlock.get(p.block)[p.for ? 'for' : 'against']++
  }
  let agree = 0, disagree = 0, split = 0
  for (const [, counts] of byBlock) {
    const blockLean = counts.for === counts.against ? null : (counts.for > counts.against ? 'for' : 'against')
    if (blockLean == null) split++
    else if (blockLean === lean) agree++
    else disagree++
  }
  const total = byBlock.size
  return {
    agree, disagree, split, total,
    note: disagree === 0 && split === 0
      ? `All ${total} contributing block${total > 1 ? 's' : ''} (${[...byBlock.keys()].join(', ')}) point the same way.`
      : disagree > 0
        ? `${agree} of ${total} blocks agree; ${disagree} point the other way${split > 0 ? `, ${split} internally mixed` : ''} — worth reading the dissenting evidence before acting.`
        : `${agree} of ${total} blocks agree; ${split} internally mixed, contributing no net direction.`,
  }
}

/**
 * @param intent one of INTENTS' ids
 * @param ctx.triggers          evaluateTriggers()'s return, with .suggestions
 *                              (suggestLevels()'s return) merged in
 * @param ctx.health            positionHealth()'s return
 * @param ctx.technicals        the raw technicals object (deeper signals:
 *                              MACD, OBV, divergence, patterns, overall
 *                              score/label/groups — not just moving
 *                              averages/RSI/crossovers)
 * @param ctx.quality           scoreQuality()'s return (quality.js)
 * @param ctx.moatQuality       assessMoatQuality()'s return (moatQuality.js)
 * @param ctx.marketExpectation runMarketExpectation()'s return
 * @param ctx.peers             { peBand, roeBand, ownPe, ownRoe, count } —
 *                              built by PositionsPanel.jsx from a fresh,
 *                              on-demand peersClient.js fetch; omitted (not
 *                              faked) while that fetch is still in flight
 */
export function adviseOnIntent(intent, ctx = {}) {
  const longTermPts = longTermPoints(intent, ctx)
  const shortTermPts = shortTermPoints(intent, { ...ctx, suggestions: ctx.triggers?.suggestions })
  const longLean = leanFrom(longTermPts)
  const shortLean = leanFrom(shortTermPts)
  return {
    intent,
    longTerm: { lean: longLean, points: longTermPts, convergence: convergence(longTermPts, longLean) },
    shortTerm: { lean: shortLean, points: shortTermPts, convergence: convergence(shortTermPts, shortLean) },
  }
}
