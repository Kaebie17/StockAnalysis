import React, { createContext, useContext, useReducer, useCallback } from 'react'
import { fetchTicker } from '../api/orchestrator.js'
import { normalize } from '../engine/normalize.js'
import { calcRatios } from '../engine/ratios.js'
import { runValuation } from '../engine/valuation.js'
import { runTechnicals } from '../engine/technicals.js'
import { scoreQuality } from '../engine/quality.js'
import { detectStage, detectSectorType } from '../engine/stage.js'
import { getCached, setCached } from '../utils/db.js'

const AppContext = createContext(null)

const initial = {
  status: 'idle', progress: null, error: null, ticker: '',
  data: null, ratios: null, valuation: null, technicals: null, quality: null,
  stage: null, sectorType: null,
  assumptions: {}, scoreWeights: {}, uploadRequired: false
}

function reducer(s, a) {
  switch (a.type) {
    case 'FETCH_START':   return { ...s, status: 'loading', error: null, progress: null, uploadRequired: false, ticker: a.ticker }
    case 'PROGRESS':      return { ...s, progress: a.payload }
    case 'FETCH_SUCCESS': return { ...s, status: 'success', error: null, ...a.payload }
    case 'FETCH_ERROR':   return { ...s, status: 'error', error: a.error }
    case 'UPLOAD_REQ':    return { ...s, status: 'error', uploadRequired: true, error: 'Both sources unavailable. Upload CSV.' }
    case 'SET_STAGE':     return { ...s, stage: a.stage, valuation: a.valuation }
    case 'RECALC':        return { ...s, ...a.payload }
    default:              return s
  }
}

function computeAll(data, assumptions, weights) {
  const ratios     = calcRatios(data)
  const sectorType = detectSectorType(data)
  const stage      = detectStage(data, ratios)
  const valuation  = runValuation(data, ratios, stage, sectorType, assumptions)
  const technicals = runTechnicals(data.priceHistory)
  const quality    = scoreQuality(data, ratios, weights)
  return { ratios, sectorType, stage, valuation, technicals, quality }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial)

  const load = useCallback(async (rawTicker) => {
    if (!rawTicker?.trim()) return
    dispatch({ type: 'FETCH_START', ticker: rawTicker.trim().toUpperCase() })
    try {
      const cached = await getCached(rawTicker)
      if (cached) { dispatch({ type: 'FETCH_SUCCESS', payload: cached }); return }

      const { source, raw } = await fetchTicker(rawTicker, p => dispatch({ type: 'PROGRESS', payload: p }))
      const data = normalize(source, raw)
      const computed = computeAll(data, {}, {})
      const payload = { data, ...computed }
      await setCached(rawTicker, payload)
      dispatch({ type: 'FETCH_SUCCESS', payload })
    } catch (err) {
      if (err.message === 'UPLOAD_REQUIRED') dispatch({ type: 'UPLOAD_REQ' })
      else dispatch({ type: 'FETCH_ERROR', error: err.message })
    }
  }, [])

  const recalc = useCallback((newAssumptions, newWeights) => {
    if (!state.data) return
    const assumptions = { ...state.assumptions, ...newAssumptions }
    const weights     = { ...state.scoreWeights, ...newWeights }
    const valuation   = runValuation(state.data, state.ratios, state.stage, state.sectorType, assumptions)
    const quality     = scoreQuality(state.data, state.ratios, weights)
    dispatch({ type: 'RECALC', payload: { valuation, quality, assumptions, scoreWeights: weights } })
  }, [state])

  const overrideStage = useCallback((stage) => {
    if (!state.data) return
    const valuation = runValuation(state.data, state.ratios, stage, state.sectorType, state.assumptions)
    dispatch({ type: 'SET_STAGE', stage, valuation })
  }, [state])

  const loadFromCSV = useCallback((normalizedData) => {
    try {
      const computed = computeAll(normalizedData, {}, {})
      dispatch({ type: 'FETCH_SUCCESS', payload: { data: normalizedData, ...computed } })
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', error: err.message })
    }
  }, [])

  return (
    <AppContext.Provider value={{ state, load, recalc, overrideStage, loadFromCSV }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be within AppProvider')
  return ctx
}
