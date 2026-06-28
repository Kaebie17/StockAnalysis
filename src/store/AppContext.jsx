// AppContext.jsx
// Global state via React Context — no external state library needed

import React, { createContext, useContext, useReducer, useCallback } from 'react'
import { saveProfile, loadAllProfiles, deleteProfile } from '../utils/db.js'
import { fetchWithFallback, OrchestratorError, SOURCE_STATUS } from '../api/orchestrator.js'
import { normalizeRawData } from '../engine/normalize.js'
import { calculateRatios, calculateHistoricalRatios } from '../engine/ratios.js'
import { detectStage } from '../engine/stage.js'
import { runAllModels, DEFAULT_ASSUMPTIONS } from '../engine/valuation.js'
import { runAllTechnicals } from '../engine/technicals.js'
import { scoreFundamentals, scoreTechnicals, buildVerdict, DEFAULT_FUNDAMENTAL_PREDICTORS, DEFAULT_TECHNICAL_PREDICTORS } from '../engine/quality.js'

// ── Initial state ─────────────────────────────────────────

const initialState = {
  // API key
  apiKey: '',

  // Fetch state
  status:  'idle',      // idle | loading | success | error | needs_upload
  error:   null,
  source:  null,        // which source succeeded
  sourceProgress: {     // live status of each source attempt
    yahoo:    SOURCE_STATUS.IDLE,
    screener: SOURCE_STATUS.IDLE,
  },

  // Raw + normalized data
  raw:        null,
  data:       null,
  ratios:     null,
  histRatios: null,

  // Derived
  stage:        null,
  stageOverride:null,
  valuation:    null,
  technicals:   null,
  fundScore:    null,
  techScore:    null,
  verdict:      null,

  // Config
  assumptions:    { ...DEFAULT_ASSUMPTIONS },
  fundPredictors: DEFAULT_FUNDAMENTAL_PREDICTORS,
  techPredictors: DEFAULT_TECHNICAL_PREDICTORS,
  pillarWeights:  { valuation: 40, fundamentals: 35, technicals: 25 },

  // Profiles
  profiles:      [],
  activeProfile: 'default',

  // UI
  expandedPanel: null,

  // Upload
  pendingTicker: null,  // ticker waiting for upload
}

// ── Reducer ───────────────────────────────────────────────

function reducer(state, action) {
  switch (action.type) {
    case 'SET_API_KEY':
      localStorage.setItem('fmp_api_key', action.payload)
      return { ...state, apiKey: action.payload }

    case 'FETCH_START':
      return {
        ...state,
        status: 'loading',
        error: null,
        sourceProgress: { yahoo: SOURCE_STATUS.IDLE, screener: SOURCE_STATUS.IDLE },
        pendingTicker: action.payload,
      }

    case 'SOURCE_PROGRESS':
      return { ...state, sourceProgress: action.payload }

    case 'FETCH_SUCCESS':
      return { ...state, status: 'success', error: null, pendingTicker: null, ...action.payload }

    case 'FETCH_ERROR':
      return { ...state, status: 'error', error: action.payload }

    case 'NEEDS_UPLOAD':
      return {
        ...state,
        status: 'needs_upload',
        error: action.payload.message,
        sourceProgress: action.payload.progress,
      }

    case 'SET_STAGE_OVERRIDE':
      return { ...state, stageOverride: action.payload }

    case 'SET_ASSUMPTIONS':
      return { ...state, assumptions: { ...state.assumptions, ...action.payload } }

    case 'RESET_ASSUMPTIONS':
      return { ...state, assumptions: { ...DEFAULT_ASSUMPTIONS } }

    case 'SET_FUND_PREDICTORS':
      return { ...state, fundPredictors: action.payload }

    case 'SET_TECH_PREDICTORS':
      return { ...state, techPredictors: action.payload }

    case 'SET_PILLAR_WEIGHTS':
      return { ...state, pillarWeights: action.payload }

    case 'SET_PROFILES':
      return { ...state, profiles: action.payload }

    case 'SET_ACTIVE_PROFILE':
      return { ...state, activeProfile: action.payload }

    case 'SET_EXPANDED_PANEL':
      return { ...state, expandedPanel: state.expandedPanel === action.payload ? null : action.payload }

    case 'RECALCULATE':
      return { ...state, ...recalculate(state) }

    default:
      return state
  }
}

// ── Recalculate derived values ────────────────────────────

function recalculate(state) {
  if (!state.data) return {}

  const ratios     = calculateRatios(state.data)
  const histRatios = calculateHistoricalRatios(state.data)
  const stage      = state.stageOverride ?? detectStage(state.data, histRatios)
  const valuation  = runAllModels(state.data, ratios, state.assumptions)
  const technicals = state.data.priceHistory?.length > 30
    ? runAllTechnicals(state.data.priceHistory)
    : null

  const fundScore = scoreFundamentals(state.data, ratios, histRatios, state.fundPredictors)
  const techScore = technicals
    ? scoreTechnicals(technicals, state.techPredictors)
    : { score: null, label: 'INSUFFICIENT DATA', results: [] }

  const verdict = buildVerdict(valuation.signal, techScore, fundScore)

  return { ratios, histRatios, stage, valuation, technicals, fundScore, techScore, verdict }
}

// ── Process raw result into full state payload ────────────

function processRawResult(rawResult, state) {
  const data       = normalizeRawData(rawResult)
  const ratios     = calculateRatios(data)
  const histRatios = calculateHistoricalRatios(data)
  const stage      = detectStage(data, histRatios)
  const valuation  = runAllModels(data, ratios, state.assumptions)
  const technicals = data.priceHistory?.length > 30
    ? runAllTechnicals(data.priceHistory)
    : null

  const fundScore = scoreFundamentals(data, ratios, histRatios, state.fundPredictors)
  const techScore = technicals
    ? scoreTechnicals(technicals, state.techPredictors)
    : { score: null, label: 'INSUFFICIENT DATA', results: [] }

  const verdict = buildVerdict(valuation.signal, techScore, fundScore)

  return {
    raw: rawResult.raw,
    source: rawResult.source,
    data, ratios, histRatios,
    stage, stageOverride: null,
    valuation, technicals,
    fundScore, techScore, verdict,
  }
}

// ── Context ───────────────────────────────────────────────

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  // ── fetchTicker: tries all sources automatically ──────

  const fetchTicker = useCallback(async (ticker) => {
    dispatch({ type: 'FETCH_START', payload: ticker.toUpperCase() })

    try {
      const rawResult = await fetchWithFallback(
        ticker,
        state.apiKey,
        (progress) => dispatch({ type: 'SOURCE_PROGRESS', payload: progress })
      )

      const payload = processRawResult(rawResult, state)
      dispatch({ type: 'FETCH_SUCCESS', payload })

    } catch (err) {
      if (err instanceof OrchestratorError && err.needsUpload) {
        // All auto sources failed — prompt user for upload
        dispatch({
          type: 'NEEDS_UPLOAD',
          payload: {
            message: err.message,
            progress: state.sourceProgress,
          }
        })
      } else {
        dispatch({ type: 'FETCH_ERROR', payload: err.message })
      }
    }
  }, [state.apiKey, state.assumptions, state.fundPredictors, state.techPredictors])

  // ── injectUploadedData: called after user uploads file ─

  const injectUploadedData = useCallback((rawResult) => {
    try {
      const payload = processRawResult(rawResult, state)
      dispatch({ type: 'FETCH_SUCCESS', payload })
    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', payload: `Upload processing failed: ${err.message}` })
    }
  }, [state])

  const setApiKey = useCallback((key) => {
    dispatch({ type: 'SET_API_KEY', payload: key })
  }, [])

  const setStageOverride = useCallback((stage) => {
    dispatch({ type: 'SET_STAGE_OVERRIDE', payload: stage })
    dispatch({ type: 'RECALCULATE' })
  }, [])

  const updateAssumptions = useCallback((updates) => {
    dispatch({ type: 'SET_ASSUMPTIONS', payload: updates })
    dispatch({ type: 'RECALCULATE' })
  }, [])

  const resetAssumptions = useCallback(() => {
    dispatch({ type: 'RESET_ASSUMPTIONS' })
    dispatch({ type: 'RECALCULATE' })
  }, [])

  const updateFundPredictors = useCallback((predictors) => {
    dispatch({ type: 'SET_FUND_PREDICTORS', payload: predictors })
    dispatch({ type: 'RECALCULATE' })
  }, [])

  const updateTechPredictors = useCallback((predictors) => {
    dispatch({ type: 'SET_TECH_PREDICTORS', payload: predictors })
    dispatch({ type: 'RECALCULATE' })
  }, [])

  const updatePillarWeights = useCallback((weights) => {
    dispatch({ type: 'SET_PILLAR_WEIGHTS', payload: weights })
  }, [])

  const togglePanel = useCallback((panel) => {
    dispatch({ type: 'SET_EXPANDED_PANEL', payload: panel })
  }, [])

  const loadProfiles = useCallback(async () => {
    const profiles = await loadAllProfiles()
    dispatch({ type: 'SET_PROFILES', payload: profiles })
  }, [])

  const saveCurrentProfile = useCallback(async (name) => {
    const profile = {
      id:             Date.now().toString(),
      name,
      assumptions:    state.assumptions,
      fundPredictors: state.fundPredictors,
      techPredictors: state.techPredictors,
      pillarWeights:  state.pillarWeights,
      savedAt:        Date.now(),
    }
    await saveProfile(profile)
    await loadProfiles()
  }, [state.assumptions, state.fundPredictors, state.techPredictors, state.pillarWeights, loadProfiles])

  const applyProfile = useCallback(async (id) => {
    const profiles = await loadAllProfiles()
    const profile  = profiles.find(p => p.id === id)
    if (!profile) return
    dispatch({ type: 'SET_ASSUMPTIONS',     payload: profile.assumptions })
    dispatch({ type: 'SET_FUND_PREDICTORS', payload: profile.fundPredictors })
    dispatch({ type: 'SET_TECH_PREDICTORS', payload: profile.techPredictors })
    dispatch({ type: 'SET_PILLAR_WEIGHTS',  payload: profile.pillarWeights })
    dispatch({ type: 'SET_ACTIVE_PROFILE',  payload: id })
    dispatch({ type: 'RECALCULATE' })
  }, [])

  const removeProfile = useCallback(async (id) => {
    await deleteProfile(id)
    await loadProfiles()
  }, [loadProfiles])

  return (
    <AppContext.Provider value={{
      state,
      actions: {
        setApiKey,
        fetchTicker,
        injectUploadedData,
        setStageOverride,
        updateAssumptions,
        resetAssumptions,
        updateFundPredictors,
        updateTechPredictors,
        updatePillarWeights,
        togglePanel,
        loadProfiles,
        saveCurrentProfile,
        applyProfile,
        removeProfile,
      }
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
