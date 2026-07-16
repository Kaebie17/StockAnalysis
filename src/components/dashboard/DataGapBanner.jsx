
import React from 'react'
import { findMissingBaseMetrics } from '../../engine/dataGaps.js'

export default function DataGapBanner({ ratioResult, data, dismissed = [], onDismiss, onFix }) {
  // `data` is required: capex and cogs sit on the history rows, not on
  // ratioResult. Called without it they read as permanently missing.
  const { hasGaps, missing, byTable, softGaps, nextStep, dismissed: hiddenGaps } =
    findMissingBaseMetrics(ratioResult, data, dismissed)
  if (!hasGaps && !softGaps.length) return null

  const tableCount = Object.keys(byTable).length
  const metricNames = missing.map(m => m.label).join(', ')

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5
                    bg-neutral/10 border border-neutral/30 rounded-lg text-sm">
      <div className="flex items-start gap-2 min-w-0">
        <span className="shrink-0">⚠️</span>
        <span className="text-slate-300 min-w-0">
          <span className="text-neutral font-medium">{missing.length} metric{missing.length > 1 ? 's' : ''} missing</span>
          {' '}{nextStep === 'ar' ? 'after Screener/SEC' : 'from Yahoo'}:{' '}
          {missing.map((m, i) => (
            <span key={m.metric} className="text-slate-400">
              {m.label}
              {onDismiss && (
                <button
                  onClick={() => onDismiss(m.metric)}
                  title={`${m.label} isn't reported for this company — stop asking`}
                  className="ml-0.5 text-slate-600 hover:text-slate-300"
                >×</button>
              )}
              {i < missing.length - 1 ? ', ' : ''}
            </span>
          ))}
          {hiddenGaps.length > 0 && (
            <span className="text-slate-600"> · {hiddenGaps.length} hidden</span>
          )}
          {softGaps.length > 0 && (
            <span className="text-slate-500"> · {softGaps.map(g => g.label).join(', ')} estimated</span>
          )}
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