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
import { validateScreenerHistory } from '../engine/screenerValidation.js'

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

  // Screener available — validate before merging
  log('Validating Screener data against Yahoo…', 2)

  const validation = validateScreenerHistory(
    yahooData,     // already normalized Yahoo data
    screenerData   // raw Screener data (not yet normalized)
  )

  if (!validation.passed) {
    console.warn('[orchestrator] Screener validation failed:', validation.message)
    // Use Yahoo only — attach validation result for UI to show
    return {
      source:     'yahoo',
      raw:        yahooData,
      validation  // UI shows "extended history unavailable" with reason
    }
  }

  // Validation passed — merge Yahoo with Screener's pre-Yahoo historical years
  log(`Data loaded ✓ (+${validation.validHistoricalYears.length} historical years)`, 2)
  return {
    source:     'merged',
    raw:        { yahoo: yahooData, screener: screenerData },
    validation
  }
}

