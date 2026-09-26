/**
 * src/api/peersClient.js — similar companies and what they trade at.
 *
 * Second anchor for the multiple. A company's own history can't see a sector-wide
 * re-rating: if every NBFC de-rates together, this stock's past looks like a
 * bargain right up until it isn't. Peers are the only view that distinguishes
 * "the market changed its mind about this company" from "…about this industry",
 * and those two have very different odds of reverting.
 *
 * Candidates come from two automatic sources — NSE's own sectoral index
 * constituents and this browser's own analysis history in the same sector
 * (see fetchPeerCandidates below) — never Yahoo's recommendationsBySymbol,
 * which is effectively empty for Indian tickers. Neither source is cached
 * across a full session by itself (the server already CDN-caches the NSE
 * fetch for a day; the own-cache scan is a cheap local IndexedDB read every
 * time), only the NSE constituent list gets a short in-module cache below,
 * shared across every stock in the same sector.
 */

import { getCached, listCachedTickers, listClassifications, listPeerRelationshipsFor, savePeerRelationship, getPeerSuggestions, savePeerSuggestions } from '../utils/db.js'
import { sectorIndexFor, NSE_SECTORAL_INDEX_KEYS } from './marketRegime.js'
import { scoreBusinessModelMatch, financialsFromRatioResult } from '../engine/peerCompatibility.js'
import { buildWaterfallForecast } from '../engine/estimate.js'

// EV/Revenue, EV/FCFF, EV/EBITDA, P/E and P/B all need each peer's own
// financials, not just a live quote — and every one of them is read off
// each peer's OWN cached ratioResult (db.js's getCached/setCached) rather
// than any live network call. Reused for free: if a peer ticker has
// ALREADY been analyzed in this app — this stock's own history, or as
// someone else's peer before — its full financials are already sitting in
// this browser's IndexedDB, including any richer, longer-history Screener
// data if it was ever pasted for that ticker (the cache doesn't track
// source, it just holds whatever's most current). No network call either
// way: a cache hit reads local IndexedDB; a miss just leaves that one peer
// without these fields — peerBand() already filters out missing/
// non-positive values, so an unresolved peer simply doesn't contribute to
// that particular median rather than breaking anything. Coverage grows for
// free as more tickers get analyzed over time — including by deliberately
// opening a peer ticker once to "warm" it, if you want a specific sector's
// peer coverage sooner than that (see PeerSelectModal.jsx for the
// deliberate version of that).
async function enrichFromCache(peers) {
  return Promise.all(peers.map(async p => {
    try {
      const rec = await getCached(p.symbol)
      // `cached` is whether this ticker has EVER been analyzed in this app
      // — distinct from whether these fields actually computed (a cached
      // record might still lack, say, FCF). PeerSelectModal and the
      // auto-open trigger both need the former: "is there anything to gain
      // by loading this peer" is a different question from "did every
      // multiple resolve."
      if (!rec) return { ...p, cached: false }
      const r = rec.ratioResult
      // r.ev, not a hand-reconstructed marketCap+debt-cash — ratios.js
      // already computes and stores enterprise value on every ratioResult,
      // the same figure the rest of the app trusts; recomputing a parallel
      // version here risked silently drifting from it. Same reasoning for
      // pe/pb: ratios.js already computes them (price ÷ EPS, price ÷ book
      // value per share) for every analyzed ticker — reading that instead
      // of a live Yahoo quote means peer P/E and P/B bands need no network
      // call at all, same as the EV multiples below.
      const evRevenue = (r?.ev > 0 && r.revenue > 0) ? r.ev / r.revenue : null
      const evEbitda    = (r?.ev > 0 && r.ebitda > 0)  ? r.ev / r.ebitda  : null
      const pe = r?.ratios?.pe?.value > 0 ? r.ratios.pe.value : null
      const pb = r?.ratios?.pb?.value > 0 ? r.ratios.pb.value : null
      const revCagr = r?.ratios?.revCagr?.value ?? null
      // FCFF (Free Cash Flow to Firm), not the old CFO-CapEx-based EV/FCF —
      // read straight off this peer's own ratioResult.ratios.evFcff, the SAME
      // ratio currentSnapshot.js now computes for every analyzed ticker (see
      // its own note on why FCFF, not levered FCF, is what pairs correctly
      // with an EV-based multiple). No re-derivation from raw statement rows
      // needed here — it's already sitting in this exact cache entry.
      const evFcff = r?.ratios?.evFcff?.value > 0 ? r.ratios.evFcff.value : null
      // A genuine, self-computed forward P/E — the SAME machinery that
      // projects the target's own forward EPS (buildWaterfallForecast: this
      // peer's own revenue-growth trend, its own margin trend, its own tax
      // rate, all read off its own multi-year history), run on this peer's
      // cached data instead. No analyst estimate anywhere in it. Preferred
      // over Yahoo's own analyst-consensus forwardPE (meta.forwardPe,
      // coverage-dependent and this app can't verify it) — that stays only
      // as the fallback for a peer this can't be computed for (e.g. too
      // little margin history), same "decline to a cruder source, never
      // silently" pattern this codebase uses everywhere else.
      const selfForecast = rec.data ? buildWaterfallForecast(rec.data) : null
      const selfForwardEps = selfForecast?.eps > 0 ? selfForecast.eps : null
      const selfForwardPe = (selfForwardEps > 0 && r?.price > 0) ? r.price / selfForwardEps : null
      const yahooForwardPe = rec.data?.meta?.forwardPe > 0 ? rec.data.meta.forwardPe : null
      const forwardPe = selfForwardPe ?? yahooForwardPe
      const forwardPeSource = selfForwardPe != null ? 'self' : yahooForwardPe != null ? 'yahoo' : null
      // The ONE shared path for "ratioResult → eligibility-relevant financial
      // summary" (peerCompatibility.js) — used here for every peer, and
      // separately for the target wherever screenedPeerBand() is called.
      // Previously this function re-derived the same four fields inline with
      // its own expression, a second copy of the same read that could
      // silently drift from the shared one if either changed without the
      // other. netDebtRatio's own formula label (currentSnapshot.js)
      // confirms it IS net debt/EBITDA, not a generic leverage ratio.
      const fin = financialsFromRatioResult(r)
      // Passed through so a cached candidate can be classified without a
      // second DB read — PeerSelectModal's per-candidate classify button
      // needs the same sector/industry/businessSummary inputs the target
      // ticker's own classify flow uses.
      const meta = rec.data?.meta ? {
        sector: rec.data.meta.sector, industry: rec.data.meta.industry, businessSummary: rec.data.meta.businessSummary,
      } : null
      return { ...p, cached: true, evRevenue, evFcff, evEbitda, pe, pb, forwardPe, forwardPeSource, revCagr, ...fin, meta }
    } catch {
      return { ...p, cached: false }   // a read failure just leaves this one peer without the extra fields
    }
  }))
}

// NSE Indices Ltd's own sectoral index constituents (api/nseIndices.js) —
// real, exchange-maintained peer candidates, unlike Yahoo's
// recommendationsBySymbol (documented weak international coverage,
// confirmed empty for RELIANCE.NS). Cached by SECTOR SLUG, not by ticker
// — every stock in the same sector shares the same constituent list, so
// caching per-parent-ticker would refetch/reparse the identical data for
// each one. The server (api/nseIndices.js) already caches the raw fetch
// for a day at the CDN; this just avoids redundant client-side re-fetches
// of that same cached response within a session.
const sectorCache = new Map()   // csvSlug -> { at, constituents }
const SECTOR_TTL_MS = 60 * 60 * 1000   // shorter than the server's day-long cache is fine to keep this simple

async function fetchIndexCsv(csvSlug) {
  const hit = sectorCache.get(csvSlug)
  if (hit && Date.now() - hit.at < SECTOR_TTL_MS) return hit.constituents
  // A failed request (non-OK, bad JSON, network error) is retried once and is
  // never cached — caching its empty result made a transient failure look like
  // "this index has no members" for an hour, so the ticker's peers vanished.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`/api/nseIndices?index=${encodeURIComponent(csvSlug)}`)
      const j = r.ok ? await r.json().catch(() => null) : null
      if (Array.isArray(j?.constituents)) {
        sectorCache.set(csvSlug, { at: Date.now(), constituents: j.constituents })
        return j.constituents
      }
    } catch { /* retry */ }
  }
  return []
}

export async function fetchSectorConstituents(excludeTicker) {
  const t = String(excludeTicker || '').trim().toUpperCase()
  // NSE only lists NSE-listed (.NS) and dual-listed-on-BSE (.BO) companies
  // — a US ticker or anything else can never appear in these CSVs, so
  // decline before firing ten (cheap, cached, but pointless) requests on
  // every non-Indian ticker's load.
  if (!/\.(NS|BO)$/.test(t)) return []
  const bareTicker = t.replace(/\.(NS|BO)$/, '')

  // Real NSE index MEMBERSHIP, not a text-classification guess: check
  // every one of NSE's 28 published sectoral indices (small, CDN- and
  // session-cached CSVs, cheap to check in parallel) for the ticker's own
  // row, rather than inferring "which one index" from Yahoo's free-text
  // sector/industry via a hand-maintained keyword regex (marketRegime.js's
  // sectorIndexFor — kept for its own, lower-stakes use there, see that
  // file). A regex is a judgment call sitting between two data sources
  // with no guaranteed correspondence between their wording; checking
  // real membership has no such gap — the ticker either is or isn't a row
  // in a given index's own published list. (An earlier version of this
  // checked only ten hand-picked sectors and used the broader "Nifty
  // Energy" theme in place of a dedicated Oil & Gas index — both were
  // guesses that turned out wrong: NSE publishes 28 real sectoral
  // indices, not 10, and Energy isn't even one of them.)
  const perIndex = await Promise.all(NSE_SECTORAL_INDEX_KEYS.map(fetchIndexCsv))

  const matches = new Map()   // symbol -> constituent row
  for (const constituents of perIndex) {
    const ownRow = constituents.find(c => String(c.symbol || '').trim().toUpperCase() === bareTicker)
    if (!ownRow) continue
    // NSE's own per-company Industry column (already in every row of the
    // CSV, no extra call) is a real, finer classification than "member of
    // this Nifty index": Nifty Energy alone spans Oil Gas & Consumable
    // Fuels, Power AND Capital Goods — three different businesses that
    // happen to share one index (confirmed live: RELIANCE's own row is
    // tagged "Oil Gas & Consumable Fuels", same CSV that also lists NTPC
    // as "Power" and Siemens as "Capital Goods"). Narrow to constituents
    // sharing the ticker's own Industry value, not the whole index.
    for (const c of constituents) {
      if (c.industry === ownRow.industry) matches.set(c.symbol, c)
    }
  }

  // Not a member of ANY NSE sectoral index at all — a real, disclosed gap
  // (below the index's market-cap cutoff, a sector NSE doesn't publish a
  // dedicated index for, or a BSE-only listing) rather than something to
  // paper over with a looser guess.
  if (matches.size === 0) return []

  // NSE's CSV symbols are bare (e.g. "BPCL") — this app's convention is
  // exchange-suffixed (e.g. "BPCL.NS"), same as every other ticker.
  const mapped = [...matches.values()].map(c => ({ symbol: `${c.symbol}.NS`, name: c.name, industry: c.industry }))
  const withCache = await enrichFromCache(mapped)
  return withCache.filter(p => p.symbol !== t)
}

// Every ticker this browser has ever analyzed, matched against the CURRENT
// stock's sector — the real fallback for what NSE index MEMBERSHIP
// (#fetchSectorConstituents above) structurally can't cover at all: a
// BSE-only comparable is never a row in any NSE CSV, no matter how
// thoroughly the user has researched it independently, so there's no
// membership check to run for it. A stock the user has personally
// analyzed — under whatever ticker/exchange suffix — gets a real chance
// to surface as a peer here instead.
//
// This is the one place in the peer pipeline that still uses
// sectorIndexFor's text-classification regex, not real membership data —
// unavoidably: a cached candidate with no NSE index row of its own (that's
// the whole reason it needs this fallback) has no NSE Industry label to
// check against either. Matched on csvSlug (not on sectorType, which is a
// coarse valuation-methodology bucket — checked stage.js directly:
// STANDARD/BANK/NBFC/INSURANCE/YIELD/HOLDING/REALTY/CYCLICAL/
// CAPITAL_INTENSIVE — where RELIANCE and an unrelated IT company could
// both land in STANDARD). Both sides must resolve to a KNOWN bucket, so
// this declines for a sector SECTOR_INDICES doesn't cover at all, same as
// fetchSectorConstituents — it doesn't guess at a looser match just
// because the precise one came up empty. Being the lower-confidence,
// text-matched tier is exactly why PeerSelectModal tags these 'own-cache'
// rather than showing an NSE industry label.
async function fetchCachedSameSector(meta, sectorType, excludeTicker) {
  const target = sectorIndexFor(meta, sectorType)
  if (!target) return []

  const t = String(excludeTicker || '').trim().toUpperCase()
  let all
  try {
    all = await listCachedTickers()
  } catch {
    return []
  }

  const matches = all.filter(rec => {
    if (rec.symbol === t) return false
    // This is a peer list for an NSE/BSE-listed company — a candidate that
    // isn't itself Indian-listed has no business here no matter what its
    // Yahoo sector text happens to match. sectorIndexFor's regex has no
    // exchange awareness at all (it's a text match on Yahoo's sector/
    // industry labels, e.g. "Consumer Electronics" or "Consumer Cyclical"
    // both trivially match on the word "consumer"), so this has to be
    // enforced here explicitly, not assumed.
    if (!/\.(NS|BO)$/i.test(rec.symbol || '')) return false
    const recIdx = sectorIndexFor(rec.meta, rec.sectorType)
    return recIdx?.csvSlug === target.csvSlug
  })

  const mapped = matches.map(rec => ({ symbol: rec.symbol, name: rec.name, industry: rec.meta?.industry || null }))
  return enrichFromCache(mapped)
}

// Peer relationships already established for this ticker — via a prior
// AI-suggest run (this ticker's own, or the OTHER side's: confirming Kaynes
// as Dixon's peer writes ONE record, so opening Kaynes later finds it here
// too, no re-discovery needed) — src/utils/db.js's peerRelationships store.
// Free: no AI call, no network beyond enrichFromCache's own cached-ratio
// reads.
async function fetchKnownRelationships(excludeTicker) {
  const t = String(excludeTicker || '').trim().toUpperCase()
  let rels
  try { rels = await listPeerRelationshipsFor(t) } catch { return [] }
  const mapped = rels.map(r => ({
    symbol: r.peerSymbol, name: r.peerName || r.peerSymbol,
    relationship: r.relationshipType || null, overlap: r.overlap || [], rationale: r.rationale || '',
    aiConfidence: r.confidence || null,
  }))
  return enrichFromCache(mapped)
}

// Merges NSE's real sectoral constituents, this browser's own analysis
// history in the same sector, and any peer relationship already established
// for this ticker (AI-suggested and confirmed, on either side of the pair).
// `classification` (this ticker's OWN business-model record, or null) is
// used only to TAG candidates that already happen to have their own
// classification too — enrichment, not discovery: see suggestPeers() below
// for the actual discovery step, which is a separate, explicit AI call
// (never triggered automatically here) rather than something this function
// runs on its own.
export async function fetchPeerCandidates({ ticker, meta, sectorType, classification } = {}) {
  const t = String(ticker || '').trim().toUpperCase()
  const [nse, ownCache, known] = await Promise.all([
    fetchSectorConstituents(ticker),
    fetchCachedSameSector(meta, sectorType, ticker),
    fetchKnownRelationships(ticker),
  ])

  const bySymbol = new Map()
  for (const p of nse) bySymbol.set(p.symbol, { ...p, sources: ['nse-index'] })
  for (const p of ownCache) {
    const existing = bySymbol.get(p.symbol)
    if (existing) {
      bySymbol.set(p.symbol, { ...existing, ...p, sources: [...existing.sources, 'own-cache'] })
    } else {
      bySymbol.set(p.symbol, { ...p, sources: ['own-cache'] })
    }
  }
  for (const p of known) {
    const existing = bySymbol.get(p.symbol)
    bySymbol.set(p.symbol, existing
      ? { ...existing, ...p, sources: [...existing.sources, 'known-relationship'] }
      : { ...p, sources: ['known-relationship'] })
  }

  // Tag any candidate that already has its OWN classification in the
  // central store, purely for display (a businessRelationship badge) — this
  // never adds a new candidate to the list, only annotates ones already
  // surfaced by the three sources above.
  if (classification?.businessModel) {
    let allClassifications = []
    try { allClassifications = await listClassifications() } catch { /* no annotation, not fatal */ }
    if (allClassifications.length) {
      const bySymbolClassification = new Map(allClassifications.map(rec => [rec.symbol, rec]))
      for (const [symbol, p] of bySymbol) {
        const rec = bySymbolClassification.get(symbol)
        if (!rec) continue
        const match = scoreBusinessModelMatch(classification, rec)
        if (match) bySymbol.set(symbol, { ...p, businessRelationship: match.businessRelationship, businessModelScore: match.businessModelScore, reasons: match.reasons })
      }
    }
  }

  // Belt-and-suspenders: every individual source already excludes the
  // target's own symbol, but a mismatch anywhere upstream (case, a resolved
  // vs. raw ticker string) shouldn't be able to leak the company through as
  // its own "peer" — guaranteed here regardless of which source it came from.
  bySymbol.delete(t)

  return [...bySymbol.values()]
}

// A symbol's own real NSE Industry label — every row fetchSectorConstituents
// returns for a given ticker already carries that ticker's own Industry
// string (the function filters its whole result down to rows sharing it),
// so reading it off the first result IS the target's own label. Used as the
// classification-input source everywhere in this feature instead of Yahoo's
// sector/industry, which this app already treats as a lower-confidence
// fallback elsewhere (fetchCachedSameSector's docblock) — there's no reason
// the AI-facing parts of this feature should be the one place using the
// weaker source when the real NSE label is one call away. Null for a
// company NSE doesn't index (BSE-only, below a market-cap cutoff) — callers
// fall back to businessSummary alone in that case, not to Yahoo's label.
export async function ownNseIndustry(symbol) {
  const candidates = await fetchSectorConstituents(symbol)
  return candidates[0]?.industry || null
}

// ── AI peer suggestion — the actual discovery step ──────────────────────────
// Asks Gemini directly for real peer companies, rather than only matching
// against whatever's already in the classification store.
//
// NOT sent to the AI: any sector/industry classification label, NSE's or
// Yahoo's. NSE's own per-company Industry label is still too coarse (Dixon:
// "Consumer Electronics", same bucket as branded companies with a
// completely different business model) and risked anchoring the model
// toward it despite instructions not to. Only the company's name and its
// real business description go in — see api/suggestPeers.js.
//
// `nseIndustry` is still looked up and returned here, purely as DISPLAY
// context in the modal (so you can see what NSE's coarse label says
// alongside what the AI actually found) — it never reaches the prompt.
//
// Never called automatically — PeerSelectModal.jsx's explicit "Discover
// peers with AI" button is the only trigger. The RAW suggestion list (pre-
// enrichment) is cached per target symbol (src/utils/db.js's
// peerSuggestions store), fingerprinted on name+businessSummary — a re-open
// of the modal, or clicking Discover again, reuses it instead of spending a
// fresh call for the same answer. Confirming a peer is still a separate,
// stronger fact recorded in peerRelationships (confirmPeerRelationship
// below); this cache only remembers what the AI last said, confirmed or not.
// Bump this whenever a change to api/suggestPeers.js's PROMPT (not the
// input data) should invalidate every already-cached suggestion list —
// e.g. tightening what counts as a valid candidate. Without this, a prompt
// fix has no effect on a ticker that was already discovered: the fingerprint
// would still match on unchanged name+businessSummary and just keep
// returning the old, stale response forever.
const PROMPT_VERSION = 2   // v2: stopped including unlisted/no-symbol candidates

function suggestionFingerprint(name, businessSummary) {
  let h = 0
  const s = `${PROMPT_VERSION}|${name || ''}|${businessSummary || ''}`
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h.toString(36)
}

// Cache-only read — no network call, ever. This is what was actually
// missing: suggestPeers() correctly WROTE to peerSuggestions, but nothing
// read it back except suggestPeers() itself, which only runs from the
// explicit "Discover" click. Reopening the modal called fetchPeerCandidates
// alone, which has no idea peerSuggestions exists — so an unconfirmed AI
// suggestion, sitting safely in IndexedDB the whole time, never made it back
// onto the screen. This is called on modal open specifically so that gap is
// closed without ever triggering a fresh AI call on open.
export async function getCachedSuggestions(ticker) {
  const t = String(ticker || '').trim().toUpperCase()
  const cached = await getPeerSuggestions(t).catch(() => null)
  if (!cached?.peers?.length) return []
  const withCache = await enrichFromCache(cached.peers.filter(p => p.symbol).map(p => ({ ...p })))
  const unresolved = cached.peers.filter(p => !p.symbol)
  return [...withCache, ...unresolved]
}

export async function suggestPeers({ ticker, name, meta, userKey, model, force = false }) {
  const nseIndustry = await ownNseIndustry(ticker)   // display-only, not sent to the AI
  const t = String(ticker || '').trim().toUpperCase()
  const targetName = String(name || '').trim().toLowerCase()
  const fp = suggestionFingerprint(name, meta?.businessSummary)

  let filtered
  if (!force) {
    const cached = await getPeerSuggestions(t)
    if (cached?.fingerprint === fp) filtered = cached.peers
  }

  if (!filtered) {
    try {
      const r = await fetch('/api/suggestPeers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: ticker, name, businessSummary: meta?.businessSummary, userKey, model }),
      })
      const data = await r.json().catch(() => null)
      if (!data || !Array.isArray(data.peers)) {
        return { peers: null, error: data?.error || 'fetch_failed', detail: data?.detail, nseIndustry }
      }
      // Nothing upstream (the model, or the app's own filtering) excludes
      // the target from naming ITSELF as a "peer" — guard it here, on both
      // symbol and name, since the model can return a candidate with no
      // symbol at all.
      filtered = data.peers.filter(p =>
        String(p.symbol || '').trim().toUpperCase() !== t &&
        String(p.name || '').trim().toLowerCase() !== targetName)
      savePeerSuggestions({ symbol: t, name, peers: filtered, fingerprint: fp, model: model || 'gemini-2.5-flash', generatedAt: Date.now() }).catch(() => {})
    } catch (e) {
      return { peers: null, error: 'fetch_failed', detail: e?.message, nseIndustry }
    }
  }

  // Enrichment always runs fresh, cache hit or not — a peer's financials can
  // change (warmed later, re-analyzed) even when the suggestion list itself
  // hasn't, so this is never what's cached.
  const withCache = await enrichFromCache(filtered.filter(p => p.symbol).map(p => ({ ...p })))
  const bySymbol = new Map(withCache.map(p => [p.symbol, p]))
  // Entries with no resolvable symbol still carry real info (name,
  // rationale) worth showing, just not confirmable/warmable yet.
  const unresolved = filtered.filter(p => !p.symbol)
  return { peers: [...bySymbol.values(), ...unresolved], nseIndustry }
}

// Writes the relationship bidirectionally — confirming Kaynes as Dixon's
// peer means Dixon shows up for Kaynes too, immediately, with zero further
// AI calls (see fetchKnownRelationships above).
export async function confirmPeerRelationship(ticker, tickerName, peer) {
  return savePeerRelationship(ticker, tickerName, peer.symbol, peer.name || peer.symbol, {
    relationshipType: peer.relationship || null,
    overlap: peer.overlap || [],
    rationale: peer.rationale || '',
    confidence: peer.aiConfidence || peer.confidence || null,
    source: 'ai',
    createdAt: Date.now(),
  })
}

export function clearPeersCache() { sectorCache.clear() }
