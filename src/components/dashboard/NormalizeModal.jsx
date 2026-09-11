import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { reconstructRow } from '../../engine/reconstruct.js'
import { parseExcerpt, proposalToEdit } from '../../engine/parseExcerpt.js'
import { parsePastedTable, tagPastedRows, parseRestatementRows } from '../../utils/pasteParser.js'
import { suggestNormalizationTarget, availableTargets } from '../../engine/normalizationTargets.js'
import Modal from '../Modal.jsx'
/**
 * NormalizeModal — manual normalization via paste. Three modes, all paste boxes:
 *
 *   FULL TABLE   → paste a restated P&L table → the parsed netProfit/eps for
 *                  those years become netProfitNormalized/epsNormalized
 *                  overrides written onto the matching reportedIncomeHistory
 *                  rows (no reconstruction needed — Screener/the AR already
 *                  gave the resolved figure).
 *
 *   EXCERPT      → paste a sentence/snippet from the report → the app deciphers
 *                  {line, year, value} and PROPOSES a reconstruction, which the
 *                  user confirms/corrects before it is applied. Free-text parsing
 *                  is never trusted blind.
 *
 *   RESTATEMENT  → paste ANY statement or note (P&L, Balance Sheet, Cash Flow,
 *                  an AR notes breakdown — doesn't matter which, no need to
 *                  say). Every row becomes an adjustment: a target field (from
 *                  normalizationTargets.js's fixed ten, keyword-suggested,
 *                  always editable) and a +/− sign. Multiple rows can target
 *                  the same field/year and sum together. This is the only mode
 *                  that reaches fields beyond net profit/EPS — EBIT, interest,
 *                  tax, D&A, capex, and the four core working-capital lines,
 *                  each written as {target}Normalized on whichever statement's
 *                  history it actually lives on (see APPLY_RESTATEMENTS).
 *
 * Reported data is never overwritten — every {field} stays as reported;
 * {field}Normalized is a separate sibling field on the same row, read only
 * when the basis toggle is set to 'normalized'. All hooks are ABOVE the early
 * return.
 */

const cur = c => (c === 'INR' ? '\u20b9' : '$')
const num = f => (f && typeof f === 'object' ? f.value : f)
const yr  = row => String(row?.year ?? '')

const LINE_LABELS = {
  otherIncome: 'Other income', expenses: 'Expenses', interest: 'Interest',
  depreciation: 'Depreciation', tax: 'Tax', revenue: 'Revenue',
  // Below-the-line, already net-of-tax — an insurer's inter-fund transfer, an
  // actuarial reserve movement, etc. Doesn't run through the identity below;
  // see reconstructRow's dedicated direct-netProfit path.
  netProfit: 'Net profit (direct, net of tax)',
}

export default function NormalizeModal({ open, onClose, flag = null }) {
  const { state, applyNormalization, applyRestatements, setBasis } = useApp()
  // reportedIncomeHistory specifically, not incomeHistory — the latter is the
  // ACTIVE series and is already normalized whenever basis is 'normalized'.
  // Reconstructing a fresh manual correction on top of an already-adjusted
  // netProfit would silently double-adjust it.
  const income   = state?.data?.reportedIncomeHistory || state?.data?.incomeHistory || []
  const currency = state?.data?.currency
  const div   = currency === 'INR' ? 1e7 : 1e6
  const unit  = currency === 'INR' ? 'Cr' : 'M'
  const sym   = cur(currency)
  const scale = currency === 'INR' ? 1e7 : 1

  // Arriving from a data-quality flag ("Depreciation jumped 40%...") means the
  // fix is a full restated table more often than not — Screener/the AR usually
  // give you the whole year again, not one isolated line. Table mode is the
  // default here; excerpt stays one tab away for a single disclosed line-item.
  const [mode, setMode]         = useState(flag ? 'table' : 'excerpt')
  const [text, setText]         = useState('')
  const [proposal, setProposal] = useState(null)
  const [edit, setEdit]         = useState(null)
  const [tableResult, setTableResult] = useState(null)
  // Table mode can paste several years at once, same as any bulk paste
  // elsewhere in the app — same Gap fill/Replace choice, same default.
  const [tablePasteMode, setTablePasteMode] = useState('gapFill')
  const [applied, setApplied]   = useState(false)
  // Restatement mode's own state — separate from the plain textarea above so
  // switching tabs doesn't clobber a half-finished paste in another mode.
  const [restText, setRestText]     = useState('')
  const [restParsed, setRestParsed] = useState(null)   // { years, rows, warnings }
  // Keyed by each row's normalizedLabel: { target: key|null, sign: 1|-1 }.
  const [restMap, setRestMap]       = useState({})
  // Governs a DIFFERENT thing from each row's own +/- sign: the sign decides
  // whether a row adds to or subtracts from its target WITHIN this paste;
  // this decides what happens to a RestatementsTotal already stored from an
  // earlier, separate apply. 'accumulate' (default) adds this paste's total
  // on top of it — a restructuring charge found today and a litigation
  // settlement found next week should both count. 'replace' discards
  // whatever was there and starts fresh with only this paste's amount.
  const [restMode, setRestMode]     = useState('accumulate')

  useEffect(() => {
    if (!open) return
    setMode(flag ? 'table' : 'excerpt'); setText(''); setProposal(null)
    // Pre-seed year (and line, when the flag named one Screener line) so
    // switching to excerpt mode doesn't make the user re-type what the flag
    // already told the app.
    setEdit(flag ? { line: LINE_LABELS[flag.field] ? flag.field : '', year: String(flag.year), mode: 'set', value: null, percent: null } : null)
    setTableResult(null); setApplied(false)
    setRestText(''); setRestParsed(null); setRestMap({}); setRestMode('accumulate')
    setTablePasteMode('gapFill')
  }, [open, flag])

  useEffect(() => {
    if (!open || mode !== 'excerpt') return
    if (!text.trim()) { setProposal(null); if (!flag) setEdit(null); return }
    const p = parseExcerpt(text)
    setProposal(p)
    setEdit({ line: p.line, year: p.year, mode: p.mode, value: p.value, percent: p.percent })
  }, [open, mode, text, flag])

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

  // No separate normalized table to merge into any more — APPLY_NORMALIZATION
  // writes netProfitNormalized/epsNormalized straight onto the matching
  // year's row in reportedIncomeHistory and leaves every other year alone, so
  // this only ever needs to hand it the year(s) this one action touched.
  const applyExcerpt = () => {
    if (!excerptPreview?.ok) return
    applyNormalization([excerptPreview.row]); setBasis('normalized'); setApplied(true)
  }

  const applyTable = () => {
    if (!tableResult || !tableResult.rows?.length) return
    const overwrite = tablePasteMode === 'replace'
    if (overwrite && !window.confirm(
      `Replace will overwrite any normalized net profit/EPS already set for these years with this table's values. This can't be undone. Continue?`
    )) return
    const tagged = tagPastedRows(tableResult.rows, 'income', { scale })
    applyNormalization(tagged, overwrite); setBasis('normalized'); setApplied(true)
  }

  const parseRestatement = () => {
    const r = parseRestatementRows(restText)
    setRestParsed(r)
    // Seed a suggested target for any row seen for the first time; a row
    // already mapped (e.g. re-parsing after fixing a typo) keeps whatever
    // the user already chose rather than getting silently reset.
    setRestMap(prev => {
      const next = { ...prev }
      for (const row of r.rows) {
        if (!next[row.normalizedLabel]) {
          next[row.normalizedLabel] = { target: suggestNormalizationTarget(row.rawLabel), sign: 1 }
        }
      }
      return next
    })
  }

  const setRestRow = (normalizedLabel, patch) =>
    setRestMap(prev => ({ ...prev, [normalizedLabel]: { ...prev[normalizedLabel], ...patch } }))

  // Only rows the user actually mapped to a target contribute — an
  // unmapped row (no clear home, e.g. "Indemnification assets") is simply
  // left out, never guessed into some default target. scale converts the
  // pasted ₹ Crore figure to the app's absolute-currency storage, same as
  // every other paste path.
  const restAdjustments = (restParsed?.rows || []).flatMap(row => {
    const m = restMap[row.normalizedLabel]
    if (!m?.target) return []
    return Object.entries(row.byYear).map(([year, v]) => ({
      target: m.target, year, amount: v * (m.sign ?? 1) * scale,
    }))
  })

  const applyRestatement = () => {
    if (!restAdjustments.length) return
    if (restMode === 'replace' && !window.confirm(
      `Replace will discard any restatement already applied to these fields/years from an earlier paste and start over with only this one. This can't be undone. Continue?`
    )) return
    applyRestatements(restAdjustments, restMode); setBasis('normalized'); setApplied(true)
  }

  const compareFields = [
    ['revenue', 'Revenue'], ['otherIncome', 'Other income'],
    ['profitBeforeTax', 'Profit before tax'], ['tax', 'Tax'],
    ['netProfit', 'Net profit'], ['eps', 'EPS'],
  ]
  const rrForPreview = edit?.year ? reportedRowFor(edit.year) : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Normalize from the report"
      subtitle="Paste a full restated table (replaces those years) or an excerpt (the app reads the line, year and value - you confirm). Reported stays untouched."
      widthClass="sm:max-w-3xl"
    >
        {flag && !applied && (
          <div className="text-xs rounded-lg px-3 py-2 bg-neutral/10 text-neutral">
            Fixing FY{flag.year}: {flag.note}
          </div>
        )}

        {applied ? (
          <div className="text-center py-6 space-y-3">
            <div className="text-3xl">{'\u2705'}</div>
            <p className="text-sm text-slate-300">Normalized basis updated - toggle in the header to compare.</p>
            <button onClick={onClose} className="btn-primary text-sm">Done</button>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              {[['excerpt', 'Paste excerpt'], ['table', 'Paste full table'], ['restatement', 'Paste any statement']].map(([m, lbl]) => (
                <button key={m}
                  onClick={() => { setMode(m); setText(''); setProposal(null); setEdit(null); setTableResult(null) }}
                  className={'flex-1 py-1.5 rounded-lg text-xs border ' + (mode === m ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400')}>
                  {lbl}
                </button>
              ))}
            </div>

            {mode !== 'restatement' && (
              <textarea
                value={text}
                onChange={e => { setText(e.target.value); setTableResult(null) }}
                rows={mode === 'table' ? 5 : 3}
                placeholder={mode === 'table'
                  ? 'Paste the restated P&L table (with year headers), like the Screener paste\u2026'
                  : 'e.g. "Other income for FY2022 included a one-off gain of \u20b93,000 Cr" or "Restated tax for FY2023 was \u20b91,200 Cr"'}
                className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />
            )}

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
                        <option value="">{'\u2014'}</option>
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
                        Parsed {tableResult.rows.length} years ({tableResult.years?.join(', ')}) for the normalized basis.
                      </p>
                    ) : (
                      <p className="text-xs text-bear">Nothing recognized - check the table has year headers.</p>
                    )}

                    <div className="rounded-lg bg-navy-800/40 px-3 py-2 space-y-1.5">
                      <div className="flex gap-3">
                        {[['gapFill', 'Gap fill'], ['replace', 'Replace']].map(([m, lbl]) => (
                          <label key={m} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                            <input type="radio" name="tablePasteMode" checked={tablePasteMode === m} onChange={() => setTablePasteMode(m)} />
                            {lbl}
                          </label>
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-500">
                        {tablePasteMode === 'replace'
                          ? "Replace will overwrite any normalized net profit/EPS already set for these years. You'll be asked to confirm before it runs."
                          : 'Gap fill (default) only sets normalized net profit/EPS for years that have no normalized value yet.'}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={() => setTableResult(null)} className="btn-ghost text-sm flex-1">{'\u21ba'} Try again</button>
                      <button onClick={applyTable} disabled={!tableResult.rows?.length}
                        className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                        Apply &amp; switch to normalized
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {mode === 'restatement' && (
              <>
                <p className="text-xs text-slate-500">
                  Paste any statement or note {'\u2014'} P&amp;L, Balance Sheet, Cash Flow, an AR notes breakdown,
                  or a range copied straight out of Excel. Doesn't matter which; no need to say. Each row becomes
                  an adjustment to one of the fields below.
                </p>
                <textarea
                  value={restText}
                  onChange={e => { setRestText(e.target.value); setRestParsed(null) }}
                  rows={6}
                  placeholder={'e.g.\nRestructuring charge\t600\t0\nLitigation settlement\t400\t0'}
                  className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />

                {!restParsed && (
                  <button onClick={parseRestatement} disabled={!restText.trim()}
                    className="btn-primary text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed">
                    Parse
                  </button>
                )}

                {restParsed && (
                  <>
                    {restParsed.warnings?.length > 0 && (
                      <div className="text-xs rounded-lg px-3 py-2 bg-neutral/10 text-neutral">
                        {restParsed.warnings[0]}
                      </div>
                    )}
                    {restParsed.rows?.length > 0 ? (
                      <div className="space-y-1.5">
                        {restParsed.rows.map(row => {
                          const m = restMap[row.normalizedLabel] || { target: null, sign: 1 }
                          const valuesStr = Object.entries(row.byYear).map(([y, v]) => `${y}: ${v.toLocaleString()}`).join('  \u00b7  ')
                          return (
                            <div key={row.normalizedLabel} className="rounded-lg border border-navy-700 bg-navy-800/30 p-2 space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs text-slate-300 truncate" title={row.rawLabel}>{row.rawLabel}</span>
                                <span className="text-[10px] text-slate-500 font-mono shrink-0">{valuesStr}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <select value={m.target || ''} onChange={e => setRestRow(row.normalizedLabel, { target: e.target.value || null })}
                                  className="flex-1 bg-navy-800 border border-navy-700 rounded px-2 py-1 text-xs text-slate-200">
                                  <option value="">Not applicable {'\u2014'} ignore this row</option>
                                  {availableTargets(state.data).map(t => (
                                    <option key={t.key} value={t.key}>{t.label}</option>
                                  ))}
                                </select>
                                <div className="flex rounded overflow-hidden border border-navy-700 shrink-0">
                                  <button type="button"
                                    onClick={() => setRestRow(row.normalizedLabel, { sign: 1 })}
                                    title="Add this to the reported figure"
                                    className={'px-2 py-1 text-xs ' + (m.sign !== -1 ? 'bg-accent/20 text-accent' : 'text-slate-500')}>+</button>
                                  <button type="button"
                                    onClick={() => setRestRow(row.normalizedLabel, { sign: -1 })}
                                    title="Subtract this from the reported figure"
                                    className={'px-2 py-1 text-xs border-l border-navy-700 ' + (m.sign === -1 ? 'bg-bear/20 text-bear' : 'text-slate-500')}>\u2212</button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-bear">Nothing recognized - check the pasted text includes amounts, not just labels.</p>
                    )}
                    <p className="text-[11px] text-slate-600">
                      Values in {sym} {unit}. Rows left as "Not applicable" are ignored. Multiple rows mapped to the
                      same field and year sum together.
                    </p>

                    <div className="rounded-lg bg-navy-800/40 px-3 py-2 space-y-1.5">
                      <div className="flex gap-3">
                        {[['accumulate', 'Accumulate'], ['replace', 'Replace']].map(([m, lbl]) => (
                          <label key={m} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                            <input type="radio" name="restMode" checked={restMode === m} onChange={() => setRestMode(m)} />
                            {lbl}
                          </label>
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-500">
                        {restMode === 'replace'
                          ? "Replace discards any restatement already applied to these fields/years from an earlier paste and starts over with only this one. You'll be asked to confirm before it runs."
                          : 'Accumulate (default) adds this paste on top of any restatement already applied earlier \u2014 a separate correction found later still counts, instead of erasing the first.'}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={() => setRestParsed(null)} className="btn-ghost text-sm flex-1">{'\u21ba'} Try again</button>
                      <button onClick={applyRestatement} disabled={!restAdjustments.length}
                        className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                        Apply &amp; switch to normalized
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
    </Modal>
  )
}

function PreviewTable({ reported, row, fields, div, sym, unit, g }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-slate-300">Reported {'\u2192'} Normalized</div>
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
