

import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react'
import { fetchTicker } from '../api/orchestrator.js'
import { normalize, applyDocFacts, migrateStoredData } from '../engine/normalize.js'
import { calcRatios } from '../engine/ratios.js'
import { runValuation } from '../engine/valuation.js'
import { runTechnicals } from '../engine/technicals.js'
import { assessDataQuality } from '../engine/dataQuality.js'
import { scoreQuality } from '../engine/quality.js'
import { detectStage, detectSectorType } from '../engine/stage.js'
import { runMarketExpectation } from '../engine/marketExpectation.js'
import { getCached, setCached, deleteCached, clearAllCached, saveGuidance, loadGuidance } from '../utils/db.js'
import { queuePush } from '../sync/sync.js'
import { useSync } from '../sync/SyncProvider.jsx'
import { mergeByYear } from '../engine/reconstruct.js'
import { listRevisions } from '../utils/db.js'

const AppContext = createContext(null)

const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

// The persisted CAGR window for a ticker (stored as a 'growth-window' revision by
// useEstimate). Read here so the store computes with it from the first render —
// otherwise the slider shows the pinned window while the CAGR uses the default.

const initial = {
  status: 'idle', progress: null, error: null, ticker: '', query: '',
  data: null, ratioResult: null,
  valuation: null, technicals: null, quality: null,
  marketExpectation: null,
  stage: null, sectorType: null,
  assumptions: {}, meAssumptions: {}, scoreWeights: {},
  // Qualitative / governance inputs (Block 5)
  holdingsData: null, arData: null, quarterlyData: null,
  growthWindowYears: null,   // user's chosen CAGR window; null = full-history default
  normalizedIncomeHistory: null,   // reconstructed rows; only years the user restated
}

function reducer(s, a) {
  switch (a.type) {
    case 'FETCH_START':
      return { ...s, status: 'loading', error: null, progress: null,
               ticker: a.ticker, query: a.query,
               // WACC/growth/margin overrides are a decision about the STOCK
               // on screen — tuning one ticker's WACC and then searching a
               // different one silently applied the first ticker's override
               // to the second, with nothing on screen to say so. scoreWeights
               // is deliberately left alone: that's a standing preference
               // about how you want quality scored, not stock-specific data.
               assumptions: {}, meAssumptions: {} }
    case 'PROGRESS':      return { ...s, progress: a.payload }
    case 'FETCH_SUCCESS': return { ...s, status: 'success', error: null, ...a.payload }
    case 'FETCH_ERROR':   return { ...s, status: 'error', error: a.error }
    case 'SET_STAGE':     return { ...s, stage: a.stage, valuation: a.valuation,
                                   marketExpectation: a.marketExpectation }
    case 'RECALC':        return { ...s, ...a.payload }
    case 'SET_QUAL':      return { ...s, ...a.payload }
    case 'MERGE_PASTED': {
      if (!s.data) return s
      const histKey = a.tableType + 'History'
      // Income is the one table with a reported/normalized split. Merge onto
      // the persisted TRUE REPORTED baseline, not onto s.data.incomeHistory —
      // when basis is 'normalized' that field holds the merged/normalized
      // series, and merging a fresh reported paste on top of normalized
      // figures would bake the normalization into what's supposed to be the
      // reported source. Balance/cashflow have no such split.
      const base = a.tableType === 'income'
        ? (s.data.reportedIncomeHistory || s.data.incomeHistory || [])
        : (s.data[histKey] || [])
      const merged = { ...Object.fromEntries(base.map(r => [r.year, { ...r }])) }
      for (const row of a.taggedRows) {
        if (!row.year) continue
        if (!merged[row.year]) merged[row.year] = { year: row.year }
        for (const [field, tagged] of Object.entries(row)) {
          if (field === 'year') continue
          // Fill-only by default — a re-paste never silently downgrades a
          // field a stronger source already populated. `overwrite` is an
          // explicit, visible opt-in (AddHistoryModal's checkbox) for the
          // legitimate other case: Screener restated a figure, or the first
          // paste missed an unexpanded row and the corrected value needs to
          // actually land, not vanish with no sign it was ever dropped.
          if (tagged?.value != null && (a.overwrite || merged[row.year][field]?.value == null)) {
            merged[row.year][field] = tagged
          }
          if (tagged?.value != null) delete merged[row.year].synthetic
        }
      }
      const newHistory = Object.values(merged).sort((x, y) => x.year.localeCompare(y.year))
      // A paste into the income table IS a reported-data event — a new year
      // closing, a restated figure from a fresh Screener/AR pull. It updates
      // the reported baseline directly; computeAll re-derives the ACTIVE
      // series (merging in normalizedIncomeHistory) from there on its own.
      const data = a.tableType === 'income'
        ? { ...s.data, incomeHistory: newHistory, reportedIncomeHistory: newHistory, source: 'merged' }
        : { ...s.data, [histKey]: newHistory, source: 'merged' }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData, { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    case 'PRICE_UPDATE': {
      if (!s.data || a.price == null) return s
      const data = {
        ...s.data,
        price: a.price,
        marketCap: a.marketCap ?? s.data.marketCap,
        meta: a.change != null ? { ...s.data.meta, change1d: a.change } : s.data.meta,
      }
      // basis lives on data.basis, not on state itself — `s.basis` is always
      // undefined, which silently forced every price tick (poller + manual
      // refresh) to recompute on REPORTED figures even while a user viewing
      // Normalized basis stayed on that toggle. Every other call site here
      // uses data.basis correctly; this one didn't.
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData, { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    case 'SET_GROWTH_WINDOW': {
      if (!s.data) return { ...s, growthWindowYears: a.years }
      const data = { ...s.data, growthWindowYears: a.years }   // persist on data (cached per ticker)
      const next = { ...s, growthWindowYears: a.years, data }
      // Same s.basis typo as PRICE_UPDATE had — basis lives on data.basis.
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: a.years, basis: data.basis })
      return { ...next, ...computed }
    }
    case 'RESET':          return { ...initial }
    case 'APPLY_NORMALIZATION': {
      if (!s.data) return s
      // a.rows: full reconstructed rows (already validated, ok:true). Years not in
      // a.rows fall back to reported at compute time.
      const data = { ...s.data, normalizedIncomeHistory: a.rows }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    case 'SET_BASIS': {
      if (!s.data) return s
      const data = { ...s.data, basis: a.basis }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: a.basis })
      return { ...s, data, ...computed }
    }
    default:              return s
  }
}

/**
 * The single chokepoint: every path that produces a dashboard goes through here.
 * So the two data-repair steps live here rather than being sprinkled over eight
 * call sites where one would inevitably get missed.
 *
 *   migrateStoredData — strips fabrications frozen into records saved by older
 *     builds. What gets stored is the PROCESSED object, not the raw paste, so an
 *     old record carries `freeCashFlow = operatingCF x 0.7` as a real number.
 *     Left alone the new code reads it, sees a value, and reports it as
 *     "Reported Free Cash Flow" — the fabrication survives with a better label.
 *
 *   applyDocFacts — figures the user pulled out of a filing, dropped onto the
 *     year they belong to. Documents rank LAST: behind Yahoo, Screener and SEC.
 *     Nothing here overwrites a real source; it only fills holes.
 *
 * Returns `data` alongside the computed blocks, so callers spreading
 * `{ ...s, data, ...computed }` pick up the repaired copy automatically.
 */
/**
 * The full analysis pass. Exported so it can be run headlessly — the positions
 * pages need an analysis for stocks the user has never opened, and duplicating
 * this pipeline there would guarantee the two drift apart.
 */
export function computeAll(data, assumptions, meAssumptions, weights, arData = null, opts = {}) {
// Reported basis by default; normalized only when the user has restated years
  // AND toggled to it. One-offs are never silently adjusted — assessDataQuality
  // now only flags them (dq.flags); correction is manual via reconstruction.
  const dq = assessDataQuality(data?.incomeHistory || [])
  // reportedIncomeHistory is a SEPARATE, persisted source — the true
  // as-reported baseline. It is seeded ONCE, on the very first computeAll
  // call a fresh fetch/paste ever sees (when genuinely absent), and left
  // untouched on every call after that. computeAll runs on every basis
  // toggle and every price tick, so re-deriving it from whatever
  // data.incomeHistory currently holds — as this used to do — meant the
  // ACTIVE series (already normalized, after the first toggle) permanently
  // overwrote the reported baseline on every subsequent recompute. Genuine
  // reported-data events (initial fetch, a pasted new year, a restated
  // figure) update it explicitly at the call site instead — see
  // MERGE_PASTED, the one place besides this bootstrap that's allowed to.
  const reportedBase = data.reportedIncomeHistory ?? data.incomeHistory
  // The ACTIVE series always re-derives from the two stable sources
  // (reportedBase + normalizedIncomeHistory) rather than from the previous
  // call's incomeHistory, so toggling the basis back and forth is always
  // correct regardless of how many recomputes happened while normalized —
  // mergeByYear's own contract is "start from reported."
  const useNorm = opts.basis === 'normalized' && data.normalizedIncomeHistory?.length > 0
  const income = useNorm
    ? mergeByYear(reportedBase, data.normalizedIncomeHistory)  // normalized row wins per year
    : reportedBase
  data = { ...data, incomeHistory: income, reportedIncomeHistory: reportedBase }
  data = applyDocFacts(migrateStoredData(data), arData)
  // The growth window reaches ratios, so every consumer — stage classification,
  // fair value, market expectation, the AI verdict and the dashboard card — uses
  // the same figure the user chose.
  const ratioResult = calcRatios(data, { growthWindowYears: opts.growthWindowYears })
  const sectorType  = detectSectorType(data)
  const stage       = detectStage(data, ratioResult)
  const valuation   = runValuation(data, ratioResult, stage, sectorType, assumptions)
  const technicals  = runTechnicals(data.priceHistory || [])
  const quality     = scoreQuality(data, ratioResult, weights)
  const marketExpectation = runMarketExpectation(data, ratioResult, stage, sectorType, meAssumptions)
  return { data, ratioResult, sectorType, stage, valuation, technicals, quality, marketExpectation }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { lastPulledAt } = useSync()

  // Persist the current (possibly Screener-merged) data whenever it changes, so a
  // pasted-history merge — not just the initial fetch — survives a reload.
  useEffect(() => {
    if (state.status !== 'success' || !state.ticker || !state.data) return
    const payload = { data: state.data, ...computeAll(state.data, {}, {}, {}, state.arData, { growthWindowYears: state.growthWindowYears, basis: state.data.basis }) }
    try { setCached(state.ticker, payload) } catch {}
    // Sync merged financials (they hold pasted Screener history the user built).
    // Pure Yahoo data is re-fetchable, so it isn't synced. Shape must match what
    // setCached writes: { key, data: payload, ... }.
    if (state.data.deepSource === 'screener') {
      const t = state.ticker.toUpperCase()
      queuePush(`financials:${t}`, { key: t, data: payload, timestamp: Date.now(), lastAccessed: Date.now() })
    }
  }, [state.data])   // eslint-disable-line react-hooks/exhaustive-deps

  // A sync pull writes straight into IndexedDB (via db.js) — it has no way to
  // reach into this reducer's in-memory `state.data`. Without this, a ticker
  // opened BEFORE signing in stayed on whatever it loaded then (e.g. a plain
  // Yahoo-only fetch) even after sync pulled in the real, Screener-merged
  // record for that same ticker: same bug as usePositions, same fix — re-read
  // the currently open ticker's cache whenever a pull lands.
  useEffect(() => {
    if (!lastPulledAt || !state.ticker) return
    let cancelled = false
    getCached(state.ticker).then(cached => {
      if (cancelled || !cached) return
      const pinnedWindow = cached.data?.growthWindowYears ?? null
      const computed = computeAll(cached.data, state.assumptions, state.meAssumptions, state.scoreWeights, state.arData, { growthWindowYears: pinnedWindow, basis: cached.data?.basis })
      dispatch({ type: 'FETCH_SUCCESS', payload: { ...cached, ...computed, growthWindowYears: pinnedWindow } })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [lastPulledAt])   // eslint-disable-line react-hooks/exhaustive-deps

  // Live price poller: refresh just the quote every 60s while the user is active.
  // Stops re-fetching after 15 min of inactivity and resumes automatically on the
  // next activity. Only the price/market-cap update — the heavy data stays put.
  useEffect(() => {
    if (state.status !== 'success' || !state.ticker) return
    const POLL_MS = 60 * 1000
    const IDLE_MS = 15 * 60 * 1000
    let lastActivity = Date.now()
    const bump = () => { lastActivity = Date.now() }
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']
    events.forEach(e => window.addEventListener(e, bump, { passive: true }))

    const tick = async () => {
      if (Date.now() - lastActivity > IDLE_MS) return   // idle → skip the fetch
      try {
        const r = await fetch(`/api/quote?ticker=${encodeURIComponent(state.ticker)}`)
        const q = await r.json()
        if (q?.price != null) dispatch({ type: 'PRICE_UPDATE', price: q.price, marketCap: q.marketCap, change: q.change })
      } catch { /* ignore transient errors */ }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    return () => { clearInterval(id); events.forEach(e => window.removeEventListener(e, bump)) }
  }, [state.ticker, state.status])

  useEffect(() => {
    if (state.status === 'success' && state.data?.price != null && state.ticker) {
      const payload = { data: state.data, ...computeAll(state.data, {}, {}, {}, state.arData, { growthWindowYears: state.growthWindowYears, basis: state.data.basis }) }
      setCached(state.ticker, payload).catch(() => {})
    }
  }, [state.data?.price])
  
  const load = useCallback(async (rawTicker) => {
    if (!rawTicker?.trim()) return
    const ticker = rawTicker.trim().toUpperCase()
    // Restored from cached data below (data.growthWindowYears); no separate lookup.
    let pinnedWindow = null 
    dispatch({ type: 'FETCH_START', ticker, query: rawTicker.trim() })

    try {
      // Check cache. A READ FAILURE must never fall through to the fetch path —
      // that would overwrite good (Screener-merged / holdings / AR) data with a
      // fresh Yahoo-only record. Only a confirmed-absent record (null) may fetch.
      let cached
      try {
        cached = await getCached(ticker)
      } catch (readErr) {
        dispatch({ type: 'FETCH_ERROR', error: 'Could not read saved data — not overwriting. Please retry.' })
        return
      }
      if (cached) {
        pinnedWindow = cached.data?.growthWindowYears ?? null
        const computed = computeAll(cached.data, state.assumptions, state.meAssumptions, state.scoreWeights, state.arData, { growthWindowYears: pinnedWindow, basis: cached.data?.basis })
        dispatch({ type: 'FETCH_SUCCESS', payload: { ...cached, ...computed, growthWindowYears: pinnedWindow } })
        return
      }

      const { source, raw } = await fetchTicker(rawTicker, p => dispatch({ type: 'PROGRESS', payload: p }))
      // No year filtering: fetchTicker returns only { source, raw }, and normalize
      // takes two arguments. The old third argument (validation.validHistoricalYears)
      // was always undefined and silently discarded — a leftover from when Screener
      // was cross-validated against Yahoo before merging. That check was dropped
      // because it had the sources backwards; Screener now replaces Yahoo outright.
      const data = normalize(source, raw)

      const computed = computeAll(data, {}, {}, {}, state.arData, { growthWindowYears: pinnedWindow })
      const payload  = { data, ...computed, growthWindowYears: pinnedWindow }
      await setCached(ticker, payload)
      dispatch({ type: 'FETCH_SUCCESS', payload })

    } catch (err) {
      dispatch({ type: 'FETCH_ERROR', error: err.message })
    }
  }, [])

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

  /** "This figure isn't reported for this company — stop asking." Stored per
   *  ticker alongside the AR data, so it syncs and survives a reload. It changes
   *  no number: the estimates already fire on their own. It only silences. */
  const dismissGap = useCallback((metric) => {
    const prev = state.arData || {}
    const list = prev.dismissedGaps || []
    if (list.includes(metric)) return
    setQualInputs({ arData: { ...prev, dismissedGaps: [...list, metric] } })
  }, [state.arData]) // eslint-disable-line react-hooks/exhaustive-deps

  const setQualInputs = useCallback((patch) => {
    const next = {
      holdingsData:  patch.holdingsData  !== undefined ? patch.holdingsData  : state.holdingsData,
      arData:        patch.arData        !== undefined ? patch.arData        : state.arData,
      // Pasted quarterly P&L. Kept HERE rather than merged into incomeHistory:
      // that series is keyed by fiscal year and read as full years everywhere
      // (ratios, CAGR, DCF), so a quarter dropped into a year slot would read as
      // a collapse in revenue rather than as the partial period it is.
      quarterlyData: patch.quarterlyData !== undefined ? patch.quarterlyData : state.quarterlyData,
    }
    dispatch({ type: 'SET_QUAL', payload: next })
    if (state.ticker) {
      saveGuidance(state.ticker, next)
      queuePush(`guidance:${state.ticker.toUpperCase()}`, { ticker: state.ticker.toUpperCase(), ...next })
    }
  }, [state.ticker, state.holdingsData, state.arData, state.quarterlyData])

  // Load saved guidance/holdings/AR when the ticker changes. We clear first (so a
  // new ticker never shows the previous ticker's inputs) then load this ticker's
  // saved record — done here rather than in FETCH_START so the async fetch cycle
  // can't clobber a just-loaded record.
  useEffect(() => {
    if (!state.ticker) return
    let cancelled = false
    dispatch({ type: 'SET_QUAL', payload: { holdingsData: null, arData: null, quarterlyData: null } })
    loadGuidance(state.ticker).then(rec => {
      if (cancelled || !rec) return
      dispatch({ type: 'SET_QUAL', payload: {
        holdingsData:  rec.holdingsData  || null,
        arData:        rec.arData        || null,
        quarterlyData: rec.quarterlyData || null,
      } })
    })
    return () => { cancelled = true }
  }, [state.ticker])

  const overrideStage = useCallback((stage) => {
    if (!state.data) return
    const valuation         = runValuation(state.data, state.ratioResult, stage, state.sectorType, state.assumptions)
    const marketExpectation = runMarketExpectation(state.data, state.ratioResult, stage, state.sectorType, state.meAssumptions)
    dispatch({ type: 'SET_STAGE', stage, valuation, marketExpectation })
  }, [state])

  // Merge a single pasted table (income/balance/cashflow) into current data.
  // Pasted years that overlap Yahoo's years get added as cross-source fill
  // for any field Yahoo was missing; new years extend history. Pass
  // { overwrite: true } to replace an already-populated field instead (see
  // MERGE_PASTED) — off by default everywhere this is called from.
  const applyPastedTable = useCallback((tableType, taggedRows, opts = {}) => {
    dispatch({ type: 'MERGE_PASTED', tableType, taggedRows, overwrite: !!opts.overwrite })
    }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' })
  }, [])

  // Reset one ticker: drop its cached data so the next analyse re-fetches fresh.
  const resetTicker = useCallback(async (ticker) => {
    if (ticker) await deleteCached(ticker)
    dispatch({ type: 'RESET' })
  }, [])

  /**
   * Set the CAGR window and recompute everything that reads it.
   *
   * Persisted as a revision by useEstimate so it survives reload; this is the
   * in-memory half that makes the change visible immediately.
   */
  const setGrowthWindowYears = useCallback((years) => {
    dispatch({ type: 'SET_GROWTH_WINDOW', years: years ?? null })
  }, [])

  const setBasis = useCallback((basis) => {
    dispatch({ type: 'SET_BASIS', basis })
  }, [])

  const applyNormalization = useCallback((rows) => {
    dispatch({ type: 'APPLY_NORMALIZATION', rows })
  }, [])

  // Reset the whole app: wipe all cached financials.
  const clearAllData = useCallback(async () => {
    await clearAllCached()
    dispatch({ type: 'RESET' })
  }, [])

    const refreshPrice = useCallback(async () => {
    const ticker = state.data?.ticker || state.ticker
    if (!ticker) return
    try {
      const res = await fetch(`/api/yahoo?endpoint=all&ticker=${encodeURIComponent(ticker)}`)
      if (!res.ok) return
      const json = await res.json()
      const newPrice  = json?.quote?.regularMarketPrice
      const newMcap   = json?.quote?.marketCap
      const newChange = json?.quote?.regularMarketChangePercent
      if (newPrice != null) {
        dispatch({ type: 'PRICE_UPDATE', price: newPrice, marketCap: newMcap, change: newChange })
      }
    } catch { /* ignore transient errors */ }
  }, [state.ticker, state.data])

  return (
    <AppContext.Provider value={{
      state, load, recalc, overrideStage, reset, resetTicker, clearAllData, applyPastedTable, setQualInputs, dismissGap, setGrowthWindowYears, setBasis, applyNormalization, refreshPrice
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
