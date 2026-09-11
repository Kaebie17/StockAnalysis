import React, { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { METRICS, TABLE_SHAPE } from '../../engine/metrics.js'
import { SKIP_SCALE } from '../../utils/pasteParser.js'
import { normalizedFieldValue, availableTargets } from '../../engine/normalizationTargets.js'
import { computeNormalizedRow } from '../../engine/dataQuality.js'
import Modal from '../Modal.jsx'

/**
 * HistoryTableModal — click-to-edit view of the actual stored history.
 *
 * Two problems this fixes, both from the same root cause: nothing in the app
 * ever showed the raw reportedIncomeHistory/balanceHistory/cashflowHistory
 * rows, so every correction this far has gone through a paste-and-map flow
 * (copy text, paste, parse, pick a target, confirm) even for a single wrong
 * cell — and the only way to verify what actually got stored was IndexedDB
 * console archaeology.
 *
 * Cells are always editable (Excel-style: click, type, blur/Enter commits to
 * LOCAL pending state) but nothing reaches the store until "Save changes" —
 * that confirmation step is the guard, not a locked/unlocked mode toggle.
 * A direct cell edit always just sets the value (no Gap fill/Replace choice
 * needed here, unlike a bulk paste): clicking a cell already shows exactly
 * what's there to overwrite, or that it's blank, which is the same
 * visibility a paste's overlap preview exists to provide in the first place.
 *
 * Rows shown:
 *   - every metrics.js field for the selected statement that has at least
 *     one populated year (the TABLE_SHAPE signature fields always show too,
 *     even blank, since those are the ones a user is most likely to want to
 *     fill in first)
 *   - every custom row (data.customFields) for this statement
 *   - a handful of READ-ONLY computed rows for context (YoY, margins, the
 *     Normalized siblings if anything's been normalized) — surfacing what
 *     ratios.js/dataQuality.js already compute, not new calculations.
 */

const TABLES = [
  { key: 'income',   label: 'P&L',        icon: '📊' },
  { key: 'balance',  label: 'Balance',    icon: '⚖️' },
  { key: 'cashflow', label: 'Cash Flow',  icon: '💵' },
]

const val = t => (t && typeof t === 'object' ? t.value : t)
const histKeyFor = table => table === 'income' ? 'reportedIncomeHistory' : `${table}History`

function slugify(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'row'
}

export default function HistoryTableModal({ open, onClose }) {
  const { state, editHistoryCells, addCustomField, removeCustomField, applyRestatements } = useApp()
  const data = state?.data
  const currency = data?.currency
  const div  = currency === 'INR' ? 1e7 : 1e6
  const unit = currency === 'INR' ? 'Cr' : 'M'

  const [table, setTable] = useState('income')
  // Pending, unsaved cell edits: { [`${year}|${field}`]: string as typed }
  const [pending, setPending] = useState({})
  const [editingKey, setEditingKey] = useState(null)
  const [addingRow, setAddingRow] = useState(false)

  useEffect(() => {
    if (!open) return
    setTable('income'); setPending({}); setEditingKey(null); setAddingRow(false)
  }, [open])

  if (!open || !data) return null

  const history = data[histKeyFor(table)] || (table === 'income' ? data.incomeHistory : []) || []
  const years = [...new Set(history.map(r => String(r?.year)).filter(Boolean))].sort()
  const customFields = (data.customFields || []).filter(f => f.table === table)
  // Every valid restatement target for this ticker (Part C) — the curated
  // ten plus any other field with data, plus every custom row, across all
  // three statements. Filtered to the current tab where each use needs it.
  const allTargets = availableTargets(data)
  const targetLabel = key => allTargets.find(t => t.key === key)?.label ?? key

  const trackedKeys = Object.keys(METRICS).filter(k => METRICS[k].table === table)
  const signatureKeys = TABLE_SHAPE[table]?.signature || []
  const populatedKeys = trackedKeys.filter(k => history.some(r => val(r?.[k]) != null))
  // Signature fields always shown (even blank) so there's an obvious place
  // to click and start filling them in; every other tracked field only
  // appears once it actually has something in it, so an all-blank ticker
  // doesn't render sixty empty rows nobody asked for.
  const shownTrackedKeys = trackedKeys.filter(k => signatureKeys.includes(k) || populatedKeys.includes(k))

  const cellKey = (year, field) => `${year}|${field}`

  const displayOf = (field, raw) => {
    if (raw == null) return ''
    return SKIP_SCALE.has(field) ? String(raw) : String(+(raw / div).toFixed(2))
  }
  const parseInput = (field, text) => {
    const t = text.trim()
    if (t === '') return null
    const n = Number(t)
    if (!isFinite(n)) return undefined   // invalid — caller should ignore
    return SKIP_SCALE.has(field) ? n : n * div
  }

  const committedFor = (year, field) => {
    const row = history.find(r => String(r?.year) === year)
    return val(row?.[field])
  }

  const cellText = (year, field) => {
    const k = cellKey(year, field)
    if (k in pending) return pending[k]
    return displayOf(field, committedFor(year, field))
  }

  const isDirty = (year, field) => cellKey(year, field) in pending
  const pendingCount = Object.keys(pending).length

  const commitCell = (year, field, text) => {
    setPending(prev => {
      const committed = committedFor(year, field)
      const committedText = displayOf(field, committed)
      const next = { ...prev }
      if (text === committedText) delete next[cellKey(year, field)]
      else next[cellKey(year, field)] = text
      return next
    })
  }

  const saveChanges = () => {
    const edits = []
    for (const [k, text] of Object.entries(pending)) {
      const [year, field] = k.split('|')
      const parsed = parseInput(field, text)
      if (parsed === undefined) continue   // invalid typed value — skip, don't save garbage
      edits.push({ year, field, value: parsed })
    }
    if (edits.length) editHistoryCells(table, edits)
    setPending({}); setEditingKey(null)
  }

  const discardChanges = () => { setPending({}); setEditingKey(null) }

  // ── Read-only computed rows — context only, nothing new is calculated ──
  const computedRows = []
  if (table === 'income') {
    const seriesOf = field => years.map(y => val(history.find(r => String(r.year) === y)?.[field]))
    const yoyRow = (field, label) => {
      const series = seriesOf(field)
      const cells = years.map((y, i) => {
        const prev = series[i - 1], cur = series[i]
        return (prev != null && prev !== 0 && cur != null) ? ((cur / prev - 1) * 100) : null
      })
      if (cells.every(c => c == null)) return null
      return { label, cells, fmt: v => v == null ? null : `${v.toFixed(1)}%` }
    }
    const marginRow = (field, label) => {
      const revSeries = seriesOf('revenue')
      const series = seriesOf(field)
      const cells = years.map((y, i) => {
        const rev = revSeries[i], v = series[i]
        return (rev != null && rev !== 0 && v != null) ? (v / rev * 100) : null
      })
      if (cells.every(c => c == null)) return null
      return { label, cells, fmt: v => v == null ? null : `${v.toFixed(1)}%` }
    }
    ;[
      yoyRow('revenue', 'Revenue YoY'),
      yoyRow('netProfit', 'Net Profit YoY'),
      marginRow('operatingProfit', 'Operating Margin'),
      marginRow('netProfit', 'Net Margin'),
    ].forEach(r => r && computedRows.push(r))

    // Net Profit / EPS Normalized — computeNormalizedRow covers both the
    // manual override (NormalizeModal) and the live auto-derivation from
    // disclosed exceptional items; shown whenever either produces something
    // for at least one year, same "only render if it has content" rule as
    // the rest of this table.
    const npNorm = years.map(y => {
      const row = history.find(r => String(r.year) === y)
      const n = row ? computeNormalizedRow(row) : null
      return n ? val(n.netProfit) : null
    })
    if (npNorm.some(v => v != null)) {
      computedRows.push({ label: 'Net Profit (Normalized)', cells: npNorm, fmt: v => v == null ? null : (v / div).toLocaleString(undefined, { maximumFractionDigits: 1 }) })
    }
    const epsNorm = years.map(y => {
      const row = history.find(r => String(r.year) === y)
      const n = row ? computeNormalizedRow(row) : null
      return n ? val(n.eps) : null
    })
    if (epsNorm.some(v => v != null)) {
      computedRows.push({ label: 'EPS (Normalized)', cells: epsNorm, fmt: v => v == null ? null : v.toFixed(2) })
    }
  }
  // Restatement-tool Normalized siblings — any target on THIS statement that
  // actually has a restatement stored, not just the curated ten: since Part C
  // let NormalizeModal's restatement tool target any field with data (or a
  // custom row), a restatement can land on something outside the original
  // ten too, and hiding it here would defeat this table's whole point of
  // showing what's actually stored.
  const targetsForTable = allTargets.filter(t => t.table === table)
  for (const meta of targetsForTable) {
    const key = meta.key
    const cells = years.map(y => {
      const row = history.find(r => String(r.year) === y)
      const n = row ? normalizedFieldValue(row, key) : null
      return n?.value ?? null
    })
    const hasRestatement = years.some(y => {
      const row = history.find(r => String(r.year) === y)
      return val(row?.[`${key}RestatementsTotal`]) != null
    })
    if (hasRestatement) {
      computedRows.push({ label: `${meta.label} (Normalized)`, cells, fmt: v => v == null ? null : (SKIP_SCALE.has(key) ? v.toFixed(2) : (v / div).toLocaleString(undefined, { maximumFractionDigits: 1 })) })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Data table"
      subtitle={`As-reported history, editable cell by cell. Values in ${currency === 'INR' ? '₹' : '$'}${unit} unless noted. Nothing is saved until you confirm.`}
      widthClass="sm:max-w-4xl"
      footer={
        <div className="flex items-center justify-between w-full gap-3">
          <span className="text-xs text-slate-500">
            {pendingCount > 0 ? `${pendingCount} unsaved change${pendingCount > 1 ? 's' : ''}` : 'No unsaved changes'}
          </span>
          <div className="flex gap-2">
            {pendingCount > 0 && (
              <button onClick={discardChanges} className="btn-ghost text-sm">Discard</button>
            )}
            <button onClick={saveChanges} disabled={pendingCount === 0}
              className="btn-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed">
              Save changes
            </button>
          </div>
        </div>
      }
    >
      <div className="flex gap-2">
        {TABLES.map(t => (
          <button key={t.key}
            onClick={() => { if (pendingCount > 0 && !window.confirm('Switching statements discards unsaved edits on this one. Continue?')) return; setTable(t.key); setPending({}); setEditingKey(null) }}
            className={'flex-1 py-1.5 rounded-lg text-xs border ' + (table === t.key ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400')}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {years.length === 0 ? (
        <p className="text-xs text-slate-500">No {TABLES.find(t => t.key === table)?.label} history stored yet for this ticker.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-navy-700">
                <th className="text-left py-1 text-slate-500 sticky left-0 bg-navy-900 pr-2">Field</th>
                {years.map(y => <th key={y} className="text-right py-1 text-slate-500 px-2 font-mono">{y}</th>)}
              </tr>
            </thead>
            <tbody>
              {shownTrackedKeys.map(field => (
                <EditableRow key={field} label={METRICS[field]?.label || field} field={field} years={years}
                  cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                  commitCell={commitCell} cellKey={cellKey} />
              ))}
              {customFields.map(f => (
                <EditableRow key={f.key} label={f.label} field={f.key} years={years}
                  cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                  commitCell={commitCell} cellKey={cellKey}
                  onRemove={() => {
                    if (window.confirm(`Remove "${f.label}" and all its values? This can't be undone.`)) removeCustomField(f.key)
                  }}
                  targetNote={f.target ? `${f.sign > 0 ? '+' : '−'} feeds ${targetLabel(f.target)}` : null}
                />
              ))}
              {computedRows.map(r => (
                <tr key={r.label} className="border-b border-navy-800/50">
                  <td className="py-1 text-slate-500 italic sticky left-0 bg-navy-900 pr-2">{r.label}</td>
                  {r.cells.map((v, i) => (
                    <td key={i} className="text-right py-1 px-2 font-mono text-slate-500">
                      {r.fmt(v) ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!addingRow ? (
        <button onClick={() => setAddingRow(true)} className="text-xs text-accent hover:text-accent-light">
          + Add row
        </button>
      ) : (
        <AddRowForm
          table={table}
          years={years}
          shownTrackedKeys={shownTrackedKeys}
          targetOptions={allTargets.filter(t => t.table === table)}
          div={div}
          onCancel={() => setAddingRow(false)}
          onCreateTracked={(field, valuesByYear) => {
            const edits = Object.entries(valuesByYear)
              .filter(([, v]) => v !== '')
              .map(([year, v]) => ({ year, field, value: Number(v) * (SKIP_SCALE.has(field) ? 1 : div) }))
            if (edits.length) editHistoryCells(table, edits)
            setAddingRow(false)
          }}
          onCreateCustom={({ label, target, sign, valuesByYear }) => {
            const key = `custom_${slugify(label)}_${Date.now().toString(36)}`
            addCustomField({ key, label, table, target: target || null, sign: target ? sign : null })
            const entries = Object.entries(valuesByYear).filter(([, v]) => v !== '')
            const edits = entries.map(([year, v]) => ({ year, field: key, value: Number(v) * div }))
            if (edits.length) editHistoryCells(table, edits)
            if (target && entries.length) {
              applyRestatements(entries.map(([year, v]) => ({ target, year, amount: sign * Number(v) * div })), 'accumulate')
            }
            setAddingRow(false)
          }}
        />
      )}
    </Modal>
  )
}

function EditableRow({ label, field, years, cellText, isDirty, editingKey, setEditingKey, commitCell, cellKey, onRemove, targetNote }) {
  return (
    <tr className="border-b border-navy-800/50">
      <td className="py-1 text-slate-300 sticky left-0 bg-navy-900 pr-2">
        {label}
        {targetNote && <span className="block text-[10px] text-slate-600">{targetNote}</span>}
        {onRemove && (
          <button onClick={onRemove} title="Remove this row" className="ml-1 text-slate-600 hover:text-bear">✕</button>
        )}
      </td>
      {years.map(y => {
        const k = cellKey(y, field)
        const editing = editingKey === k
        const text = cellText(y, field)
        const dirty = isDirty(y, field)
        return (
          <td key={y} className="text-right py-0.5 px-1">
            {editing ? (
              <input
                autoFocus
                type="text"
                inputMode="decimal"
                defaultValue={text}
                onBlur={e => { commitCell(y, field, e.target.value); setEditingKey(null) }}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.target.blur()
                  if (e.key === 'Escape') { setEditingKey(null) }
                }}
                className="w-24 bg-navy-800 border border-accent rounded px-1.5 py-1 text-xs font-mono text-white text-right focus:outline-none"
              />
            ) : (
              <button
                onClick={() => setEditingKey(k)}
                className={`w-full text-right px-1.5 py-1 rounded font-mono hover:bg-navy-800/60 ${dirty ? 'text-accent' : text ? 'text-white' : 'text-slate-600'}`}
                title={dirty ? 'Unsaved edit — click to change' : 'Click to edit'}>
                {text || '—'}
              </button>
            )}
          </td>
        )
      })}
    </tr>
  )
}

function AddRowForm({ table, years, shownTrackedKeys, targetOptions, div, onCancel, onCreateTracked, onCreateCustom }) {
  const [kind, setKind] = useState('tracked')
  const [trackedField, setTrackedField] = useState('')
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')
  const [sign, setSign] = useState(1)
  const [values, setValues] = useState({})

  const availableTracked = Object.keys(METRICS).filter(k => METRICS[k].table === table && !shownTrackedKeys.includes(k))

  const canSubmit = kind === 'tracked' ? !!trackedField : label.trim().length > 0

  return (
    <div className="rounded-lg bg-navy-800/40 px-3 py-3 space-y-2.5">
      <div className="flex gap-3">
        {[['tracked', 'Tracked field'], ['custom', 'Custom line item']].map(([k, lbl]) => (
          <label key={k} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input type="radio" name="rowKind" checked={kind === k} onChange={() => setKind(k)} />
            {lbl}
          </label>
        ))}
      </div>

      {kind === 'tracked' ? (
        availableTracked.length === 0 ? (
          <p className="text-[11px] text-slate-500">Every tracked field for this statement is already shown above.</p>
        ) : (
          <select value={trackedField} onChange={e => setTrackedField(e.target.value)}
            className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
            <option value="">Pick a field…</option>
            {availableTracked.map(k => <option key={k} value={k}>{METRICS[k].label}</option>)}
          </select>
        )
      ) : (
        <>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Row label — e.g. Indemnification asset"
            className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200" />
          <div className="flex gap-2 items-center">
            <select value={target} onChange={e => setTarget(e.target.value)}
              className="flex-1 bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
              <option value="">No normalization (reference only)</option>
              {targetOptions.map(t => <option key={t.key} value={t.key}>Feeds {t.label}</option>)}
            </select>
            {target && (
              <select value={sign} onChange={e => setSign(Number(e.target.value))}
                className="bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
                <option value={1}>+ add</option>
                <option value={-1}>− subtract</option>
              </select>
            )}
          </div>
          {target && (
            <p className="text-[11px] text-slate-500">
              Values entered below are applied to {targetOptions.find(t => t.key === target)?.label}'s normalized figure immediately on create, same as pasting them through the restatement tool.
            </p>
          )}
        </>
      )}

      {(kind === 'tracked' ? trackedField : true) && (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${years.length}, minmax(4rem,1fr))` }}>
          {years.map(y => (
            <div key={y}>
              <label className="text-[10px] text-slate-500 block">{y}</label>
              <input type="text" inputMode="decimal" value={values[y] ?? ''}
                onChange={e => setValues(v => ({ ...v, [y]: e.target.value }))}
                placeholder="—"
                className="w-full bg-navy-800 border border-navy-700 rounded px-1.5 py-1 text-xs font-mono text-slate-200" />
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-ghost text-xs flex-1">Cancel</button>
        <button
          disabled={!canSubmit}
          onClick={() => {
            if (kind === 'tracked') onCreateTracked(trackedField, values)
            else onCreateCustom({ label: label.trim(), target: target || null, sign, valuesByYear: values })
          }}
          className="btn-primary text-xs flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
          Add row
        </button>
      </div>
    </div>
  )
}
