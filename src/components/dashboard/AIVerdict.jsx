import React, { useEffect, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { buildBlockSummary } from '../../engine/buildBlockSummary.js'
import { expectationInsight } from '../../engine/valuation.js'

// Session cache so we don't re-call the API every render / re-open.
const _cache = new Map()   // key -> text

export default function AIVerdict() {
  const { state } = useApp()
  const { valuation, marketExpectation, ratioResult } = state || {}
  const [text, setText]   = useState(null)
  const [loading, setLoad] = useState(false)

  // Cache key = ticker + guidance (so changing guidance refreshes the analysis).
  const key = state?.ticker
    ? `${state.ticker}|${valuation?.assumptions?.nearTermGrowth ?? ''}|${valuation?.assumptions?.wacc ?? ''}`
    : null

  useEffect(() => {
    if (!key || !valuation) return
    if (_cache.has(key)) { setText(_cache.get(key)); return }
    const summary = buildBlockSummary(state)
    if (!summary) return
    let cancelled = false
    setLoad(true); setText(null)
    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    })
      .then(r => r.json())
      .then(d => { if (!cancelled) { _cache.set(key, d?.text || null); setText(d?.text || null) } })
      .catch(() => { if (!cancelled) setText(null) })
      .finally(() => { if (!cancelled) setLoad(false) })
    return () => { cancelled = true }
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!valuation) return null

  // Loading state — dashboard already rendered; this fills in.
  if (loading) {
    return <p className="text-sm text-slate-500 leading-relaxed mt-2 animate-pulse">Generating analysis…</p>
  }

  // AI result.
  if (text) {
    return (
      <div className="mt-2">
        <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-line">🤖 {text}</p>
        <p className="text-[10px] text-slate-600 mt-1">AI-generated from the dashboard figures. Analytical opinion, not investment advice.</p>
      </div>
    )
  }

  // Fallback — AI unavailable (no key / call failed): the built-in summary.
  const guided = valuation?.assumptions?.nearTermGrowth != null
    ? valuation.assumptions.nearTermGrowth * 100 : null
  const ins = expectationInsight(valuation, marketExpectation, ratioResult, state.stage, guided)
  if (!ins?.text) return null
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-sm text-slate-200 leading-relaxed">📊 {ins.text}</p>
      {ins.bases && <p className="text-xs text-slate-400 leading-relaxed">{ins.bases}</p>}
    </div>
  )
}
