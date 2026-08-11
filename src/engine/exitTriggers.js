/**
 * src/engine/exitTriggers.js — conditions worth reviewing a holding over.
 *
 * Two design decisions worth stating, because both cut against the obvious:
 *
 * ABSOLUTE FIRST, DRIFT SECOND. A trigger phrased "since you bought" is dead on
 * a position entered in bulk: the snapshot was taken the day it was added, so
 * drift reads zero for weeks. Every trigger here is therefore expressible
 * against data that already exists — years of financials, a real purchase price
 * — and drift appears only as an extra line where a genuine baseline exists.
 * The purchase PRICE is real even for backfilled lots (the user typed it), so
 * anything comparing to cost works from the first minute; only comparisons to
 * the estimate-as-it-stood-then have to wait.
 *
 * NOTHING FIRES AN ACTION. A trigger changes a status and surfaces a row. It
 * does not sell, does not touch the estimate, and does not tell you what to do.
 * The point is to catch the case where a thesis quietly stopped being true while
 * you weren't looking — not to automate a decision the app can't be accountable
 * for.
 */

const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

/** Bands the user can tune later; these are starting points, not truths. */
export const TRIGGER_DEFAULTS = {
  concentrationPct: 25,      // one holding as % of tracked portfolio cost
  marginDropPts: 3,          // net margin below its own 3-yr average
  impliedVsGuidancePts: 10,  // market pricing this much more growth than guided
  estimateDropPct: 15,       // estimate falls this much after a revision
  atrMultiple: 2.5,          // price stop distance, in ATR(14)
}

/**
 * Average True Range — the size of this stock's normal daily move.
 *
 * A stop placed inside normal noise is hit by noise rather than by anything
 * meaningful, which is the single most common way a price stop fails. ATR is
 * what makes "is this level actually outside the ordinary range?" answerable
 * instead of a feeling.
 */
export function atr(priceHistory = [], period = 14) {
  const rows = (priceHistory || []).filter(p => p && p.high != null && p.low != null && p.close != null)
  if (rows.length < period + 1) return null
  const trs = []
  for (let i = rows.length - period; i < rows.length; i++) {
    const c = rows[i], p = rows[i - 1]
    if (!c || !p) continue
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  if (trs.length === 0) return null
  return trs.reduce((s, v) => s + v, 0) / trs.length
}

/**
 * Is a proposed stop price inside normal movement? Advisory only — the app
 * checks the level the user chose rather than choosing one for them, because
 * where to place a stop depends on horizon and risk appetite the app can't see.
 */
export function assessStopPrice(stopPrice, currentPrice, priceHistory, mult = TRIGGER_DEFAULTS.atrMultiple) {
  const a = atr(priceHistory)
  if (!(a > 0) || !(currentPrice > 0) || !(stopPrice > 0)) return null
  const distance = currentPrice - stopPrice
  const inAtr = distance / a
  const suggested = round(currentPrice - a * mult, 2)
  return {
    atr: round(a, 2),
    atrPctOfPrice: round((a / currentPrice) * 100, 2),
    distanceInAtr: round(inAtr, 1),
    tooTight: inAtr < 1.5,
    suggested,
    note: inAtr < 1.5
      ? `${round(inAtr, 1)}× ATR away — inside this stock's normal movement, so ordinary volatility would trigger it. Outside that range starts around ${suggested}.`
      : `${round(inAtr, 1)}× ATR away — outside normal daily movement.`,
  }
}

/**
 * Levels the app can defensibly propose, each from a different basis — which is
 * the point of offering more than one. The estimate range is what the business
 * is worth; support and resistance are where buyers and sellers have actually
 * turned up. Those disagree often, and the disagreement is informative.
 *
 * Nothing here is picked FOR the user. Each option carries the reasoning that
 * produced it, because a level you can't justify is one you'll abandon the first
 * time it's tested.
 */
export function suggestLevels({ price, estimate, technicals, priceHistory, buyPrice } = {}) {
  const stops = []
  const targets = []

  // ── Stops ────────────────────────────────────────────────────────────────
  // Volatility floor: far enough out that ordinary daily movement won't reach
  // it. The most common way a stop fails is being placed inside the noise.
  const a = atr(priceHistory)
  if (a > 0 && price > 0) {
    const p = round(price - a * TRIGGER_DEFAULTS.atrMultiple, 2)
    if (p > 0) stops.push({
      id: 'atr', price: p, label: 'Outside normal movement',
      why: `${TRIGGER_DEFAULTS.atrMultiple}× the ${round(a, 1)} average daily range — below the noise this stock makes on an ordinary day.`,
    })
  }

  // Chart floor: where buyers have previously stepped in. Independent of any
  // view on value, which is exactly why it's worth having alongside one.
  const sup = technicals?.levels?.strongestSupport || technicals?.levels?.nearestSupport
  if (sup?.price > 0 && price > 0 && sup.price < price) {
    stops.push({
      id: 'support', price: round(sup.price, 2), label: 'Below support',
      why: `Buyers have turned up around ${round(sup.price, 0)} before${sup.touches ? ` (${sup.touches} times)` : ''}. Losing it says that floor has gone.`,
    })
  }

  // Thesis floor: the point where your own numbers stop supporting what you
  // paid. Not a price level at all — a valuation one.
  if (estimate?.ok && buyPrice > 0 && estimate.target.low > 0) {
    stops.push({
      id: 'thesis', price: round(estimate.target.low, 2), label: 'Thesis floor',
      why: `The pessimistic end of your estimate. Below this the numbers no longer support ${round(buyPrice, 0)}, whatever the chart says.`,
    })
  }

  // ── Targets ──────────────────────────────────────────────────────────────
  if (estimate?.ok && estimate.target.high > 0) {
    targets.push({
      id: 'estimate-high', price: round(estimate.target.high, 2), label: 'Top of your estimate',
      why: 'The optimistic end of what your own numbers support. Above it you are relying on a re-rating rather than on earnings.',
    })
  }
  const res = technicals?.levels?.strongestResistance || technicals?.levels?.nearestResistance
  if (res?.price > 0 && price > 0 && res.price > price) {
    targets.push({
      id: 'resistance', price: round(res.price, 2), label: 'At resistance',
      why: `Sellers have appeared around ${round(res.price, 0)} before${res.touches ? ` (${res.touches} times)` : ''} — a natural place to take something off.`,
    })
  }

  // Sorted so the nearest is first: the one most likely to matter soonest.
  stops.sort((x, y) => y.price - x.price)
  targets.sort((x, y) => x.price - y.price)
  return { stops, targets }
}

/**
 * Evaluate every condition for one lot.
 *
 * @param pos       position record
 * @param ctx       { price, estimate, ratioResult, marketExpectation, guidanceAssessment,
 *                    priceHistory, portfolioCost, plan }
 * @returns { fired: [...], watching: [...], stop }
 */
export function evaluateTriggers(pos, ctx = {}) {
  const cfg = { ...TRIGGER_DEFAULTS, ...(ctx.plan?.thresholds || {}) }
  const price = ctx.price
  const est = ctx.estimate
  const out = []

  const add = (t) => out.push(t)

  // ── Profit side ───────────────────────────────────────────────────────────
  if (est?.ok && price > 0) {
    const { low, base, high } = est.target
    const upperThird = base + (high - base) * 0.34
    if (price >= high) {
      add(trig('above-range', 'profit', 'fired',
        `Price is above your estimate's high (${fmt(high)})`,
        'Your own number says this is worth less than it trades at. That is not a sell signal by itself — it is the point at which the reason you bought no longer applies.'))
    } else if (price >= upperThird) {
      add(trig('upper-third', 'profit', 'fired',
        `Price is in the top third of your estimate range`,
        `${fmt(price)} against a range of ${fmt(low)}–${fmt(high)}.`))
    } else {
      add(trig('upper-third', 'profit', 'watching',
        `Top of range at ${fmt(upperThird)}`,
        `${round(((upperThird - price) / price) * 100)}% above today's price.`))
    }
  }

  // Market pricing more growth than management will commit to.
  const implied = ctx.marketExpectation?.impliedGrowth
    ?? ctx.estimate?.impliedGrowth ?? null
  const guided = ctx.guidanceAssessment?.basis === 'guidance'
    ? guidedGrowthPct(ctx) : null
  if (implied != null && guided != null) {
    const gap = implied - guided
    add(gap >= cfg.impliedVsGuidancePts
      ? trig('implied-vs-guidance', 'profit', 'fired',
          `Market is pricing ${round(gap)} pts more growth than guidance`,
          `Priced for ${round(implied)}% against guidance of ${round(guided)}%. Expectations, not earnings, are carrying the price.`)
      : trig('implied-vs-guidance', 'profit', 'watching',
          `Market pricing ${round(implied)}% vs guidance ${round(guided)}%`, ''))
  }

  // Concentration — arithmetic on the user's own lots, available immediately.
  //
  // Both sides must be measured the same way. Comparing this lot's market VALUE
  // against the portfolio's COST reports a position as a larger share of the
  // book than it is (or smaller, on a loser) — it's really measuring
  // appreciation, not concentration. The caller supplies portfolioValue priced
  // the same way this lot is.
  const base = ctx.portfolioValue > 0 ? ctx.portfolioValue : ctx.portfolioCost
  if (base > 0) {
    const cost = (Number(pos.shares) || 0) * (Number(pos.buyPrice) || 0)
    const value = (price > 0 && ctx.portfolioValue > 0) ? (Number(pos.shares) || 0) * price : cost
    const share = (value / base) * 100
    if (share >= cfg.concentrationPct) {
      add(trig('concentration', 'risk', 'fired',
        `${round(share)}% of your tracked portfolio`,
        'Position size, not valuation. Trimming here is about how much of your outcome rides on one company.'))
    }
  }

  // ── Loss side — thesis, not price ─────────────────────────────────────────
  // The honest fundamental stop: you would not buy this today at what you paid.
  if (est?.ok && pos.buyPrice > 0 && est.target.low < pos.buyPrice) {
    add(trig('below-cost-estimate', 'loss', 'fired',
      `Your estimate's low (${fmt(est.target.low)}) is under your cost (${fmt(pos.buyPrice)})`,
      'Even the pessimistic end of your own range no longer reaches what you paid — the case for holding has to come from something other than the numbers you bought on.'))
  }

  // Margin erosion against the company's own history.
  const marginNow = ctx.ratioResult?.ratios?.netMargin?.value
  const marginAvg = ctx.estimate?.marginPct
  if (marginNow != null && marginAvg != null) {
    const drop = marginAvg - marginNow
    if (drop >= cfg.marginDropPts) {
      add(trig('margin-erosion', 'loss', 'fired',
        `Net margin ${round(marginNow)}% vs ${round(marginAvg)}% 3-yr average`,
        'Down ' + round(drop) + ' pts. Margin usually moves before the story does.'))
    }
  }

  // Guidance missed repeatedly — reported fact, no interpretation.
  const ga = ctx.guidanceAssessment
  if (ga?.verdict === 'miss' && ga.reported >= 2) {
    add(trig('guidance-miss', 'loss', 'fired',
      `Running behind ${ga.basis === 'guidance' ? 'guidance' : 'your assumption'}`,
      ga.note || ''))
  }

  // A revision that cut the estimate hard — the news actually landed.
  if (ctx.estimateDropPct != null && ctx.estimateDropPct >= cfg.estimateDropPct) {
    add(trig('estimate-cut', 'loss', 'fired',
      `Estimate cut ${round(ctx.estimateDropPct)}% by a recent revision`,
      'Something you accepted moved the number materially.'))
  }

  // ── Drift, only where a real baseline exists ──────────────────────────────
  // Backfilled snapshots were taken when the lot was ADDED, so drift from them
  // is meaningless until time passes. Saying so beats showing a confident zero.
  const snap = pos.snapshot
  if (snap?.estimate?.base && price > 0 && !snap.backfilled) {
    const gapThen = (snap.estimate.base - snap.price) / snap.price
    const gapNow = est?.ok ? (est.target.base - price) / price : null
    if (gapNow != null) {
      const drift = (gapNow - gapThen) * 100
      if (Math.abs(drift) >= 10) {
        add(trig('gap-drift', drift < 0 ? 'profit' : 'loss', 'context',
          `Headroom ${drift < 0 ? 'narrower' : 'wider'} by ${Math.abs(round(drift))} pts since purchase`, ''))
      }
    }
  }

  // ── Price stop ────────────────────────────────────────────────────────────
  let stop = null
  if (ctx.plan?.stopPrice > 0 && price > 0) {
    const hit = price <= ctx.plan.stopPrice
    stop = {
      price: ctx.plan.stopPrice, hit,
      assessment: assessStopPrice(ctx.plan.stopPrice, price, ctx.priceHistory, cfg.atrMultiple),
    }
    if (hit) {
      add(trig('stop-hit', 'loss', 'fired',
        `Price ${fmt(price)} is at or below your stop (${fmt(ctx.plan.stopPrice)})`, ''))
    }
  }
  if (ctx.plan?.targetPrice > 0 && price >= ctx.plan.targetPrice) {
    add(trig('target-hit', 'profit', 'fired',
      `Price ${fmt(price)} reached your target (${fmt(ctx.plan.targetPrice)})`, ''))
  }

  return {
    fired: out.filter(t => t.state === 'fired'),
    watching: out.filter(t => t.state === 'watching'),
    context: out.filter(t => t.state === 'context'),
    stop,
    // True when nothing can be evaluated yet — a stock with no analysis at all.
    empty: out.length === 0 && !stop,
    baselineFrom: snap?.backfilled ? snap.takenAt : null,
  }
}

function trig(id, side, state, title, detail) {
  return { id, side, state, title, detail }
}

function guidedGrowthPct(ctx) {
  const g = ctx.guidance?.revenueGuidance
  if (g && g.status !== 'resolved' && g.unit === 'growthPct' && g.value != null) return g.value
  if (ctx.estimate?.growthSource === 'guidance') return ctx.estimate.growthPct
  return null
}

const fmt = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'))
