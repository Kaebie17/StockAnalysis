
/**
 * src/api/orchestrator.js
 *
 * Fetches Yahoo (primary) + Screener (historical extension) in parallel.
 *
 * Screener validation:
 *   - Yahoo and Screener data compared on 12 base metrics for overlapping years
 *   - All 12 must match (to Crore precision) across all overlapping years
 *   - Only if validation passes: Screener's pre-Yahoo years (2016-2021) are used
 *   - If validation fails: Yahoo 4-year data only, clear message shown
 *   - If Screener blocked (Cloudflare): Yahoo only, no error shown to user
 */

import { fetchYahoo }   from './yahoo.js'
import { fetchScreener } from './screener.js'
import { fetchSec, isUsTicker } from './secClient.js'

export async function fetchTicker(rawTicker, onProgress) {
  const log  = (msg, step) => onProgress?.({ msg, step })
  const bare = rawTicker.trim().toUpperCase().replace(/\.(NS|BO)$/i, '')

  log('Fetching financial data…', 1)

  // ── US tickers: Yahoo (price/meta) + SEC EDGAR (deep annual history) ────────
  // SEC fills Screener's slot for US stocks — automatic, no paste. Any SEC
  // failure falls through to the Yahoo-only result, i.e. previous behaviour.
  if (isUsTicker(rawTicker)) {
    const [yRes, secRes] = await Promise.allSettled([fetchYahoo(rawTicker), fetchSec(rawTicker)])
    if (yRes.status !== 'fulfilled') throw new Error('UPLOAD_REQUIRED')
    const yahooData = yRes.value
    if (secRes.status !== 'fulfilled' || !secRes.value) {
      console.info('[orchestrator] SEC unavailable:', secRes.reason?.message || 'no data')
      return { source: 'yahoo', raw: yahooData }
    }
    log('Merging SEC filing history…', 2)
    return { source: 'sec-merged', raw: { yahoo: yahooData, sec: secRes.value } }
  }

  // Yahoo and Screener in parallel
  const [yahooResult, screenerResult] = await Promise.allSettled([
    fetchYahoo(rawTicker),
    fetchScreener(bare)
  ])

  const yahooOk    = yahooResult.status    === 'fulfilled'
  const screenerOk = screenerResult.status === 'fulfilled'

  if (!yahooOk) {
    console.warn('[orchestrator] Yahoo failed:', yahooResult.reason?.message)
  }
  if (!screenerOk) {
    // Screener failure is expected (Cloudflare) — not logged as error
    console.info('[orchestrator] Screener unavailable:', screenerResult.reason?.message)
  }

  // Yahoo is required — cannot function without it
  if (!yahooOk) throw new Error('UPLOAD_REQUIRED')

  const yahooData    = yahooResult.value
  const screenerData = screenerOk ? screenerResult.value : null

  // If Screener unavailable — Yahoo only
  if (!screenerData) {
    log('Data loaded (Yahoo only)', 2)
    return { source: 'yahoo', raw: yahooData }
  }

  // Screener available — merge. No numeric validation: Screener is a read of the
  // filings, Yahoo is a vendor feed, and Screener now REPLACES Yahoo year for
  // year. Checking the stronger source against the weaker one had it backwards,
  // and it also failed on Yahoo's own holes. The only check on a paste is
  // structural (right table, annual not quarterly) and it lives in the parser.
  log('Merging Screener history…', 2)
  return {
    source: 'merged',
    raw:    { yahoo: yahooData, screener: screenerData },
  }

}