import React, { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { reconstructRow } from '../../engine/reconstruct.js'

/**
 * NormalizeModal — manual normalization via P&L reconstruction.
 *
 * Produces the NORMALIZED basis: the user restates a line for a year (a one-off
 * stripped out of Other Income, a corrected figure from the annual report), the
 * app rebuilds that year via the P&L identity, and it's stored in a SEPARATE
 * table (normalizedIncomeHistory) that the basis toggle switches to. Reported is
 * never overwritten.
 *
 * HOOKS RULE: every hook (useState/useMemo/useEffect) is declared ABOVE the
 * `if (!open) return null` early return, so the hook count is identical whether
 * the modal is open or closed. A hook after the return causes React error #310.
 */

const cur = c => (c === 'INR' ? '₹' : '$')
const num = f => (f && typeof f === 'object' ? f.value : f)
const yr  = row => String(row?.year ?? '')

const EDITABLE = [
  ['otherIncome', 'Other income'],
  ['expenses',    'Expenses'],
  ['interest',    'Interest'],
  ['depreciation','Depreciation'],
  ['tax',         'Tax'],
]

const fmt = (v, div) => v == null ? '—' : Math.round(v / div).toLocaleString('en-IN')

export default function NormalizeModal({ open, onClose }) {
  const { state, applyNormalization, setBasis } = useApp()
  const income = state?.data?.incomeHistory || []
  const currency = state?.data?.currency
  const div = currency === 'INR' ? 1e7 : 1e6
  const unit = currency === 'INR' ? 'Cr' : 'M'
  const sym = cur(currency)

  const years = useMemo(
    () => income.map(yr).filter(Boolean).sort().reverse(),
    [income]
  )

  const [year, setYear]         = useState('')
  const [line, setLine]         = useState('otherIncome')
  const [newValue, setNewValue] = useState('')
  const [taxed, setTaxed]       = useState(true)
  const [preview, setPreview]   = useState(null)
  const [applied, setApplied]   = useState(false)

  // Reset on open.
  useEffect(() => {
    if (!open) return
    setYear(years[0] || '')
    setLine('otherIncome'); setNewValue(''); setTaxed(true)
    setPreview(null); setApplied(false)
  }, [open, years])

  const reportedRow = income.find(r => yr(r) === year) || null

  // Live preview — declared ABOVE the early return so hook count stays constant.
  useEffect(() => {
    if (!open) return
    if (!reportedRow || newValue === '' || isNaN(+newValue)) { setPreview(null); return }
    const abs = +newValue * div
    setPreview(reconstructRow(reportedRow, [{ line, newValue: abs, taxed }]))
  }, [open, year, line, newValue, taxed, reportedRow, div])

  // ── Early return AFTER all hooks ──
  if (!open) return null

  const apply = () => {
    if (!preview?.ok) return
    const existing = state?.data?.normalizedIncomeHistory || []
    const rows = [...existing.filter(r => yr(r) !== year), preview.row]
      .sort((a, b) => yr(a).localeCompare(yr(b)))
    applyNormalization(rows)
    setBasis('normalized')
    setApplied(true)
  }

  const g = (row, f) => num(row?.[f])
  const lineLabel = EDITABLE.find(([k]) => k === line)?.[1] || line

  const compareFields = [
    ['revenue', 'Revenue'],
    ['otherIncome', 'Other income'],
    ['profitBeforeTax', 'Profit before tax'],
    ['tax', 'Tax'],
    ['netProfit', 'Net profit'],
    ['eps', 'EPS'],
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card max-w-xl w-full space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Normalize a one-off</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Restate a line from the annual report; the year is rebuilt and kept as a
              separate normalized basis you can switch to. Reported stays untouched.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>

        {!applied ? (
          <>
            {years.length === 0 ? (
              <p className="text-xs text-bear">No income history loaded.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400">Year</label>
                    <select value={year} onChange={e => setYear(e.target.value)}
                      className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs text-slate-200 mt-1 focus:outline-none focus:border-accent">
                      {years.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400">Line to restate</label>
                    <select value={line} onChange={e => setLine(e.target.value)}
                      className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs text-slate-200 mt-1 focus:outline-none focus:border-accent">
                      {EDITABLE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </div>
                </div>

                {reportedRow && (
                  <p className="text-[11px] text-slate-600">
                    Reported {lineLabel} for {year}: {sym}{fmt(g(reportedRow, line), div)} {unit}
                  </p>
                )}

                <div>
                  <label className="text-xs text-slate-400">Restated {lineLabel} ({sym}, in {unit})</label>
                  <input type="number" inputMode="decimal" value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    placeholder={`e.g. the recurring portion only`}
                    className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 mt-1 focus:outline-none focus:border-accent" />
                </div>

                {line !== 'tax' && (
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-slate-400">This change was:</span>
                    <button onClick={() => setTaxed(true)}
                      className={`px-2 py-1 rounded border ${taxed ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400'}`}>
                      Taxed (recompute tax)
                    </button>
                    <button onClick={() => setTaxed(false)}
                      className={`px-2 py-1 rounded border ${!taxed ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400'}`}>
                      Tax-neutral
                    </button>
                  </div>
                )}

                {preview && !preview.ok && (
                  <div className="text-xs rounded-lg px-3 py-2 bg-bear/10 text-bear">
                    Can't reconcile: {preview.reason}
                  </div>
                )}

                {preview?.ok && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-300">Reported → Normalized</div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b border-navy-700">
                          <th className="text-left py-1 text-slate-500">Field</th>
                          <th className="text-right py-1 text-slate-500 px-2">Reported</th>
                          <th className="text-right py-1 text-slate-500 px-2">Normalized</th>
                        </tr></thead>
                        <tbody>
                          {compareFields.map(([f, l]) => {
                            const before = g(reportedRow, f)
                            const after  = g(preview.row, f)
                            const moved  = before != null && after != null && Math.abs(before - after) > 0.001
                            const isEps  = f === 'eps'
                            const showB  = isEps ? (before?.toFixed?.(2) ?? '—') : fmt(before, div)
                            const showA  = isEps ? (after?.toFixed?.(2) ?? '—')  : fmt(after, div)
                            return (
                              <tr key={f} className="border-b border-navy-800/50">
                                <td className="py-1 text-slate-300">{l}</td>
                                <td className="text-right py-1 px-2 font-mono text-slate-400">{showB}</td>
                                <td className={`text-right py-1 px-2 font-mono ${moved ? 'text-accent' : 'text-slate-400'}`}>{showA}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[11px] text-slate-600">
                      Values in {sym} {unit}. Only the reconstructed year changes; every other year stays reported.
                    </p>
                  </div>
                )}

                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-sm flex-1">Cancel</button>
                  <button onClick={apply} disabled={!preview?.ok}
                    className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                    Apply &amp; switch to normalized
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="text-center py-6 space-y-3">
            <div className="text-3xl">✅</div>
            <p className="text-sm text-slate-300">{year} normalized. Basis switched — toggle in the header to compare.</p>
            <button onClick={onClose} className="btn-primary text-sm">Done</button>
          </div>
        )}
      </div>
    </div>
  )
}
