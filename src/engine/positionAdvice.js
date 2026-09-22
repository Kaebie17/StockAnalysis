/**
 * src/engine/positionAdvice.js — Buy/Hold/Sell/Wait for a specific question
 * (average up, average down, exit) about a held position.
 *
 * Three genuinely different questions, kept separate rather than collapsed
 * into one score:
 *   VALUATION  — what price is the market assuming? (model estimate range,
 *                market-implied growth vs this company's own historical
 *                growth, peer multiple)
 *   QUALITY    — is the underlying business supporting that price? (growth,
 *                margins, ROE, ROCE, moat — and whether they agree with
 *                each other, not just whether each clears a threshold)
 *   TECHNICAL  — is the market currently confirming either case? (trend,
 *                momentum, participation, support/resistance)
 * A company can be a good business trading at a rich price with a
 * confirming uptrend, or a mediocre business trading cheap with technicals
 * that haven't turned yet — these are different situations that a single
 * "for/against" score cannot tell apart, which is exactly the failure mode
 * an earlier version of this file had.
 *
 * The decision (Buy/Hold/Sell/Wait) is computed LAST, from the three
 * section verdicts plus how they conflict — never as fundamentalScore +
 * technicalScore + valuationScore added together, which produces a number
 * with no accountable reasoning behind it. See buildConflict/buildDecision.
 *
 *   Buy  = evidence supports initiating/increasing exposure at the current price
 *   Hold = the existing thesis remains plausible, but evidence doesn't
 *          clear the bar for increasing exposure
 *   Sell = the thesis or valuation has deteriorated enough to reduce exposure
 *   Wait = a specific, named piece of confirmation is missing — not a
 *          verdict in itself, a flag for what to watch before either Buy or Sell
 *
 * Every section shows its own real numbers (actual ratio values, actual
 * price levels, actual implied-growth figures) — not a restated threshold
 * pass/fail and not a bare label. Nothing here decides anything or is
 * saved anywhere; it's answered fresh from the same live analysis blocks
 * the rest of the app already computes (quality.js, moatQuality.js,
 * marketExpectation.js, technicals.js, peersClient.js/peerBands.js) every
 * time a question is asked.
 */

export const INTENTS = [
  { id: 'average-up',   label: 'Average up — buy more at a higher price' },
  { id: 'average-down', label: 'Average down — buy more at a lower price' },
  { id: 'exit',         label: 'Exit the position' },
]

const round1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10)
const fmtPct = v => (v == null ? '—' : `${round1(v)}%`)

// ─────────────────────────────────────────────────────────────────────────
// VALUATION — what price is the market assuming?
// ─────────────────────────────────────────────────────────────────────────

function buildValuation({ estimate, price, marketExpectation, peers }) {
  const facts = []
  let zone = null   // 'below' | 'within' | 'above' | null
  if (estimate?.ok && price > 0) {
    const { low, high } = estimate.target
    zone = price < low ? 'below' : price > high ? 'above' : 'within'
    const pctVsHigh = round1(((high - price) / price) * 100)
    facts.push(`Model estimate range: ${round1(low)}–${round1(high)} per share.`)
    facts.push(`Current price: ${round1(price)} — ${
      zone === 'below' ? `${Math.abs(pctVsHigh)}% below the upper end of the range`
      : zone === 'above' ? `${Math.abs(pctVsHigh)}% above the upper end of the range`
      : 'within the range'
    }.`)
  }

  const variant = ['earnings', 'sales', 'fcf', 'reverseDcf']
    .map(k => marketExpectation?.variants?.[k])
    .find(v => v?.applicable !== false && v?.impliedGrowth != null)
  let gapPts = null
  if (variant) {
    const hc = variant.historicalComparison
    facts.push(`Market-implied growth: ${fmtPct(variant.impliedGrowth)}.`)
    if (hc?.available) {
      gapPts = round1(hc.gapVsMedianYoY)
      facts.push(`This company's own historical median growth: ${fmtPct(hc.medianYoY)}.`)
      facts.push(gapPts >= 0
        ? `Market-implied growth is ${Math.abs(gapPts)} points ABOVE its historical median — the price assumes an acceleration, not a continuation.`
        : `Market-implied growth is ${Math.abs(gapPts)} points below its historical median — the price assumes less than the company has actually delivered.`)
    }
  }

  let peerNote = null, peerExtreme = false
  if (peers?.peBand?.median > 0 && peers.ownPe > 0) {
    const ratio = peers.ownPe / peers.peBand.median
    peerExtreme = ratio >= 3 || ratio <= 0.34
    // A ratio under 1 (e.g. 0.14×) reads as a small, unremarkable-looking
    // number even when it represents a huge gap — stating it as "N times
    // cheaper/richer" keeps the magnitude legible regardless of direction.
    const magnitude = ratio >= 1 ? `${round1(ratio)}× its peer median` : `${round1(1 / ratio)}× below its peer median`
    facts.push(`Peer P/E: trading at ${round1(peers.ownPe)}× vs a peer median of ${peers.peBand.median}× (${peers.count} peers).`)
    peerNote = peerExtreme
      ? `The gap between this stock's own multiple and its peer median is large enough (${magnitude}) that it needs interpretation, not a bare "cheap" or "expensive" reading — either the peer set doesn't genuinely compare (a common problem for a business with few true comparables), or the market is pricing in something the peer group doesn't share. Taking the raw ratio at face value either way would be a mistake.`
      : `Reasonably in line with its peer set.`
    facts.push(peerNote)
  }

  // Base signal as a sum of the two data-backed directions (model-range
  // position, market-implied-vs-historical growth gap), not a strict
  // same-zone match — a price sitting WITHIN the model range (neither
  // signal on its own) alongside implied growth well below the company's
  // own historical median is still a genuine net-positive read, not
  // "mixed" just because the price position alone didn't clear the bar.
  // The peer gap, when extreme, qualifies the verdict with uncertainty
  // rather than adding a third vote — an extreme peer gap is itself
  // ambiguous (could mean either direction, or an uncomparable peer set)
  // rather than a clean data point the way the other two are.
  let score = 0
  if (zone === 'below') score += 1
  else if (zone === 'above') score -= 1
  if (gapPts != null) score += gapPts <= 0 ? 1 : -1
  const base = score > 0 ? 'positive' : score < 0 ? 'negative' : (facts.length > 0 ? 'mixed' : null)

  const verdict =
    base === 'positive' ? (peerExtreme ? 'Positive, but with uncertainty' : 'Undervalued')
    : base === 'negative' ? (peerExtreme ? 'Overvalued, but with uncertainty' : 'Overvalued')
    : (facts.length === 0 ? 'Unavailable' : 'Fair, with mixed signals')

  return { verdict, base, zone, gapPts, peerExtreme, facts, available: facts.length > 0 }
}

// ─────────────────────────────────────────────────────────────────────────
// QUALITY — is the underlying business supporting that price?
// ─────────────────────────────────────────────────────────────────────────

function metricOf(quality, key) {
  const p = (quality?.predictors || []).find(x => x.key === key)
  return p?.value != null ? p : null
}

function buildQuality({ quality, moatQuality }) {
  const facts = []
  const narrative = []
  const revGrowth = metricOf(quality, 'revenueGrowth')
  const opMargin = metricOf(quality, 'ebitdaMargin')
  const netMargin = metricOf(quality, 'netMargin')
  const roe = metricOf(quality, 'roe')
  const roce = metricOf(quality, 'roce')

  for (const [label, m] of [
    ['Revenue growth', revGrowth], ['Operating margin', opMargin], ['Net margin', netMargin],
    ['ROE', roe], ['ROCE', roce],
  ]) {
    if (m) facts.push(`${label}: ${fmtPct(m.value)}`)
  }

  // The specific structural conflict worth naming explicitly: a high ROE
  // that ISN'T accompanied by strong ROCE (or margins) is a real economic
  // distinction, not a nitpick — ROE alone can be inflated by leverage or,
  // structurally, by a thin equity base (insurers and some capital-light
  // businesses run this way by design), while ROCE measures returns on ALL
  // capital employed, debt included. A business can show an excellent ROE
  // and a poor ROCE at the same time; when that happens, the ROE number on
  // its own is not evidence of superior capital-allocation economics.
  if (roe?.pass && roce && !roce.pass) {
    narrative.push(
      `ROE is strong (${fmtPct(roe.value)}), but it is not accompanied by strong ROCE (${fmtPct(roce.value)})` +
      `${opMargin && !opMargin.pass ? ` or operating margins (${fmtPct(opMargin.value)})` : ''}. ` +
      `On its own, a high ROE alongside weak capital efficiency more broadly is not strong evidence of superior ` +
      `business economics — it can also reflect a thin equity base or financial leverage rather than genuinely ` +
      `superior returns on the capital actually employed in the business.`
    )
  }
  if (revGrowth && !revGrowth.pass && netMargin?.pass) {
    narrative.push(`Growth is slow (${fmtPct(revGrowth.value)}), but net margin (${fmtPct(netMargin.value)}) is holding up — a maturity/capital-discipline profile rather than a growth one.`)
  }

  if (moatQuality?.moat?.tier && moatQuality?.quality?.tier) {
    facts.push(`Moat: ${moatQuality.moat.tier}. Quality tier: ${moatQuality.quality.tier}.`)
    if (moatQuality.implication) narrative.push(moatQuality.implication)
  }

  const withValues = (quality?.predictors || []).filter(p => p.value != null && p.threshold != null)
  const failing = withValues.filter(p => !p.pass)
  const conflicted = narrative.length > 0 && quality?.label !== 'WEAK'
  const verdict = !quality?.label ? 'Unavailable'
    : quality.label === 'EXCELLENT' && !conflicted ? 'Strong operating quality'
    : quality.label === 'WEAK' ? 'Weak operating quality'
    : conflicted || quality.label === 'CONCERNS' ? 'Mixed / weak operating-quality evidence'
    : 'Reasonable operating quality'

  return {
    verdict, narrative, facts,
    scoreLabel: quality?.label ?? null, score: quality?.score ?? null,
    failingCount: failing.length, totalCount: withValues.length,
    available: !!quality?.label,
    // Kept on the built section (not just the raw input) so buildConflict/
    // buildWatchlist can point at the same specific metrics (ROCE, margins)
    // without needing the raw ctx.quality threaded through separately.
    predictors: quality?.predictors || [],
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TECHNICAL — is the market currently confirming either case?
// ─────────────────────────────────────────────────────────────────────────

function buildTechnical(intent, { technicals, suggestions }) {
  const facts = []
  if (!technicals?.available) return { verdict: 'Unavailable', facts, available: false }

  const ind = technicals.indicators, dist = technicals.smaDistances
  if (ind?.price > 0 && dist?.sma50Pct != null) facts.push(`Price ${dist.sma50Pct < 0 ? 'below' : 'above'} its 50-day average (${Math.round(ind.sma50)}).`)
  if (ind?.price > 0 && dist?.sma200Pct != null) facts.push(`Price ${dist.sma200Pct < 0 ? 'below' : 'above'} its 200-day average (${Math.round(ind.sma200)}).`)
  facts.push(`Trend regime: ${technicals.regime || 'unclear'}.`)
  if (technicals.groups?.momentum?.status) facts.push(`Momentum: ${technicals.groups.momentum.status}.`)
  if (technicals.groups?.participation?.status) facts.push(`Participation: ${technicals.groups.participation.status}.`)
  const support = (suggestions?.stops || []).find(s => s.id === 'support')
  const resistance = (suggestions?.targets || []).find(t => t.id === 'resistance')
  if (support) facts.push(`Support: ${support.price}.`)
  if (resistance) facts.push(`Resistance: ${resistance.price}.`)

  // "Confirming" means what an average-up/average-down question needs
  // (bullish price action) — for exit, it's the mirror (bearish price
  // action confirms the case FOR exiting).
  const wantsBullish = intent !== 'exit'
  const bullish = technicals.label === 'BULLISH'
  const bearish = technicals.label === 'BEARISH'
  const confirming = wantsBullish ? bullish : bearish
  const contradicting = wantsBullish ? bearish : bullish
  const verdict = confirming ? 'Confirmed' : contradicting ? 'Contradicting' : 'Not confirmed'

  const narrative = verdict === 'Confirmed'
    ? `Price action is currently confirming this — technicals (${technicals.label}, ${technicals.score}/10) agree with the direction this question is asking about.`
    : verdict === 'Contradicting'
    ? `Price action is currently running the OPPOSITE way (${technicals.label}, ${technicals.score}/10) — a real, active disagreement with this question's direction, not just an absence of confirmation.`
    : `The fundamental case is not currently being confirmed by price action (${technicals.label}, ${technicals.score}/10). This doesn't invalidate the fundamental thesis; it means the technical evidence does not currently support using technical strength as additional confirmation.`

  return { verdict, facts, narrative, available: true, label: technicals.label, score: technicals.score }
}

// ─────────────────────────────────────────────────────────────────────────
// CONFLICT — why do the signals disagree?
// ─────────────────────────────────────────────────────────────────────────

function buildConflict(intent, valuation, quality, technical) {
  const supporting = [], against = []

  if (valuation.available) {
    if (valuation.base === 'positive') {
      supporting.push('Current valuation leaves room versus the model range.')
      if (valuation.gapPts != null && valuation.gapPts < 0) supporting.push('Implied market growth is below this company\'s own historical median — a conservative, not optimistic, assumption.')
    } else if (valuation.base === 'negative') {
      against.push('Current price sits above the model\'s own estimate range.')
      if (valuation.gapPts != null && valuation.gapPts > 0) against.push('Implied market growth is already above this company\'s own historical median.')
    }
    if (valuation.peerExtreme) against.push('Peer multiple comparison is unusually extreme and needs independent interpretation.')
  }

  if (quality.available) {
    const goodMetric = (label, m) => m?.pass && supporting.push(`${label} clears its own threshold.`)
    const badMetric = (label, m) => m && !m.pass && against.push(`${label} is weak.`)
    const revG = metricOf(quality, 'revenueGrowth'), roe = metricOf(quality, 'roe'), roce = metricOf(quality, 'roce'), opM = metricOf(quality, 'ebitdaMargin'), netM = metricOf(quality, 'netMargin')
    if (roe?.pass) supporting.push(`Reported ROE is high (${fmtPct(roe.value)}).`)
    if (revG?.pass) supporting.push('Earnings/revenue have grown strongly.')
    badMetric('Operating margin', opM); badMetric('Net margin', netM); badMetric('ROCE', roce)
    if (quality.narrative.length > 0) against.push('The strong ROE is not corroborated by capital efficiency more broadly.')
  }

  if (technical.available) {
    if (technical.verdict === 'Confirmed') supporting.push('Technical trend is confirming this direction.')
    else against.push(technical.verdict === 'Contradicting' ? 'Technical trend is actively running the other way.' : 'Technical trend isn\'t confirming.')
  }

  // A handful of named, common patterns get a tailored central-issue
  // sentence; anything else gets an honest generic one rather than a
  // fabricated-sounding specific claim the evidence doesn't actually support.
  let centralIssue
  if (valuation.base === 'positive' && (quality.verdict.startsWith('Mixed') || quality.verdict === 'Weak operating quality') && technical.verdict !== 'Confirmed') {
    centralIssue = 'The valuation says the market may be underestimating future value, while the quality and technical evidence do not yet provide strong confirmation that the underlying business is translating that into sustainable operating returns.'
  } else if (valuation.base === 'negative' && quality.verdict === 'Strong operating quality') {
    centralIssue = 'This looks like a genuinely good business trading at a price that already assumes it — the risk here is paying up for quality that\'s already in the number, not a deteriorating business.'
  } else if (supporting.length > 0 && against.length === 0) {
    centralIssue = 'The evidence gathered here points the same way across valuation, quality, and technicals — a genuine, if never guaranteed, alignment.'
  } else if (against.length > 0 && supporting.length === 0) {
    centralIssue = 'The evidence gathered here points the same way against this — valuation, quality, and technicals aren\'t offering a reason to disagree with each other.'
  } else {
    centralIssue = 'The evidence here doesn\'t point cleanly one way — different parts of the analysis (valuation, business quality, price action) are answering their own separate questions differently, and none of them overrides the others by default.'
  }

  return { supporting, against, centralIssue }
}

// What would move this — a direct answer to "what would make you change
// your mind," derived from whichever specific things are actually weak
// (not a generic pair of platitudes attached regardless of the evidence).
function buildWatchlist(valuation, quality, technical) {
  const strengthen = [], weaken = []
  const roce = (quality.predictors || []).find(p => p.key === 'roce')
  const opMargin = (quality.predictors || []).find(p => p.key === 'ebitdaMargin')

  if (technical.available && technical.verdict !== 'Confirmed') {
    strengthen.push('Price reclaims the relevant moving averages, or the technical trend confirms.')
  }
  if (technical.available) weaken.push('Technical deterioration continues.')

  if (valuation.available) {
    strengthen.push('Earnings continue to support the current valuation.')
    weaken.push('The valuation estimate falls, or earnings growth deteriorates.')
    if (valuation.base === 'positive') strengthen.push('The valuation discount remains in place while fundamentals improve.')
  }

  if (roce && !roce.pass) {
    strengthen.push('Operating returns improve, particularly ROCE.')
    weaken.push('Operating profitability/ROCE remains weak.')
  } else if (opMargin && !opMargin.pass) {
    strengthen.push('Operating margins improve.')
    weaken.push('Operating margins remain weak.')
  }

  return { strengthen, weaken }
}

// ─────────────────────────────────────────────────────────────────────────
// DECISION — computed last, from the three verdicts plus their conflict
// ─────────────────────────────────────────────────────────────────────────

function buildDecision(intent, valuation, quality, technical, conflict) {
  const valGood = valuation.base === 'positive'
  const valBad = valuation.base === 'negative'
  const qualGood = quality.verdict === 'Strong operating quality' || quality.verdict === 'Reasonable operating quality'
  const qualBad = quality.verdict === 'Weak operating quality'
  const techConfirms = technical.verdict === 'Confirmed'
  const techFights = technical.verdict === 'Contradicting'

  if (intent === 'exit') {
    let action, reason
    if (valBad && qualBad) { action = 'Sell'; reason = 'The valuation case has deteriorated and the underlying business isn\'t supporting it either — both the reason to own this and the price you\'d be holding it at have moved against you.' }
    else if (valGood && qualGood && !techFights) { action = 'Hold'; reason = 'Neither the valuation nor the business case has broken — the evidence doesn\'t currently support giving this up.' }
    else if (techFights && !valBad) { action = 'Wait'; reason = 'Price action is currently working against the position, but neither the valuation nor the business case has actually deteriorated — worth distinguishing a real thesis break from a temporary de-rating before acting.' }
    else { action = 'Hold'; reason = 'The evidence is mixed rather than clearly broken — not the same as a confirmed reason to exit.' }
    return { action, reason, ...buildWatchlist(valuation, quality, technical) }
  }

  // average-up / average-down: the question is whether to ADD, so the
  // floor is higher than merely "not broken" — Buy needs actual, not just
  // absent-of-bad, support.
  let action, reason
  if (valGood && qualGood && techConfirms) {
    action = 'Buy'
    reason = 'Valuation, business quality, and price action are all pointing the same way — as close to a clean case as this framework produces.'
  } else if (valGood && qualGood && !techFights) {
    action = 'Wait'
    reason = 'The valuation case is positive and the business quality evidence supports it, but price action isn\'t yet confirming — worth watching for that confirmation rather than adding into an unconfirmed setup.'
  } else if (valGood && !qualGood) {
    action = 'Hold'
    reason = 'The valuation case is positive, but it is offset by weak or conflicted operating-quality evidence. The evidence doesn\'t currently establish a sufficiently strong case for adding at this price.'
  } else if (valBad || qualBad) {
    action = 'Hold'
    reason = `${valBad ? 'The price already appears to assume a favorable outcome' : 'The underlying business evidence is weak'} — this isn't a case for adding exposure right now.`
  } else {
    action = 'Hold'
    reason = 'The evidence doesn\'t clear the bar for adding — the existing position\'s own thesis isn\'t necessarily wrong, there just isn\'t a strong enough case here to increase exposure.'
  }
  return { action, reason, ...buildWatchlist(valuation, quality, technical) }
}

/**
 * @param intent one of INTENTS' ids
 * @param ctx.estimate          buildEstimate()'s return (App Target) — the
 *                              model range used for the valuation section
 * @param ctx.price             current price
 * @param ctx.marketExpectation runMarketExpectation()'s return
 * @param ctx.peers             { peBand, roeBand, ownPe, ownRoe, count } —
 *                              built by PositionsPanel.jsx from a fresh,
 *                              on-demand peersClient.js fetch; omitted
 *                              (not faked) while that fetch is in flight
 * @param ctx.quality           scoreQuality()'s return
 * @param ctx.moatQuality       assessMoatQuality()'s return
 * @param ctx.technicals        the raw technicals object
 * @param ctx.triggers          evaluateTriggers()'s return, with
 *                              .suggestions (suggestLevels()'s return) —
 *                              only .suggestions is used here (support/
 *                              resistance levels for the technical section)
 */
export function adviseOnIntent(intent, ctx = {}) {
  const valuation = buildValuation(ctx)
  const quality = buildQuality(ctx)
  const technical = buildTechnical(intent, { technicals: ctx.technicals, suggestions: ctx.triggers?.suggestions })
  const conflict = buildConflict(intent, valuation, quality, technical)
  const decision = buildDecision(intent, valuation, quality, technical, conflict)
  return { intent, valuation, quality, technical, conflict, decision }
}
