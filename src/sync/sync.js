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

// One upsert statement covering the whole pending set (which can be
// hundreds of records right after sign-in, via pushAllLocal) risked growing
// large enough — several merged financials records, each holding years of
// pasted history, in one statement — to blow past Postgres's
// statement_timeout (error 57014). Worse, a fixed 30s retry then replayed
// that exact same oversized statement forever, which is what was tipping a
// recovering database back into an unhealthy state. Capping each upsert to
// a bounded number of rows keeps every individual statement small
// regardless of how much is queued.
const PUSH_CHUNK_SIZE = 10

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
  const entries = [...snapshot.entries()]
  const chunks = []
  for (let i = 0; i < entries.length; i += PUSH_CHUNK_SIZE) chunks.push(entries.slice(i, i + PUSH_CHUNK_SIZE))

  let firstError = null
  for (const chunk of chunks) {
    const rows = chunk.map(([key, value]) => ({
      user_id: user.id, key, value, updated_at: new Date().toISOString(),
    }))
    try {
      const { error } = await supabase.from('user_data').upsert(rows, { onConflict: 'user_id,key' })
      if (error) throw error
      // Only drop the keys we just pushed, and only if nothing newer re-queued
      // that same key while the request was in flight (reference equality on
      // the value we snapshotted — a fresh queuePush call replaces it).
      for (const [key, value] of chunk) {
        if (pending.get(key) === value) pending.delete(key)
      }
    } catch (e) {
      console.warn('[sync] push chunk failed', e)
      firstError = firstError || e
      // Stop rather than push straight on to the next chunk — a timeout
      // usually means the database is already under strain, and immediately
      // firing more upserts at it would only make that worse. Whatever
      // wasn't pushed stays in `pending` for the retry below.
      break
    }
  }

  clearTimeout(retryTimer)
  if (firstError) {
    // Nothing further was removed from `pending` — the next queuePush's
    // debounce will retry it. But if the user makes no further edits, that
    // would never fire, so also schedule one attempt on our own.
    retryTimer = setTimeout(flush, 30000)
    return { ok: false, error: firstError }
  }
  return { ok: true }
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
    // A financials record's local `timestamp` gets reset by every 60s
    // price-poll tick and by every plain ticker fetch — passive refreshes
    // with no user edit behind them. Left as `row.updated_at` unconditionally,
    // putSyncableRecord's freshness gate (below) compares that constantly-
    // refreshed local timestamp against the pulled record's `updated_at` —
    // which is from whenever it was actually pushed — and a plain Yahoo
    // record that merely loaded moments ago always wins, discarding a
    // genuinely richer Screener-merged pull every time. Bypass the gate
    // specifically for that upgrade (local isn't Screener-merged, the pull
    // is); once local already HAS its own Screener-merged data, both sides
    // represent real pasted effort, so recency still decides between them.
    let bypassFreshnessGate = false
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
        // Matches exportSyncableRecords()'s own eligibility check: `source`,
        // not `deepSource` — MERGE_PASTED (manual "Add History") only ever
        // set `source`, so any ticker built up that way still reads
        // `deepSource: undefined` locally even after being correctly pushed.
        // Checking `deepSource` here would silently fail the bypass for every
        // one of those, recreating this exact bug for them specifically.
        // row.value is the RAW pulled record (rec) → source is two levels in
        // (row.value.data.data.source). `existing` is getCached()'s return,
        // already unwrapped one level (rec.data, i.e. the payload) → source is
        // one level in (existing.data.source) — same distinction the
        // price-merge above already relies on.
        bypassFreshnessGate = row.value?.data?.data?.source === 'merged'
          && existing?.data?.source !== 'merged'
      } catch { /* no local copy to protect — fall through to the pulled value */ }
    }
    try { await putSyncableRecord(store, row.value, bypassFreshnessGate ? null : row.updated_at); pulled++ } catch {}
  }
  return { pulled, ok: true }
}
