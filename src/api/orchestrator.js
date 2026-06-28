// orchestrator.js
// Tries data sources in sequence: FMP → Screener → signals upload needed
// Returns a standard { raw, source, errors, fetchedAt } object regardless of source

import { fetchAllRawData } from './fmp.js'
import { fetchFromScreener } from './screener.js'
import { cacheGet, cacheSet, loadFinancials, saveFinancials } from '../utils/db.js'

const ONE_HOUR = 60 * 60 * 1000

export const SOURCE_STATUS = {
  IDLE:    'idle',
  TRYING:  'trying',
  SUCCESS: 'success',
  FAILED:  'failed',
  SKIPPED: 'skipped',
}

// onProgress({ fmp, screener, upload }) — called as each source is tried
export async function fetchWithFallback(ticker, apiKey, onProgress) {
  const T = ticker.toUpperCase()

  const progress = {
    fmp:      SOURCE_STATUS.IDLE,
    screener: SOURCE_STATUS.IDLE,
    upload:   SOURCE_STATUS.IDLE,
  }

  function emit(updates) {
    Object.assign(progress, updates)
    onProgress?.({ ...progress })
  }

  // ── Check IndexedDB cache first (any source) ──────────
  const cached = await loadFinancials(T)
  if (cached?.rawResult && (Date.now() - cached.savedAt < ONE_HOUR)) {
    emit({ [cached.rawResult.source === 'Screener.in' ? 'screener' : 'fmp']: SOURCE_STATUS.SUCCESS })
    return { ...cached.rawResult, fromCache: true }
  }

  // ── Layer 1: FMP API ───────────────────────────────────
  if (apiKey) {
    emit({ fmp: SOURCE_STATUS.TRYING })
    try {
      const result = await fetchAllRawData(T, apiKey)

      // FMP succeeded but may have partial data — check profile at minimum
      if (!result.raw?.profile && !result.raw?.quote) {
        throw new Error('FMP returned empty profile — ticker may not exist or key is invalid')
      }

      emit({ fmp: SOURCE_STATUS.SUCCESS, screener: SOURCE_STATUS.SKIPPED })
      await saveFinancials(T, { rawResult: result })
      return result

    } catch (fmpErr) {
      emit({ fmp: SOURCE_STATUS.FAILED })
      console.warn('[FMP failed]', fmpErr.message)

      // ── Layer 2: Screener.in (Indian stocks) ──────────
      emit({ screener: SOURCE_STATUS.TRYING })
      try {
        const result = await fetchFromScreener(T)

        if (!result.raw?.profile) {
          throw new Error('Screener returned no data for this ticker')
        }

        emit({ screener: SOURCE_STATUS.SUCCESS })
        await saveFinancials(T, { rawResult: result })
        return result

      } catch (screenerErr) {
        emit({ screener: SOURCE_STATUS.FAILED })
        console.warn('[Screener failed]', screenerErr.message)

        // ── Layer 3: Signal upload needed ─────────────
        emit({ upload: SOURCE_STATUS.TRYING })
        throw new OrchestratorError(
          'All automatic sources failed. Please upload financial statements.',
          { fmpError: fmpErr.message, screenerError: screenerErr.message }
        )
      }
    }
  } else {
    // No API key — skip FMP, go straight to Screener
    emit({ fmp: SOURCE_STATUS.SKIPPED, screener: SOURCE_STATUS.TRYING })
    try {
      const result = await fetchFromScreener(T)

      if (!result.raw?.profile) {
        throw new Error('Screener returned no data for this ticker')
      }

      emit({ screener: SOURCE_STATUS.SUCCESS })
      await saveFinancials(T, { rawResult: result })
      return result

    } catch (screenerErr) {
      emit({ screener: SOURCE_STATUS.FAILED })
      emit({ upload: SOURCE_STATUS.TRYING })
      throw new OrchestratorError(
        'No API key set and Screener fallback also failed. Please add an FMP API key or upload financial statements.',
        { screenerError: screenerErr.message }
      )
    }
  }
}

// Custom error so AppContext can distinguish "needs upload" from other errors
export class OrchestratorError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'OrchestratorError'
    this.details = details
    this.needsUpload = true
  }
}
