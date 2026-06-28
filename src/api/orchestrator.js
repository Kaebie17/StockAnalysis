/**
 * src/api/orchestrator.js
 * Tries Yahoo Finance first. Falls back to Screener.in for Indian tickers.
 * Returns a standardized raw data object consumed by normalize.js.
 */

import { fetchYahoo } from './yahoo.js'
import { fetchScreener } from './screener.js'

export async function fetchTicker(rawTicker, onProgress) {
  const log = (msg, step) => onProgress?.({ msg, step })

  // --- Layer 1: Yahoo Finance ---
  log('Connecting to Yahoo Finance…', 1)
  try {
    const raw = await fetchYahoo(rawTicker)
    log('Yahoo Finance ✓', 1)
    return { source: 'yahoo', raw }
  } catch (yahooErr) {
    console.warn('[orchestrator] Yahoo failed:', yahooErr.message)
    log(`Yahoo failed: ${yahooErr.message}`, 1)
  }

  // --- Layer 2: Screener.in (Indian stocks) ---
  log('Trying Screener.in…', 2)
  try {
    const ticker = rawTicker.trim().toUpperCase().replace(/\.(NS|BO)$/i, '')
    const data = await fetchScreener(ticker)
    log('Screener.in ✓', 2)
    return { source: 'screener', raw: data }
  } catch (screenerErr) {
    console.warn('[orchestrator] Screener failed:', screenerErr.message)
    log(`Screener failed: ${screenerErr.message}`, 2)
  }

  // --- Layer 3: Upload required ---
  throw new Error('UPLOAD_REQUIRED')
}
