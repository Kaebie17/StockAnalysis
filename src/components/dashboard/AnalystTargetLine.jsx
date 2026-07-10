import React, { useEffect, useRef, useState } from 'react'
import { fetchTargets } from '../../api/targetsClient.js'

/**
 * AnalystTargetLine — one-line analyst target range for the highlight area,
 * placed directly under the Fair value line. Same plain "₹low – ₹high" format.
 * Renders nothing while loading and a quiet note when there's no coverage.
 */
export default function AnalystTargetLine({ ticker, currency }) {
  const [t, setT] = useState(undefined)   // undefined=loading, null=none, obj=data
  const abortRef = useRef(null)

  useEffect(() => {
    if (!ticker) return
    setT(undefined)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    fetchTargets(ticker, ctrl.signal)
      .then(res => { if (!ctrl.signal.aborted) setT(res.ok ? res.targets : null) })
      .catch(() => { if (!ctrl.signal.aborted) setT(null) })
    return () => ctrl.abort()
  }, [ticker])

  if (t === undefined) return null                 // loading — show nothing
  if (!t || (t.low == null && t.high == null && t.mean == null)) {
    return (
      <span>
        <span>Analyst Target: </span>
        <span className="font-mono font-bold text-slate-500 ml-1">no coverage</span>
      </span>
    )
  }

  const cur = symbolFor(t.currency || currency)
  const lo = t.low ?? t.mean
  const hi = t.high ?? t.mean
  const range = lo != null && hi != null && lo !== hi
    ? `${cur}${fmt(lo)} – ${cur}${fmt(hi)}`
    : `${cur}${fmt(t.mean ?? lo ?? hi)}`

  return (
    <span>
      <span>Analyst Target: </span>
      <span className="font-mono font-bold text-white ml-1">{range}</span>
    </span>
  )
}

const fmt = v => (v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: v < 100 ? 1 : 0 }))
function symbolFor(code) {
  return ({ INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }[code]) || (code ? `${code} ` : '')
}
