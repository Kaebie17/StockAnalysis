import React, { useState, useMemo } from 'react'
import { findMissingBaseMetrics, TABLE_INFO } from '../../engine/dataGaps.js'
import { parsePastedTable, tagPastedRows } from '../../utils/pasteParser.js'

const STEP_ICON = { income: '📊', balance: '⚖️', cashflow: '💵' }

export default function GapFillModal({ open, onClose, ratioResult, ticker, onApply }) {
  const { byTable } = useMemo(() => findMissingBaseMetrics(ratioResult), [ratioResult])
  const tables = Object.keys(byTable) // e.g. ['income', 'cashflow']

  const [stepIdx, setStepIdx] = useState(0)
  const [pasteText, setPasteText] = useState('')
  const [preview, setPreview] = useState(null)
  const [completed, setCompleted] = useState({})

  if (!open || tables.length === 0) return null

  const currentTable = tables[stepIdx]
  const currentMissing = byTable[currentTable]
  const tableInfo = TABLE_INFO[currentTable]
  const isLastStep = stepIdx === tables.length - 1
  const isDone = Object.keys(completed).length === tables.length

  const openScreener = () => {
    if (ticker) window.open(`https://www.screener.in/company/${ticker.replace(/\.(NS|BO)$/i, '')}/consolidated/`, '_blank')
  }

  const handleParse = () => {
    const result = parsePastedTable(pasteText, currentTable)
    setPreview(result)
  }

  const handleConfirmStep = () => {
    if (!preview) return
    const tagged = tagPastedRows(preview.rows, currentTable)
    onApply(currentTable, tagged)
    setCompleted(prev => ({ ...prev, [currentTable]: true }))
    setPasteText('')
    setPreview(null)
    if (!isLastStep) {
      setStepIdx(stepIdx + 1)
    }
  }

  const handleSkipStep = () => {
    setPasteText('')
    setPreview(null)
    if (!isLastStep) setStepIdx(stepIdx + 1)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card max-w-lg w-full space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Fill missing data</h2>
            <p className="text-xs text-slate-500 mt-0.5">Step {stepIdx + 1} of {tables.length}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>

        {/* Step progress dots */}
        <div className="flex gap-1.5">
          {tables.map((t, i) => (
            <div key={t}
              className={`h-1.5 flex-1 rounded-full ${
                completed[t] ? 'bg-bull' : i === stepIdx ? 'bg-accent' : 'bg-navy-800'
              }`} />
          ))}
        </div>

        {!isDone ? (
          <>
            {/* What's needed this step */}
            <div className="bg-navy-800/50 rounded-lg p-3 space-y-1">
              <div className="text-sm font-medium text-white flex items-center gap-2">
                <span>{STEP_ICON[currentTable]}</span>
                {tableInfo.name} table
              </div>
              <p className="text-xs text-slate-400">
                Missing: {currentMissing.map(m => m.label).join(', ')}
              </p>
            </div>

            {/* Step 1: open Screener */}
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                1. Open Screener, find the <strong className="text-slate-300">{tableInfo.screenerSection}</strong> table,
                select it and copy (the whole table, including the year headers)
              </p>
              <button onClick={openScreener} className="btn-ghost text-sm w-full">
                Open Screener for {ticker} →
              </button>
            </div>

            {/* Step 2: paste */}
            <div className="space-y-2">
              <p className="text-xs text-slate-400">2. Paste it here</p>
              <textarea
                value={pasteText}
                onChange={e => { setPasteText(e.target.value); setPreview(null) }}
                placeholder="Paste the copied table here..."
                rows={5}
                className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2
                           text-xs font-mono text-slate-200 placeholder-slate-600
                           focus:outline-none focus:border-accent resize-none"
              />
            </div>

            {!preview && (
              <button
                onClick={handleParse}
                disabled={!pasteText.trim()}
                className="btn-primary text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed">
                Parse
              </button>
            )}

            {/* Preview */}
            {preview && (
              <div className="space-y-2">
                {preview.warnings.length > 0 && (
                  <div className="bg-bear/10 border border-bear/30 rounded-lg p-2 text-xs text-bear">
                    {preview.warnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                )}
                {preview.rows.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-navy-700">
                          <th className="text-left py-1 text-slate-500">Field</th>
                          {preview.years.map(y => (
                            <th key={y} className="text-right py-1 text-slate-500 px-2">{y}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {currentMissing.map(m => (
                          <tr key={m.metric} className="border-b border-navy-800/50">
                            <td className="py-1 text-slate-300">{m.label}</td>
                            {preview.rows.map((row, i) => (
                              <td key={i} className="text-right py-1 px-2 font-mono">
                                {row[m.metric] != null
                                  ? <span className="text-white">{row[m.metric].toLocaleString()}</span>
                                  : <span className="text-slate-600">—</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-xs text-slate-500">Check this against your Screener tab before confirming.</p>
                <div className="flex gap-2">
                  <button onClick={() => setPreview(null)} className="btn-ghost text-sm flex-1">
                    ↺ Try again
                  </button>
                  <button
                    onClick={handleConfirmStep}
                    disabled={preview.matchedCount === 0}
                    className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                    Looks good, add it
                  </button>
                </div>
              </div>
            )}

            {!preview && (
              <button onClick={handleSkipStep} className="text-xs text-slate-500 hover:text-slate-300 w-full text-center">
                Skip this table
              </button>
            )}
          </>
        ) : (
          <div className="text-center py-6 space-y-3">
            <div className="text-3xl">✅</div>
            <p className="text-sm text-slate-300">All set — data added and recalculated.</p>
            <button onClick={onClose} className="btn-primary text-sm">Done</button>
          </div>
        )}
      </div>
    </div>
  )
}
