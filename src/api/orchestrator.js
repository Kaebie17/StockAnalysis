// orchestrator.js
// Source priority: FMP (key required) → Yahoo Finance (no key) → Screener (Indian, via proxy) → Upload

import { fetchAllRawData } from './fmp.js'
import { fetchAllYahoo }   from './yahoo.js'
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

export async function fetchWithFallback(ticker, apiKey, onProgress) {
  const T = ticker.toUpperCase()

  const progress = {
    fmp:      SOURCE_STATUS.IDLE,
    yahoo:    SOURCE_STATUS.IDLE,
    screener: SOURCE_STATUS.IDLE,
  }

  function emit(updates) {
    Object.assign(progress, updates)
    onProgress?.({ ...progress })
  }

  // ── Check cache first ──────────────────────────────────
  const cached = await loadFinancials(T)
  if (cached?.rawResult && (Date.now() - cached.savedAt < ONE_HOUR)) {
    const src = cached.rawResult.source
    const key = src === 'Yahoo Finance' ? 'yahoo'
              : src === 'Screener.in'   ? 'screener'
              : 'fmp'
    emit({ [key]: SOURCE_STATUS.SUCCESS })
    return { ...cached.rawResult, fromCache: true }
  }

  // ── Layer 1: FMP (if key provided) ────────────────────
  if (apiKey) {
    emit({ fmp: SOURCE_STATUS.TRYING })
    try {
      const result = await fetchAllRawData(T, apiKey)
      if (!result.raw?.profile && !result.raw?.quote) {
        throw new Error('FMP returned empty — check ticker or API key')
      }
      emit({ fmp: SOURCE_STATUS.SUCCESS, yahoo: SOURCE_STATUS.SKIPPED, screener: SOURCE_STATUS.SKIPPED })
      await saveFinancials(T, { rawResult: result })
      return result
    } catch (err) {
      emit({ fmp: SOURCE_STATUS.FAILED })
      console.warn('[FMP failed]', err.message)
      // fall through to Yahoo
    }
  } else {
    emit({ fmp: SOURCE_STATUS.SKIPPED })
  }

  // ── Layer 2: Yahoo Finance (no key, browser CORS open) ─
  emit({ yahoo: SOURCE_STATUS.TRYING })
  try {
    const result = await fetchAllYahoo(T)
    if (!result.raw?.profile) throw new Error('Yahoo returned no profile data')
    emit({ yahoo: SOURCE_STATUS.SUCCESS, screener: SOURCE_STATUS.SKIPPED })
    await saveFinancials(T, { rawResult: result })
    return result
  } catch (err) {
    emit({ yahoo: SOURCE_STATUS.FAILED })
    console.warn('[Yahoo failed]', err.message)
    // fall through to Screener
  }

  // ── Layer 3: Screener.in (Indian stocks, via Vite/Vercel proxy) ─
  emit({ screener: SOURCE_STATUS.TRYING })
  try {
    const result = await fetchFromScreener(T)
    if (!result.raw?.profile) throw new Error('Screener returned no data')
    emit({ screener: SOURCE_STATUS.SUCCESS })
    await saveFinancials(T, { rawResult: result })
    return result
  } catch (err) {
    emit({ screener: SOURCE_STATUS.FAILED })
    console.warn('[Screener failed]', err.message)
  }

  // ── All failed → signal upload ─────────────────────────
  throw new OrchestratorError(
    `Could not fetch data for "${T}" from any source. Please upload a financial statement CSV.`,
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
