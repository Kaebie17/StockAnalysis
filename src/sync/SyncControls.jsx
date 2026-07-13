import React, { useState } from 'react'
import { useSync } from './SyncProvider.jsx'

/**
 * SyncControls — magic-link sign-in / status / sign-out. Renders nothing if
 * Supabase isn't configured (local-only build). Mount in Header.
 */
export default function SyncControls() {
  const { enabled, user, status, signIn, signOut, syncNow } = useSync()
  const [email, setEmail] = useState('')
  const [open, setOpen] = useState(false)
  if (!enabled) return null

  if (user) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-slate-500">{status === 'syncing' ? 'Syncing…' : 'Synced'} · {user.email}</span>
        <button onClick={syncNow} className="text-slate-400 hover:text-accent">↻</button>
        <button onClick={signOut} className="text-slate-500 hover:text-bear">sign out</button>
      </div>
    )
  }

  return (
    <div className="text-xs">
      {!open ? (
        <button onClick={() => setOpen(true)} className="text-accent hover:text-accent-light">☁ Sync across devices</button>
      ) : status === 'link-sent' ? (
        <span className="text-bull">Check your email for a sign-in link.</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com"
            className="input-field text-xs py-1 w-40" />
          <button onClick={() => email && signIn(email)} className="btn-primary text-xs"
            disabled={status === 'sending'}>{status === 'sending' ? '…' : 'Send link'}</button>
          <button onClick={() => setOpen(false)} className="text-slate-500">✕</button>
        </div>
      )}
    </div>
  )
}
