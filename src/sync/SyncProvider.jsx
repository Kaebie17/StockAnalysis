import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase, syncEnabled } from './supabaseClient.js'
import { pullAll, pushAllLocal } from './sync.js'

/**
 * SyncProvider — magic-link auth + local-first sync orchestration.
 *
 * On sign-in / app-open with a session: pullAll() (remote → local), then
 * pushAllLocal() so local-only records reach the cloud. Thereafter, local changes
 * push (debounced) via queuePush wired at the write sites. Conflict = last-write-
 * wins. If Supabase isn't configured, this is inert and the app is local-only.
 */
const SyncCtx = createContext(null)

// Turn any Supabase/network error into readable text (mobile has no console).
function errText(e) {
  if (!e) return 'Unknown error'
  const parts = []
  if (e.message) parts.push(e.message)
  if (e.name && e.name !== 'Error') parts.push(`(${e.name})`)
  if (e.status) parts.push(`[status ${e.status}]`)
  if (e.code) parts.push(`[code ${e.code}]`)
  if (parts.length === 0) {
    try { return JSON.stringify(e, Object.getOwnPropertyNames(e)) } catch { return String(e) }
  }
  return parts.join(' ')
}


export function SyncProvider({ children }) {
  const [user, setUser] = useState(null)
  const [status, setStatus] = useState(syncEnabled() ? 'idle' : 'off')
  const [error, setError] = useState(null)
  // Bumped after every pull that actually lands records. pullAll() writes
  // straight into IndexedDB through db.js — it has no way to reach into
  // AppContext's in-memory `state.data` or usePositions' in-memory list, so
  // without this, a ticker already open (or the positions list already
  // mounted) BEFORE sign-in stayed on whatever it loaded then, even after
  // sync pulled newer data underneath it. Consumers (AppContext, usePositions)
  // watch this value and re-read their own cache when it changes.
  const [lastPulledAt, setLastPulledAt] = useState(0)

  const runInitialSync = useCallback(async () => {
    setStatus('syncing')
    setError(null)
    // A network call here (getUser/select/upsert) has no built-in timeout — a
    // stalled connection would otherwise leave status stuck on 'syncing'
    // forever with nothing shown to the user. This guarantees a terminal
    // status either way. pushAllLocal can be several small chunked upserts
    // rather than one big one (see sync.js) — a heavy account's full push
    // can legitimately take longer wall-clock time even with each request
    // individually fast, so this needs real headroom rather than a budget
    // sized for a single request.
    const SYNC_TIMEOUT_MS = 45000
    const timeout = (label) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Sync timed out (${label})`)), SYNC_TIMEOUT_MS))
    try {
      const pullResult = await Promise.race([pullAll(), timeout('pull')])
      if (pullResult?.ok && pullResult.pulled > 0) setLastPulledAt(Date.now())
      const pushResult = await Promise.race([pushAllLocal(), timeout('push')])
      // Both halves have to actually succeed for this to mean "synced" — a pull
      // or push that silently failed used to still land here and show the same
      // "Synced" label as a real success.
      if (pullResult?.ok === false || pushResult?.ok === false) {
        setError(errText(pullResult?.ok === false ? pullResult.error : pushResult.error))
        setStatus('error')
      } else {
        setStatus('synced')
      }
    } catch (e) {
      setError(errText(e))
      setStatus('error')
    }
  }, [])

  // onAuthStateChange fires immediately on subscribe with whatever session
  // already exists, THEN again on any later real change (sign-in, sign-out,
  // token refresh) — it already covers "there's a session on mount," so a
  // separate currentUser() check here was a second, redundant trigger. Both
  // fired runInitialSync() on every load with an existing session, running
  // two full pull+push cycles concurrently instead of one.
  useEffect(() => {
    if (!syncEnabled()) return
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      const u = session?.user || null
      setUser(u)
      if (u) runInitialSync()
    })
    return () => sub?.subscription?.unsubscribe()
  }, [runInitialSync])

  const signIn = useCallback(async (email) => {
    if (!syncEnabled()) return { error: 'Sync not configured.' }
    setStatus('sending')
    // OTP CODE (not a link): works inside an installed PWA, no Safari handoff.
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email, options: { shouldCreateUser: true },
      })
      if (error) console.error('[sync] signIn error:', error)
      setStatus(error ? 'idle' : 'code-sent')
      return { error: error ? errText(error) : null }
    } catch (e) {
      console.error('[sync] signIn threw:', e)
      setStatus('idle')
      return { error: errText(e) }
    }
  }, [])

  const verifyCode = useCallback(async (email, token) => {
    if (!syncEnabled()) return { error: 'Sync not configured.' }
    setStatus('verifying')
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
    if (error) console.error('[sync] verifyOtp error:', error)
    setStatus(error ? 'code-sent' : 'idle')
    return { error: error ? errText(error) : null }
  }, [])

  const signOut = useCallback(async () => {
    if (!syncEnabled()) return
    await supabase.auth.signOut()
    setUser(null); setStatus('idle'); setError(null)
  }, [])

  const syncNow = useCallback(async () => { if (user) await runInitialSync() }, [user, runInitialSync])

  return (
    <SyncCtx.Provider value={{ enabled: syncEnabled(), user, status, error, lastPulledAt, signIn, verifyCode, signOut, syncNow }}>
      {children}
    </SyncCtx.Provider>
  )
}

export function useSync() {
  const ctx = useContext(SyncCtx)
  if (!ctx) throw new Error('useSync must be within SyncProvider')
  return ctx
}
