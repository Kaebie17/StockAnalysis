/**
 * src/utils/db.js — Raw IndexedDB, no Dexie
 */

const DB_NAME = 'stockval'
const DB_VERSION = 1
let db = null

function openDB() {
  if (db) return Promise.resolve(db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      const d = e.target.result
      if (!d.objectStoreNames.contains('financials')) {
        d.createObjectStore('financials', { keyPath: 'key' })
      }
      if (!d.objectStoreNames.contains('profiles')) {
        d.createObjectStore('profiles', { keyPath: 'name' })
      }
    }
    req.onsuccess = e => { db = e.target.result; resolve(db) }
    req.onerror   = () => reject(req.error)
  })
}

async function txGet(store, key) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function txPut(store, value) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite')
    const req = tx.objectStore(store).put(value)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

async function txDelete(store, key) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite')
    const req = tx.objectStore(store).delete(key)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

async function txGetAll(store) {
  const d = await openDB()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

const TTL = 3600 * 1000 // 1 hour

export async function getCached(ticker) {
  try {
    const rec = await txGet('financials', ticker.toUpperCase())
    if (!rec) return null
    if (Date.now() - rec.timestamp > TTL) { await txDelete('financials', ticker.toUpperCase()); return null }
    return rec.data
  } catch { return null }
}

export async function setCached(ticker, data) {
  try {
    await txPut('financials', { key: ticker.toUpperCase(), data, timestamp: Date.now() })
  } catch { /* non-critical */ }
}

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
