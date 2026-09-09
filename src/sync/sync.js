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

// ── Change detection ────────────────────────────────────────────────────────
// pushAllLocal() re-exports and re-queues EVERY syncable record on every
// sync cycle (app open, sign-in, auth-refresh), unconditionally — including
// full financials blobs that can run several hundred KB — with no check
// against what's already on the server. Most of the time nothing has
// actually changed, so that was pure waste: bytes over the wire and real
// Postgres write work on every single sync, which is exactly the kind of
// avoidable load that was contributing to the 57014s. Track a lightweight
// fingerprint of what was last successfully pushed and skip re-sending
// anything that still matches it.
const FP_KEY = 'sa_sync_pushed_fp'

function loadFingerprints() {
  try { return JSON.parse(localStorage.getItem(FP_KEY) || '{}') } catch { return {} }
}
function saveFingerprints() {
  try { localStorage.setItem(FP_KEY, JSON.stringify(fingerprints)) } catch { /* private mode — just re-pushes next time, harmless */ }
}
let fingerprints = loadFingerprints()

// A cheap, deterministic string hash (djb2) — this only needs to detect
// "did the syncable content change," not resist tampering.
function hashString(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h.toString(36)
}

// financials' top-level `timestamp` and `lastAccessed` — and the live
// price/marketCap/change1d fields nested inside data.data — all get touched
// by routine, no-edit-behind-them activity: `timestamp` on every fetch/poll
// (setCached), `lastAccessed` on every plain read (getCached, called on
// basically every ticker view), and the price fields on every 60s poll tick
// (pullAll below has the matching note on why those specific fields aren't
// sync-worthy). Fingerprinting the raw record would re-flag it as "changed"
// on essentially every page view and defeat the whole point, so all of
// those are stripped before hashing.
function fingerprintOf(key, value) {
  const store = key.split(':', 1)[0]
  if (store === 'financials' && value?.data?.data) {
    const { price, marketCap, meta, ...restData } = value.data.data
    const { timestamp, lastAccessed, ...restValue } = value
    return hashString(JSON.stringify({
      ...restValue,
      data: { ...value.data, data: { ...restData, meta: meta ? { ...meta, change1d: undefined } : meta } },
    }))
  }
  return hashString(JSON.stringify(value))
}

// Fingerprints aren't scoped per Supabase user id — just per sync key — so
// switching to a different account on the same browser could otherwise
// wrongly skip pushing records the new account's server side has never
// actually seen. Cleared on sign-out (called from SyncProvider) so a fresh
// sign-in always starts from "prove it's already there," never assumes it.
export function clearPushFingerprints() {
  fingerprints = {}
  try { localStorage.removeItem(FP_KEY) } catch { /* ignore */ }
}

// ── Push ────────────────────────────────────────────────────────────────────
let pending = new Map()   // key -> value, coalesced
let timer = null
let retryTimer = null

export function queuePush(key, value) {
  if (!syncEnabled()) return
  // Nothing to send if this exact content (modulo the live fields above)
  // is already what we last confirmed made it to the server.
  if (fingerprints[key] === fingerprintOf(key, value)) return
  pending.set(key, value)
  clearTimeout(timer)
  timer = setTimeout(flush, 1200)   // debounce
}

// One upsert statement covering the whole pending set (which can be
// hundreds of records right after sign-in, via pushAllLocal) risked growing
// large enough — several merged financials records, each holding years of
// pasted history, in one statement — to blow past Postgres's
// statement_timeout (error 57014, an 8s hard ceiling on Supabase's free-tier
// `authenticated` role). Worse, a fixed 30s retry then replayed that exact
// same oversized statement forever, which is what was tipping a recovering
// database back into an unhealthy state.
//
// A fixed ROW count isn't the right cap: a pasted-history financials record
// runs 40-400KB+ while a positions/revisions row is a few hundred bytes, so
// 10 rows can mean anywhere from a few KB to several MB depending which
// stores happen to land in that chunk together. Chunking by cumulative BYTE
// size instead bounds what actually costs time to write regardless of
// composition. A single record bigger than the budget still ships alone
// (one JSON value can't be split) — that's fine, it's the SUM of several
// large records sharing one statement that risked the timeout, not any one
// of them individually.
const PUSH_CHUNK_MAX_BYTES = 150_000
const PUSH_CHUNK_MAX_ROWS = 25   // secondary cap so many tiny records don't pile into one huge row count

function buildPushChunks(entries) {
  const chunks = []
  let current = []
  let currentBytes = 0
  for (const entry of entries) {
    const size = JSON.stringify(entry[1]).length
    if (current.length > 0 && (current.length >= PUSH_CHUNK_MAX_ROWS || currentBytes + size > PUSH_CHUNK_MAX_BYTES)) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(entry)
    currentBytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// Chunks were pushed one at a time, sequentially — safe for the database,
// but with 200+ records split into dozens of small chunks, waiting for each
// round trip before starting the next meant the whole push could take well
// over SyncProvider's 20s overall sync budget even though every individual
// chunk was healthy and fast. A few chunks in flight together cuts that
// wall-clock time roughly by the concurrency factor while still keeping
// each request itself small — the thing that actually made a request risky
// was one oversized STATEMENT, not several small ones overlapping in time.
const PUSH_CONCURRENCY = 4

async function pushChunk(user, chunk) {
  const rows = chunk.map(([key, value]) => ({
    user_id: user.id, key, value, updated_at: new Date().toISOString(),
  }))
  try {
    const { error } = await supabase.from('user_data').upsert(rows, { onConflict: 'user_id,key' })
    if (error) throw error
    // Only drop the keys we just pushed, and only if nothing newer re-queued
    // that same key while the request was in flight (reference equality on
    // the value we snapshotted — a fresh queuePush call replaces it). Record
    // what actually made it to the server so the next sync cycle can skip
    // these entirely if nothing changes before then.
    for (const [key, value] of chunk) {
      if (pending.get(key) === value) pending.delete(key)
      fingerprints[key] = fingerprintOf(key, value)
    }
    saveFingerprints()
    return { ok: true }
  } catch (e) {
    // Sizes logged alongside the failure so a recurrence is diagnosable
    // without a trip to the SQL editor: a timeout on a chunk that's well
    // under the byte budget would point at the database itself (still
    // degraded, or a stuck lock) rather than payload size.
    console.warn('[sync] push chunk failed', e,
      chunk.map(([key, value]) => `${key}: ${JSON.stringify(value).length}B`))
    return { ok: false, error: e }
  }
}

// Supabase's client re-checks/refreshes the session on its own — notably on
// every tab-visibility change — and each of those emits an auth event that
// SyncProvider reacts to by starting a fresh full sync. Nothing stopped two
// of those from overlapping (e.g. a tab regaining focus moments after page
// load, or the debounce timer below firing while pushAllLocal's own flush
// call is still in flight), and two concurrent upserts touching the SAME
// (user_id, key) rows make the second one queue behind the first's row lock
// — that wait time counts against Postgres's statement_timeout too, so an
// otherwise-healthy write can time out purely from contending with itself.
// Collapsing every call onto one shared in-flight promise makes overlap
// impossible: a second caller just awaits the run already underway instead
// of starting a competing one.
let flushInFlight = null

async function flush() {
  if (flushInFlight) return flushInFlight
  flushInFlight = doFlush()
  try {
    return await flushInFlight
  } finally {
    flushInFlight = null
  }
}

// @returns {{ok: boolean, error?: any}} — the caller (SyncProvider) surfaces
// this as real sync status instead of assuming every push landed.
async function doFlush() {
  const user = await currentUser()
  if (!user) return { ok: false, error: 'not signed in' }
  if (pending.size === 0) return { ok: true }
  // Snapshot rather than clear-then-build: `pending` stays live for the
  // duration of the request so a NEW edit queued while this upsert is in
  // flight isn't lost, and isn't silently discarded if the upsert fails.
  const snapshot = new Map(pending)
  const chunks = buildPushChunks([...snapshot.entries()])

  let firstError = null
  for (let i = 0; i < chunks.length; i += PUSH_CONCURRENCY) {
    const wave = chunks.slice(i, i + PUSH_CONCURRENCY)
    const results = await Promise.all(wave.map(chunk => pushChunk(user, chunk)))
    const failed = results.find(r => !r.ok)
    if (failed) { firstError = failed.error; break }
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
// Same overlap risk as flush() above (an auth-refresh-triggered resync
// landing mid-pull), so the same single-in-flight guard applies here.
let pullInFlight = null

export async function pullAll() {
  if (pullInFlight) return pullInFlight
  pullInFlight = doPullAll()
  try {
    return await pullInFlight
  } finally {
    pullInFlight = null
  }
}

// @returns {{pulled: number, ok: boolean, error?: any}}
async function doPullAll() {
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
    try {
      await putSyncableRecord(store, row.value, bypassFreshnessGate ? null : row.updated_at)
      pulled++
      // The server already has exactly this content — recording its
      // fingerprint now means the very next push (pushAllLocal always runs
      // right after a pull, see SyncProvider) won't needlessly re-upload
      // something that was just confirmed to already be there. Safe even
      // when putSyncableRecord's freshness gate above just skipped the
      // local write because local was newer: this only records what the
      // SERVER's copy looks like, not a claim about local content, so a
      // genuinely newer/different local value still won't match it and
      // still gets pushed as normal.
      fingerprints[row.key] = fingerprintOf(row.key, row.value)
    } catch {}
  }
  saveFingerprints()
  return { pulled, ok: true }
}
