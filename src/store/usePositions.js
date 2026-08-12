import { useCallback, useEffect, useState } from 'react'
import {
  savePosition, listPositions, getPosition, closePosition, deletePosition,
  saveEstimate, currentEstimate,
} from '../utils/db.js'
import { queuePush } from '../sync/sync.js'
import { buildEstimate } from '../engine/estimate.js'
import { rebuildSnapshot } from '../engine/snapshotRebuild.js'
import { fetchRegimeOn, fetchMarketRegime } from '../api/marketRegime.js'
import { analyzeTicker } from './analyzeTicker.js'

/**
 * usePositions — the read/write layer for stocks the user actually owns.
 *
 * One lot per record, never one per ticker: buying the same stock three times
 * gives three records, each with its own price, date and snapshot. Averaging
 * them into a single holding would destroy the very thing the "since you bought"
 * comparison needs — what was true at each purchase.
 */
export function usePositions(ticker) {
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try { setPositions(await listPositions(ticker ? { ticker } : {})) }
    catch { setPositions([]) }
    finally { setLoading(false) }
  }, [ticker])

  useEffect(() => { refresh() }, [refresh])

  return { positions, loading, refresh }
}

/**
 * Freeze what the app believed at the moment of purchase.
 *
 * This is the whole reason a position is more than a price and a date. None of
 * it can be reconstructed later: the financials move on, and re-deriving "what
 * we thought in February" from August's data would be a fiction dressed as a
 * record. Captured live or not at all.
 *
 * `isLate` marks a position added well after the buy date — the snapshot then
 * describes today, not the purchase, and every comparison built on it has to say
 * so rather than quietly implying it observed something it didn't.
 */
export function buildSnapshot({ state, buyDate, regime }) {
  const { ratioResult, data, valuation, quality, marketExpectation, assumptions } = state || {}
  const now = Date.now()
  const LATE_MS = 7 * 86400000

  const est = ratioResult ? buildEstimate(ratioResult, {
    guidedGrowth: (assumptions?.nearTermGrowth != null && isFinite(assumptions.nearTermGrowth))
      ? assumptions.nearTermGrowth : null,
    priceHistory:   data?.priceHistory   || [],
    incomeHistory:  data?.incomeHistory  || [],
    balanceHistory: data?.balanceHistory || [],
  }) : null

  return {
    takenAt: now,
    isLate: buyDate != null && (now - buyDate) > LATE_MS,
    price: ratioResult?.price ?? null,
    estimate: est?.ok ? {
      low: est.target.low, base: est.target.base, high: est.target.high,
      growthPct: est.growthPct, marginPct: est.marginPct,
      multipleBase: est.multiples?.base ?? null,
      basisSummary: est.basisSummary,
    } : null,
    qualityScore: quality?.score ?? null,
    fairValue: valuation?.fairValue ?? valuation?.fairValueRange ?? null,
    marketImpliedGrowth: valuation?.impliedGrowth
      ?? marketExpectation?.variants?.sales?.impliedGrowth
      ?? marketExpectation?.variants?.earnings?.impliedGrowth ?? null,
    sectorType: state?.sectorType ?? null,
    currency: data?.currency ?? null,
    // Market conditions entered in. Without these a holding's return can't be
    // separated from the market's — up 18% in a market that rose 11% is a very
    // different result from the same 18% in a flat one.
    vix: regime?.vix ?? null,
    indexLevel: regime?.indexChangePct != null ? (regime.indexLevel ?? null) : (regime?.indexLevel ?? null),
    missing: regime?.missing?.length ? regime.missing : undefined,
  }
}

/** Record a purchase, freezing the snapshot at the same moment. */
export async function recordBuy({ ticker, name, shares, buyPrice, buyDate, note, state }) {
  // Regime at the moment of purchase — today's reading for a same-day entry, the
  // historical one for a back-dated lot. Never blocks the save: a position that
  // fails to record because a volatility index was unreachable would be absurd.
  let regime = null
  try {
    const indian = /\.(NS|BO)$/i.test(ticker || '')
    const isBackdated = buyDate && (Date.now() - buyDate) > 2 * 86400000
    regime = isBackdated ? await fetchRegimeOn(buyDate, { indian })
                         : await fetchMarketRegime({ indian })
  } catch { /* recorded as unavailable */ }

  const rec = await savePosition({
    ticker, name: name || null,
    shares: Number(shares) || 0,
    buyPrice: Number(buyPrice) || 0,
    buyDate: buyDate || Date.now(),
    note: note || null,
    snapshot: buildSnapshot({ state, buyDate, regime }),
  })
  if (rec) queuePush(`positions:${rec.id}`, rec)

  // Persist the estimate too, if this ticker doesn't already have a live one.
  // A purchase is exactly the moment a dated claim becomes worth keeping, and
  // without one there's nothing for a later "was this right?" to compare against.
  try {
    if (state?.ratioResult && !(await currentEstimate(ticker))) {
      const est = buildEstimate(state.ratioResult, {
        guidedGrowth: (state.assumptions?.nearTermGrowth != null && isFinite(state.assumptions.nearTermGrowth))
          ? state.assumptions.nearTermGrowth : null,
        priceHistory:   state.data?.priceHistory   || [],
        incomeHistory:  state.data?.incomeHistory  || [],
        balanceHistory: state.data?.balanceHistory || [],
      })
      if (est.ok) await saveEstimate(ticker, est, { trigger: 'purchase' })
    }
  } catch { /* the position is the important part — never block it on this */ }

  return rec
}

/**
 * Record a sale, allocated FIFO across the lots held for a ticker.
 *
 * FIFO is the convention (and what Indian capital-gains treatment assumes), so
 * there is nothing for the user to choose — the oldest shares are the ones sold.
 * What DOES need handling is a sale that doesn't line up with lot boundaries:
 * selling 50 when the oldest lot holds 40 closes that lot and takes 10 from the
 * next one.
 *
 * A partially sold lot is SPLIT rather than edited down: the sold portion
 * becomes its own closed record with the original buy price and date, and the
 * remainder stays open. That keeps the realised gain on those 10 shares in the
 * history instead of quietly rewriting the lot as though they were never bought.
 */
export async function recordSell(ticker, { sellPrice, sellDate, shares, exitReason, exitNote } = {}) {
  const t = String(ticker || '').toUpperCase()
  const open = (await listPositions({ ticker: t, status: 'open' }))
    .sort((a, b) => (a.buyDate || 0) - (b.buyDate || 0))    // oldest first
  if (open.length === 0) return { closed: [], remaining: 0 }

  const held = open.reduce((s, p) => s + (Number(p.shares) || 0), 0)
  let toSell = shares != null && +shares > 0 ? Math.min(+shares, held) : held
  const when  = sellDate || Date.now()
  const price = sellPrice != null ? Number(sellPrice) : null
  const closed = []

  for (const lot of open) {
    if (toSell <= 0) break
    const lotShares = Number(lot.shares) || 0
    if (lotShares <= 0) continue

    if (toSell >= lotShares) {
      // Whole lot goes.
      let rec = await closePosition(lot.id, { sellPrice: price, sellDate: when, sharesSold: lotShares })
      if (rec && (exitReason || exitNote)) rec = await savePosition({ ...rec, exitReason, exitNote })
      if (rec) { queuePush(`positions:${rec.id}`, rec); closed.push(rec) }
      toSell -= lotShares
    } else {
      // Split: a closed record for the sold part, the rest stays open.
      const sold = await savePosition({
        ...lot,
        id: undefined,                       // new record
        shares: toSell,
        status: 'closed',
        sellPrice: price, sellDate: when, sharesSold: toSell,
        exitReason: exitReason || null, exitNote: exitNote || null,
        splitFrom: lot.id,
        createdAt: undefined,
      })
      const remainder = await savePosition({ ...lot, shares: lotShares - toSell })
      if (sold)      { queuePush(`positions:${sold.id}`, sold); closed.push(sold) }
      if (remainder) queuePush(`positions:${remainder.id}`, remainder)
      toSell = 0
    }
  }

  return { closed, remaining: held - (shares != null ? Math.min(+shares, held) : held) }
}

/**
 * What a FIFO sale of `shares` would actually consume, without writing anything.
 * Lets the sell form show the breakdown before the user commits, which matters
 * when a sale spans lots bought at different prices — the realised gain isn't
 * obvious from the average.
 */
export function previewFifo(lots, shares) {
  const open = (lots || [])
    .filter(p => p.status !== 'closed')
    .sort((a, b) => (a.buyDate || 0) - (b.buyDate || 0))
  const held = open.reduce((s, p) => s + (Number(p.shares) || 0), 0)
  let left = shares != null && +shares > 0 ? Math.min(+shares, held) : held
  const take = []
  for (const lot of open) {
    if (left <= 0) break
    const n = Math.min(left, Number(lot.shares) || 0)
    if (n > 0) take.push({ lot, shares: n, whole: n === Number(lot.shares) })
    left -= n
  }
  return { take, held, selling: (shares != null && +shares > 0) ? Math.min(+shares, held) : held }
}

export async function removePosition(id) {
  await deletePosition(id)
  queuePush(`positions:${id}`, null)
}

/**
 * Give a position a baseline it never got.
 *
 * A lot added through bulk entry has no snapshot: there was no analysis in
 * memory at the time, so nothing was frozen. Bar 1 compares today's
 * estimate-to-price gap against the gap at purchase, so without one it stays
 * permanently unavailable — the stocks entered on day one would be the only
 * ones that never show it.
 *
 * Backfilling uses today's numbers and is marked `isLate`, because that is what
 * it is: a baseline starting now, not a reconstruction of what was true when the
 * shares were bought. The UI says so rather than implying the app saw something
 * it didn't.
 */
export async function backfillSnapshot(position, analysis) {
  if (!position || position.snapshot?.estimate) return null      // already has one
  if (!analysis?.ratioResult) return null

  const est = buildEstimate(analysis.ratioResult, {
    priceHistory:   analysis.data?.priceHistory   || [],
    incomeHistory:  analysis.data?.incomeHistory  || [],
    balanceHistory: analysis.data?.balanceHistory || [],
  })
  if (!est?.ok) return null

  const rec = await savePosition({
    ...position,
    snapshot: {
      ...(position.snapshot || {}),
      takenAt: Date.now(),
      isLate: true,                 // baseline starts now, not at purchase
      backfilled: true,
      price: analysis.ratioResult.price ?? null,
      currency: analysis.data?.currency ?? position.snapshot?.currency ?? null,
      estimate: {
        low: est.target.low, base: est.target.base, high: est.target.high,
        growthPct: est.growthPct, marginPct: est.marginPct,
        multipleBase: est.multiples?.base ?? null,
        basisSummary: est.basisSummary,
      },
      qualityScore: analysis.quality?.score ?? position.snapshot?.qualityScore ?? null,
      marketImpliedGrowth: analysis.valuation?.impliedGrowth ?? null,
    },
  })
  if (rec) queuePush(`positions:${rec.id}`, rec)
  return rec
}

/**
 * Move a lot's purchase date, and rebuild its baseline to match.
 *
 * Changing the date alone would be close to useless: the recorded estimate would
 * still be whatever was captured when the position was ADDED, so every
 * comparison would stay flat while wearing a convincingly old date — worse than
 * an obvious placeholder, because it looks like a real six-month result.
 *
 * So the snapshot is reconstructed from data as it stood on the new date, and
 * anything unavailable for that date is named rather than filled in.
 */
export async function updatePositionDate(id, newDateMs) {
  const rec = await getPosition(id)
  if (!rec || !isFinite(newDateMs)) return null

  let snapshot = rec.snapshot
  try {
    const analysis = await analyzeTicker(rec.ticker)
    if (analysis) {
      const indian = /\.(NS|BO)$/i.test(rec.ticker || '')
      let regimeOn = null
      try { regimeOn = await fetchRegimeOn(newDateMs, { indian }) } catch { /* named below */ }
      const rebuilt = rebuildSnapshot(analysis, newDateMs, regimeOn)
      if (rebuilt) snapshot = rebuilt
    }
  } catch { /* keep the existing snapshot rather than lose the date change */ }

  const updated = await savePosition({ ...rec, buyDate: newDateMs, snapshot })
  if (updated) queuePush(`positions:${updated.id}`, updated)
  return updated
}

/**
 * The exit plan for a lot: an optional stop, an optional target, and any
 * threshold overrides. Stored on the position rather than in its own table —
 * it's per-lot, changes with the lot, and dies with it.
 */
export async function saveExitPlan(id, plan) {
  const rec = await getPosition(id)
  if (!rec) return null
  const updated = await savePosition({
    ...rec,
    plan: { ...(rec.plan || {}), ...plan, updatedAt: Date.now() },
  })
  if (updated) queuePush(`positions:${updated.id}`, updated)
  return updated
}

/** Cost, value and P/L for a lot at the current price. */
export function positionMath(pos, currentPrice) {
  const shares = Number(pos?.shares) || 0
  const buy    = Number(pos?.buyPrice) || 0
  const cost   = shares * buy
  const isOpen = pos?.status !== 'closed'
  const exit   = isOpen ? currentPrice : (pos?.sellPrice ?? currentPrice)
  if (!(cost > 0) || exit == null) return { cost, value: null, pnl: null, pnlPct: null, isOpen }
  const value = shares * exit
  return { cost, value, pnl: value - cost, pnlPct: ((exit - buy) / buy) * 100, isOpen }
}
