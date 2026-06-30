import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react'
import { fetchTicker } from '../api/orchestrator.js'
import { normalize } from '../engine/normalize.js'
import { calcRatios } from '../engine/ratios.js'
import { runValuation } from '../engine/valuation.js'
import { runTechnicals } from '../engine/technicals.js'
import { scoreQuality } from '../engine/quality.js'
import { detectStage, detectSectorType } from '../engine/stage.js'
import { runMarketExpectation } from '../engine/marketExpectation.js'
import { getCached, setCached, loadFolderHandle, saveFolderHandle,
         loadSwapState, saveSwapState } from '../utils/db.js'
import { applyCSVOverrides, swapField, autoLoadOverride } from '../utils/csv.js'

const AppContext = createContext(null)

const initial = {
  status: 'idle', progress: null, error: null, ticker: '', validation: null,
  data: null, ratioResult: null,
  valuation: null, technicals: null, quality: null,
  marketExpectation: null,
  stage: null, sectorType: null,
  assumptions: {}, meAssumptions: {}, scoreWeights: {},
  uploadRequired: false,
  // CSV state
  csvData: null,      // raw parsed CSV for this ticker
  csvActive: false,   // whether CSV overrides are applied
  folderHandle: null, // File System Access API folder handle
  // Swap state: { income:{year:{field:true}}, balance:{...}, cashflow:{...} }
  swapState: {},
}

function reducer(s, a) {
  switch (a.type) {
    case 'FETCH_START':
      return { ...s, status: 'loading', error: null, progress: null,
               uploadRequired: false, ticker: a.ticker,
               csvData: null, csvActive: false, swapState: {} }
    case 'PROGRESS':      return { ...s, progress: a.payload }
    case 'FETCH_SUCCESS': return { ...s, status: 'success', error: null, ...a.payload }
    case 'FETCH_ERROR':   return { ...s, status: 'error', error: a.error }
    case 'UPLOAD_REQ':    return { ...s, status: 'error', uploadRequired: true,
                                   error: 'Both sources unavailable. Upload CSV.' }
    case 'SET_STAGE':     return { ...s, stage: a.stage, valuation: a.valuation,
                                   marketExpectation: a.marketExpectation }
    case 'RECALC':        return { ...s, ...a.payload }
    case 'SET_FOLDER':    return { ...s, folderHandle: a.handle }
    case 'CSV_APPLIED':   return { ...s, ...a.payload }
    case 'SWAP_FIELD':    return { ...s, ...a.payload }
    case 'RESET':          return { ...initial, folderHandle: s.folderHandle }  // keep CSV folder connection
    default:              return s
  }
}

function computeAll(data, assumptions, meAssumptions, weights) {
  const ratioResult = calcRatios(data)
  const sectorType  = detectSectorType(data)
  const stage       = detectStage(data, ratioResult)
  const valuation   = runValuation(data, ratioResult, stage, sectorType, assumptions)
  const technicals  = runTechnicals(data.priceHistory || [])
  const quality     = scoreQuality(data, ratioResult, weights)
  const marketExpectation = runMarketExpectation(data, ratioResult, stage, sectorType, meAssumptions)
  return { ratioResult, sectorType, stage, valuation, technicals, quality, marketExpectation }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial)

  // Load folder handle on mount
  useEffect(() => {
    loadFolderHandle().then(handle => {
      if (handle) dispatch({ type: 'SET_FOLDER', handle })
    }).catch(() => {})
  }, [])

  const load = useCallback(async (rawTicker) => {
    if (!rawTicker?.trim()) return
    const ticker = rawTicker.trim().toUpperCase()
    dispatch({ type: 'FETCH_START', ticker })

    try {
      // Check cache
      const cached = await getCached(ticker)
      if (cached) {
        // Try auto-load CSV override (Chrome/Android)
        if (state.folderHandle) {
          const csvData = await autoLoadOverride(ticker, state.folderHandle)
          if (csvData) {
            const withCSV = applyCSVOverrides(cached.data, csvData)
            const computed = computeAll(withCSV, {}, {}, {})
            dispatch({ type: 'FETCH_SUCCESS', payload: { ...cached, ...computed, data: withCSV, csvData, csvActive: true } })
            return
          }
        }
        dispatch({ type: 'FETCH_SUCCESS', payload: cached })
        // Load swap state
        const swaps = await loadSwapState(ticker)
        if (Object.keys(swaps).length > 0) dispatch({ type: 'RECALC', payload: { swapState: swaps } })
        return
      }

      const { source, raw, validation } = await fetchTicker(rawTicker, p => dispatch({ type: 'PROGRESS', payload: p }))
      // Pass validated historical years to normalize so only those are merged
      const data = source === 'merged'
        ? normalize(source, raw, validation?.validHistoricalYears)
        : normalize(source, raw)

      // Try auto-load CSV for this ticker (Chrome/Android)
      let finalData = data
      let csvData   = null
      let csvActive = false
      if (state.folderHandle) {
        csvData = await autoLoadOverride(ticker, state.folderHandle)
        if (csvData) {
          finalData = applyCSVOverrides(data, csvData)
          csvActive = true
        }
      }

      const computed = computeAll(finalData, {}, {}, {})
      const payload  = { data: finalData, ...computed, csvData, csvActive, validation }
      await setCached(ticker, { data, ...computeAll(data, {}, {}, {}) })  // cache without CSV
      dispatch({ type: 'FETCH_SUCCESS', payload })

    } catch (err) {
      if (err.message === 'UPLOAD_REQUIRED') dispatch({ type: 'UPLOAD_REQ' })
      else dispatch({ type: 'FETCH_ERROR', error: err.message })
    }
  }, [state.folderHandle])

  const recalc = useCallback((newAssumptions, newWeights, newMeAssumptions) => {
    if (!state.data) return
    const assumptions   = { ...state.assumptions,   ...newAssumptions }
    const weights       = { ...state.scoreWeights,  ...newWeights }
    const meAssumptions = { ...state.meAssumptions, ...newMeAssumptions }
    const valuation     = runValuation(state.data, state.ratioResult, state.stage, state.sectorType, assumptions)
    const quality       = scoreQuality(state.data, state.ratioResult, weights)
    const me            = runMarketExpectation(state.data, state.ratioResult, state.stage, state.sectorType, meAssumptions)
    dispatch({ type: 'RECALC', payload: { valuation, quality, marketExpectation: me, assumptions, scoreWeights: weights, meAssumptions } })
  }, [state])

  const overrideStage = useCallback((stage) => {
    if (!state.data) return
    const valuation         = runValuation(state.data, state.ratioResult, stage, state.sectorType, state.assumptions)
    const marketExpectation = runMarketExpectation(state.data, state.ratioResult, stage, state.sectorType, state.meAssumptions)
    dispatch({ type: 'SET_STAGE', stage, valuation, marketExpectation })
  }, [state])

  // Apply CSV data — CSV wins for raw fields, recalculates everything
  const applyCSV = useCallback((csvData) => {
    if (!state.data) return
    const withCSV  = applyCSVOverrides(state.data, csvData)
    const computed = computeAll(withCSV, state.assumptions, state.meAssumptions, state.scoreWeights)
    dispatch({ type: 'CSV_APPLIED', payload: { data: withCSV, ...computed, csvData, csvActive: true } })
  }, [state])

  // Swap a single field between CSV value and source value — triggers full recalc
  const swap = useCallback(async (historyType, year, field) => {
    if (!state.data) return
    const updated  = swapField(state.data, year, historyType, field)
    const computed = computeAll(updated, state.assumptions, state.meAssumptions, state.scoreWeights)

    // Track swap state
    const newSwaps = { ...state.swapState }
    if (!newSwaps[historyType]) newSwaps[historyType] = {}
    if (!newSwaps[historyType][year]) newSwaps[historyType][year] = {}
    const key = `${historyType}.${year}.${field}`
    newSwaps[historyType][year][field] = !newSwaps[historyType][year][field]

    await saveSwapState(state.ticker, newSwaps)
    dispatch({ type: 'SWAP_FIELD', payload: { data: updated, ...computed, swapState: newSwaps } })
  }, [state])

  // Merge a single pasted table (income/balance/cashflow) into current data.
  // Pasted years that overlap Yahoo's years get added as cross-source fill
  // for any field Yahoo was missing; new years extend history.
  const applyPastedTable = useCallback((tableType, taggedRows) => {
    if (!state.data) return
    const histKey = tableType + 'History'
    const existing = state.data[histKey] || []

    const merged = { ...Object.fromEntries(existing.map(r => [r.year, { ...r }])) }
    for (const row of taggedRows) {
      if (!row.year) continue
      if (!merged[row.year]) merged[row.year] = { year: row.year }
      for (const [field, tagged] of Object.entries(row)) {
        if (field === 'year') continue
        // Only fill if existing value is missing — never override a real source value
        if (tagged?.value != null && merged[row.year][field]?.value == null) {
          merged[row.year][field] = tagged
        }
      }
    }

    const newHistory = Object.values(merged).sort((a, b) => a.year.localeCompare(b.year))
    const updatedData = { ...state.data, [histKey]: newHistory, source: 'merged' }
    const computed = computeAll(updatedData, state.assumptions, state.meAssumptions, state.scoreWeights)
    dispatch({ type: 'CSV_APPLIED', payload: { data: updatedData, ...computed } })
  }, [state])

  const setFolderHandle = useCallback(async (handle) => {
    await saveFolderHandle(handle)
    dispatch({ type: 'SET_FOLDER', handle })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  const loadFromCSV = useCallback((normalizedData) => {
    try {
      const computed = computeAll(normalizedData, {}, {}, {})
      dispatch({ type: 'FETCH_SUCCESS', payload: { data: normalizedData, ...computed } })
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', error: err.message })
    }
  }, [])

  return (
    <AppContext.Provider value={{
      state, load, recalc, overrideStage, applyCSV, swap, setFolderHandle, loadFromCSV, reset, applyPastedTable
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be within AppProvider')
  return ctx
}
