import React, { useState } from 'react'
import { useApp } from '../store/AppContext.jsx'
import FormulaBuilder from './FormulaBuilder.jsx'
import { getOverrides, setOverride, clearOverride } from '../engine/formulaOverrides.js'
import { exprString } from '../engine/formulaBuilder.js'

// Overridable metrics + their default (display) formula, mirroring ratios.js.
const METRICS = [
  { key: 'operatingMargin', label: 'Operating margin', def: 'Operating Profit ÷ Revenue × 100' },
  { key: 'ebitdaMargin', label: 'EBITDA margin', def: 'EBITDA ÷ Revenue × 100' },
  { key: 'netMargin', label: 'Net margin', def: 'Net Profit ÷ Revenue × 100' },
  { key: 'roe', label: 'ROE', def: 'Net Profit ÷ Avg Equity × 100' },
  { key: 'roce', label: 'ROCE', def: 'EBITDA ÷ (Total Equity + Total Debt) × 100' },
  { key: 'roa', label: 'ROA', def: 'Net Profit ÷ Total Assets × 100' },
  { key: 'de', label: 'D/E', def: 'Total Debt ÷ Total Equity' },
  { key: 'icr', label: 'Interest coverage', def: 'EBITDA ÷ Interest' },
  { key: 'pe', label: 'P/E', def: 'Price ÷ EPS' },
  { key: 'pb', label: 'P/B', def: 'Price ÷ Book Value / Share' },
  { key: 'ps', label: 'P/S', def: 'Market Cap ÷ Revenue' },
  { key: 'evEbitda', label: 'EV/EBITDA', def: 'EV ÷ EBITDA' },
  { key: 'evRevenue', label: 'EV/Revenue', def: 'EV ÷ Revenue' },
  { key: 'fcfYield', label: 'FCF yield', def: 'FCF ÷ Market Cap × 100' },
  { key: 'fcfConversion', label: 'FCF conversion', def: 'FCF ÷ Net Profit × 100' },
  { key: 'bookPerShare', label: 'Book / share', def: 'Total Equity ÷ Shares' },
]

export default function FormulasPanel({ open, onClose }) {
  const { state } = useApp()
  const [editing, setEditing] = useState(null)   // metric key being edited
  const [overrides, setOverrides] = useState(getOverrides())

  if (!open) return null
  const scope = state.ratioResult || {}

  const save = (key, def) => { setOverride(key, def); setOverrides(getOverrides()); setEditing(null) }
  const reset = (key) => { clearOverride(key); setOverrides(getOverrides()) }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card max-w-2xl w-full space-y-3 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Formulas</h2>
            <p className="text-xs text-slate-500 mt-0.5">Override any metric's formula. Applies across all tickers; reload to recompute.</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>

        <div className="space-y-2">
          {METRICS.map(m => {
            const ov = overrides[m.key]
            const isEditing = editing === m.key
            return (
              <div key={m.key} className="rounded-lg border border-navy-700 bg-navy-900/40 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200">{m.label} {ov && <span className="text-[10px] text-neutral">(custom)</span>}</div>
                    <div className="font-mono text-[11px] text-slate-500 truncate">
                      {ov ? exprString(ov.tree) : m.def}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {ov && <button onClick={() => reset(m.key)} className="badge bg-navy-700 text-slate-400 hover:text-accent">↺</button>}
                    <button onClick={() => setEditing(isEditing ? null : m.key)}
                      className={`badge ${isEditing ? 'badge-bull' : 'bg-navy-700 text-slate-300'}`}>{isEditing ? 'editing' : 'edit'}</button>
                  </div>
                </div>
                {isEditing && (
                  <div className="mt-2 pt-2 border-t border-navy-800">
                    <FormulaBuilder scope={scope} initial={ov} onSave={def => save(m.key, def)} onCancel={() => setEditing(null)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <p className="text-[10px] text-slate-600">Custom formulas are stored on this device (they'll sync once cross-device sync is enabled). A formula that can't compute falls back to the default.</p>
      </div>
    </div>
  )
}
