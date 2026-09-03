/**
 * src/sync/sync.js — local-first sync between IndexedDB/localStorage and Supabase.
 *
 * Model: one key-value table (user_data: user_id, key, value, updated_at).
 * Each syncable record maps to a key "<store>:<naturalKey>". Push on change
 * (debounced), pull on open / ticker-load. Conflict = last-write-wins by
 * updated_at. Local stays primary — sync mirrors it; the app works offline.
 *
 * Syncable = user-generated data. financials is a re-fetchable cache → NOT synced.
 */
import { supabase, syncEnabled } from './supabaseClient.js'
import { exportSyncableRecords, putSyncableRecord, deleteSyncableRecord, getCached } from '../utils/db.js'

export async function currentUser() {
  if (!syncEnabled()) return null
  const { data } = await supabase.auth.getUser()
  return data?.user || null
}

// ── Push ────────────────────────────────────────────────────────────────────
let pending = new Map()   // key -> value, coalesced
let timer = null
let retryTimer = null

export function queuePush(key, value) {
  if (!syncEnabled()) return
  pending.set(key, value)
  clearTimeout(timer)
  timer = setTimeout(flush, 1200)   // debounce
}

// @returns {{ok: boolean, error?: any}} — the caller (SyncProvider) surfaces
// this as real sync status instead of assuming every push landed.
async function flush() {
  const user = await currentUser()
  if (!user) return { ok: false, error: 'not signed in' }
  if (pending.size === 0) return { ok: true }
  // Snapshot rather than clear-then-build: `pending` stays live for the
  // duration of the request so a NEW edit queued while this upsert is in
  // flight isn't lost, and isn't silently discarded if the upsert fails.
  const snapshot = new Map(pending)
  const rows = [...snapshot.entries()].map(([key, value]) => ({
    user_id: user.id, key, value, updated_at: new Date().toISOString(),
  }))
  try {
    const { error } = await supabase.from('user_data').upsert(rows, { onConflict: 'user_id,key' })
    if (error) throw error
    // Only drop the keys we just pushed, and only if nothing newer re-queued
    // that same key while the request was in flight (reference equality on
    // the value we snapshotted — a fresh queuePush call replaces it).
    for (const [key, value] of snapshot) {
      if (pending.get(key) === value) pending.delete(key)
    }
    clearTimeout(retryTimer)
    return { ok: true }
  } catch (e) {
    console.warn('[sync] push failed', e)
    // Nothing was removed from `pending` — the next queuePush's debounce
    // will retry it. But if the user makes no further edits, that would
    // never fire, so also schedule one attempt on our own.
    clearTimeout(retryTimer)
    retryTimer = setTimeout(flush, 30000)
    return { ok: false, error: e }
  }
}

// Convenience: push everything currently local (called after sign-in).
export async function pushAllLocal() {
  if (!syncEnabled()) return { ok: true }
  const records = await exportSyncableRecords()          // [{ key, value }]
  for (const r of records) queuePush(r.key, r.value)
  return await flush()
}

// ── Pull ──────────────────────────────────────────────────────────────────────
// @returns {{pulled: number, ok: boolean, error?: any}}
export async function pullAll() {
  const user = await currentUser()
  if (!user) return { pulled: 0, ok: false, error: 'not signed in' }
  let rows = []
  try {
    const { data, error } = await supabase.from('user_data').select('key,value,updated_at').eq('user_id', user.id)
    if (error) throw error
    rows = data || []
  } catch (e) { console.warn('[sync] pull failed', e); return { pulled: 0, ok: false, error: e } }

  let pulled = 0
  for (const row of rows) {
    const [store, ...rest] = row.key.split(':')
    const naturalKey = rest.join(':')

    // A tombstone: another device deleted this record (see removePosition).
    // Previously this pushed `null`, which putSyncableRecord's `!record`
    // guard silently discarded — the delete never propagated, so a removed
    // position resurrected on the next pull from any other device.
    if (row.value?.__deleted) {
      try { await deleteSyncableRecord(store, naturalKey); pulled++ } catch {}
      continue
    }

    // financials only syncs to carry pasted Screener history across devices
    // (see exportSyncableRecords). Price/marketCap/change1d are live,
    // re-fetchable quote data — the poller and manual refresh keep them
    // current locally on their own, and a pull must never regress them back
    // to whatever price happened to be pushed last. That surfaced as a
    // freshly-refreshed price reverting on every full page reload (which
    // re-runs the initial pull), while in-app navigation — which never
    // re-pulls — kept the fresh price.
    if (store === 'financials') {
      try {
        // getCached(ticker) resolves the stored record's `data` field, i.e.
        // the payload `{ data: <normalized>, ratioResult, ... }` — the live
        // fields live at existing.data.price, not existing.price.
        const existing = await getCached(naturalKey)
        if (existing?.data?.price != null) {
          row.value = {
            ...row.value,
            data: {
              ...row.value.data,
              data: {
                ...row.value.data?.data,
                price:     existing.data.price,
                marketCap: existing.data.marketCap,
                meta:      { ...row.value.data?.data?.meta, change1d: existing.data.meta?.change1d },
              },
            },
          }
        }
      } catch { /* no local copy to protect — fall through to the pulled value */ }
    }
    try { await putSyncableRecord(store, row.value, row.updated_at); pulled++ } catch {}
  }
  return { pulled, ok: true }
}
