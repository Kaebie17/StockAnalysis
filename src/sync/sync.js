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
import { exportSyncableRecords, putSyncableRecord, getCached } from '../utils/db.js'
import { getOverrides } from '../engine/formulaOverrides.js'

const OVERRIDES_KEY = 'formulaOverrides:global'

export async function currentUser() {
  if (!syncEnabled()) return null
  const { data } = await supabase.auth.getUser()
  return data?.user || null
}

// ── Push ────────────────────────────────────────────────────────────────────
let pending = new Map()   // key -> value, coalesced
let timer = null

export function queuePush(key, value) {
  if (!syncEnabled()) return
  pending.set(key, value)
  clearTimeout(timer)
  timer = setTimeout(flush, 1200)   // debounce
}

async function flush() {
  const user = await currentUser()
  if (!user || pending.size === 0) return
  const rows = [...pending.entries()].map(([key, value]) => ({
    user_id: user.id, key, value, updated_at: new Date().toISOString(),
  }))
  pending.clear()
  try { await supabase.from('user_data').upsert(rows, { onConflict: 'user_id,key' }) }
  catch (e) { console.warn('[sync] push failed', e) }
}

// Convenience: push everything currently local (called after sign-in).
export async function pushAllLocal() {
  if (!syncEnabled()) return
  const records = await exportSyncableRecords()          // [{ key, value }]
  records.push({ key: OVERRIDES_KEY, value: getOverrides() })
  for (const r of records) queuePush(r.key, r.value)
  await flush()
}

// ── Pull ──────────────────────────────────────────────────────────────────────
export async function pullAll() {
  const user = await currentUser()
  if (!user) return { pulled: 0 }
  let rows = []
  try {
    const { data, error } = await supabase.from('user_data').select('key,value,updated_at').eq('user_id', user.id)
    if (error) throw error
    rows = data || []
  } catch (e) { console.warn('[sync] pull failed', e); return { pulled: 0 } }

  let pulled = 0
  for (const row of rows) {
    if (row.key === OVERRIDES_KEY) {
      try { localStorage.setItem('sa_formula_overrides', JSON.stringify(row.value)) } catch {}
      pulled++
      continue
    }
    const [store, ...rest] = row.key.split(':')
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
        const existing = await getCached(rest.join(':'))
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
    try { await putSyncableRecord(store, row.value); pulled++ } catch {}
  }
  return { pulled }
}
