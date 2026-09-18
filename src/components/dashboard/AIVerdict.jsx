import React, { useEffect, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { buildBlockSummary } from '../../engine/buildBlockSummary.js'
import { useEstimate } from '../../store/useEstimate.js'
import { expectationInsight } from '../../engine/valuation.js'
import { getAiKey, setAiKey, clearAiKey, isKeyRemembered } from '../../utils/aiKey.js'
import { getAiVerdict, setAiVerdict } from '../../utils/db.js'

// Map raw API/Gemini errors to something a user can act on (never fail silently).
function friendlyAiError(err, raw) {
  const e = String(err || '').toLowerCase()
  const detail = String(raw?.error?.message || '').toLowerCase()
  const both = e + ' ' + detail
  if (both.includes('400') || both.includes('api key not valid') || both.includes('invalid'))
    return 'Your Gemini API key looks invalid — check that you pasted it correctly.'
  if (both.includes('401') || both.includes('403') || both.includes('permission') || both.includes('unauthor'))
    return 'Your API key was rejected (unauthorised). It may be revoked or restricted.'
  if (both.includes('429') || both.includes('quota') || both.includes('rate'))
    return 'Rate limit or quota exceeded on your Gemini key — wait a bit, or check your usage limit.'
  if (both.includes('500') || both.includes('503') || both.includes('unavailable'))
    return "Google's AI service is temporarily unavailable. Try again shortly."
  if (both.includes('failed to fetch') || both.includes('network'))
    return 'Network error — check your connection.'
  return err ? `Error: ${err}` : 'Unknown error from the AI service.'
}

// Session cache so we don't re-call the API every render / re-open.
const _cache = new Map()
function hashStr(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0 } return h.toString(36) }

export default function AIVerdict() {
  const { state } = useApp()
  const { valuation, marketExpectation, ratioResult } = state || {}
  const [text, setText]   = useState(null)
  const [loading, setLoad] = useState(false)
  const [failed, setFailed] = useState(false)
  const [errMsg, setErrMsg] = useState('')
  const [keyVal, setKeyVal] = useState(() => getAiKey())
  const hasKey = !!keyVal
  const [editKey, setEditKey] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [remember, setRemember] = useState(true)
  const [showKey, setShowKey] = useState(false)
  const [modelVal, setModelVal] = useState('gemini-2.5-flash')

  // The estimates and consensus are part of the payload, so the fingerprint
  // below covers them too: a re-rating, a revision that moves an estimate, or a
  // moat/quality change all alter the summary and therefore re-run the verdict
  // on their own. No separate trigger wiring is needed.
  const { estimate, justified, sanity } = useEstimate(state)
  const summary = valuation
    ? buildBlockSummary(state, {
        estimate, justified, sanity,
        analystTarget: state.analystTarget || null,
      })
    : null
  // Fingerprint the summary so ANY change (data breadth, valuation, expectation,
  // guidance) produces a new key and re-runs the analysis.
  const fp = summary ? hashStr(JSON.stringify(summary)) : ''
  const key = state?.ticker && summary ? `${state.ticker}|${fp}|${modelVal}` : null

  // Cache-check ONLY — never calls the API on its own. A miss here just
  // leaves `text` null, and the render below shows an explicit "Generate"
  // trigger instead of firing a paid call automatically. This is the fix for
  // "don't auto-trigger": the old version called /api/analyze itself the
  // moment a key existed and nothing was cached, including the instant a key
  // was first saved (keyVal was in this effect's own dependency array).
  useEffect(() => {
    if (!key || !valuation || !summary) return
    if (_cache.has(key)) { setText(_cache.get(key)); setFailed(false); return }
    setText(null); setFailed(false); setErrMsg('')   // avoid showing a stale prior ticker's text while this one loads
    let cancelled = false
    ;(async () => {
      const saved = await getAiVerdict(state.ticker, fp)
      if (cancelled) return
      if (saved) { _cache.set(key, saved); setText(saved) }
    })()
    return () => { cancelled = true }
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!valuation) return null

  // Key storage is fully separate from generation — saving/removing a key
  // never calls the API. keyVal isn't in the cache-check effect's deps
  // above, so nothing reacts to it; the only path to a paid call is the
  // explicit generate()/refresh() below, both triggered by a click.
  const saveKey = () => {
    const cleaned = keyInput.trim()
    setKeyVal(cleaned)              // in-memory: used for requests this session
    setAiKey(cleaned, remember)     // best-effort persistence (may fail in private/in-app browsers)
    setEditKey(false); setKeyInput('')
  }
  const removeKey = () => { clearAiKey(); setKeyVal('') }

  // The one place that actually spends tokens — always a direct response to
  // a click (the "Generate AI analysis" button, "↻ Refresh analysis", or
  // "Try again" after a failure), never called from an effect.
  const generate = async () => {
    if (!key || !hasKey) return
    setLoad(true); setFailed(false); setErrMsg('')
    try {
      const r = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary, userKey: keyVal, model: modelVal }),
      })
      const d = await r.json()
      if (d?.text) {
        _cache.set(key, d.text); setText(d.text)
        setAiVerdict(state.ticker, fp, d.text)   // persist latest-per-ticker
      } else {
        setFailed(true)
        setErrMsg(friendlyAiError(d?.error, d?.raw))
      }
    } catch (e) {
      setFailed(true); setErrMsg(friendlyAiError(String(e?.message || e)))
    } finally {
      setLoad(false)
    }
  }
  // Re-run over an existing verdict: clear its cache entry first so a stale
  // one can't flash back in before the fresh call resolves.
  const refresh = () => { _cache.delete(key); generate() }

  // Key entry UI (shown when no key, or when editing).
  const KeyBox = (
    <div className="mt-2 text-xs bg-navy-800/50 rounded-lg p-3 space-y-2">
      <div className="text-slate-300">Enable AI analysis with your own Gemini API key</div>
      <form onSubmit={e => { e.preventDefault(); saveKey() }} className="flex flex-col sm:flex-row gap-2">
        <select value={modelVal} onChange={e => setModelVal(e.target.value)} className="input-field text-xs bg-navy-900 cursor-pointer sm:w-auto">
          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
          <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
          <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
          <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
        </select>
        <div className="flex flex-1 gap-2">
          <div className="relative flex-1 flex">
            <input type={showKey ? "text" : "password"} value={keyInput} onChange={e => setKeyInput(e.target.value)}
              autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off"
              inputMode="text" placeholder="Paste Gemini API key…" className="input-field text-xs flex-1 pr-8" />
            <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200">
              {showKey ? '🙈' : '👁️'}
            </button>
          </div>
          <button type="submit" className="btn-primary text-xs shrink-0">Save</button>
          {hasKey && <button type="button" onClick={() => setEditKey(false)} className="text-slate-500 text-xs shrink-0">Cancel</button>}
        </div>
      </form>
      <label className="flex items-center gap-2 text-[11px] text-slate-400">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
        Remember on this device (stay signed in after closing the browser)
      </label>
      <p className="text-[10px] text-slate-600">
        {remember
          ? 'Saved on this device until you clear it.'
          : 'Kept only for this session (cleared when you close the browser).'}
        {' '}Get a free key at Google AI Studio and set a usage limit on it. Sent only to Google via our server; never stored on our side.
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
  if (loading) return <p className="text-sm text-slate-500 leading-relaxed mt-2 animate-pulse">Generating AI analysis…</p>
  // A cached/generated verdict shows regardless of whether a key is present now.
  if (text) return (
    <div className="mt-2">
      <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">🤖 {text}</p>
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        {hasKey && (
          <button onClick={refresh} title="Re-run the AI analysis on the current dashboard figures (uses tokens)"
            className="text-[10px] text-accent hover:text-accent-light inline-flex items-center gap-1">
            ↻ Refresh analysis
          </button>
        )}
        <span className="text-[10px] text-slate-600">AI-generated from the dashboard figures. Analytical opinion, not investment advice.</span>
        <button onClick={() => setEditKey(true)} className="text-[10px] text-slate-500 hover:text-slate-300">change key</button>
        <button onClick={removeKey} className="text-[10px] text-slate-500 hover:text-bear">remove key</button>
      </div>
    </div>
  )
  // No cached verdict and no key → show boilerplate + key prompt.
  if (!hasKey) return <>{Boilerplate}{KeyBox}</>
  // Key present, nothing cached, nothing attempted yet → boilerplate + an
  // explicit trigger. This is the state that used to auto-call the API.
  if (!failed) return (
    <div>
      {Boilerplate}
      <button onClick={generate} title="Uses your Gemini key"
        className="mt-1.5 text-[11px] text-accent hover:text-accent-light inline-flex items-center gap-1">
        ✨ Generate AI analysis
      </button>
    </div>
  )
  // Key present but the last call failed → boilerplate + retry affordance.
  return (
    <div>
      {Boilerplate}
      {failed && (
        <div className="mt-1.5 text-[11px] rounded-lg border border-bear/40 bg-bear/10 px-2.5 py-1.5 text-bear">
          <div className="font-semibold">AI analysis failed</div>
          <div className="text-slate-300">{errMsg || 'Could not reach the AI service.'} Showing the built-in summary instead.</div>
          <div className="flex gap-3 mt-1">
            <button onClick={refresh} className="underline text-accent">Try again</button>
            <button onClick={() => setEditKey(true)} className="underline text-slate-400">Check key</button>
          </div>
        </div>
      )}
    </div>
  )
}
