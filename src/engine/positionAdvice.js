/**
 * src/engine/positionAdvice.js — a leaning on a specific question you're
 * asking about a held position: average up, average down, or exit.
 *
 * Deliberately NOT a new scoring model. exitTriggers.js already computes the
 * facts (profit/loss/risk triggers) and positionHealth.js already interprets
 * the technical and fundamental picture into disclosed bars — this reuses
 * both rather than re-deriving a parallel judgment from raw data. What's new
 * here is purely INTERPRETATION: which of those already-computed facts argue
 * for or against the SPECIFIC action being asked about, since "margin
 * eroded" argues against averaging down but says nothing about whether to
 * average up, and "price near resistance" cuts the opposite way for exiting
 * versus adding.
 *
 * A lean is a synthesis of the evidence shown alongside it, never a bare
 * directive — every point that fed it is named and visible, same disclosure
 * standard as the rest of this app (see exitTriggers.js's own "nothing fires
 * an action" principle, which this respects: it answers a question you
 * asked, it doesn't decide anything or get saved anywhere). Computed fresh
 * from the same live data every time it's asked, nothing cached.
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

function longTermPoints(intent, { triggers, health }) {
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
  // or upper-third (watching) — whenever an estimate exists at all, one of
  // them is present. Reading fired only meant a position sitting quietly in
  // the lower two-thirds of its own range — neither cheap nor rich enough to
  // trip a threshold — surfaced nothing here, even though "comfortably
  // within range, no red flags" is itself a real, usable fact.
  const withinRange = watching.find(t => t.id === 'upper-third')

  if (intent === 'exit') {
    // Either reason to exit counts here: the thesis broke (loss side), or it
    // played out and the market has already paid you for it (profit side).
    for (const t of thesisBreaks) points.push({ for: true, text: t.title, detail: t.detail })
    if (aboveRange) points.push({ for: true, text: aboveRange.title, detail: aboveRange.detail })
    if (upperThird) points.push({ for: true, text: upperThird.title, detail: upperThird.detail })
    if (impliedVsGuidance) points.push({ for: true, text: impliedVsGuidance.title, detail: impliedVsGuidance.detail })
    if (withinRange) points.push({ for: false, text: `Still ${withinRange.detail?.toLowerCase() || 'below the top of your range'}` })
    if (fb?.available && fb.level >= 3) points.push({ for: false, text: fb.label, detail: fb.detail })
    if (eb?.available && eb.direction === 'up') points.push({ for: false, text: eb.label, detail: eb.detail })
  }

  if (intent === 'average-down') {
    // The whole question is whether a lower price is a discount on an
    // intact business or a discount on a business that's gotten worse.
    for (const t of thesisBreaks) points.push({ for: false, text: t.title, detail: t.detail })
    if (fb?.available && fb.level >= 3) points.push({ for: true, text: fb.label, detail: fb.detail })
    if (fb?.available && fb.level <= 1 && thesisBreaks.length === 0) points.push({ for: false, text: fb.label, detail: fb.detail })
    // Headroom widening since purchase (estimateBar's own direction) means
    // the price fell (or the estimate rose) relative to the case you bought
    // on — the "got cheaper without the business changing" read this
    // question is actually asking.
    if (eb?.available && eb.direction === 'up') points.push({ for: true, text: eb.label, detail: eb.detail })
    if (eb?.available && eb.direction === 'down' && thesisBreaks.length === 0) {
      points.push({ for: false, text: `${eb.label} — the discount has narrowed, not widened`, detail: eb.detail })
    }
    if (aboveRange || upperThird) {
      const t = aboveRange || upperThird
      points.push({ for: false, text: 'Already trading in the rich part of your own range — not obviously a discount', detail: t.detail })
    }
  }

  if (intent === 'average-up') {
    // Paying more only makes sense if the thesis is actually strengthening
    // AND there's still room per your own numbers — strong fundamentals
    // alone don't justify it if the price has already caught up.
    for (const t of thesisBreaks) points.push({ for: false, text: t.title, detail: t.detail })
    if (aboveRange) points.push({ for: false, text: aboveRange.title, detail: aboveRange.detail })
    if (impliedVsGuidance) points.push({ for: false, text: impliedVsGuidance.title, detail: impliedVsGuidance.detail })
    if (fb?.available && fb.level >= 3) points.push({ for: true, text: fb.label, detail: fb.detail })
    if (!aboveRange && !upperThird && (withinRange || (fb?.available && fb.level >= 2))) {
      points.push({ for: true, text: 'Thesis on track and price still below the top of your estimate range' })
    }
  }

  return points
}

function shortTermPoints(intent, { health, technicals, suggestions }) {
  const points = []
  const tb = health?.technical
  const rb = health?.rerate
  const sig = technicals?.signals || {}
  const supportStop = (suggestions?.stops || []).find(s => s.id === 'support')
  const resistanceTarget = (suggestions?.targets || []).find(t => t.id === 'resistance')

  if (intent === 'exit') {
    if (tb?.available && tb.level <= 1) points.push({ for: true, text: tb.label, detail: tb.detail })
    if (tb?.available && tb.level >= 3) points.push({ for: false, text: tb.label, detail: tb.detail })
    if (rb?.available && rb.direction === 'down') points.push({ for: true, text: rb.label, detail: rb.detail })
    if (rb?.available && rb.direction === 'up') points.push({ for: false, text: rb.label, detail: rb.detail })
    if (resistanceTarget) {
      points.push({ for: true, text: `Near resistance at ${resistanceTarget.price}`, detail: resistanceTarget.why })
    }
  }

  if (intent === 'average-down') {
    // A support/oversold read makes the CURRENT price a defensible entry
    // even while the broader trend is still down — that's a different
    // question from "is this an uptrend," which is what the plain technical
    // bar answers, so both are checked rather than only the coarser one.
    if (sig.rsiOversold) points.push({ for: true, text: 'RSI oversold' })
    if (sig.rsiOverbought) points.push({ for: false, text: 'RSI overbought — an unusual point to be adding' })
    if (supportStop && !supportStop.tooClose) {
      points.push({ for: true, text: `Sitting near ${supportStop.label.toLowerCase()} (${supportStop.price})`, detail: supportStop.why })
    }
    if (sig.deathCross) points.push({ for: false, text: 'Death cross — the trend is still deteriorating' })
    if (tb?.available && tb.level <= 1 && !supportStop) {
      points.push({ for: false, text: 'No nearby support and the trend is still weak — a real risk of catching a falling knife', detail: tb.detail })
    }
  }

  if (intent === 'average-up') {
    // Averaging up means paying MORE to extend exposure — a call that leans
    // on the stock's own strength being real and continuing, not on it being
    // cheap (that's the long-term/fundamental side's question, not this
    // one). A downtrend doesn't mean the stock is expensive; it means the
    // confirmed strength this specific action relies on isn't there right
    // now, whatever the valuation case looks like separately.
    if (tb?.available && tb.level >= 3) points.push({ for: true, text: tb.label, detail: tb.detail })
    if (tb?.available && tb.level <= 1) {
      points.push({ for: false, text: `${tb.label} — not the confirmed strength averaging up usually relies on`, detail: tb.detail })
    }
    if (rb?.available && rb.direction === 'up') points.push({ for: true, text: rb.label, detail: rb.detail })
    if (rb?.available && rb.direction === 'down') points.push({ for: false, text: rb.label, detail: rb.detail })
    if (sig.rsiOverbought) points.push({ for: false, text: 'RSI overbought — already extended' })
    if (resistanceTarget) {
      points.push({ for: false, text: `Approaching resistance at ${resistanceTarget.price}`, detail: resistanceTarget.why })
    }
  }

  return points
}

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

/**
 * @param intent one of INTENTS' ids
 * @param ctx.triggers   evaluateTriggers()'s return, with .suggestions
 *                       (suggestLevels()'s return) merged in — same object
 *                       PositionsPanel.jsx already builds for the exit-plan UI
 * @param ctx.health     positionHealth()'s return
 * @param ctx.technicals the raw technicals object (for signals not already
 *                       surfaced by a health bar, e.g. RSI oversold/overbought)
 */
export function adviseOnIntent(intent, ctx = {}) {
  const { triggers, health, technicals } = ctx
  const longTermPts = longTermPoints(intent, { triggers, health })
  const shortTermPts = shortTermPoints(intent, { health, technicals, suggestions: triggers?.suggestions })
  return {
    intent,
    longTerm: { lean: leanFrom(longTermPts), points: longTermPts },
    shortTerm: { lean: leanFrom(shortTermPts), points: shortTermPts },
  }
}
