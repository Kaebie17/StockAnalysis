import React from 'react'
import { tierMeta } from '../engine/methodologyTier.js'

/**
 * ProvenanceTag — a tiny badge marking a value Reported / Derived / Assumed.
 * The one shared badge for methodology-confidence tags across the app —
 * replaces the separate ProvenanceTag (data-quality REAL/CALCULATED/
 * ESTIMATED) and inline ResTag (resolutionBadge icon+hover) that used to
 * disagree on both vocabulary and visual pattern.
 * Usage: <ProvenanceTag tier={result.tier} /> or
 *        <ProvenanceTag tier="assumed" method="sector median fallback" />
 */
export default function ProvenanceTag({ tier, method, compact = false }) {
  if (!tier) return null
  const m = tierMeta(tier)
  return (
    <span className={`inline-flex items-center text-[9px] font-semibold ${m.className}`}
      title={method ? `${m.hint} — ${method}` : m.hint}>
      {compact ? m.short : m.label}
      {method && !compact ? ` · ${method}` : ''}
    </span>
  )
}
