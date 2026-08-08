import { useCallback, useEffect, useState } from 'react'
import {
  savePosition, listPositions, closePosition, deletePosition, saveEstimate, currentEstimate,
} from '../utils/db.js'
import { queuePush } from '../sync/sync.js'
import { buildEstimate } from '../engine/estimate.js'

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
export function buildSnapshot({ state, buyDate }) {
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
    sectorType: data?.sectorType ?? null,
    currency: data?.currency ?? null,
  }
}

/** Record a purchase, freezing the snapshot at the same moment. */
export async function recordBuy({ ticker, name, shares, buyPrice, buyDate, note, state }) {
  const rec = await savePosition({
    ticker, name: name || null,
    shares: Number(shares) || 0,
    buyPrice: Number(buyPrice) || 0,
    buyDate: buyDate || Date.now(),
    note: note || null,
    snapshot: buildSnapshot({ state, buyDate }),
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

/** Record a sale. Closes the lot; the record stays. */
export async function recordSell(id, { sellPrice, sellDate, sharesSold } = {}) {
  const rec = await closePosition(id, {
    sellPrice: sellPrice != null ? Number(sellPrice) : null,
    sellDate: sellDate || Date.now(),
    sharesSold: sharesSold != null ? Number(sharesSold) : undefined,
  })
  if (rec) queuePush(`positions:${rec.id}`, rec)
  return rec
}

export async function removePosition(id) {
  await deletePosition(id)
  queuePush(`positions:${id}`, null)
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
