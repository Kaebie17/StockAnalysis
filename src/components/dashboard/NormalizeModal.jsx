import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { reconstructRow } from '../../engine/reconstruct.js'
import { parseExcerpt, proposalToEdit } from '../../engine/parseExcerpt.js'
import { parsePastedTable, tagPastedRows } from '../../utils/pasteParser.js'

/**
 * NormalizeModal — manual normalization via paste. Two modes, both paste boxes:
 *
 *   FULL TABLE  → paste a restated P&L table → parsed rows REPLACE those years
 *                 in normalizedIncomeHistory (a complete restated table is the
 *                 answer; no reconstruction needed).
 *
 *   EXCERPT     → paste a sentence/snippet from the report → the app deciphers
 *                 {line, year, value} and PROPOSES a reconstruction, which the
 *                 user confirms/corrects before it is applied. Free-text parsing
 *                 is never trusted blind.
 *
 * Reported data is never overwritten — normalized rows live in a separate table
 * the basis toggle switches to. All hooks are ABOVE the early return.
 */

const cur = c => (c === 'INR' ? '\u20b9' : '$')
const num = f => (f && typeof f === 'object' ? f.value : f)
const yr  = row => String(row?.year ?? '')

const LINE_LABELS = {
  otherIncome: 'Other income', expenses: 'Expenses', interest: 'Interest',
  depreciation: 'Depreciation', tax: 'Tax', revenue: 'Revenue',
}

export default function NormalizeModal({ open, onClose }) {
  const { state, applyNormalization, setBasis } = useApp()
  const income   = state?.data?.incomeHistory || []
  const currency = state?.data?.currency
  const div   = currency === 'INR' ? 1e7 : 1e6
  const unit  = currency === 'INR' ? 'Cr' : 'M'
  const sym   = cur(currency)
  const scale = currency === 'INR' ? 1e7 : 1

  const [mode, setMode]         = useState('excerpt')
  const [text, setText]         = useState('')
  const [proposal, setProposal] = useState(null)
  const [edit, setEdit]         = useState(null)
  const [tableResult, setTableResult] = useState(null)
  const [applied, setApplied]   = useState(false)

  useEffect(() => {
    if (!open) return
    setMode('excerpt'); setText(''); setProposal(null); setEdit(null)
    setTableResult(null); setApplied(false)
  }, [open])

  useEffect(() => {
    if (!open || mode !== 'excerpt') return
    if (!text.trim()) { setProposal(null); setEdit(null); return }
    const p = parseExcerpt(text)
    setProposal(p)
    setEdit({ line: p.line, year: p.year, mode: p.mode, value: p.value, percent: p.percent })
  }, [open, mode, text])

  if (!open) return null

  const reportedRowFor = (y) => income.find(r => yr(r) === String(y)) || null
  const g = (row, f) => num(row?.[f])

  let excerptPreview = null
  if (mode === 'excerpt' && edit?.line && edit?.year && edit?.mode) {
    const rr = reportedRowFor(edit.year)
    if (!rr) excerptPreview = { ok: false, reason: 'No reported data for ' + edit.year + '.' }
    else {
      const reportedVal = num(rr[edit.line])
      const editForRecon = proposalToEdit(
        { line: edit.line, mode: edit.mode, value: edit.value, percent: edit.percent },
        reportedVal
      )
      excerptPreview = editForRecon
        ? reconstructRow(rr, [{ ...editForRecon, taxed: true }])
        : { ok: false, reason: 'Incomplete \u2014 check the value.' }
    }
  }

  const parseTable = () => setTableResult(parsePastedTable(text, 'income'))

  const applyExcerpt = () => {
    if (!excerptPreview?.ok) return
    const existing = state?.data?.normalizedIncomeHistory || []
    const rows = [...existing.filter(r => yr(r) !== String(edit.year)), excerptPreview.row]
      .sort((a, b) => yr(a).localeCompare(yr(b)))
    applyNormalization(rows); setBasis('normalized'); setApplied(true)
  }

  const applyTable = () => {
    if (!tableResult || !tableResult.rows?.length) return
    const tagged = tagPastedRows(tableResult.rows, 'income', { scale })
    const existing = state?.data?.normalizedIncomeHistory || []
    const byYear = Object.fromEntries(existing.map(r => [yr(r), r]))
    for (const row of tagged) byYear[yr(row)] = row
    const rows = Object.values(byYear).sort((a, b) => yr(a).localeCompare(yr(b)))
    applyNormalization(rows); setBasis('normalized'); setApplied(true)
  }

  const compareFields = [
    ['revenue', 'Revenue'], ['otherIncome', 'Other income'],
    ['profitBeforeTax', 'Profit before tax'], ['tax', 'Tax'],
    ['netProfit', 'Net profit'], ['eps', 'EPS'],
  ]
  const rrForPreview = edit?.year ? reportedRowFor(edit.year) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card max-w-xl w-full space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Normalize from the report</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Paste a full restated table (replaces those years) or an excerpt (the app
              reads the line, year and value \u2014 you confirm). Reported stays untouched.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">\u2715</button>
        </div>

        {applied ? (
          <div className="text-center py-6 space-y-3">
            <div className="text-3xl">\u2705</div>
            <p className="text-sm text-slate-300">Normalized basis updated \u2014 toggle in the header to compare.</p>
            <button onClick={onClose} className="btn-primary text-sm">Done</button>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              {[['excerpt', 'Paste excerpt'], ['table', 'Paste full table']].map(([m, lbl]) => (
                <button key={m}
                  onClick={() => { setMode(m); setText(''); setProposal(null); setEdit(null); setTableResult(null) }}
                  className={'flex-1 py-1.5 rounded-lg text-xs border ' + (mode === m ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400')}>
                  {lbl}
                </button>
              ))}
            </div>

            <textarea
              value={text}
              onChange={e => { setText(e.target.value); setTableResult(null) }}
              rows={mode === 'table' ? 5 : 3}
              placeholder={mode === 'table'
                ? 'Paste the restated P&L table (with year headers), like the Screener paste\u2026'
                : 'e.g. "Other income for FY2022 included a one-off gain of \u20b93,000 Cr" or "Restated tax for FY2023 was \u20b91,200 Cr"'}
              className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />

            {mode === 'excerpt' && proposal && (
              <>
                <div className={'text-xs rounded-lg px-3 py-2 ' + (proposal.ok ? 'bg-navy-800/50 text-slate-300' : 'bg-neutral/10 text-neutral')}>
                  {proposal.note}
                </div>

                {edit && (
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-slate-500">Line</label>
                      <select value={edit.line || ''} onChange={e => setEdit({ ...edit, line: e.target.value })}
                        className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1 text-xs text-slate-200 mt-0.5">
                        <option value="">\u2014</option>
                        {Object.entries(LINE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500">Year</label>
                      <input value={edit.year || ''} onChange={e => setEdit({ ...edit, year: e.target.value })}
                        className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1 text-xs text-slate-200 mt-0.5 font-mono" />
                    </div>
                    <div>
                      <label className="text-[10px] text-slate-500">Reading</label>
                      <select value={edit.mode || ''} onChange={e => setEdit({ ...edit, mode: e.target.value })}
                        className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1 text-xs text-slate-200 mt-0.5">
                        <option value="set">Set to</option>
                        <option value="remove">Remove amount</option>
                        <option value="percent">% change</option>
                      </select>
                    </div>
                  </div>
                )}

                {edit && edit.mode !== 'percent' && (
                  <div>
                    <label className="text-[10px] text-slate-500">
                      {edit.mode === 'remove' ? 'Amount to remove' : 'New value'} ({sym}, {unit})
                    </label>
                    <input type="number" inputMode="decimal"
                      value={edit.value != null ? Math.round(edit.value / div) : ''}
                      onChange={e => setEdit({ ...edit, value: e.target.value === '' ? null : +e.target.value * div })}
                      className="w-40 bg-navy-800 border border-navy-700 rounded px-2 py-1 text-xs font-mono text-slate-200 mt-0.5" />
                  </div>
                )}
                {edit && edit.mode === 'percent' && (
                  <div>
                    <label className="text-[10px] text-slate-500">Percent change</label>
                    <input type="number" inputMode="decimal" value={edit.percent ?? ''}
                      onChange={e => setEdit({ ...edit, percent: e.target.value === '' ? null : +e.target.value })}
                      className="w-28 bg-navy-800 border border-navy-700 rounded px-2 py-1 text-xs font-mono text-slate-200 mt-0.5" />
                    <span className="text-slate-500 text-xs ml-1">%</span>
                  </div>
                )}

                {excerptPreview && !excerptPreview.ok && (
                  <div className="text-xs rounded-lg px-3 py-2 bg-bear/10 text-bear">
                    Can't reconcile: {excerptPreview.reason}
                  </div>
                )}
                {excerptPreview?.ok && rrForPreview && (
                  <PreviewTable reported={rrForPreview} row={excerptPreview.row}
                    fields={compareFields} div={div} sym={sym} unit={unit} g={g} />
                )}

                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-sm flex-1">Cancel</button>
                  <button onClick={applyExcerpt} disabled={!excerptPreview?.ok}
                    className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                    Apply &amp; switch to normalized
                  </button>
                </div>
              </>
            )}

            {mode === 'table' && (
              <>
                {!tableResult && (
                  <button onClick={parseTable} disabled={!text.trim()}
                    className="btn-primary text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed">
                    Parse table
                  </button>
                )}
                {tableResult && (
                  <>
                    {tableResult.warnings?.length > 0 && (
                      <div className="text-xs rounded-lg px-3 py-2 bg-neutral/10 text-neutral">
                        {tableResult.warnings[0]}
                      </div>
                    )}
                    {tableResult.rows?.length > 0 ? (
                      <p className="text-xs text-slate-400">
                        Parsed {tableResult.rows.length} years ({tableResult.years?.join(', ')}). These replace the
                        same years in the normalized basis.
                      </p>
                    ) : (
                      <p className="text-xs text-bear">Nothing recognized \u2014 check the table has year headers.</p>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => setTableResult(null)} className="btn-ghost text-sm flex-1">\u21ba Try again</button>
                      <button onClick={applyTable} disabled={!tableResult.rows?.length}
                        className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                        Replace &amp; switch to normalized
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function PreviewTable({ reported, row, fields, div, sym, unit, g }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-slate-300">Reported \u2192 Normalized</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="border-b border-navy-700">
            <th className="text-left py-1 text-slate-500">Field</th>
            <th className="text-right py-1 text-slate-500 px-2">Reported</th>
            <th className="text-right py-1 text-slate-500 px-2">Normalized</th>
          </tr></thead>
          <tbody>
            {fields.map(([f, l]) => {
              const before = g(reported, f), after = g(row, f)
              const moved = before != null && after != null && Math.abs(before - after) > 0.001
              const isEps = f === 'eps'
              const showB = isEps ? (before?.toFixed?.(2) ?? '\u2014') : (before == null ? '\u2014' : Math.round(before / div).toLocaleString('en-IN'))
              const showA = isEps ? (after?.toFixed?.(2) ?? '\u2014')  : (after == null ? '\u2014' : Math.round(after / div).toLocaleString('en-IN'))
              return (
                <tr key={f} className="border-b border-navy-800/50">
                  <td className="py-1 text-slate-300">{l}</td>
                  <td className="text-right py-1 px-2 font-mono text-slate-400">{showB}</td>
                  <td className={'text-right py-1 px-2 font-mono ' + (moved ? 'text-accent' : 'text-slate-400')}>{showA}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-600">Values in {sym} {unit}. Only this year changes; others stay reported.</p>
    </div>
  )
}
