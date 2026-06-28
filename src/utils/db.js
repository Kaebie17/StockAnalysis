// Raw IndexedDB utility — no external modules
// Stores: financials, scoringProfiles, cachedTickers

const DB_NAME    = 'StockValDB'
const DB_VERSION = 1

const STORES = {
  FINANCIALS: 'financials',
  PROFILES:   'profiles',
  CACHE:      'cache',
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORES.FINANCIALS)) {
        db.createObjectStore(STORES.FINANCIALS, { keyPath: 'ticker' })
      }
      if (!db.objectStoreNames.contains(STORES.PROFILES)) {
        db.createObjectStore(STORES.PROFILES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.CACHE)) {
        const cacheStore = db.createObjectStore(STORES.CACHE, { keyPath: 'key' })
        cacheStore.createIndex('expiry', 'expiry', { unique: false })
      }
    }

    req.onsuccess  = () => resolve(req.result)
    req.onerror    = () => reject(req.error)
  })
}

function tx(db, storeName, mode = 'readonly') {
  return db.transaction([storeName], mode).objectStore(storeName)
}

async function dbGet(storeName, key) {
  const db    = await openDB()
  const store = tx(db, storeName)
  return new Promise((resolve, reject) => {
    const req  = store.get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror   = () => reject(req.error)
  })
}

async function dbPut(storeName, value) {
  const db    = await openDB()
  const store = tx(db, storeName, 'readwrite')
  return new Promise((resolve, reject) => {
    const req  = store.put(value)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function dbDelete(storeName, key) {
  const db    = await openDB()
  const store = tx(db, storeName, 'readwrite')
  return new Promise((resolve, reject) => {
    const req  = store.delete(key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function dbGetAll(storeName) {
  const db    = await openDB()
  const store = tx(db, storeName)
  return new Promise((resolve, reject) => {
    const req  = store.getAll()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror   = () => reject(req.error)
  })
}

// ── Public API ────────────────────────────────────────────

// Financials: store/retrieve fetched raw data per ticker
export async function saveFinancials(ticker, data) {
  await dbPut(STORES.FINANCIALS, { ticker: ticker.toUpperCase(), ...data, savedAt: Date.now() })
}

export async function loadFinancials(ticker) {
  return dbGet(STORES.FINANCIALS, ticker.toUpperCase())
}

// Profiles: scoring profiles
export async function saveProfile(profile) {
  await dbPut(STORES.PROFILES, profile)
}

export async function loadProfile(id) {
  return dbGet(STORES.PROFILES, id)
}

export async function loadAllProfiles() {
  return dbGetAll(STORES.PROFILES)
}

export async function deleteProfile(id) {
  return dbDelete(STORES.PROFILES, id)
}

// Cache: short-lived API responses (1 hour default)
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

export async function cacheSet(key, value, ttl = CACHE_TTL) {
  await dbPut(STORES.CACHE, { key, value, expiry: Date.now() + ttl })
}

export async function cacheGet(key) {
  const entry = await dbGet(STORES.CACHE, key)
  if (!entry) return null
  if (Date.now() > entry.expiry) { await dbDelete(STORES.CACHE, key); return null }
  return entry.value
}
