import React from 'react'
import { METRICS } from '../../engine/metrics.js'

/**
 * A pasted Screener row whose label matches no known alias is silently
 * dropped by parsePastedTable() otherwise — the user only ever sees the
 * downstream symptom (a field reading blank), never the cause. This is
 * that surfaced: one dropdown per unmatched label, letting the user say
 * what it means. A confirmed mapping is saved (src/utils/db.js's
 * aliasOverrides, via onMap) so the exact same wording never asks again.
 *
 * Only for Screener — a fixed, documented API surface (Yahoo/SEC) is the
 * app's job to get right in code, not something to ask the user to
 * arbitrate at runtime.
 */
export default function AliasReconcile({ tableType, unmatched, onMap }) {
  if (!unmatched?.length) return null

  const fieldTable = tableType === 'quarterly' ? 'income' : tableType
  const options = Object.entries(METRICS)
    .filter(([, m]) => m.table === fieldTable)
    .map(([key, m]) => ({ key, label: m.label }))

  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-2 space-y-1.5">
      <p className="text-xs text-accent">
        {unmatched.length} row{unmatched.length > 1 ? 's' : ''} in this paste
        {unmatched.length > 1 ? " weren't recognized" : " wasn't recognized"} —
        say what {unmatched.length > 1 ? 'they mean' : 'it means'} and it won't ask again.
      </p>
      {unmatched.map(u => (
        <div key={u.normalizedLabel} className="flex items-center gap-2 text-xs">
          <span className="text-slate-300 flex-1 truncate" title={u.rawLabel}>{u.rawLabel}</span>
          <select
            defaultValue=""
            onChange={e => {
              const v = e.target.value
              if (v) onMap(u, v === '__ignore' ? null : v)
            }}
            className="bg-navy-800 border border-navy-700 rounded px-1.5 py-1 text-slate-300 text-[11px] max-w-[45%]">
            <option value="" disabled>this means…</option>
            {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            <option value="__ignore">ignore this row</option>
          </select>
        </div>
      ))}
    </div>
  )
}
