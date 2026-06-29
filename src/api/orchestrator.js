/**
 * src/api/orchestrator.js
 * Yahoo (3 parallel calls) + Screener run simultaneously.
 * Merge the best of both. Never error for any listed stock.
 */

import { fetchYahoo } from './yahoo.js'
import { fetchScreener } from './screener.js'

export async function fetchTicker(rawTicker, onProgress) {
  const log = (msg, step) => onProgress?.({ msg, step })
  log('Fetching price, fundamentals & history…', 1)

  const bare = rawTicker.trim().toUpperCase().replace(/\.(NS|BO)$/i, '')

  const [yahooResult, screenerResult] = await Promise.allSettled([
    fetchYahoo(rawTicker),
    fetchScreener(bare)
  ])

  const yahooOk    = yahooResult.status === 'fulfilled'
  const screenerOk = screenerResult.status === 'fulfilled'

  if (!yahooOk) console.warn('[orchestrator] Yahoo:', yahooResult.reason?.message)
  if (!screenerOk) console.warn('[orchestrator] Screener:', screenerResult.reason?.message)

  if (!yahooOk && !screenerOk) throw new Error('UPLOAD_REQUIRED')

  if (yahooOk && screenerOk) {
    log('Data loaded ✓', 2)
    return { source: 'merged', raw: { yahoo: yahooResult.value, screener: screenerResult.value } }
  }
  if (yahooOk)    { log('Data loaded ✓', 2); return { source: 'yahoo',    raw: yahooResult.value } }
                    log('Data loaded ✓', 2); return { source: 'screener', raw: screenerResult.value }
}
