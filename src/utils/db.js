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
const DB_VERSION = 4
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

const TTL = 3600 * 1000  // 1 hour

export async function getCached(ticker) {
  // IMPORTANT: return null ONLY when the record genuinely doesn't exist. A read
  // FAILURE must throw — otherwise the caller can't tell "no cache" from "read
  // broke" and would re-fetch + overwrite good (e.g. Screener-merged) data.
  const rec = await txGet('financials', ticker.toUpperCase())   // throws on tx error
  if (!rec) return null
  // Touch lastAccessed (best-effort; a failure here must NOT lose the read).
  try { await txPut('financials', { ...rec, lastAccessed: Date.now() }) } catch {}
  return rec.data
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
  try { await txPut('aiVerdicts', { ticker: ticker.toUpperCase(), fp, text, savedAt: Date.now() }) } catch {}
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


