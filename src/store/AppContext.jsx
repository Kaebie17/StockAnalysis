

import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react'
import { fetchTicker } from '../api/orchestrator.js'
import { normalize, applyDocFacts, migrateStoredData, migrateNormalizedTable } from '../engine/normalize.js'
import { calcRatios } from '../engine/ratios.js'
import { runValuation } from '../engine/valuation.js'
import { runTechnicals } from '../engine/technicals.js'
import { assessDataQuality, materializeIncomeNormalization, hasAnyNormalization } from '../engine/dataQuality.js'
import { METRICS } from '../engine/metrics.js'
import { recomputeNormalizedTargets } from '../engine/normalizationTargets.js'
import { materializeFormulas } from '../engine/formulas.js'
import { scoreQuality } from '../engine/quality.js'
import { detectStage, detectSectorType } from '../engine/stage.js'
import { runMarketExpectation } from '../engine/marketExpectation.js'
import { getCached, setCached, deleteCached, clearAllCached, saveGuidance, loadGuidance } from '../utils/db.js'
import { queuePush } from '../sync/sync.js'
import { useSync } from '../sync/SyncProvider.jsx'
import { listRevisions } from '../utils/db.js'
import { fetchPeerCandidates, clearPeersCache } from '../api/peersClient.js'
import { getRiskFreeRate } from '../api/riskFreeClient.js'
import { getEquityRiskPremium } from '../api/erpClient.js'
import { getAiKey } from '../utils/aiKey.js'
import { computeBeta } from '../engine/beta.js'
import { fetchIndexHistory } from '../api/marketRegime.js'

const AppContext = createContext(null)

const yearOf = row => {
  const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
  return m ? Number(m[0]) : null
}

// A peer the user has explicitly reviewed and confirmed as a real
// comparable for THIS ticker specifically — stored on data.confirmedPeers
// (per-ticker, mirrors growthWindowYears' storage), never on the peer
// ticker's own record. Opt-IN, not opt-out: the candidate pool now
// includes NSE's own sectoral index constituents (peersClient.js's
// fetchPeerCandidates), which can run 20-30 names deep and mixes genuinely
// different businesses inside one index (e.g. Nifty Energy has pure-play
// oil & gas alongside Power names) — a broad list like that needs the
// user to actively pick which ones count, not everything counting by
// default minus explicit exclusions. Filtered in only at the point of USE
// (feeding runValuation/runMarketExpectation), never by mutating
// assumptions.peers itself — that stays the full raw candidate list
// always, so confirming/unconfirming later just needs a re-filter, not a
// fresh fetch.
const activePeers = (allPeers, confirmedPeers) => {
  if (!confirmedPeers?.length) return []
  const confirmed = new Set(confirmedPeers)
  return (allPeers || []).filter(p => confirmed.has(p.symbol))
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
  // This app's own regression beta (src/engine/beta.js) — see the
  // SET_LIVE_BETA case and its effect below. Session-scoped like the WACC/
  // margin overrides in `assumptions` already are, not persisted per ticker
  // like growthWindowYears — a "how many years should the regression use"
  // preference, not curated per-company data.
  betaWindowYears: 5,
  computedBeta: null,   // { beta, n, years, r2, label } | { beta: null, insufficientReason } | null (not yet resolved)
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
    // Live peers + risk-free rate + equity risk premium resolve asynchronously
    // (a network fetch, up to a few seconds) well after the ticker itself
    // finished loading. Merging them via the REDUCER's own `s` — not a
    // closure-captured `state` from whenever the fetch started — is what
    // keeps this safe if the user changed some other assumption (a slider)
    // while the fetch was still in flight; a plain callback closing over
    // `state` would risk clobbering that change with whatever `state` looked
    // like when the effect was created.
    case 'SET_LIVE_INPUTS': {
      if (!s.data) return s
      // assumptions.peers stays the FULL raw list — exclusions are applied
      // fresh, below, at the point of use, not baked in here.
      const assumptions = { ...s.assumptions, peers: a.peers, liveRiskFree: a.liveRiskFree, liveErp: a.liveErp, market: a.market }
      const peers = activePeers(assumptions.peers, s.data.confirmedPeers)
      const valuation = runValuation(s.data, s.ratioResult, s.stage, s.sectorType, { ...assumptions, peers })
      const meOpts = {
        liveRiskFree: a.liveRiskFree,
        liveErp: a.liveErp,
        beta: assumptions.beta ?? s.ratioResult?.ratios?.beta?.value ?? null,
        betaMeta: assumptions.betaMeta ?? null,
        market: a.market,
        peers,
      }
      const marketExpectation = runMarketExpectation(s.data, s.ratioResult, s.stage, s.sectorType, s.meAssumptions, meOpts)
      return { ...s, assumptions, valuation, marketExpectation }
    }
    // This app's own regression beta (src/engine/beta.js), resolved
    // asynchronously by the effect below once price + index history are
    // available. Same shape as SET_LIVE_INPUTS above — beta lives in
    // `assumptions` (the slot every CAPM consumer already reads as
    // `assumptions.beta ?? ratios.beta.value`), `betaMeta` rides alongside
    // it so requiredReturn.js's labels can say WHICH source produced the
    // number. `a.beta` is null when the regression declined (not enough
    // overlapping history) — that's a real, intentional value: it means
    // "fall through to Yahoo's reported figure", not "no data at all".
    case 'SET_LIVE_BETA': {
      if (!s.data) return s
      const assumptions = { ...s.assumptions, beta: a.beta, betaMeta: a.betaMeta ?? null }
      const peers = activePeers(assumptions.peers, s.data.confirmedPeers)
      const valuation = runValuation(s.data, s.ratioResult, s.stage, s.sectorType, { ...assumptions, peers })
      const meOpts = {
        liveRiskFree: assumptions.liveRiskFree ?? null,
        liveErp: assumptions.liveErp ?? null,
        beta: assumptions.beta ?? s.ratioResult?.ratios?.beta?.value ?? null,
        betaMeta: assumptions.betaMeta ?? null,
        market: assumptions.market ?? 'IN',
        peers,
      }
      const marketExpectation = runMarketExpectation(s.data, s.ratioResult, s.stage, s.sectorType, s.meAssumptions, meOpts)
      return { ...s, assumptions, valuation, marketExpectation, computedBeta: a.betaMeta ?? null }
    }
    // Just records the chosen window — the effect below reacts to the
    // change, fetches/refits, and dispatches SET_LIVE_BETA once resolved.
    // Not persisted per ticker (see the `betaWindowYears` comment on
    // `initial` above), so this intentionally survives a ticker switch.
    case 'SET_BETA_WINDOW':
      return { ...s, betaWindowYears: a.years }
    case 'SET_QUAL':      return { ...s, ...a.payload }
    case 'MERGE_PASTED': {
      if (!s.data) return s
      const histKey = a.tableType + 'History'
      // Income has no separate normalized table any more — one table
      // (reportedIncomeHistory), with netProfitNormalized/epsNormalized as
      // real sibling fields on the same rows (materializeIncomeNormalization
      // in dataQuality.js, called from computeAll). A paste always merges
      // onto this persisted reported baseline, never onto some other
      // "active" series — there isn't one any more; every consumer reads
      // reportedIncomeHistory directly and resolves netProfit/eps (and every
      // other normalizable field) itself via activeValue against the
      // current basis. `|| s.data.
      // incomeHistory` is a legacy fallback for a record from before the
      // reported/active split existed at all. Balance/cashflow have no such
      // split.
      const base = a.tableType === 'income'
        ? (s.data.reportedIncomeHistory || s.data.incomeHistory || [])
        : (s.data[histKey] || [])
      const merged = { ...Object.fromEntries(base.map(r => [r.year, { ...r }])) }
      for (const row of a.taggedRows) {
        if (!row.year) continue
        if (!merged[row.year]) merged[row.year] = { year: row.year }
        for (const [field, tagged] of Object.entries(row)) {
          if (field === 'year') continue
          // A pasted figure ALWAYS beats a Yahoo-derived one for the same
          // field, in every paste mode, not just Replace — Yahoo and
          // Screener don't necessarily mean the same thing by "current
          // assets" or "total debt" (different disclosure bases), so once a
          // real, disclosed figure exists there's no good reason to leave a
          // rougher, definitionally-uncertain aggregate sitting next to it.
          // Gap fill's protection is for a field a PRIOR PASTE already
          // set — never re-paste over your own earlier work by accident —
          // not for shielding a Yahoo fallback from being replaced by the
          // real thing. Replace (`a.overwrite`) additionally overwrites a
          // prior paste too, for a genuine restatement/correction.
          const existingIsPasted = merged[row.year][field]?.status === 'pasted'
          if (tagged?.value != null && (a.overwrite || !existingIsPasted)) {
            merged[row.year][field] = tagged
          }
          if (tagged?.value != null) delete merged[row.year].synthetic
        }
      }
      const newHistory = Object.values(merged).sort((x, y) => x.year.localeCompare(y.year))
      // A paste into the income table IS a reported-data event — a new year
      // closing, a restated figure from a fresh Screener/AR pull. It updates
      // the reported baseline directly; computeAll derives the ACTIVE
      // series (normalized netProfit/eps, computed live per row) from there
      // on its own — nothing to pre-derive or store here any more.
      // deepSource is the ONLY thing exportSyncableRecords() checks to decide
      // whether a financials record is worth pushing to Supabase (db.js).
      // normalize.js sets it when Screener data merges in automatically at
      // initial fetch — but a manual paste through this exact modal is the
      // SAME kind of Screener data, arriving later, and this case never set
      // it. That silently made every ticker built up via "Add History" un-
      // syncable: real pasted effort, sitting on one device forever.
      const data = a.tableType === 'income'
        ? { ...s.data, incomeHistory: newHistory, reportedIncomeHistory: newHistory, source: 'merged', deepSource: 'screener' }
        : { ...s.data, [histKey]: newHistory, source: 'merged', deepSource: 'screener' }
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
    case 'PRICE_HISTORY_UPDATE': {
      // Replaces ONLY priceHistory — never incomeHistory/balanceHistory/
      // cashflowHistory/reportedIncomeHistory, which is where a manually
      // pasted Screener history (real, hand-curated work) lives. A fresh
      // Yahoo price fetch is always safe to drop in wholesale; a fresh
      // statement fetch is not, since it would silently discard anything
      // the auto Screener re-scrape doesn't recapture (Screener is commonly
      // blocked by Cloudflare, at which point the fallback is Yahoo-only).
      if (!s.data || !Array.isArray(a.priceHistory)) return s
      const data = { ...s.data, priceHistory: a.priceHistory }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
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
    // How much App Estimate's peer cross-check (targetMultiple.js) pulls the
    // fitted own-history multiple toward the peer band — a per-ticker
    // judgment call (persisted on data, same storage as growthWindowYears
    // above), not something valuation.js/marketExpectation.js read at all.
    // No computeAll/runValuation pass needed: useEstimate.js's buildEstimate
    // call reads state.data.peerWeight directly on its own next render, the
    // same way it already reacts to state.data.confirmedPeers changing.
    case 'SET_PEER_WEIGHT': {
      if (!s.data) return s
      return { ...s, data: { ...s.data, peerWeight: a.weight } }
    }
    // A peer explicitly confirmed as a real comparable for THIS ticker —
    // persisted on data (same per-ticker storage as growthWindowYears
    // above), never touches the confirmed ticker's OWN cached record. Only
    // affects the peer-median tiers in valuation.js/marketExpectation.js
    // (via activePeers, applied fresh here) — everything else about this
    // stock is unrelated, so a light recompute (like SET_LIVE_BETA above)
    // is enough; no need for computeAll's full ratios/stage pass.
    case 'SET_CONFIRMED_PEERS': {
      if (!s.data) return s
      const data = { ...s.data, confirmedPeers: a.confirmedPeers }
      const peers = activePeers(s.assumptions.peers, a.confirmedPeers)
      const valuation = runValuation(data, s.ratioResult, s.stage, s.sectorType, { ...s.assumptions, peers })
      const meOpts = {
        liveRiskFree: s.assumptions.liveRiskFree ?? null,
        liveErp: s.assumptions.liveErp ?? null,
        beta: s.assumptions.beta ?? s.ratioResult?.ratios?.beta?.value ?? null,
        betaMeta: s.assumptions.betaMeta ?? null,
        market: s.assumptions.market ?? 'IN',
        peers,
      }
      const marketExpectation = runMarketExpectation(data, s.ratioResult, s.stage, s.sectorType, s.meAssumptions, meOpts)
      return { ...s, data, valuation, marketExpectation }
    }
    case 'RESET':          return { ...initial }
    case 'APPLY_NORMALIZATION': {
      if (!s.data) return s
      // a.rows: full reconstructed rows from NormalizeModal (already
      // validated, ok:true) — one entry per year the user manually
      // normalized. No separate table any more: write netProfitNormalized /
      // epsNormalized directly onto the matching year's row in
      // reportedIncomeHistory, as an override sibling field. Only netProfit
      // and eps are ever lifted out of a.rows — every other field
      // reconstructRow's identity chain touched (PBT, tax, ...) was only ever
      // scratch work toward those two, never separately consumed by anything
      // downstream. A year not present in a.rows is completely untouched.
      //
      // a.overwrite ('replace' behavior when true) matters for Table mode,
      // which can paste several years at once — same Gap fill/Replace choice
      // as every other bulk paste surface in the app, defaulted to true here
      // since Excerpt mode (a single, deliberate one-year correction) has no
      // ambiguity to gap-fill against and should always just set the value.
      const overwrite = a.overwrite ?? true
      const overridesByYear = Object.fromEntries((a.rows || []).map(r => [String(r.year), r]))
      const reportedBase = s.data.reportedIncomeHistory || s.data.incomeHistory || []
      const reportedIncomeHistory = reportedBase.map(row => {
        const o = overridesByYear[String(row.year)]
        if (!o) return row
        const out = { ...row }
        if (o.netProfit != null && (overwrite || out.netProfitNormalized?.value == null)) out.netProfitNormalized = o.netProfit
        if (o.eps != null && (overwrite || out.epsNormalized?.value == null)) out.epsNormalized = o.eps
        return out
      })
      const data = { ...s.data, reportedIncomeHistory }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    // The general historical-normalization restatement tool — NormalizeModal's
    // "paste any statement" mode. Superseded design: every pasted row the
    // user maps to a target used to sum invisibly into an opaque
    // {target}RestatementsTotal, discarding the individual labels — the same
    // treatment Screener itself never gives a real disclosed waterfall
    // (Exceptional Items AT, Profit for EPS/PE all survive as their OWN
    // rows, never collapsed into Net Profit). Every mapped row now becomes
    // its own persisted custom field instead — see ADD_CUSTOM_FIELDS_BATCH —
    // so there's nothing left for this action to do; a target's Normalized
    // figure is derived live from whichever custom rows currently target it
    // (normalizationTargets.js's normalizedFieldValue), not from a stored
    // total. Nothing dispatches this any more.
    //
    // Creating several named rows in one paste, plus their values (which can
    // span more than one statement — a restatement paste can mix P&L and
    // balance-sheet rows), needs a single batched dispatch rather than N
    // separate ADD_CUSTOM_FIELD + EDIT_HISTORY_CELLS round trips, each of
    // which would otherwise re-run computeAll on its own.
    // a.fields: [{ key, label, table }] — one per mapped row.
    // a.assignments: [{ field, kind: 'restatement', target, sign }] — that
    // row's mapping, unsigned magnitude in a.edits (sign lives on the
    // assignment, applied only when the target's Normalized figure is
    // derived).
    // a.edits:  [{ key, year, value }] — that row's own values, unsigned.
    case 'ADD_CUSTOM_FIELDS_BATCH': {
      if (!s.data) return s
      const customFields = [...(s.data.customFields || []), ...(a.fields || [])]
      const fieldAssignments = (a.assignments || []).length
        ? [...(s.data.fieldAssignments || []), ...a.assignments]
        : s.data.fieldAssignments
      let data = { ...s.data, customFields, fieldAssignments }
      const tableByKey = Object.fromEntries((a.fields || []).map(f => [f.key, f.table]))
      const editsByTable = {}
      for (const e of (a.edits || [])) {
        const table = tableByKey[e.key]
        if (!table || e.value == null) continue
        ;(editsByTable[table] ??= []).push(e)
      }
      for (const [table, edits] of Object.entries(editsByTable)) {
        const histKey = table === 'income' ? 'reportedIncomeHistory' : `${table}History`
        const base = table === 'income' ? (data.reportedIncomeHistory || data.incomeHistory || []) : (data[histKey] || [])
        const byYear = Object.fromEntries(base.map(r => [String(r.year), { ...r }]))
        for (const e of edits) {
          const y = String(e.year)
          if (!byYear[y]) byYear[y] = { year: y }
          byYear[y] = { ...byYear[y], [e.key]: { value: e.value, status: 'pasted', formula: null } }
        }
        const newHistory = Object.values(byYear).sort((x, y) => x.year.localeCompare(y.year))
        data = table === 'income'
          ? { ...data, incomeHistory: newHistory, reportedIncomeHistory: newHistory, source: 'merged', deepSource: 'screener' }
          : { ...data, [histKey]: newHistory, source: 'merged', deepSource: 'screener' }
      }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    // Combine several custom rows into one — either a brand-new row
    // (a.mode 'new', a.newField carries its {key,label,table,target,sign})
    // or one of the merged rows itself (a.mode 'existing', a.destKey names
    // which — it keeps its own name/target/sign, only its values change).
    // The merged value for each year is the sum of whatever the SOURCE rows
    // currently hold that year (a year every source lacks stays blank, never
    // fabricated as 0). Every source row except the destination is deleted —
    // its values stripped off every row, its definition removed — since the
    // merge is meant to replace them, not leave duplicates sitting around.
    // Scoped to custom rows only, deliberately: a tracked metrics.js field's
    // key is read directly, by name, by ratios.js/valuation.js's own
    // formulas (net working capital, FCF, ...) — merging one of those away
    // would silently sever that calculation, not just tidy up a label.
    case 'MERGE_CUSTOM_FIELDS': {
      if (!s.data) return s
      const { table, sourceKeys = [], mode, destKey, newField } = a
      if (!table || sourceKeys.length < 2) return s
      const histKey = table === 'income' ? 'reportedIncomeHistory' : `${table}History`
      const base = table === 'income' ? (s.data.reportedIncomeHistory || s.data.incomeHistory || []) : (s.data[histKey] || [])
      const finalDestKey = mode === 'new' ? newField.key : destKey
      const keysToRemove = sourceKeys.filter(k => k !== finalDestKey)

      const newHistory = base.map(row => {
        let sum = null
        for (const k of sourceKeys) {
          const v = row?.[k]?.value
          if (v != null) sum = (sum ?? 0) + v
        }
        let out = { ...row }
        for (const k of keysToRemove) { const { [k]: _drop, ...rest } = out; out = rest }
        if (sum != null) out[finalDestKey] = { value: sum, status: 'pasted', formula: null }
        return out
      })

      let customFields = s.data.customFields || []
      if (mode === 'new') customFields = [...customFields, newField]
      customFields = customFields.filter(f => !keysToRemove.includes(f.key))

      // The merged row inherits whatever the FIRST selected source was
      // feeding (a new row has no assignments of its own to carry over;
      // 'existing' mode keeps destKey's own, already correct as-is) — same
      // "first source wins" precedent the old target/sign inheritance used.
      // Every source's assignments are dropped either way once its key is
      // removed below, so nothing doubles up.
      let fieldAssignments = s.data.fieldAssignments || []
      if (mode === 'new') {
        const inherited = fieldAssignments
          .filter(x => x.field === sourceKeys[0])
          .map(x => ({ ...x, field: finalDestKey }))
        fieldAssignments = [...fieldAssignments, ...inherited]
      }
      fieldAssignments = fieldAssignments.filter(x => !keysToRemove.includes(x.field))

      const data = table === 'income'
        ? { ...s.data, incomeHistory: newHistory, reportedIncomeHistory: newHistory, customFields, fieldAssignments }
        : { ...s.data, [histKey]: newHistory, customFields, fieldAssignments }
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
    // The editable data-table's own commit path — a direct, single-cell (or
    // multi-cell, one Save) correction, as an alternative to pasting a whole
    // table through AddHistoryModal/GapFillModal for a one-off fix. No Gap
    // fill/Replace choice here: clicking a cell already shows the user
    // exactly what's being overwritten (or that it's blank), which is the
    // same visibility a paste's overlap preview exists to provide — so a
    // direct edit always just sets the value, same as NormalizeModal's
    // Excerpt mode for the same reason (one exact, deliberate number).
    // a.edits: [{ year, field, value }] — value: number to set, or null to
    // clear the cell back to unpopulated.
    case 'EDIT_HISTORY_CELLS': {
      if (!s.data) return s
      const histKey = a.tableType === 'income' ? 'reportedIncomeHistory' : `${a.tableType}History`
      const base = a.tableType === 'income'
        ? (s.data.reportedIncomeHistory || s.data.incomeHistory || [])
        : (s.data[histKey] || [])
      const byYear = Object.fromEntries(base.map(r => [String(r.year), { ...r }]))
      for (const e of (a.edits || [])) {
        if (!e?.year) continue
        const y = String(e.year)
        if (!byYear[y]) byYear[y] = { year: y }
        if (e.value == null) {
          const { [e.field]: _drop, ...rest } = byYear[y]
          byYear[y] = rest
        } else {
          // alwaysPositive (capex) — a spend magnitude, not a signed
          // quantity; see metrics.js. Someone typing in the exact figure
          // they see on a cash-flow statement (which shows it negative,
          // an outflow) would otherwise silently store the wrong sign.
          const value = METRICS[e.field]?.alwaysPositive ? Math.abs(e.value) : e.value
          byYear[y] = { ...byYear[y], [e.field]: { value, status: 'pasted', formula: null } }
        }
      }
      const newHistory = Object.values(byYear).sort((x, y) => x.year.localeCompare(y.year))
      // Same reasoning as MERGE_PASTED: a hand-typed correction is real,
      // hand-curated work exactly like a Screener paste, so it needs the same
      // deepSource flag or exportSyncableRecords() silently never syncs it.
      const data = a.tableType === 'income'
        ? { ...s.data, incomeHistory: newHistory, reportedIncomeHistory: newHistory, source: 'merged', deepSource: 'screener' }
        : { ...s.data, [histKey]: newHistory, source: 'merged', deepSource: 'screener' }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    // A genuinely custom line item (not in metrics.js) added from the data
    // table — see HistoryTableModal.jsx. Its VALUES live on the same history
    // rows as any tracked field (byYear[key]), keyed by this synthetic key;
    // only the definition (label, which statement, optional normalization
    // mapping) needs its own storage, kept on `data` the same way
    // confirmedPeers/growthWindowYears already are (per-ticker, persisted).
    // a.field: { key, label, table } — a plain reference row, no mapping.
    // a.assignments (optional): [{ kind, target|formula, bucket, sign }] —
    // filled in with field:a.field.key and appended, so a row can be wired
    // into a normalization/formula the moment it's created rather than
    // needing a second trip through SET_ASSIGNMENTS_FOR_FIELD.
    case 'ADD_CUSTOM_FIELD': {
      if (!s.data) return s
      const customFields = [...(s.data.customFields || []), a.field]
      const newAssignments = (a.assignments || []).map(x => ({ ...x, field: a.field.key }))
      const fieldAssignments = newAssignments.length
        ? [...(s.data.fieldAssignments || []), ...newAssignments]
        : s.data.fieldAssignments
      return { ...s, data: { ...s.data, customFields, fieldAssignments } }
    }
    // Removing a custom row also strips its values off every history row,
    // and any assignments it fed (a formula bucket, a restatement target) —
    // otherwise both would silently linger, orphaned, under a key no longer
    // listed anywhere for the grid to show or let the user manage.
    case 'REMOVE_CUSTOM_FIELD': {
      if (!s.data) return s
      const customFields = (s.data.customFields || []).filter(f => f.key !== a.key)
      const fieldAssignments = (s.data.fieldAssignments || []).filter(x => x.field !== a.key)
      const strip = rows => (rows || []).map(r => {
        if (!(a.key in r)) return r
        const { [a.key]: _drop, ...rest } = r
        return rest
      })
      const data = {
        ...s.data,
        customFields,
        fieldAssignments,
        reportedIncomeHistory: strip(s.data.reportedIncomeHistory || s.data.incomeHistory),
        balanceHistory: strip(s.data.balanceHistory),
        cashflowHistory: strip(s.data.cashflowHistory),
      }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
      return { ...s, data, ...computed }
    }
    // Replaces every assignment for ONE field with a.assignments in a single
    // go — the "+ add another" list UI (HistoryTableModal's Formulas tab)
    // edits a field's whole assignment set as a unit rather than issuing one
    // dispatch per add/remove. a.assignments: [{ kind, target|formula,
    // bucket, sign }] — field is filled in here, not by the caller.
    case 'SET_ASSIGNMENTS_FOR_FIELD': {
      if (!s.data) return s
      const rest = (s.data.fieldAssignments || []).filter(x => x.field !== a.field)
      const mine = (a.assignments || []).map(x => ({ ...x, field: a.field }))
      const data = { ...s.data, fieldAssignments: [...rest, ...mine] }
      const computed = computeAll(data, s.assumptions, s.meAssumptions, s.scoreWeights, s.arData,
                                  { growthWindowYears: s.growthWindowYears, basis: data.basis })
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
  // A ticker normalized before the reported/normalized split was collapsed
  // into row-level fields still carries the old separate array in storage —
  // fold it onto reportedIncomeHistory BEFORE reportedBase is read below, not
  // just in the migrateStoredData() call further down: that one runs after
  // the active series is already derived from reportedBase, which would mean
  // this one-time migration lands one recompute too late for a manually
  // normalized year to show correctly on the very first load after this
  // change. Idempotent — a no-op once the old array is gone, so calling it
  // again inside migrateStoredData() below is harmless.
  data = migrateNormalizedTable(data)
// reportedIncomeHistory is the ONE income table — the true as-reported
  // baseline, PLUS netProfitNormalized/epsNormalized as real sibling fields
  // on the same rows (materializeIncomeNormalization, right below) whenever
  // normalization applies, same discipline recomputeNormalizedTargets
  // already applies to the other ten fields. There used to also be a
  // separate `incomeHistory` array — the whole row set copied again, just
  // to pre-resolve which of TWO fields (netProfit, eps) the current basis
  // toggle should show — which meant every consumer read a duplicated
  // array instead of the one real table, and (before a separate fix)
  // that duplicate was even being persisted to IndexedDB alongside the
  // original. Gone: every consumer now reads reportedIncomeHistory
  // directly and resolves netProfit/eps — and every other normalizable
  // field — itself via activeValue (dataQuality.js) against data.basis,
  // right where it's actually needed — not a whole array pre-resolved on
  // the chance something might ask.
  // Falls back to a legacy `incomeHistory` for a record from before the
  // reported/active split existed at all.
  const reportedBase = data.reportedIncomeHistory ?? data.incomeHistory ?? []
  // Reported basis by default; normalized only when the user has restated years
  // AND toggled to it. One-offs are never silently adjusted — assessDataQuality
  // now only flags them (dq.flags); correction is manual via reconstruction.
  const dq = assessDataQuality(reportedBase, {
    balanceHistory: data?.balanceHistory || [],
    cashflowHistory: data?.cashflowHistory || [],
  })
  const reportedIncomeHistory = materializeIncomeNormalization(reportedBase)
  const { incomeHistory: _legacyIncomeHistory, ...dataWithoutIncome } = data
  data = { ...dataWithoutIncome, reportedIncomeHistory }
  data = applyDocFacts(migrateStoredData(data), arData)
  // Rewrites every {target}Normalized row from its current reported value
  // and its current custom-row contributors — the one chokepoint every
  // reducer path already funnels through, so a target's Normalized row
  // never needs a separate "keep it in sync" call at each individual
  // mutation site (add/edit/remove/merge a custom row, or re-paste the
  // reported figure itself all land here automatically). See
  // recomputeNormalizedTargets for why this writes a real, stored,
  // inspectable row instead of computing the figure only for display.
  data = recomputeNormalizedTargets(data)
  // Writes every derived formula's (currently just NWC) own reported/
  // Normalized output directly onto its row — see materializeFormulas —
  // AFTER the line above, since a formula's inputs (e.g.
  // tradeReceivablesNormalized) must already exist on the row by the time
  // it combines them.
  data = materializeFormulas(data)
  // Normalize for everything, not a toggle between two equally-weighted
  // views: every restatement in this app is an explicit, evidence-based,
  // user-confirmed correction (a NormalizeModal entry, a restatement-tool
  // mapping) — never an algorithmic guess — so once one exists, it IS the
  // better figure, the same way a Screener paste automatically outranks a
  // Yahoo fallback with no toggle involved. `data.basis` unset (no explicit
  // choice ever made, via the header's Reported/Normalized button)
  // defaults to 'normalized' the moment there's anything to normalize,
  // instead of silently sitting on unrestated figures until someone
  // remembers to click a switch. An EXPLICIT choice — 'reported', to audit
  // the raw as-disclosed numbers, or 'normalized' again after that — always
  // wins outright; this only fills the gap before either was ever chosen.
  if (data.basis == null && hasAnyNormalization(data)) {
    data = { ...data, basis: 'normalized' }
  }
  // The growth window reaches ratios, so every consumer — stage classification,
  // fair value, market expectation, the AI verdict and the dashboard card — uses
  // the same figure the user chose.
  const ratioResult = calcRatios(data, { growthWindowYears: opts.growthWindowYears })
  const sectorType  = detectSectorType(data)
  const stage       = detectStage(data, ratioResult)
  // Every caller of computeAll() routes through here — including
  // PRICE_UPDATE, which fires every 60s from the live-price poller. Without
  // filtering here too, a confirmed peer (SET_CONFIRMED_PEERS) would get
  // silently reverted on the very next price tick, since this bootstrap
  // pass otherwise uses assumptions.peers as-is. No async wait needed for
  // this one (unlike beta/liveRiskFree, which genuinely need a network
  // round-trip and so stay absent from this pass by established design) —
  // it's a synchronous derivation from data already in hand.
  const peers       = activePeers(assumptions.peers, data.confirmedPeers)
  const valuation   = runValuation(data, ratioResult, stage, sectorType, { ...assumptions, peers })
  const technicals  = runTechnicals(data.priceHistory || [])
  const quality     = scoreQuality(data, ratioResult, weights)
  const marketExpectation = runMarketExpectation(data, ratioResult, stage, sectorType, meAssumptions)
  return { data, ratioResult, sectorType, stage, valuation, technicals, quality, marketExpectation }
}

// computeAll no longer produces a separate incomeHistory array at all —
// reportedIncomeHistory is the one income table, with netProfitNormalized/
// epsNormalized as real sibling fields on its own rows (see
// materializeIncomeNormalization). So there's nothing left to strip out for
// income specifically; this is now just the storage chokepoint for trimming
// price history down to what's actually useful to keep — see
// trimPriceHistoryForStorage.
function forStorage(payload) {
  return trimPriceHistoryForStorage(payload)
}

// The FETCH stays unbounded (api/yahoo.js's own period1=epoch, deliberately
// — see its comment: a fixed window used to cap the multiple-band pairing
// at whatever years it allowed, regardless of how far back the pasted
// statement history actually went). But nothing ever calculates with price
// data older than this ticker's OWN statement history reaches, plus a
// margin for a beta/CAGR window that looks slightly past it — so nothing is
// lost by not KEEPING what was fetched only to satisfy that one pairing
// need. At a portfolio of 100-150 tracked tickers, unbounded daily OHLCV
// alone can exceed the entire 40MB cache budget (db.js) on its own — ~85MB
// for 150 tickers at 25 years of history, measured — crowding out hand-
// pasted Screener data (a real, hard-to-reproduce loss) to make room for
// price data that's a lossless, trivial re-fetch, well before either
// should ever be evicted.
function trimPriceHistoryForStorage(payload) {
  const data = payload?.data
  const ph = data?.priceHistory
  if (!ph?.length) return payload
  const incomeYears = (data.reportedIncomeHistory || data.incomeHistory || [])
    .map(r => parseInt(r.year, 10)).filter(Number.isFinite)
  const earliestStatementYear = incomeYears.length ? Math.min(...incomeYears) : null
  // Whichever needs MORE history: 5 years past the earliest pasted
  // statement (covers a beta/CAGR window that looks slightly further back
  // than the statements themselves), or a flat 10-year floor so a ticker
  // with little or no pasted history yet still keeps a reasonable window
  // for technicals/beta rather than being trimmed to almost nothing.
  const cutoffYear = Math.min(
    earliestStatementYear != null ? earliestStatementYear - 5 : Infinity,
    new Date().getFullYear() - 10
  )
  const cutoff = `${cutoffYear}-01-01`
  const trimmed = ph.filter(r => r.date >= cutoff)
  if (trimmed.length === ph.length) return payload
  return { ...payload, data: { ...data, priceHistory: trimmed } }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { lastPulledAt } = useSync()

  // Persist the current (possibly Screener-merged) data whenever it changes, so a
  // pasted-history merge — not just the initial fetch — survives a reload.
  useEffect(() => {
    if (state.status !== 'success' || !state.ticker || !state.data) return
    const payload = { data: state.data, ...computeAll(state.data, {}, {}, {}, state.arData, { growthWindowYears: state.growthWindowYears, basis: state.data.basis }) }
    try { setCached(state.ticker, forStorage(payload)) } catch {}
    // Sync merged financials (they hold pasted Screener history the user built).
    // Pure Yahoo data is re-fetchable, so it isn't synced. Shape must match what
    // setCached writes: { key, data: payload, ... }.
    if (state.data.deepSource === 'screener') {
      const t = state.ticker.toUpperCase()
      queuePush(`financials:${t}`, { key: t, data: forStorage(payload), timestamp: Date.now(), lastAccessed: Date.now() })
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
      setCached(state.ticker, forStorage(payload)).catch(() => {})
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
        // Empty priceHistory here means either a genuinely fresh record or
        // db.js's own staleness sweep cleared it (see sweepStalePriceHistory
        // — it's the one thing safe to drop from an unvisited ticker's
        // cache, since it's a lossless re-fetch unlike the pasted
        // financials). Silently backfill it now that this ticker is
        // actually being opened again. Fire-and-forget, after the dispatch
        // above — the user sees their data immediately; price history fills
        // in a moment later rather than delaying the render. Inlined
        // (rather than calling the refreshPriceHistory callback below)
        // because that callback closes over `state`, which would still be
        // whatever it was on mount here — this uses the ticker already
        // correctly scoped to this call instead.
        if (!cached.data?.priceHistory?.length) {
          fetch(`/api/yahoo?endpoint=all&ticker=${encodeURIComponent(ticker)}`)
            .then(res => res.ok ? res.json() : null)
            .then(json => {
              const fresh = Array.isArray(json?.history) ? json.history : null
              if (fresh?.length) dispatch({ type: 'PRICE_HISTORY_UPDATE', priceHistory: fresh })
            })
            .catch(() => {})
        }
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
      await setCached(ticker, forStorage(payload))
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
    const peers         = activePeers(assumptions.peers, state.data.confirmedPeers)
    const valuation     = runValuation(state.data, state.ratioResult, state.stage, state.sectorType, { ...assumptions, peers })
    const quality       = scoreQuality(state.data, state.ratioResult, weights)
    // liveRiskFree/beta/market live in `assumptions` (valuation.js's WACC reads
    // them from there too) — forwarded here as marketExpectation.js's own
    // trailing `opts` param, since that file merges `meAssumptions`(overrides)
    // onto its DEFAULTS object directly rather than reading raw inputs from it.
    const meOpts = {
      liveRiskFree: assumptions.liveRiskFree ?? null,
      liveErp: assumptions.liveErp ?? null,
      beta: assumptions.beta ?? state.ratioResult?.ratios?.beta?.value ?? null,
      betaMeta: assumptions.betaMeta ?? null,
      market: assumptions.market ?? 'IN',
      peers,
    }
    const me            = runMarketExpectation(state.data, state.ratioResult, state.stage, state.sectorType, meAssumptions, meOpts)
    dispatch({ type: 'RECALC', payload: { valuation, quality, marketExpectation: me, assumptions, scoreWeights: weights, meAssumptions } })
  }, [state])

  // Real peer data + a live risk-free rate for the SAME "required return"/
  // "peer comparison" every valuation lens now shares (see requiredReturn.js,
  // sectorMultiples.js). Centralized here (not scoped to whichever detail
  // panel happens to be open) so every consumer of state.valuation/
  // state.marketExpectation benefits — the dashboard's summary badges
  // included, not just the Valuation/Market Expectation panels. Both fetches
  // are already cache/dedup-safe (peersClient: 30-min TTL; riskFreeClient:
  // shared module state + hour-long retry lockout), so this doesn't double up
  // against useEstimate.js's own independent fetch of the same data for App
  // Target/Justified Multiple. First paint always uses the hardcoded
  // fallbacks (this hasn't resolved yet); the SET_LIVE_INPUTS dispatch below
  // is a second, later render once it has — same two-pass pattern
  // useEstimate.js already exhibits today, just extended to Fair Value and
  // Market Expectation too.
  useEffect(() => {
    if (state.status !== 'success' || !state.ticker) return
    let cancelled = false
    const market = state.data?.currency === 'INR' ? 'IN' : 'US'
    // assumptions.peers is the full CANDIDATE pool (NSE sectoral index
    // constituents merged with this browser's own same-sector analysis
    // history, see peersClient.js's fetchPeerCandidates) — everything a
    // user could possibly confirm via PeerSelectModal, not just the ones
    // already confirmed. activePeers() below filters it down to
    // data.confirmedPeers at the point of use. A confirmed candidate that
    // isn't in this pool would filter to nothing, so this has to be the
    // full pool, not some narrower list.
    // state.ticker is the RAW user input ("RELIANCE") — the exchange-
    // suffixed symbol fetchSectorConstituents needs to check NSE
    // membership only lives on state.data.ticker (set by normalizeYahoo,
    // the same resolved form fetchTicker's resolveTicker() produced).
    // Passing the raw form meant a bare "RELIANCE" search never carried
    // .NS, fetchSectorConstituents' own-market guard rejected it before
    // ever calling /api/nseIndices, and the peer pipeline silently ran on
    // zero NSE candidates for anyone who hadn't typed the suffix by hand.
    const peerTicker = state.data?.ticker || state.ticker
    Promise.all([
      fetchPeerCandidates({ ticker: peerTicker, meta: state.data?.meta, sectorType: state.sectorType }),
      getRiskFreeRate({ market, userKey: getAiKey() }),
      getEquityRiskPremium({ market, userKey: getAiKey() }),
    ]).then(([peers, rf, erp]) => {
      if (cancelled) return
      dispatch({ type: 'SET_LIVE_INPUTS', peers, liveRiskFree: rf?.rate ?? null, liveErp: erp?.erp ?? null, market })
    })
    return () => { cancelled = true }
  }, [state.ticker, state.status])

  // This app's own regression beta (src/engine/beta.js) — stock monthly
  // returns against the index's, over `state.betaWindowYears`. Separate
  // from the peers/risk-free/ERP effect above: it needs
  // state.data.priceHistory (not guaranteed ready at the exact same
  // instant on every load path) and re-fires on its own trigger
  // (betaWindowYears, via BetaWindowPicker) independent of ticker load.
  // `result.beta` is null when the regression declines (too little
  // overlapping history) — every CAPM consumer's `assumptions.beta ??
  // ratios.beta.value` already falls back to Yahoo's reported figure in
  // that case, so this dispatches null deliberately rather than skipping.
  useEffect(() => {
    if (state.status !== 'success' || !state.ticker || !state.data?.priceHistory?.length) return
    let cancelled = false
    const indian = state.data?.currency === 'INR'
    const indexSymbol = indian ? '^NSEI' : '^GSPC'
    const indexLabel = indian ? 'Nifty 50' : 'the S&P 500'
    fetchIndexHistory(indexSymbol, state.betaWindowYears).then(indexHistory => {
      if (cancelled) return
      const result = computeBeta(state.data.priceHistory, indexHistory, { years: state.betaWindowYears, indexLabel })
      dispatch({ type: 'SET_LIVE_BETA', beta: result?.beta ?? null, betaMeta: result })
    })
    return () => { cancelled = true }
  }, [state.ticker, state.status, state.data?.priceHistory, state.betaWindowYears])

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
    const peers              = activePeers(state.assumptions.peers, state.data.confirmedPeers)
    const valuation         = runValuation(state.data, state.ratioResult, stage, state.sectorType, { ...state.assumptions, peers })
    const marketExpectation = runMarketExpectation(state.data, state.ratioResult, stage, state.sectorType, state.meAssumptions, {
      liveRiskFree: state.assumptions.liveRiskFree ?? null,
      liveErp: state.assumptions.liveErp ?? null,
      beta: state.assumptions.beta ?? state.ratioResult?.ratios?.beta?.value ?? null,
      betaMeta: state.assumptions.betaMeta ?? null,
      market: state.assumptions.market ?? 'IN',
      peers,
    })
    dispatch({ type: 'SET_STAGE', stage, valuation, marketExpectation })
  }, [state])

  // Re-fetch peers on demand (rather than waiting for the next ticker load)
  // — used after PeerSelectModal finishes warming some peer tickers'
  // IndexedDB cache, so their real EV/Revenue/EV/FCF/EV/EBITDA (see
  // peersClient.js's enrichFromCache) reach the live valuation/market-
  // expectation numbers immediately instead of only on the next visit.
  // clearPeersCache() forces fetchPeerCandidates() past its own in-memory
  // caches; the underlying /api/yahoo and /api/nseIndices calls are still
  // CDN-cached server-side, so this doesn't add a real new upstream hit.
  const refreshPeers = useCallback(async () => {
    if (!state.ticker || !state.data) return
    clearPeersCache()
    const rawPeers = await fetchPeerCandidates({ ticker: state.data?.ticker || state.ticker, meta: state.data?.meta, sectorType: state.sectorType })
    const assumptions = { ...state.assumptions, peers: rawPeers }   // full raw candidate pool, confirmations applied fresh below
    const peers = activePeers(rawPeers, state.data.confirmedPeers)
    const valuation = runValuation(state.data, state.ratioResult, state.stage, state.sectorType, { ...assumptions, peers })
    const marketExpectation = runMarketExpectation(state.data, state.ratioResult, state.stage, state.sectorType, state.meAssumptions, {
      liveRiskFree: assumptions.liveRiskFree ?? null,
      liveErp: assumptions.liveErp ?? null,
      beta: assumptions.beta ?? state.ratioResult?.ratios?.beta?.value ?? null,
      betaMeta: assumptions.betaMeta ?? null,
      market: assumptions.market ?? 'IN',
      peers,
    })
    dispatch({ type: 'RECALC', payload: { valuation, marketExpectation, assumptions } })
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

  const setPeerWeight = useCallback((weight) => {
    dispatch({ type: 'SET_PEER_WEIGHT', weight: Math.max(0, Math.min(1, weight ?? 0)) })
  }, [])

  const setBetaWindowYears = useCallback((years) => {
    dispatch({ type: 'SET_BETA_WINDOW', years: years ?? 5 })
  }, [])

  // Mark/unmark a peer as confirmed for THIS ticker — persisted on
  // data.confirmedPeers, never touches the confirmed ticker's own cached
  // record. Opt-in: a symbol only counts toward peer-median multiples once
  // explicitly confirmed here. See activePeers above for where that's
  // actually applied.
  const togglePeerConfirmation = useCallback((symbol) => {
    const current = state.data?.confirmedPeers || []
    const next = current.includes(symbol) ? current.filter(s => s !== symbol) : [...current, symbol]
    dispatch({ type: 'SET_CONFIRMED_PEERS', confirmedPeers: next })
  }, [state.data])

  const setBasis = useCallback((basis) => {
    dispatch({ type: 'SET_BASIS', basis })
  }, [])

  // overwrite: true (default) always sets the value — right for Excerpt
  // mode's single, deliberate correction. Table mode passes its own Gap
  // fill/Replace choice explicitly, same pattern as every other bulk-paste
  // surface.
  const applyNormalization = useCallback((rows, overwrite = true) => {
    dispatch({ type: 'APPLY_NORMALIZATION', rows, overwrite })
  }, [])

  // The editable data table's direct-cell commit — see EDIT_HISTORY_CELLS.
  // edits: [{ year, field, value }], value null clears the cell.
  const editHistoryCells = useCallback((tableType, edits) => {
    dispatch({ type: 'EDIT_HISTORY_CELLS', tableType, edits })
  }, [])

  // field: { key, label, table } — a plain reference row. assignments
  // (optional): [{ kind, target|formula, bucket, sign }], wired in at
  // creation. See ADD_CUSTOM_FIELD.
  const addCustomField = useCallback((field, assignments) => {
    dispatch({ type: 'ADD_CUSTOM_FIELD', field, assignments })
  }, [])

  const removeCustomField = useCallback((key) => {
    dispatch({ type: 'REMOVE_CUSTOM_FIELD', key })
  }, [])

  // One or more named rows created in a single go, each with its own values
  // — NormalizeModal's restatement paste, which can map several distinct
  // line items to targets at once. See ADD_CUSTOM_FIELDS_BATCH.
  const addCustomFieldsBatch = useCallback((fields, edits, assignments) => {
    dispatch({ type: 'ADD_CUSTOM_FIELDS_BATCH', fields, edits, assignments })
  }, [])

  // Replace a field's entire assignment list in one go — what does this row
  // feed, into which bucket(s), with what sign. See SET_ASSIGNMENTS_FOR_FIELD.
  const setAssignmentsForField = useCallback((field, assignments) => {
    dispatch({ type: 'SET_ASSIGNMENTS_FOR_FIELD', field, assignments })
  }, [])

  // Combine several custom rows into one. opts: { mode: 'new', newField } to
  // create a fresh row, or { mode: 'existing', destKey } to fold the rest
  // into one of the rows being merged. See MERGE_CUSTOM_FIELDS.
  const mergeCustomFields = useCallback((table, sourceKeys, opts) => {
    dispatch({ type: 'MERGE_CUSTOM_FIELDS', table, sourceKeys, ...opts })
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

  // Re-fetch ONLY Yahoo's price history and drop it in over the existing
  // series — never touches incomeHistory/balanceHistory/cashflowHistory, so
  // a manually-built Screener history survives this untouched. This exists
  // specifically because resetTicker() (delete the whole cached record, then
  // re-fetch everything) turned out to be unsafe for exactly the tickers
  // this needs testing on: the fresh fetch re-runs the automatic Screener
  // scrape, which is routinely blocked by Cloudflare, and on failure falls
  // back to Yahoo-only — silently discarding real, hand-curated paste work
  // with no error shown. A price-history refresh has no such risk: Yahoo is
  // the only source for it either way.
  const refreshPriceHistory = useCallback(async () => {
    const ticker = state.data?.ticker || state.ticker
    if (!ticker) return { ok: false }
    try {
      const res = await fetch(`/api/yahoo?endpoint=all&ticker=${encodeURIComponent(ticker)}`)
      if (!res.ok) return { ok: false }
      const json = await res.json()
      // api/yahoo.js already flattens chart()'s {quotes:[...]} into the same
      // {date,open,high,low,close,adjClose,volume} shape priceHistory uses.
      const fresh = Array.isArray(json?.history) ? json.history : null
      if (!fresh?.length) return { ok: false }
      dispatch({ type: 'PRICE_HISTORY_UPDATE', priceHistory: fresh })
      return { ok: true, count: fresh.length }
    } catch {
      return { ok: false }
    }
  }, [state.ticker, state.data])

  return (
    <AppContext.Provider value={{
      state, load, recalc, overrideStage, reset, resetTicker, clearAllData, applyPastedTable, setQualInputs, dismissGap, setGrowthWindowYears, setBetaWindowYears, setBasis, applyNormalization, editHistoryCells, addCustomField, removeCustomField, addCustomFieldsBatch, mergeCustomFields, setAssignmentsForField, refreshPrice, refreshPriceHistory, refreshPeers, togglePeerConfirmation, setPeerWeight
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
