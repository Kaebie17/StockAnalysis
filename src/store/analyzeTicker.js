import { fetchTicker } from '../api/orchestrator.js'
import { normalize } from '../engine/normalize.js'
import { getCached, setCached } from '../utils/db.js'
import { computeAll } from './AppContext.jsx'

/**
 * src/store/analyzeTicker.js — analyse a stock without opening it.
 *
 * The positions pages need an analysis for every holding, including ones the
 * user has never looked up. That's not an edge case: the onboarding flow is
 * "add the stocks you already own", so on day one *nothing* is cached and the
 * health bars would be blank for the entire portfolio — the exact moment they'd
 * be most useful.
 *
 * Requiring a visit per stock also gets the dependency backwards. Position data
 * should keep itself current; the ticker page is for reading the detail, not a
 * precondition for the portfolio knowing anything.
 *
 * Runs the same pipeline as a normal load (fetch → normalize → computeAll) and
 * writes the same cache record, so a later visit finds it already warm and the
 * two paths can't produce different numbers.
 */

// One in flight per ticker: the panel renders repeatedly and several rows can
// ask for the same stock at once.
const inflight = new Map()

// Failures are remembered for a while so a delisted or misspelled ticker isn't
// retried on every render.
const failedAt = new Map()
const RETRY_AFTER_MS = 10 * 60 * 1000

export async function analyzeTicker(ticker, { force = false } = {}) {
  const t = String(ticker || '').trim().toUpperCase()
  if (!t) return null

  if (!force) {
    try {
      const cached = await getCached(t)
      if (cached) return cached
    } catch { /* read failure — fall through and fetch */ }

    const failed = failedAt.get(t)
    if (failed && Date.now() - failed < RETRY_AFTER_MS) return null
  }

  if (inflight.has(t)) return inflight.get(t)

  const job = (async () => {
    try {
      const { source, raw } = await fetchTicker(t)
      const data = normalize(source, raw)
      const payload = { data, ...computeAll(data, {}, {}, {}, null) }
      try { await setCached(t, payload) } catch { /* quota — still usable in memory */ }
      failedAt.delete(t)
      return payload
    } catch (e) {
      // A stock that can't be fetched shouldn't take the whole panel down; the
      // row falls back to cost-only and says so.
      console.info(`[analyzeTicker] ${t} unavailable:`, e?.message)
      failedAt.set(t, Date.now())
      return null
    } finally {
      inflight.delete(t)
    }
  })()

  inflight.set(t, job)
  return job
}

/**
 * Analyse several tickers, newest-need first, without flooding the upstream
 * sources. Yahoo and Screener are both rate-sensitive and a portfolio can be
 * twenty names; firing them together is what gets a shared serverless IP
 * throttled. `onEach` fires as each lands so rows fill in progressively rather
 * than the panel sitting blank until the last one returns.
 */
export async function analyzeMany(tickers = [], { onEach, concurrency = 2 } = {}) {
  const queue = [...new Set(tickers.filter(Boolean))]
  const results = {}
  let idx = 0

  async function worker() {
    while (idx < queue.length) {
      const t = queue[idx++]
      const res = await analyzeTicker(t)
      if (res) { results[t] = res; onEach?.(t, res) }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return results
}
