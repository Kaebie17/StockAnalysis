import React from 'react'
import { findMissingBaseMetrics } from '../../engine/dataGaps.js'

export default function DataGapBanner({ ratioResult, onFix }) {
  const { hasGaps, missing, byTable } = findMissingBaseMetrics(ratioResult)
  if (!hasGaps) return null

  const tableCount = Object.keys(byTable).length
  const metricNames = missing.map(m => m.label).join(', ')

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5
                    bg-neutral/10 border border-neutral/30 rounded-lg text-sm">
      <div className="flex items-start gap-2 min-w-0">
        <span className="shrink-0">⚠️</span>
        <span className="text-slate-300 min-w-0">
          <span className="text-neutral font-medium">{missing.length} metric{missing.length > 1 ? 's' : ''} missing</span>
          {' '}from Yahoo: <span className="text-slate-400">{metricNames}</span>
        </span>
      </div>
      <button
        onClick={onFix}
        className="shrink-0 text-xs font-medium text-accent hover:text-accent-light
                   bg-accent/10 hover:bg-accent/20 px-3 py-1.5 rounded-md transition-colors whitespace-nowrap">
        Fix this →
      </button>
    </div>
  )
}
