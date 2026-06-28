/**
 * src/store/AppContext.jsx
 */

import React, { createContext, useContext, useReducer, useCallback } from 'react'
import { fetchTicker } from '../api/orchestrator.js'
import { normalize } from '../engine/normalize.js'
import { calcRatios } from '../engine/ratios.js'
import { runValuation } from '../engine/valuation.js'
import { runTechnicals } from '../engine/technicals.js'
import { scoreQuality } from '../engine/quality.js'
import { getCached, setCached } from '../utils/db.js'

const AppContext = createContext(null)

const initialState = {
  status: 'idle',       // idle | loading | success | error
  progress: null,       // { msg, step }
  error: null,
  ticker: '',
  data: null,           // normalized data
  ratios: null,
  valuation: null,
  technicals: null,
  quality: null,
  assumptions: {},      // user-edited DCF assumptions
  scoreWeights: {},     // user-edited quality weights
  uploadRequired: false
}

function reducer(state, action) {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, status: 'loading', error: null, progress: null, uploadRequired: false, ticker: action.ticker }
    case 'PROGRESS':
      return { ...state, progress: action.payload }
    case 'FETCH_SUCCESS':
      return { ...state, status: 'success', ...action.payload, error: null }
    case 'FETCH_ERROR':
      return { ...state, status: 'error', error: action.error }
    case 'UPLOAD_REQUIRED':
      return { ...state, status: 'error', uploadRequired: true, error: 'Both Yahoo and Screener unavailable. Please upload a CSV.' }
    case 'SET_ASSUMPTIONS':
      return { ...state, assumptions: { ...state.assumptions, ...action.payload } }
    case 'SET_WEIGHTS':
      return { ...state, scoreWeights: { ...state.scoreWeights, ...action.payload } }
    case 'RECALC':
      return { ...state, ...action.payload }
    default:
      return state
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  const load = useCallback(async (rawTicker) => {
    if (!rawTicker?.trim()) return
    dispatch({ type: 'FETCH_START', ticker: rawTicker.trim().toUpperCase() })

    try {
      // Check cache first
      const cached = await getCached(rawTicker)
      if (cached) {
        dispatch({ type: 'FETCH_SUCCESS', payload: cached })
        return
      }

      const { source, raw } = await fetchTicker(rawTicker, (progress) =>
        dispatch({ type: 'PROGRESS', payload: progress })
      )

      const data        = normalize(source, raw)
      const ratios      = calcRatios(data)
      const valuation   = runValuation(data, ratios, {})
      const technicals  = runTechnicals(data.priceHistory)
      const quality     = scoreQuality(data, ratios, {})

      const payload = { data, ratios, valuation, technicals, quality }
      await setCached(rawTicker, payload)
      dispatch({ type: 'FETCH_SUCCESS', payload })

    } catch (err) {
      if (err.message === 'UPLOAD_REQUIRED') {
        dispatch({ type: 'UPLOAD_REQUIRED' })
      } else {
        dispatch({ type: 'FETCH_ERROR', error: err.message })
      }
    }
  }, [])

  const recalc = useCallback((newAssumptions, newWeights) => {
    if (!state.data) return
    const assumptions = { ...state.assumptions, ...newAssumptions }
    const weights     = { ...state.scoreWeights, ...newWeights }
    const valuation   = runValuation(state.data, state.ratios, assumptions)
    const quality     = scoreQuality(state.data, state.ratios, weights)
    dispatch({ type: 'RECALC', payload: { valuation, quality, assumptions, scoreWeights: weights } })
  }, [state])

  const loadFromCSV = useCallback((parsedData) => {
    // parsedData should be a normalized data object
    try {
      const ratios     = calcRatios(parsedData)
      const valuation  = runValuation(parsedData, ratios, {})
      const technicals = runTechnicals(parsedData.priceHistory || [])
      const quality    = scoreQuality(parsedData, ratios, {})
      dispatch({ type: 'FETCH_SUCCESS', payload: { data: parsedData, ratios, valuation, technicals, quality } })
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', error: err.message })
    }
  }, [])

  return (
    <AppContext.Provider value={{ state, load, recalc, loadFromCSV }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
