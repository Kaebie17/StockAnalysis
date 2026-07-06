// Per-ticker persistence of loaded data in IndexedDB. Survives refresh/tab close.
// Not secret data, so no security concern. Reset rules:
//   - new upload for a ticker   → saveTicker overwrites that ticker's entry
//   - reset ticker              → deleteTicker(ticker)
//   - reset whole app           → clearAllTickers()
const DB_NAME = 'stockanalyzr'
const STORE   = 'tickers'
const VERSION = 1

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return }
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

export async function saveTicker(ticker, data) {
  if (!ticker) return false
  try {
    const db = await openDB()
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ ticker, data, savedAt: Date.now() }, ticker)
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

export async function loadTicker(ticker) {
  if (!ticker) return null
  try {
    const db = await openDB()
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const rq = tx.objectStore(STORE).get(ticker)
      rq.onsuccess = () => res(rq.result?.data ?? null)
      rq.onerror = () => res(null)
    })
  } catch { return null }
}

export async function deleteTicker(ticker) {
  try {
    const db = await openDB()
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(ticker)
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

export async function clearAllTickers() {
  try {
    const db = await openDB()
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

export async function listTickers() {
  try {
    const db = await openDB()
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const rq = tx.objectStore(STORE).getAllKeys()
      rq.onsuccess = () => res(rq.result || [])
      rq.onerror = () => res([])
    })
  } catch { return [] }
}
