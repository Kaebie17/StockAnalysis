import React, { useState } from 'react'
import { useSync } from './SyncProvider.jsx'

/**
 * SyncControls — email → 6-digit code sign-in (OTP). Works inside an installed
 * PWA (no magic-link Safari handoff). Renders nothing if Supabase isn't set up.
 */
export default function SyncControls() {
  const { enabled, user, status, signIn, verifyCode, signOut, syncNow } = useSync()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  if (!enabled) return null

  if (user) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="text-slate-500 truncate">{status === 'syncing' ? 'Syncing…' : 'Synced'} · {user.email}</span>
        <button onClick={syncNow} className="text-slate-400 hover:text-accent shrink-0">↻</button>
        <button onClick={signOut} className="text-slate-500 hover:text-bear shrink-0">sign out</button>
      </div>
    )
  }

  if (!open) {
    return <button onClick={() => setOpen(true)} className="text-xs text-accent hover:text-accent-light">☁ Sync across devices</button>
  }


  const sendCode = async () => {
    setErr('')
    const { error } = await signIn(email)
    if (error) setErr(String(error))
  }
  const submitCode = async () => {
    setErr('')
    const { error } = await verifyCode(email, code.trim())
    if (error) setErr(String(error))
  }

  // After signIn, status becomes 'code-sent' → show the code field.
  const codeStage = status === 'code-sent' || status === 'verifying'

  return (
    <div className="w-full space-y-1.5">
      {!codeStage ? (
        <div className="flex items-center gap-1.5 w-full">
          <input type="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="you@email.com" className="input-field text-xs py-1 flex-1 min-w-0" />
          <button onClick={sendCode} disabled={status === 'sending' || !email}
            className="btn-primary text-xs shrink-0">{status === 'sending' ? '…' : 'Send code'}</button>
          <button onClick={() => { setOpen(false); setErr('') }} className="text-slate-500 shrink-0">✕</button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 w-full">
          <input type="text" inputMode="numeric" autoComplete="one-time-code" value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="Enter code from email" className="input-field text-xs py-1 flex-1 min-w-0 tracking-widest" />
          <button onClick={submitCode} disabled={status === 'verifying' || code.length < 4}
            className="btn-primary text-xs shrink-0">{status === 'verifying' ? '…' : 'Verify'}</button>
          <button onClick={() => { setOpen(false); setCode(''); setErr('') }} className="text-slate-500 shrink-0">✕</button>
        </div>
      )}
      {codeStage && !err && <p className="text-[11px] text-slate-500">Enter the code sent to {email}.</p>}
      {err && <p className="text-[11px] text-bear">{err}</p>}
    </div>
  )
}
