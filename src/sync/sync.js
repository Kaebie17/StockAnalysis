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
import { exportSyncableRecords, putSyncableRecord } from '../utils/db.js'
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
    const [store] = row.key.split(':')
    try { await putSyncableRecord(store, row.value); pulled++ } catch {}
  }
  return { pulled }
}
