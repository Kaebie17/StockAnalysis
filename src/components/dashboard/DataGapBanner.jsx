import React from 'react'
import { findMissingBaseMetrics } from '../../engine/dataGaps.js'

export default function DataGapBanner({ ratioResult, data, dismissed = [], onDismiss, onFix }) {
  // `data` is required: capex and cogs sit on the history rows, not on
  // ratioResult. Called without it they read as permanently missing.
  const { missing, softGaps, byTable, nextStep, dismissed: hiddenGaps } =
    findMissingBaseMetrics(ratioResult, data, dismissed)

  // Nothing left to act on → no banner at all.
  //
  // The old guard hid the banner the moment `missing` (hard gaps) emptied out,
  // on the theory that softGaps (capex ~ depreciation, an unconfirmed
  // exceptional-items row) outlive any fix — they're still "estimated" after
  // every hard gap is filled, so a banner gated on softGaps alone would read
  // "0 metrics missing" forever next to a dead "Fix this →" button. That
  // reasoning held only while soft gaps genuinely had nowhere to go. Now that
  // GapFillModal gives a soft-but-actionable gap (one with a real Screener/AR
  // source, per findMissingBaseMetrics) its own optional wizard step, the
  // button isn't dead any more when only those remain — so the real test is
  // whether `byTable` (which now includes both) still has anything in it, not
  // whether `missing` specifically does.
  if (missing.length === 0 && Object.keys(byTable).length === 0) return null

  const hasHardMissing = missing.length > 0

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5
                    bg-neutral/10 border border-neutral/30 rounded-lg text-sm">
      <div className="flex items-start gap-2 min-w-0">
        <span className="shrink-0">{hasHardMissing ? '⚠️' : 'ℹ️'}</span>
        <span className="text-slate-300 min-w-0">
          {hasHardMissing ? (
            <>
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
            </>
          ) : (
            // Nothing hard missing — only soft, actionable gaps remain (capex
            // resting on an estimate, or a conditional exceptional-items/
            // minority-interest row that hasn't been checked). Worth a nudge
            // with a way to act on it, not an alarm.
            <span className="text-slate-400">Some figures are estimated</span>
          )}
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
