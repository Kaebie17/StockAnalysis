

import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react'
import { fetchTicker } from '../api/orchestrator.js'
import { normalize, applyDocFacts, migrateStoredData, migrateNormalizedTable } from '../engine/normalize.js'
import { calcRatios } from '../engine/ratios.js'
import { runValuation } from '../engine/valuation.js'
import { runTechnicals } from '../engine/technicals.js'
import { assessDataQuality, computeNormalizedRow } from '../engine/dataQuality.js'
import { METRICS } from '../engine/metrics.js'
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
      // (reportedIncomeHistory), normalized netProfit/eps computed live per
      // row by computeAll (see computeNormalizedRow). Merge onto the
      // persisted reported baseline, not onto s.data.incomeHistory — the
      // active series can differ from it when basis is 'normalized', and
      // merging a fresh paste onto the ACTIVE (possibly already-normalized)
      // series would bake normalization into what's supposed to be the
      // untouched reported source. Balance/cashflow have no such split.
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
    // "paste any statement" mode. Unlike APPLY_NORMALIZATION above (net
    // profit/EPS only, always income), a restatement can target any of the
    // ten fields in normalizationTargets.js, living on any of the three
    // statements. `a.adjustments`: one entry per pasted row the user actually
    // mapped to a target — { target, year, amount } — amount already signed
    // (+/- already applied by the UI). Multiple rows can share a (target,
    // year): they sum here, not overwrite each other — the one-to-many case
    // (a restructuring charge AND a litigation settlement both landing on
    // operatingProfit for the same year add together into one total).
    //
    // `a.mode` ('accumulate' | 'replace', default 'accumulate') governs a
    // DIFFERENT thing from the +/- sign above: the sign decides whether one
    // pasted row adds to or subtracts from the target WITHIN this paste;
    // this mode decides what happens to whatever RestatementsTotal is
    // already stored from an earlier, separate apply. Accumulate adds this
    // dispatch's total on top of it — the correct default, since a
    // restructuring charge found today and a litigation settlement found
    // next week should both count, not have the second silently erase the
    // first. Replace discards the prior total and starts fresh with only
    // this paste's contribution, for when the user genuinely wants to redo
    // a correction rather than layer onto it.
    case 'APPLY_RESTATEMENTS': {
      if (!s.data) return s
      const accumulate = a.mode !== 'replace'
      const totals = {}   // totals[target][year] = summed signed amount (this dispatch only)
      for (const adj of (a.adjustments || [])) {
        if (!adj?.target || !adj?.year || adj.amount == null || !isFinite(adj.amount)) continue
        totals[adj.target] ??= {}
        totals[adj.target][adj.year] = (totals[adj.target][adj.year] || 0) + adj.amount
      }

      let data = { ...s.data }
      // Route each target's totals to the array it actually lives on — an
      // income-statement target (operatingProfit, interest, tax, ...) writes
      // onto reportedIncomeHistory, a balance-sheet target onto
      // balanceHistory, a cash-flow target onto cashflowHistory. Never
      // assumes income the way the netProfit-only path above always could.
      //
      // `target` is no longer restricted to normalizationTargets.js's fixed
      // ten — NormalizeModal's dropdown (Part C) now also offers any other
      // metrics.js field with data, plus any custom row added via the data
      // table, so its table has to be resolved the same two ways: a real
      // metrics.js key knows its own table directly; a custom field's table
      // was recorded on it when it was created (HistoryTableModal.jsx).
      for (const [target, byYear] of Object.entries(totals)) {
        const table = METRICS[target]?.table
          ?? (data.customFields || []).find(f => f.key === target)?.table
        if (!table) continue
        const histKey = table === 'income' ? 'reportedIncomeHistory'
          : table === 'balance' ? 'balanceHistory' : 'cashflowHistory'
        const base = data[histKey] || []
        data[histKey] = base.map(row => {
          const thisDispatch = byYear[String(row.year)]
          if (thisDispatch == null) return row
          const reportedVal = row?.[target]?.value
          if (reportedVal == null) return row   // nothing reported to restate against
          const priorTotal = accumulate ? (row?.[`${target}RestatementsTotal`]?.value ?? 0) : 0
          const total = priorTotal + thisDispatch
          return {
            ...row,
            [`${target}RestatementsTotal`]: { value: total, adjusted: true },
            [`${target}Normalized`]: { value: reportedVal + total, adjusted: true },
          }
        })
      }
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
          byYear[y] = { ...byYear[y], [e.field]: { value: e.value, status: 'pasted', formula: null } }
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
    case 'ADD_CUSTOM_FIELD': {
      if (!s.data) return s
      const customFields = [...(s.data.customFields || []), a.field]
      return { ...s, data: { ...s.data, customFields } }
    }
    // Removing a custom row also strips its values off every history row —
    // otherwise the values would silently linger, orphaned, under a key no
    // longer listed anywhere for the grid to show or let the user manage.
    case 'REMOVE_CUSTOM_FIELD': {
      if (!s.data) return s
      const customFields = (s.data.customFields || []).filter(f => f.key !== a.key)
      const strip = rows => (rows || []).map(r => {
        if (!(a.key in r)) return r
        const { [a.key]: _drop, ...rest } = r
        return rest
      })
      const data = {
        ...s.data,
        customFields,
        reportedIncomeHistory: strip(s.data.reportedIncomeHistory || s.data.incomeHistory),
        incomeHistory: strip(s.data.incomeHistory),
        balanceHistory: strip(s.data.balanceHistory),
        cashflowHistory: strip(s.data.cashflowHistory),
      }
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
// Reported basis by default; normalized only when the user has restated years
  // AND toggled to it. One-offs are never silently adjusted — assessDataQuality
  // now only flags them (dq.flags); correction is manual via reconstruction.
  const dq = assessDataQuality(data?.incomeHistory || [], {
    balanceHistory: data?.balanceHistory || [],
    cashflowHistory: data?.cashflowHistory || [],
  })
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
  // The ACTIVE series always re-derives from reportedBase (never from the
  // previous call's incomeHistory), so toggling the basis back and forth is
  // always correct regardless of how many recomputes happened while
  // normalized. There is no second table any more — normalized netProfit/eps
  // are computed live, per row, from that SAME row's own fields
  // (computeNormalizedRow: a manual netProfitNormalized/epsNormalized
  // override from NormalizeModal if present, else derived from the
  // exceptional-items group Screener discloses, else unchanged). Every other
  // field always comes straight from reportedBase, untouched — normalization
  // in this app only ever adjusts netProfit and eps.
  const income = opts.basis === 'normalized'
    ? reportedBase.map(row => {
        const n = computeNormalizedRow(row)
        return n ? { ...row, netProfit: n.netProfit, eps: n.eps } : row
      })
    : reportedBase
  data = { ...data, incomeHistory: income, reportedIncomeHistory: reportedBase }
  data = applyDocFacts(migrateStoredData(data), arData)
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

  // adjustments: [{ target, year, amount }] — one per pasted restatement row
  // the user mapped to a target field, amount already signed by the +/-
  // toggle. mode: 'accumulate' (default) adds onto whatever's already
  // stored for that (target, year) from an earlier apply; 'replace' starts
  // fresh with only this dispatch's total. See APPLY_RESTATEMENTS.
  const applyRestatements = useCallback((adjustments, mode = 'accumulate') => {
    dispatch({ type: 'APPLY_RESTATEMENTS', adjustments, mode })
  }, [])

  // The editable data table's direct-cell commit — see EDIT_HISTORY_CELLS.
  // edits: [{ year, field, value }], value null clears the cell.
  const editHistoryCells = useCallback((tableType, edits) => {
    dispatch({ type: 'EDIT_HISTORY_CELLS', tableType, edits })
  }, [])

  // field: { key, label, table, target, sign } — target/sign null for a
  // plain reference row. See ADD_CUSTOM_FIELD.
  const addCustomField = useCallback((field) => {
    dispatch({ type: 'ADD_CUSTOM_FIELD', field })
  }, [])

  const removeCustomField = useCallback((key) => {
    dispatch({ type: 'REMOVE_CUSTOM_FIELD', key })
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
      state, load, recalc, overrideStage, reset, resetTicker, clearAllData, applyPastedTable, setQualInputs, dismissGap, setGrowthWindowYears, setBetaWindowYears, setBasis, applyNormalization, applyRestatements, editHistoryCells, addCustomField, removeCustomField, refreshPrice, refreshPriceHistory, refreshPeers, togglePeerConfirmation, setPeerWeight
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
