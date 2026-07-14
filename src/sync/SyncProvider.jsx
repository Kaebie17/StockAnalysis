import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase, syncEnabled } from './supabaseClient.js'
import { pullAll, pushAllLocal, currentUser } from './sync.js'

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

  const runInitialSync = useCallback(async () => {
    setStatus('syncing')
    await pullAll()
    await pushAllLocal()
    setStatus('synced')
  }, [])

  useEffect(() => {
    if (!syncEnabled()) return
    currentUser().then(u => { if (u) { setUser(u); runInitialSync() } })
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
    setUser(null); setStatus('idle')
  }, [])

  const syncNow = useCallback(async () => { if (user) await runInitialSync() }, [user, runInitialSync])

  return (
    <SyncCtx.Provider value={{ enabled: syncEnabled(), user, status, signIn, verifyCode, signOut, syncNow }}>
      {children}
    </SyncCtx.Provider>
  )
}

export function useSync() {
  const ctx = useContext(SyncCtx)
  if (!ctx) throw new Error('useSync must be within SyncProvider')
  return ctx
}
