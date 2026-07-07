import React, { useEffect, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { buildBlockSummary } from '../../engine/buildBlockSummary.js'
import { expectationInsight } from '../../engine/valuation.js'
import { getAiKey, setAiKey, clearAiKey } from '../../utils/aiKey.js'
import { getAiVerdict, setAiVerdict } from '../../utils/db.js'

// Session cache so we don't re-call the API every render / re-open.
const _cache = new Map()
function hashStr(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0 } return h.toString(36) }

export default function AIVerdict() {
  const { state } = useApp()
  const { valuation, marketExpectation, ratioResult } = state || {}
  const [text, setText]   = useState(null)
  const [loading, setLoad] = useState(false)
  const [failed, setFailed] = useState(false)
  const [hasKey, setHasKey] = useState(!!getAiKey())
  const [editKey, setEditKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')

  const summary = valuation ? buildBlockSummary(state) : null
  // Fingerprint the summary so ANY change (data breadth, valuation, expectation,
  // guidance) produces a new key and re-runs the analysis.
  const fp = summary ? hashStr(JSON.stringify(summary)) : ''
  const key = state?.ticker && summary ? `${state.ticker}|${fp}` : null

  useEffect(() => {
    if (!key || !valuation || !hasKey || !summary) return
    if (_cache.has(key)) { setText(_cache.get(key)); return }
    let cancelled = false
    ;(async () => {
      // 1) Persistent cache: same ticker + same data → reuse, no API call
      //    (survives refresh and sessions; only regenerates when data changes).
      const saved = await getAiVerdict(state.ticker, fp)
      if (cancelled) return
      if (saved) { _cache.set(key, saved); setText(saved); return }
      // 2) Miss → generate once, then persist under this ticker+fingerprint.
      setLoad(true); setText(null); setFailed(false)
      try {
        const r = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary, userKey: getAiKey() }),
        })
        const d = await r.json()
        if (cancelled) return
        if (d?.text) {
          _cache.set(key, d.text); setText(d.text)
          setAiVerdict(state.ticker, fp, d.text)   // persist latest-per-ticker
        } else setFailed(true)
      } catch { if (!cancelled) setFailed(true) }
      finally { if (!cancelled) setLoad(false) }
    })()
    return () => { cancelled = true }
  }, [key, hasKey])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!valuation) return null

  const saveKey = () => {
    setAiKey(keyInput)
    setHasKey(!!keyInput.trim())
    setEditKey(false); setKeyInput('')
    _cache.clear()
  }
  const removeKey = () => { clearAiKey(); setHasKey(false); setText(null); _cache.clear() }

  // Key entry UI (shown when no key, or when editing).
  const KeyBox = (
    <div className="mt-2 text-xs bg-navy-800/50 rounded-lg p-3 space-y-2">
      <div className="text-slate-300">Enable AI analysis with your own Gemini API key</div>
      <div className="flex gap-2">
        <input type="password" value={keyInput} onChange={e => setKeyInput(e.target.value)}
          placeholder="Paste Gemini API key…" className="input-field text-xs flex-1" />
        <button onClick={saveKey} className="btn-primary text-xs shrink-0">Save</button>
        {hasKey && <button onClick={() => setEditKey(false)} className="text-slate-500 text-xs">Cancel</button>}
      </div>
      <p className="text-[10px] text-slate-600">
        Stored in this browser tab only (cleared when you close it). Get a free key at Google AI Studio,
        and set a usage limit on it. Sent only to Google via our server; never stored on our side.
      </p>
    </div>
  )

  // Fallback boilerplate (used when no key, or the AI call failed).
  const guided = valuation?.assumptions?.nearTermGrowth != null
    ? valuation.assumptions.nearTermGrowth * 100 : null
  const ins = expectationInsight(valuation, marketExpectation, ratioResult, state.stage, guided)
  const Boilerplate = ins?.text ? (
    <div className="mt-2 space-y-1.5">
      <p className="text-sm text-slate-200 leading-relaxed">📊 {ins.text}</p>
      {ins.bases && <p className="text-xs text-slate-400 leading-relaxed">{ins.bases}</p>}
    </div>
  ) : null

  if (editKey) return KeyBox
  if (!hasKey) return <>{Boilerplate}{KeyBox}</>
  if (loading) return <p className="text-sm text-slate-500 leading-relaxed mt-2 animate-pulse">Generating AI analysis…</p>
  if (text) return (
    <div className="mt-2">
      <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">🤖 {text}</p>
      <div className="flex items-center gap-3 mt-1">
        <span className="text-[10px] text-slate-600">AI-generated from the dashboard figures. Analytical opinion, not investment advice.</span>
        <button onClick={() => setEditKey(true)} className="text-[10px] text-slate-500 hover:text-slate-300">change key</button>
        <button onClick={removeKey} className="text-[10px] text-slate-500 hover:text-bear">remove key</button>
      </div>
    </div>
  )
  // key present but call failed → boilerplate + retry affordance
  return (
    <div>
      {Boilerplate}
      {failed && <p className="text-[10px] text-neutral mt-1">AI analysis unavailable right now — showing the built-in summary. <button onClick={() => setEditKey(true)} className="underline">check key</button></p>}
    </div>
  )
}
