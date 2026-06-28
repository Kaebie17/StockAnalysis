/**
 * src/api/orchestrator.js
 *
 * Yahoo Finance covers ALL markets including Indian stocks (.NS/.BO).
 * Screener.in fallback is only triggered if:
 *   a) Yahoo completely fails (network error / 5xx), OR
 *   b) Yahoo returns data but income history is totally empty (rare edge case
 *      for very small/unlisted stocks not in Yahoo's fundamentals database)
 *
 * It does NOT fall through just because timeseries is sparse —
 * that was the bug. We now use incomeStatementHistory which is populated
 * for all exchange-listed stocks Yahoo covers.
 */

import { fetchYahoo } from './yahoo.js'
import { fetchScreener } from './screener.js'

export async function fetchTicker(rawTicker, onProgress) {
  const log = (msg, step) => onProgress?.({ msg, step })

  log('Fetching from Yahoo Finance…', 1)

  try {
    const raw = await fetchYahoo(rawTicker)

    // Check we got meaningful data — price + at least chart OR financials
    const result = raw.quote?.quoteSummary?.result?.[0]
    const hasPrice = result?.price?.regularMarketPrice?.raw != null ||
                     result?.price?.regularMarketPrice != null
    const hasChart = (raw.chart?.chart?.result?.[0]?.timestamp?.length || 0) > 0
    const hasFinancials = (result?.incomeStatementHistory?.incomeStatementHistory?.length || 0) > 0

    if (!hasPrice && !hasChart && !hasFinancials) {
      throw new Error(`Yahoo returned empty data for "${raw.ticker}"`)
    }

    log('Yahoo Finance ✓', 1)
    return { source: 'yahoo', raw }

  } catch (yahooErr) {
    console.warn('[orchestrator] Yahoo failed:', yahooErr.message)
    log(`Yahoo unavailable — trying Screener.in…`, 2)
  }

  // Screener fallback — Indian stocks only, strips exchange suffix
  try {
    const bare = rawTicker.trim().toUpperCase().replace(/\.(NS|BO)$/i, '')
    const data = await fetchScreener(bare)
    log('Screener.in ✓', 2)
    return { source: 'screener', raw: data }
  } catch (screenerErr) {
    console.warn('[orchestrator] Screener failed:', screenerErr.message)
    log(`Screener unavailable`, 2)
  }

  throw new Error('UPLOAD_REQUIRED')
}
