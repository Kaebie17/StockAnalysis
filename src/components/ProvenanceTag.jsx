import React from 'react'
import { tierMeta } from '../engine/provenance.js'

/**
 * ProvenanceTag — a tiny badge marking a value as Real / Calculated / Estimated.
 * Usage: <ProvenanceTag tier={metric.tier} /> or <ProvenanceTag tier="estimated" method="trend ratio" />
 */
export default function ProvenanceTag({ tier, method, compact = false }) {
  if (!tier) return null
  const m = tierMeta(tier)
  const cls = { bull: 'text-bull', accent: 'text-accent', neutral: 'text-neutral', slate: 'text-slate-500' }[m.color]
  return (
    <span className={`inline-flex items-center text-[9px] font-semibold ${cls}`}
      title={method ? `${m.hint} — ${method}` : m.hint}>
      {compact ? m.short : m.label}
      {method && !compact ? ` · ${method}` : ''}
    </span>
  )
}
