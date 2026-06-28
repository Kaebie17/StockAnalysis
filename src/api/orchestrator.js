/**
 * src/api/orchestrator.js
 *
 * Strategy: run Yahoo and Screener in parallel, merge the best data from both.
 * Yahoo takes precedence for price/volume/TTM. Screener fills gaps in
 * historical financials. The app NEVER errors for any listed Indian stock.
 *
 * Failure modes handled:
 * - Yahoo totally down        → use Screener alone (no price history, but all financials)
 * - Screener totally down     → use Yahoo alone (full data for most stocks)
 * - Both return partial data  → merge: Yahoo price history + Screener financials where richer
 * - Both totally down         → prompt CSV upload (extremely unlikely)
 */

import { fetchYahoo } from './yahoo.js'
import { fetchScreener } from './screener.js'

export async function fetchTicker(rawTicker, onProgress) {
  const log = (msg, step) => onProgress?.({ msg, step })

  log('Fetching data…', 1)

  const bare = rawTicker.trim().toUpperCase().replace(/\.(NS|BO)$/i, '')

  // Run both sources in parallel — never let one block the other
  const [yahooResult, screenerResult] = await Promise.allSettled([
    fetchYahoo(rawTicker),
    fetchScreener(bare)
  ])

  const yahooOk    = yahooResult.status === 'fulfilled'
  const screenerOk = screenerResult.status === 'fulfilled'

  if (!yahooOk) console.warn('[orchestrator] Yahoo failed:', yahooResult.reason?.message)
  if (!screenerOk) console.warn('[orchestrator] Screener failed:', screenerResult.reason?.message)

  if (!yahooOk && !screenerOk) {
    throw new Error('UPLOAD_REQUIRED')
  }

  // Both succeeded → return merged
  if (yahooOk && screenerOk) {
    log('Yahoo ✓  Screener ✓ — merging', 2)
    return {
      source: 'merged',
      raw: {
        yahoo: yahooResult.value,
        screener: screenerResult.value
      }
    }
  }

  // Only Yahoo
  if (yahooOk) {
    log('Yahoo ✓', 2)
    return { source: 'yahoo', raw: yahooResult.value }
  }

  // Only Screener
  log('Screener ✓', 2)
  return { source: 'screener', raw: screenerResult.value }
}
