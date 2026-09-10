import React, { useState, useEffect, useMemo } from 'react'
import { findMissingBaseMetrics, TABLE_INFO , expandHintsForTable } from '../../engine/dataGaps.js'
import { parsePastedTable, tagPastedRows } from '../../utils/pasteParser.js'
import { useApp } from '../../store/AppContext.jsx'
import { getAliasOverrides, saveAliasOverride, deleteAliasOverride } from '../../utils/db.js'
import AliasReconcile from './AliasReconcile.jsx'
import Modal from '../Modal.jsx'

const STEP_ICON = { income: '📊', balance: '⚖️', cashflow: '💵' }

const screenerUrl = (ticker) =>
  ticker
    ? `https://www.screener.in/company/${ticker.replace(/\.(NS|BO)$/i, '').toUpperCase()}/consolidated/`
    : null

// Screener reports financials in ₹ Crore; the app stores absolute currency.
// Scale pasted numbers for Indian tickers so they line up with Yahoo data.
// Screener reports in ₹ Crore; the app stores absolute currency. Scale pasted
// numbers when the loaded stock is INR (Indian). Uses currency (reliable) with
// the exchange suffix as a fallback — the raw ticker often lacks .NS/.BO.
const pasteScale = (currency, ticker) =>
  (currency === 'INR' || /.(NS|BO)$/i.test(ticker || '')) ? 1e7 : 1

export default function GapFillModal({ open, onClose, ratioResult, ticker, onApply }) {
  const { state: appState } = useApp()
  const currency = appState?.data?.currency
  const data     = appState?.data
  // Stable plan captured when the modal opens. We must NOT drive the wizard off
  // the live ratioResult — it shrinks as gaps get filled, which previously made
  // the step indexing and the "all done" check break mid-flow.
  const [plan, setPlan] = useState({ tables: [], byTable: {} })
  const [stepIdx, setStepIdx]     = useState(0)
  const [pasteText, setPasteText] = useState('')
  const [preview, setPreview]     = useState(null)
  const [completed, setCompleted] = useState({})
  const [finished, setFinished]   = useState(false)
  // Screener row-label -> field mappings already confirmed, for whichever
  // table is the current step — full rows (not just the flattened
  // label->field map parsePastedTable wants), so AliasReconcile can
  // actually display and revise them rather than only applying them
  // silently.
  const [overrideRows, setOverrideRows] = useState([])
  const flatOverrides = Object.fromEntries(overrideRows.map(r => [r.normalizedLabel, r.field]))

  // (Re)initialise every time the modal is opened.
  useEffect(() => {
    if (!open) return
    const { byTable } = findMissingBaseMetrics(ratioResult, data)
    const tables = Object.keys(byTable)
    setPlan({ tables, byTable })
    setStepIdx(0)
    setPasteText('')
    setPreview(null)
    setCompleted({})
    setFinished(tables.length === 0)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reload confirmed mappings whenever the active step's table changes, so a
  // mapping confirmed earlier (this session or a previous one) is already
  // applied silently rather than re-prompted.
  useEffect(() => {
    if (!open) return
    const t = plan.tables[stepIdx]
    if (!t) { setOverrideRows([]); return }
    (async () => setOverrideRows(await getAliasOverrides(t)))()
  }, [open, stepIdx, plan.tables])

  // Live view of what is still missing — used only to relabel a step, never to
  // resize the wizard.
  // `data` matters: capex and cogs live on the history rows, not on ratioResult.
  // Without it they read as permanently missing.
  const gaps = useMemo(
    () => findMissingBaseMetrics(ratioResult, data),
    [ratioResult, data]
  )
  const liveByTable = gaps.byTable

  if (!open) return null

  const { tables } = plan
  const currentTable  = tables[stepIdx]
  const tableInfo     = currentTable ? TABLE_INFO[currentTable] : null
  // Prefer the live missing-list for this table (fields a prior step may have
  // already resolved drop off), falling back to the snapshot.
  const currentMissing = (liveByTable[currentTable] || plan.byTable[currentTable] || [])
  const isLastStep    = stepIdx >= tables.length - 1
  const url           = screenerUrl(ticker)
  const expandHints   = expandHintsForTable(gaps, currentTable)

  const handleParse = () => {
    setPreview(parsePastedTable(pasteText, currentTable, { overrides: flatOverrides }))
  }

  // A row's meaning confirmed in the reconciliation prompt: save it (so the
  // exact same wording never asks again) and re-parse with it applied.
  // `field === null` means "ignore this row" — not persisted, since that's
  // a per-paste call rather than a durable fact about what the label means.
  const handleMap = async (u, field) => {
    let rows = overrideRows
    if (field) {
      await saveAliasOverride({ tableType: currentTable, normalizedLabel: u.normalizedLabel, rawLabel: u.rawLabel, field })
      rows = [...rows.filter(r => r.normalizedLabel !== u.normalizedLabel),
              { tableType: currentTable, normalizedLabel: u.normalizedLabel, rawLabel: u.rawLabel, field }]
      setOverrideRows(rows)
    }
    if (!pasteText.trim()) return
    const next = Object.fromEntries(rows.map(r => [r.normalizedLabel, r.field]))
    setPreview(prev => field
      ? parsePastedTable(pasteText, currentTable, { overrides: next })
      : { ...prev, unmatched: (prev?.unmatched || []).filter(x => x.normalizedLabel !== u.normalizedLabel) })
  }

  // A previously-confirmed mapping, changed or forgotten — see
  // AddHistoryModal's handleRevise for the same logic; kept in sync with it.
  const handleRevise = async (override, newField) => {
    let rows
    if (newField) {
      await saveAliasOverride({ tableType: currentTable, normalizedLabel: override.normalizedLabel, rawLabel: override.rawLabel, field: newField })
      rows = overrideRows.map(r => r.normalizedLabel === override.normalizedLabel ? { ...r, field: newField } : r)
    } else {
      await deleteAliasOverride({ tableType: currentTable, normalizedLabel: override.normalizedLabel })
      rows = overrideRows.filter(r => r.normalizedLabel !== override.normalizedLabel)
    }
    setOverrideRows(rows)
    if (!pasteText.trim()) return
    const next = Object.fromEntries(rows.map(r => [r.normalizedLabel, r.field]))
    setPreview(prev => (prev ? parsePastedTable(pasteText, currentTable, { overrides: next }) : prev))
  }

  const advance = () => {
    setPasteText('')
    setPreview(null)
    if (isLastStep) setFinished(true)
    else setStepIdx(i => i + 1)
  }

  const handleConfirmStep = () => {
    // A rejected paste (wrong table / quarterly) parses to zero rows. Applying it
    // would blank the step rather than fill it. The warning is already on screen.
    if (!preview || preview.rejected) return
    const tagged = tagPastedRows(preview.rows, currentTable, { scale: pasteScale(currency, ticker) })
    onApply(currentTable, tagged)
    setCompleted(prev => ({ ...prev, [currentTable]: true }))
    advance()
  }

  const handleSkipStep = () => advance()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Fill missing data"
      subtitle={!finished ? `Step ${stepIdx + 1} of ${tables.length}` : null}
    >
        {/* Step progress dots */}
        {!finished && (
          <div className="flex gap-1.5">
            {tables.map((t, i) => (
              <div key={t}
                className={`h-1.5 flex-1 rounded-full ${
                  completed[t] ? 'bg-bull' : i === stepIdx ? 'bg-accent' : 'bg-navy-800'
                }`} />
            ))}
          </div>
        )}

        {!finished && currentTable ? (
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

              {/* Some metrics are only visible once a row is expanded. Name the
                  exact "+" to click, and only for the ones actually missing —
                  we can't click it ourselves (it's someone else's website, and
                  the browser won't let us reach into that tab). */}
              {expandHints.length > 0 && (
                <div className="rounded border border-accent/30 bg-accent/5 px-2 py-1.5 space-y-1">
                  {expandHints.map(h => (
                    <p key={h.expand} className="text-xs text-slate-300">
                      Click the <strong className="text-accent">+</strong> on the{' '}
                      <strong className="text-accent">{h.expand}</strong> row first — it reveals{' '}
                      <strong>{h.metrics.join(', ')}</strong>
                      <span className="text-slate-500"> (needed for {h.needs.join('; ')})</span>
                    </p>
                  ))}
                </div>
              )}
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer"
                   className="btn-ghost text-sm w-full inline-flex items-center justify-center">
                  Open Screener for {ticker} →
                </a>
              ) : (
                <p className="text-xs text-bear">No ticker available to open Screener.</p>
              )}
            </div>

            {/* Saved mappings for this step's table, always shown — not
                gated on the current paste having unmatched rows, since
                revising a wrong one has to be reachable before pasting
                again too. Unmatched rows from a parsed preview show in the
                same block once there are any. */}
            <AliasReconcile tableType={currentTable} unmatched={preview?.unmatched || []}
              onMap={handleMap} savedOverrides={overrideRows} onRevise={handleRevise} />

            {/* Step 2: paste */}
            <div className="space-y-2">
              <p className="text-xs text-slate-400">2. Paste it here</p>
              {/* Clear below the box, not above — see AddHistoryModal. Font
                  stays xs so the paste keeps its column width. */}
              <textarea
                value={pasteText}
                onChange={e => { setPasteText(e.target.value); setPreview(null) }}
                placeholder="Paste the copied table here..."
                rows={5}
                className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2
                           text-xs font-mono text-slate-200 placeholder-slate-600
                           focus:outline-none focus:border-accent resize-none"
              />
              {pasteText.trim().length > 0 && (
                <div className="flex justify-end">
                  <button type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { setPasteText(''); setPreview(null) }}
                    className="text-[11px] px-2 py-1 rounded border border-navy-700 text-slate-400 hover:text-bear hover:border-bear/50 transition-colors">
                    ✕ Clear
                  </button>
                </div>
              )}
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
                <p className="text-xs text-slate-500">Values shown as pasted (₹ Crore for Screener). Check against your Screener tab before confirming.</p>
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
    </Modal>
  )
}

