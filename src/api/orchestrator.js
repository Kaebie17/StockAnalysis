// orchestrator.js
// Source priority: Yahoo Finance (no key) → Screener.in (Indian, proxy) → CSV upload
// FMP removed: free tier has no price data and is US-only

import { fetchAllYahoo }     from './yahoo.js'
import { fetchFromScreener } from './screener.js'
import { loadFinancials, saveFinancials } from '../utils/db.js'

const ONE_HOUR = 60 * 60 * 1000

export const SOURCE_STATUS = {
  IDLE:    'idle',
  TRYING:  'trying',
  SUCCESS: 'success',
  FAILED:  'failed',
  SKIPPED: 'skipped',
}

export async function fetchWithFallback(ticker, _apiKey, onProgress) {
  const T = ticker.toUpperCase()

  const progress = {
    yahoo:    SOURCE_STATUS.IDLE,
    screener: SOURCE_STATUS.IDLE,
  }

  function emit(updates) {
    Object.assign(progress, updates)
    onProgress?.({ ...progress })
  }

  // ── Check cache first ─────────────────────────────────
  try {
    const cached = await loadFinancials(T)
    if (cached?.rawResult && (Date.now() - cached.savedAt < ONE_HOUR)) {
      const src = cached.rawResult.source
      emit({ [src === 'Screener.in' ? 'screener' : 'yahoo']: SOURCE_STATUS.SUCCESS })
      return { ...cached.rawResult, fromCache: true }
    }
  } catch { /* ignore cache errors */ }

  // ── Layer 1: Yahoo Finance ────────────────────────────
  emit({ yahoo: SOURCE_STATUS.TRYING })
  try {
    const result = await fetchAllYahoo(T)
    if (!result.raw?.profile?.symbol) throw new Error('Yahoo returned no profile data')
    emit({ yahoo: SOURCE_STATUS.SUCCESS, screener: SOURCE_STATUS.SKIPPED })
    await saveFinancials(T, { rawResult: result }).catch(() => {})
    return result
  } catch (yahooErr) {
    emit({ yahoo: SOURCE_STATUS.FAILED })
    console.warn('[Yahoo failed]', yahooErr.message)
  }

  // ── Layer 2: Screener.in (Indian stocks) ─────────────
  emit({ screener: SOURCE_STATUS.TRYING })
  try {
    const result = await fetchFromScreener(T)
    if (!result.raw?.profile?.symbol) throw new Error('Screener returned no data')
    emit({ screener: SOURCE_STATUS.SUCCESS })
    await saveFinancials(T, { rawResult: result }).catch(() => {})
    return result
  } catch (screenerErr) {
    emit({ screener: SOURCE_STATUS.FAILED })
    console.warn('[Screener failed]', screenerErr.message)
  }

  // ── All failed → signal upload ────────────────────────
  throw new OrchestratorError(
    `Could not fetch data for "${T}" from Yahoo Finance or Screener.in. ` +
    `Upload a CSV financial statement to continue.`,
    { progress: { ...progress } }
  )
}

export class OrchestratorError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name        = 'OrchestratorError'
    this.details     = details
    this.needsUpload = true
  }
}
