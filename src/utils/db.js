

/**
 * src/utils/db.js — IndexedDB with eviction policy
 *
 * Stores: financials (ephemeral, evictable), profiles, swapStates
 * Does NOT store: CSV data (lives in file system)
 *
 * Eviction: if total financial cache > 40MB, evict oldest-accessed entries
 * Never evict: profiles, swapStates (user-generated)
 */

const DB_NAME    = 'stockanalyzr'
const DB_VERSION = 6
const MAX_CACHE_BYTES = 40 * 1024 * 1024  // 40MB for financial cache

let db = null
let openPromise = null

function openDB() {
  if (db) return Promise.resolve(db)
  if (openPromise) return openPromise            // dedupe concurrent opens
  openPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      const d = e.target.result
      if (!d.objectStoreNames.contains('financials')) {
        const s = d.createObjectStore('financials', { keyPath: 'key' })
        s.createIndex('lastAccessed', 'lastAccessed')
      }
      if (!d.objectStoreNames.contains('profiles')) {
        d.createObjectStore('profiles', { keyPath: 'name' })
      }
      if (!d.objectStoreNames.contains('swapStates')) {
        d.createObjectStore('swapStates', { keyPath: 'ticker' })
      }
      // folderHandle store for File System Access API
      if (!d.objectStoreNames.contains('fsHandles')) {
        d.createObjectStore('fsHandles', { keyPath: 'id' })
      }
      // AI verdict cache — one (latest) verdict per ticker, keyed by ticker
      if (!d.objectStoreNames.contains('aiVerdicts')) {
        d.createObjectStore('aiVerdicts', { keyPath: 'ticker' })
      }
      // Guidance + governance inputs (holdings paste, AR data) — one per ticker
      if (!d.objectStoreNames.contains('guidance')) {
        d.createObjectStore('guidance', { keyPath: 'ticker' })
      }
      // Positions — keyed by generated id, NOT by ticker: the same stock can be
      // bought more than once, and each lot carries its own price, date and
      // frozen snapshot. Collapsing to one row per ticker would average away
      // exactly the per-lot detail the whole "since you bought" comparison runs
      // on. Indexed by ticker (list a stock's lots) and by status (open vs sold).
      if (!d.objectStoreNames.contains('positions')) {
        const s = d.createObjectStore('positions', { keyPath: 'id' })
        s.createIndex('ticker', 'ticker')
        s.createIndex('status', 'status')
      }
      // Revisions — append-only log of every estimate change and every decision
      // NOT to change one. Dismissals and defers are rows too: that's what lets
      // a bar answer "is anything still open on this lever?" by querying the log
      // rather than by keeping a second copy of that state somewhere else.
      if (!d.objectStoreNames.contains('revisions')) {
        const s = d.createObjectStore('revisions', { keyPath: 'id' })
        s.createIndex('ticker', 'ticker')
        s.createIndex('positionId', 'positionId')
      }
      // Estimates — frozen, dated claims about where the price can go. Stored
      // rather than recomputed on demand precisely so they can turn out wrong:
      // a number that silently re-derives itself from today's inputs has no
      // track record and can never be corrected against what actually happened.
      if (!d.objectStoreNames.contains('estimates')) {
        const s = d.createObjectStore('estimates', { keyPath: 'id' })
        s.createIndex('ticker', 'ticker')
      }
    }
    req.onsuccess = e => { db = e.target.result; openPromise = null; resolve(db) }
    req.onerror   = () => { openPromise = null; reject(req.error) }
  })
  return openPromise
}

async function txGet(store, key) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror   = () => reject(req.error)
  })
}

async function txPut(store, value) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readwrite').objectStore(store).put(value)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function txDelete(store, key) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readwrite').objectStore(store).delete(key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function txGetAll(store) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror   = () => reject(req.error)
  })
}

// ─── Financial cache (ephemeral) ──────────────────────────────────────────────

export const FINANCIALS_TTL = 3600 * 1000  // 1 hour

// Read-only: how old the cached record for a ticker is, in ms — or null if
// there isn't one. Lets a caller (the Positions panel, so held stocks refresh
// themselves instead of sitting on whatever snapshot was cached the day they
// were added) decide a cache hit is too old to trust, without the get()
// touching lastAccessed the way getCached() does.
export async function getCachedAge(ticker) {
  try {
    const rec = await txGet('financials', ticker.toUpperCase())
    return rec ? Date.now() - (rec.timestamp ?? 0) : null
  } catch { return null }
}

export async function getCached(ticker) {
  // IMPORTANT: return null ONLY when the record genuinely doesn't exist. A read
  // FAILURE must throw — otherwise the caller can't tell "no cache" from "read
  // broke" and would re-fetch + overwrite good (e.g. Screener-merged) data.
  //
  // The get and the lastAccessed touch-write run in ONE readwrite transaction.
  // Doing them as two separate transactions (get, then a later put) let a
  // concurrent setCached() land in between: this function would re-save the
  // record it read BEFORE that write, clobbering the fresh data with a stale
  // copy stamped with a new lastAccessed. That surfaced as a manually-
  // refreshed price reverting on reload whenever something else (e.g. the
  // Positions panel) read the same ticker's cache while the price save was
  // still in flight.
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const store = d.transaction('financials', 'readwrite').objectStore('financials')
    const req = store.get(ticker.toUpperCase())
    req.onsuccess = () => {
      const rec = req.result
      if (!rec) { resolve(null); return }
      try { store.put({ ...rec, lastAccessed: Date.now() }) } catch {}
      resolve(rec.data)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function setCached(ticker, data) {
  try {
    const serialized = JSON.stringify(data)
    const bytes      = new TextEncoder().encode(serialized).length

    await txPut('financials', {
      key:          ticker.toUpperCase(),
      data,
      timestamp:    Date.now(),
      lastAccessed: Date.now(),
      bytes
    })

    // Run eviction check asynchronously — don't block the caller
    evictIfNeeded().catch(() => {})
  } catch { /* non-critical */ }
}

// Remove one ticker's cached data (used by "reset ticker").
export async function deleteCached(ticker) {
  try { await txDelete('financials', ticker.toUpperCase()) } catch { /* non-critical */ }
}

// ── AI verdict cache ─────────────────────────────────────────────────────────
// Keyed by ticker (latest only). `fp` is a fingerprint of the data/summary — a
// cache hit requires the SAME fp, so changed data misses and regenerates.
export async function getAiVerdict(ticker, fp) {
  try {
    const rec = await txGet('aiVerdicts', ticker.toUpperCase())
    return (rec && rec.fp === fp) ? rec.text : null
  } catch { return null }
}
export async function setAiVerdict(ticker, fp, text) {
  const rec = { ticker: ticker.toUpperCase(), fp, text, savedAt: Date.now() }
  try { await txPut('aiVerdicts', rec) } catch {}
  // Sync the verdict so the same tokens aren't re-spent on another device.
  import('../sync/sync.js').then(m => m.queuePush(`aiVerdicts:${rec.ticker}`, rec)).catch(() => {})
}
export async function deleteAiVerdict(ticker) {
  try { await txDelete('aiVerdicts', ticker.toUpperCase()) } catch {}
}

// Wipe ALL cached financials (used by "reset whole app").
export async function clearAllCached() {
  try {
    const d = await openDB()
    await new Promise((resolve, reject) => {
      const req = d.transaction('financials', 'readwrite').objectStore('financials').clear()
      req.onsuccess = () => resolve()
      req.onerror   = () => reject(req.error)
    })
  } catch { /* non-critical */ }
}

async function evictIfNeeded() {
  try {
    const all   = await txGetAll('financials')
    const total = all.reduce((s, r) => s + (r.bytes || 0), 0)
    if (total <= MAX_CACHE_BYTES) return

    // Evict oldest-accessed entries until under limit
    const sorted = [...all].sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0))
    let remaining = total
    for (const rec of sorted) {
      if (remaining <= MAX_CACHE_BYTES * 0.8) break  // evict to 80% capacity
      await txDelete('financials', rec.key)
      remaining -= (rec.bytes || 0)
    }
  } catch { /* non-critical */ }
}

// ─── Scoring profiles ─────────────────────────────────────────────────────────

export async function saveProfile(name, config) {
  await txPut('profiles', { name, config, updatedAt: Date.now() })
}

export async function loadProfile(name) {
  const rec = await txGet('profiles', name)
  return rec?.config ?? null
}

export async function listProfiles() {
  const all = await txGetAll('profiles')
  return all.map(r => ({ name: r.name, updatedAt: r.updatedAt }))
}

export async function deleteProfile(name) {
  await txDelete('profiles', name)
}

// ─── Swap states (which fields user has swapped to CSV) ───────────────────────

export async function saveSwapState(ticker, swaps) {
  await txPut('swapStates', { ticker: ticker.toUpperCase(), swaps, updatedAt: Date.now() })
}

export async function loadSwapState(ticker) {
  const rec = await txGet('swapStates', ticker.toUpperCase())
  return rec?.swaps ?? {}
}

export async function saveGuidance(ticker, payload) {
  await txPut('guidance', { ticker: ticker.toUpperCase(), ...payload, updatedAt: Date.now() })
}

export async function loadGuidance(ticker) {
  const rec = await txGet('guidance', ticker.toUpperCase())
  return rec || null
}

export async function clearGuidance(ticker) {
  await txDelete('guidance', ticker.toUpperCase())
}

export async function clearSwapState(ticker) {
  await txDelete('swapStates', ticker.toUpperCase())
}

// ─── Positions (stocks the user actually owns) ───────────────────────────────
// A sale CLOSES a position, it never deletes one: a sold holding is precisely
// the record that says whether the call was right, so it's the last thing to
// throw away. `snapshot` freezes what the app believed at purchase — estimate,
// quality, market-implied growth — because none of it is reconstructible later
// (the financials move on, and re-deriving the past with today's data would be
// a fiction). `snapshot.isLate` marks a position added well after the buy date,
// so any "since you bought" comparison built on it can say so plainly instead
// of implying it captured conditions that were never actually observed.

const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

export async function savePosition(position) {
  const now = Date.now()
  const rec = {
    status: 'open',
    ...position,
    id:     position.id || newId(),
    ticker: String(position.ticker || '').toUpperCase(),
    createdAt: position.createdAt || now,
    updatedAt: now,
  }
  await txPut('positions', rec)
  return rec
}

export async function listPositions({ ticker, status } = {}) {
  let recs = await txGetAll('positions')
  if (ticker) {
    const t = String(ticker).toUpperCase()
    recs = recs.filter(r => r.ticker === t)
  }
  if (status) recs = recs.filter(r => r.status === status)
  return recs.sort((a, b) => (b.buyDate || 0) - (a.buyDate || 0))
}

export async function getPosition(id) {
  return (await txGet('positions', id)) || null
}

// Selling is an update, not a delete — see the note above.
export async function closePosition(id, { sellPrice, sellDate, sharesSold } = {}) {
  const rec = await txGet('positions', id)
  if (!rec) return null
  const updated = {
    ...rec,
    status: 'closed',
    sellPrice: sellPrice ?? null,
    sellDate:  sellDate  ?? Date.now(),
    sharesSold: sharesSold ?? rec.shares,
    updatedAt: Date.now(),
  }
  await txPut('positions', updated)
  return updated
}

// Only for a mis-entry the user wants gone. Closing is the normal path.
export async function deletePosition(id) {
  await txDelete('positions', id)
}

// ─── Revision log (append-only) ──────────────────────────────────────────────
// Every estimate change AND every deliberate decision not to change one. A
// dismissal is as much a fact worth keeping as a revision: it's the difference
// between "nobody looked at this" and "someone looked and judged it immaterial",
// and only the log can tell those apart. Never updated in place, never deleted.

export async function appendRevision(entry) {
  const rec = {
    ...entry,
    id:     entry.id || newId(),
    ticker: String(entry.ticker || '').toUpperCase(),
    createdAt: entry.createdAt || Date.now(),
  }
  await txPut('revisions', rec)
  return rec
}

/**
 * Data-quality resolutions — what the user decided about a flagged year.
 *
 * Keyed by (ticker, year, kind), because a year flagged for a margin spike and
 * the same year previously resolved for a revenue step are different problems;
 * matching on year alone would offer one as a fix for the other.
 *
 * These persist across data refreshes. A fact about a past year — "FY24 included
 * an 800 Cr land sale" — stays true when FY27 arrives, and the app cannot
 * re-derive it. The flag itself is re-detected from scratch on every paste; the
 * resolution returns as a suggestion rather than reapplying itself, so a
 * restated year doesn't silently keep an adjustment that no longer fits.
 */
export async function saveDataResolution(entry) {
  const rec = {
    ...entry,
    id: `${String(entry.ticker || '').toUpperCase()}:${entry.year}:${entry.kind}`,
    ticker: String(entry.ticker || '').toUpperCase(),
    updatedAt: Date.now(),
  }
  await txPut('revisions', { ...rec, lever: 'data-quality', disposition: entry.disposition })
  return rec
}

export async function listDataResolutions(ticker) {
  const rows = await listRevisions({ ticker })
  return rows.filter(r => r.lever === 'data-quality')
}

export async function listRevisions({ ticker, positionId } = {}) {
  let recs = await txGetAll('revisions')
  if (ticker) {
    const t = String(ticker).toUpperCase()
    recs = recs.filter(r => r.ticker === t)
  }
  if (positionId) recs = recs.filter(r => r.positionId === positionId)
  return recs.sort((a, b) => b.createdAt - a.createdAt)   // newest first
}

/**
 * Which levers still have an unresolved item hanging over them. A bar shows
 * "under review" while its lever appears here, and clears only once EVERY open
 * item on it has a disposition — dismissing one of two doesn't clear the bar.
 * Derived from the log rather than stored separately, so the two can't drift.
 */
export async function openLevers(ticker) {
  const recs = await listRevisions({ ticker })
  const open = new Set()
  for (const r of recs) {
    if (r.disposition === 'deferred' || r.disposition == null) {
      if (r.lever) open.add(r.lever)
    }
  }
  return [...open]
}

// ─── Estimates (frozen, dated claims) ────────────────────────────────────────
// A new estimate SUPERSEDES the previous one rather than replacing it: the old
// row stays, marked superseded, so the history of what was believed and when
// survives. Overwriting would leave only the current opinion, which is exactly
// the state that made fair value uncheckable in the first place.

export async function saveEstimate(ticker, estimate, meta = {}) {
  const t = String(ticker || '').toUpperCase()
  if (!t || !estimate) return null

  // Retire whatever was current for this ticker.
  const existing = (await txGetAll('estimates')).filter(e => e.ticker === t && e.current)
  for (const old of existing) {
    await txPut('estimates', { ...old, current: false, supersededAt: Date.now() })
  }

  const rec = {
    id: newId(),
    ticker: t,
    current: true,
    ...meta,                 // e.g. { trigger: 'quarterly' | 'revision' | 'initial' }
    estimate,
    createdAt: estimate.createdAt || Date.now(),
  }
  await txPut('estimates', rec)
  return rec
}

export async function currentEstimate(ticker) {
  const t = String(ticker || '').toUpperCase()
  const all = await txGetAll('estimates')
  return all.find(e => e.ticker === t && e.current) || null
}

export async function listEstimates(ticker) {
  const t = String(ticker || '').toUpperCase()
  return (await txGetAll('estimates'))
    .filter(e => e.ticker === t)
    .sort((a, b) => b.createdAt - a.createdAt)
}

// ─── Backup: export / import all user data ────────────────────────────────────
// A backup/restore pair (not a sync mechanism). Exports every user-data store to
// a JSON object; imports merge records back (put overwrites by key, so a restore
// never wipes stores it doesn't mention). fsHandles is skipped (not serializable).

const BACKUP_STORES = ['financials', 'guidance', 'swapStates', 'aiVerdicts', 'profiles',
                       'positions', 'revisions', 'estimates']

export async function exportAllData() {
  const stores = {}
  for (const name of BACKUP_STORES) {
    try { stores[name] = await txGetAll(name) } catch { stores[name] = [] }
  }
  return { app: 'stockanalyzr', version: DB_VERSION, exportedAt: new Date().toISOString(), stores }
}

export async function importAllData(backup) {
  if (!backup || backup.app !== 'stockanalyzr' || !backup.stores) {
    throw new Error('Not a valid StockAnalyzr backup file.')
  }
  let restored = 0
  for (const name of BACKUP_STORES) {
    const records = backup.stores[name]
    if (!Array.isArray(records)) continue
    for (const rec of records) {
      try { await txPut(name, rec); restored++ } catch { /* skip bad record */ }
    }
  }
  return { restored }
}

// ─── Sync helpers ─────────────────────────────────────────────────────────────
// Sync EVERYTHING that cost the user effort or tokens: merged financials (holds
// pasted Screener history), guidance/AR docs, swaps, profiles, AI verdicts. Only
// a pure re-fetchable Yahoo pull would be safe to skip — but since `financials`
// merges Yahoo + Screener into one record, we sync it whole (re-fetching would
// drop the pasted data). Each record maps to a sync key "<store>:<naturalKey>".
export const SYNC_STORES = {
  financials: 'key',        // merged Yahoo+Screener snapshot (keyPath is 'key')
  guidance:   'ticker',
  swapStates: 'ticker',
  aiVerdicts: 'ticker',
  profiles:   'name',
  positions:  'id',         // one row per LOT, not per ticker
  revisions:  'id',         // append-only; last-write-wins is safe (rows are immutable)
  estimates:  'id',         // superseded rows are kept, so these are immutable too
}

export async function exportSyncableRecords() {
  const out = []
  for (const [store, keyPath] of Object.entries(SYNC_STORES)) {
    let recs = []
    try { recs = await txGetAll(store) } catch { recs = [] }
    for (const rec of recs) {
      const nk = rec?.[keyPath]
      if (nk == null) continue
      // financials: only sync records holding pasted effort (merged). Pure Yahoo
      // is re-fetchable. Record shape is { key, data: { data: <normalized>, ... } },
      // so the source flag is at rec.data.data.source.
      if (store === 'financials' && rec?.data?.data?.deepSource !== 'screener') continue
      out.push({ key: `${store}:${nk}`, value: rec })
    }
  }
  return out
}

export async function putSyncableRecord(store, record) {
  if (!SYNC_STORES[store] || !record) return
  await txPut(store, record)
}

// ─── File System folder handle (Chrome/Android persistence) ──────────────────

export async function saveFolderHandle(handle) {
  try {
    await txPut('fsHandles', { id: 'stockanalyzrFolder', handle })
  } catch { /* IndexedDB can't always store FileSystemDirectoryHandle */ }
}

export async function loadFolderHandle() {
  try {
    const rec = await txGet('fsHandles', 'stockanalyzrFolder')
    if (!rec?.handle) return null
    // Verify permission is still granted
    const perm = await rec.handle.queryPermission({ mode: 'readwrite' })
    if (perm === 'granted') return rec.handle
    // Try to re-request
    const req = await rec.handle.requestPermission({ mode: 'readwrite' })
    return req === 'granted' ? rec.handle : null
  } catch { return null }
}
