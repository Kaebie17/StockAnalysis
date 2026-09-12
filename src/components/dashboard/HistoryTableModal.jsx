import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../../store/AppContext.jsx'
import { METRICS, TABLE_SHAPE } from '../../engine/metrics.js'
import { SKIP_SCALE, parseRestatementRows } from '../../utils/pasteParser.js'
import { normalizedFieldValue, availableTargets } from '../../engine/normalizationTargets.js'
import { computeNormalizedRow, activeValue } from '../../engine/dataQuality.js'
import { listFormulas, fieldLabel, fieldHistory, assignmentsForField } from '../../engine/formulas.js'
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
  { key: 'income',    label: 'P&L',        icon: '📊' },
  { key: 'balance',   label: 'Balance',    icon: '⚖️' },
  { key: 'cashflow',  label: 'Cash Flow',  icon: '💵' },
  { key: 'formulas',  label: 'Formulas',   icon: '🧮' },
]

const val = t => (t && typeof t === 'object' ? t.value : t)
const histKeyFor = table => table === 'income' ? 'reportedIncomeHistory' : `${table}History`

function slugify(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'row'
}

// A custom row's key is just its (slugified) label — no generated suffix —
// so duplicate labels are the ONE thing that must be blocked at creation
// (see AddRowForm/MergeRowsForm): once a key exists, it never needs to
// change again even as the row keeps getting picked up by new restatements
// or formula assignments, so there's nothing a stable, human-legible key
// costs here that a synthetic one would have bought instead.
function keyCollision(data, slug) {
  if (METRICS[slug]) return true
  return (data?.customFields || []).some(f => f.key === slug)
}

// One-line summary of everything a field currently feeds, across both
// restatement targets and formula buckets — replaces the old single
// "feeds X" note, which could only ever describe one destination.
function assignmentSummary(data, field) {
  const list = assignmentsForField(data, field)
  if (!list.length) return null
  return list.map(a => {
    const sign = (a.sign ?? 1) > 0 ? '+' : '−'
    if (a.kind === 'restatement') return `${sign} feeds ${fieldLabel(data, a.target)}`
    const formula = listFormulas(data).find(f => f.key === a.formula)
    const bucket = formula?.buckets.find(b => b.key === a.bucket)
    return `${sign} feeds ${formula?.label ?? a.formula} → ${bucket?.label ?? a.bucket}`
  }).join('; ')
}

export default function HistoryTableModal({ open, onClose }) {
  const { state, editHistoryCells, addCustomField, removeCustomField, mergeCustomFields, setAssignmentsForField } = useApp()
  const data = state?.data
  const currency = data?.currency
  const div  = currency === 'INR' ? 1e7 : 1e6
  const unit = currency === 'INR' ? 'Cr' : 'M'

  const [table, setTable] = useState('income')
  // Pending, unsaved cell edits: { [`${year}|${field}`]: string as typed }
  const [pending, setPending] = useState({})
  const [editingKey, setEditingKey] = useState(null)
  const [addingRow, setAddingRow] = useState(false)
  const [merging, setMerging] = useState(false)
  // Set by a row's "what does this feed" nav button (EditableRow) — lets the
  // Formulas tab open with that field's own assignment editor already open,
  // instead of just landing on an undifferentiated list.
  const [focusField, setFocusField] = useState(null)

  useEffect(() => {
    if (!open) return
    setTable('income'); setPending({}); setEditingKey(null); setAddingRow(false); setMerging(false); setFocusField(null)
  }, [open])

  const goToFormulas = (field) => { setFocusField(field); setTable('formulas') }

  if (!open || !data) return null

  const history = data[histKeyFor(table)] || (table === 'income' ? data.incomeHistory : []) || []
  const years = [...new Set(history.map(r => String(r?.year)).filter(Boolean))].sort()
  const customFields = (data.customFields || []).filter(f => f.table === table)
  // Every valid restatement target for this ticker (Part C) — the curated
  // ten plus any other field with data, plus every custom row, across all
  // three statements. Filtered to the current tab where each use needs it.
  const allTargets = availableTargets(data)

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
    // Screener shows every line whole (Cr, no paise) — a few fields (COGS
    // from a "Material Cost %" label, Gross Profit derived from it) are
    // legitimately computed as revenue × a percentage and land on a real
    // fraction of a crore, not a formatting artifact — but this grid still
    // shows whole crores for every scaled field, same convention as the
    // source. The full precision is unaffected in storage/ratio math; this
    // only rounds what's DISPLAYED here.
    return SKIP_SCALE.has(field) ? String(raw) : String(Math.round(raw / div))
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
      computedRows.push({ label: 'Net Profit (Normalized)', cells: npNorm, fmt: v => v == null ? null : Math.round(v / div).toLocaleString() })
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
  // Restatement-tool Normalized siblings — a real, stored row
  // (recomputeNormalizedTargets, called from computeAll) for any target on
  // THIS statement that currently has at least one custom row feeding it —
  // not just the curated ten, since Part C let the restatement tool target
  // any field with data (or a custom row), and hiding one here would defeat
  // this table's whole point of showing what's actually stored.
  const targetsForTable = allTargets.filter(t => t.table === table)
  for (const meta of targetsForTable) {
    const key = meta.key
    const cells = years.map(y => {
      const row = history.find(r => String(r.year) === y)
      const n = row ? normalizedFieldValue(row, key) : null
      return n?.value ?? null
    })
    const hasContribution = years.some(y => val(history.find(r => String(r.year) === y)?.[`${key}Normalized`]) != null)
    if (hasContribution) {
      computedRows.push({ label: `${meta.label} (Normalized)`, cells, fmt: v => v == null ? null : (SKIP_SCALE.has(key) ? v.toFixed(2) : Math.round(v / div).toLocaleString()) })
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
            onClick={() => { if (pendingCount > 0 && !window.confirm('Switching statements discards unsaved edits on this one. Continue?')) return; setTable(t.key); setPending({}); setEditingKey(null); if (t.key !== 'formulas') setFocusField(null) }}
            className={'flex-1 py-1.5 rounded-lg text-xs border ' + (table === t.key ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400')}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {table === 'formulas' ? (
        <FormulasTab data={data} div={div} focusField={focusField} setAssignmentsForField={setAssignmentsForField} />
      ) : (
        <>
      {years.length === 0 ? (
        <p className="text-xs text-slate-500">No {TABLES.find(t => t.key === table)?.label} history stored yet for this ticker.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-max min-w-full text-xs">
            <thead>
              <tr className="border-b border-navy-700">
                <th className="text-left py-1 text-slate-500 sticky left-0 bg-navy-900 pr-2 min-w-[11rem]">Field</th>
                {years.map(y => <th key={y} className="text-right py-1 text-slate-500 px-2 font-mono whitespace-nowrap min-w-[6.5rem]">{y}</th>)}
              </tr>
            </thead>
            <tbody>
              {shownTrackedKeys.map(field => (
                <EditableRow key={field} label={METRICS[field]?.label || field} field={field} years={years}
                  cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                  commitCell={commitCell} cellKey={cellKey}
                  assignmentNote={assignmentSummary(data, field)}
                  onNavigate={() => goToFormulas(field)}
                />
              ))}
              {customFields.map(f => (
                <EditableRow key={f.key} label={f.label} field={f.key} years={years}
                  cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                  commitCell={commitCell} cellKey={cellKey}
                  onRemove={() => {
                    if (window.confirm(`Remove "${f.label}" and all its values? This can't be undone.`)) removeCustomField(f.key)
                  }}
                  assignmentNote={assignmentSummary(data, f.key)}
                  onNavigate={() => goToFormulas(f.key)}
                />
              ))}
              {computedRows.map(r => (
                <tr key={r.label} className="border-b border-navy-800/50">
                  <td className="py-1 text-slate-500 italic sticky left-0 bg-navy-900 pr-2 min-w-[11rem]">{r.label}</td>
                  {r.cells.map((v, i) => (
                    <td key={i} className="text-right py-1 px-2 font-mono text-slate-500 whitespace-nowrap min-w-[6.5rem]">
                      {r.fmt(v) ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!addingRow && !merging && (
        <div className="flex gap-4">
          <button onClick={() => setAddingRow(true)} className="text-xs text-accent hover:text-accent-light">
            + Add row
          </button>
          {customFields.length >= 2 && (
            <button onClick={() => setMerging(true)} className="text-xs text-accent hover:text-accent-light">
              ⇄ Merge rows
            </button>
          )}
        </div>
      )}

      {merging && (
        <MergeRowsForm
          data={data}
          customFields={customFields}
          onCancel={() => setMerging(false)}
          onMerge={(sourceKeys, opts) => {
            mergeCustomFields(table, sourceKeys, opts)
            setMerging(false)
          }}
        />
      )}

      {addingRow && (
        <AddRowForm
          data={data}
          table={table}
          years={years}
          div={div}
          onCancel={() => setAddingRow(false)}
          onCreateCustom={({ key, label, assignments, valuesByYear }) => {
            // The row's own value is the magnitude as entered — never
            // pre-multiplied by any assignment's sign. Sign lives only as
            // metadata on the assignment, applied when a target's Normalized
            // figure (or a formula's bucket sum) is derived — so what's
            // SHOWN in this row always matches what was typed, whether or
            // not it feeds anything.
            addCustomField({ key, label, table }, assignments)
            const edits = Object.entries(valuesByYear)
              .filter(([, v]) => v !== '')
              .map(([year, v]) => ({ year, field: key, value: Number(v) * div }))
            if (edits.length) editHistoryCells(table, edits)
            setAddingRow(false)
          }}
        />
      )}
        </>
      )}
    </Modal>
  )
}

function EditableRow({ label, field, years, cellText, isDirty, editingKey, setEditingKey, commitCell, cellKey, onRemove, assignmentNote, onNavigate }) {
  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteWarning, setPasteWarning] = useState('')

  // Bulk-correct THIS row across every year in one go — e.g. a tracked
  // field that already has data but needs redoing wholesale (mixed-sign
  // CapEx, a whole column that was mis-scaled) instead of cell-by-cell.
  // Same shape as any paste in the app (a year header, then one row of
  // values); reuses parseRestatementRows as-is. Stages into the same
  // pending state a single cell edit would — still gated behind Save
  // changes, so a bad paste costs nothing until confirmed.
  const fillFromPaste = () => {
    const parsed = parseRestatementRows(pasteText)
    const row = parsed.rows?.[0]
    if (!row) {
      setPasteWarning(parsed.warnings?.[0] || 'Could not find a year header and a row of values in that paste.')
      return
    }
    let matched = 0
    const ignored = []
    for (const [y, v] of Object.entries(row.byYear)) {
      // Round off any parser float noise (e.g. a percent-derived figure)
      // before staging it — a Screener/AR figure is whole or 2dp at most,
      // never a long tail of binary-float digits.
      if (years.includes(y)) { commitCell(y, field, String(Math.round(v * 100) / 100)); matched++ }
      else ignored.push(y)
    }
    if (matched === 0) {
      setPasteWarning(`None of the pasted years match this row's years (${years.join(', ')}).`)
      return
    }
    setPasteText('')
    if (ignored.length) setPasteWarning(`Staged ${matched} year(s) — click Save changes to commit. Ignored year(s) not in this table: ${ignored.join(', ')}.`)
    else { setPasteWarning(''); setShowPaste(false) }
  }

  return (
    <>
    <tr className="border-b border-navy-800/50">
      <td className="py-1 text-slate-300 sticky left-0 bg-navy-900 pr-2 min-w-[11rem]">
        {label}
        {assignmentNote && <span className="block text-[10px] text-slate-600">{assignmentNote}</span>}
        <button onClick={() => { setShowPaste(s => !s); setPasteWarning('') }}
          title="Bulk-fill this row from a paste" className="ml-1 text-slate-600 hover:text-accent">📋</button>
        {onNavigate && (
          <button onClick={onNavigate}
            title={assignmentNote ? 'Go to its formula assignment' : 'Assign this row to a target or formula'}
            className="ml-1 text-slate-600 hover:text-accent">{assignmentNote ? '🔗' : '🧮'}</button>
        )}
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
          <td key={y} className="text-right py-0.5 px-1 min-w-[6.5rem]">
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
                className="w-full bg-navy-800 border border-accent rounded px-1.5 py-1 text-xs font-mono text-white text-right focus:outline-none"
              />
            ) : (
              <button
                onClick={() => setEditingKey(k)}
                className={`w-full text-right px-1.5 py-1 rounded font-mono whitespace-nowrap hover:bg-navy-800/60 ${dirty ? 'text-accent' : text ? 'text-white' : 'text-slate-600'}`}
                title={dirty ? 'Unsaved edit — click to change' : 'Click to edit'}>
                {text || '—'}
              </button>
            )}
          </td>
        )
      })}
    </tr>
    {showPaste && (
      <tr className="border-b border-navy-800/50">
        <td colSpan={years.length + 1} className="py-2">
          <div className="space-y-1.5 rounded-lg border border-navy-700 bg-navy-900/60 p-2">
            <textarea
              value={pasteText}
              onChange={e => { setPasteText(e.target.value); setPasteWarning('') }}
              rows={2}
              placeholder={`Paste a year header, then one row of values, e.g.\n${years.slice(0, 3).join('\t')}\n450\t600\t720`}
              className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />
            {pasteWarning && <p className="text-[11px] text-neutral">{pasteWarning}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowPaste(false)} className="btn-ghost text-xs flex-1">Cancel</button>
              <button type="button" onClick={fillFromPaste} disabled={!pasteText.trim()}
                className="btn-primary text-xs flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                Stage from paste
              </button>
            </div>
          </div>
        </td>
      </tr>
    )}
    </>
  )
}

// Every place a row can feed, for ONE statement — every valid restatement
// target on this table (dynamic: any field with data, or a custom row —
// see availableTargets), plus every derived/fallback formula's buckets that
// live on this table. One flat list so a single dropdown covers all kinds;
// `value` round-trips through parseDestination below.
function destinationOptions(data, table) {
  const out = []
  for (const t of availableTargets(data)) {
    if (t.table !== table) continue
    out.push({ value: `restatement:${t.key}`, label: t.label })
  }
  for (const formula of listFormulas(data)) {
    if (formula.kind === 'restatement' || formula.table !== table) continue
    for (const bucket of formula.buckets) {
      out.push({ value: `formula:${formula.key}:${bucket.key}`, label: `${formula.label} → ${bucket.label}` })
    }
  }
  return out
}
function parseDestination(value) {
  const [kind, a, b] = String(value).split(':')
  return kind === 'restatement' ? { kind, target: a } : { kind, formula: a, bucket: b }
}

/**
 * A field can feed several targets/formula-buckets at once (message 24 in
 * the design discussion — "each field can be used in multiple formulas") —
 * this generalizes the old single target+sign dropdown into a growable
 * list, reusing the same "+ add another" pattern Merge Rows already used
 * for picking several source rows. Used both by AddRowForm (a not-yet-
 * created row) and FormulasTab (an existing field's live assignment list).
 */
function AssignmentListEditor({ options, rows, onChange }) {
  const addRow = () => onChange([...rows, { destination: '', sign: 1 }])
  const setRow = (i, patch) => onChange(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  const removeRow = (i) => onChange(rows.filter((_, idx) => idx !== i))
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <select value={r.destination} onChange={e => setRow(i, { destination: e.target.value })}
            className="flex-1 bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
            <option value="">No normalization (reference only)</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={r.sign} onChange={e => setRow(i, { sign: Number(e.target.value) })} disabled={!r.destination}
            className="bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200 disabled:opacity-40">
            <option value={1}>+ add</option>
            <option value={-1}>− subtract</option>
          </select>
          {rows.length > 1 && (
            <button type="button" onClick={() => removeRow(i)} className="text-slate-600 hover:text-bear text-xs">✕</button>
          )}
        </div>
      ))}
      <button type="button" onClick={addRow} className="text-[11px] text-accent hover:text-accent-light">
        + Add another assignment
      </button>
    </div>
  )
}

// Custom line items only — a tracked metrics.js field with no data yet
// already shows up the moment it's populated (or, for a signature field,
// is shown blank from the start), so there was never a real gap this form's
// old "tracked field" option filled.
function AddRowForm({ data, table, years, onCancel, onCreateCustom }) {
  const [label, setLabel] = useState('')
  const [assignRows, setAssignRows] = useState([{ destination: '', sign: 1 }])
  const [values, setValues] = useState({})
  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteWarning, setPasteWarning] = useState('')

  const destOptions = destinationOptions(data, table)
  const slug = slugify(label)
  const labelTaken = label.trim().length > 0 && keyCollision(data, slug)

  // Bulk-fill the per-year boxes below from a paste, instead of typing into
  // each one — same shape every other paste surface in the app already
  // uses (a year header row, then one row of label + values), reusing
  // parseRestatementRows as-is rather than a new one-off parser. Only the
  // FIRST data row is used: this form creates one row at a time.
  const fillFromPaste = () => {
    const parsed = parseRestatementRows(pasteText)
    const row = parsed.rows?.[0]
    if (!row) {
      setPasteWarning(parsed.warnings?.[0] || 'Could not find a year header and a row of values in that paste.')
      return
    }
    const matched = {}
    const ignoredYears = []
    for (const [y, v] of Object.entries(row.byYear)) {
      if (years.includes(y)) matched[y] = String(Math.round(v * 100) / 100)
      else ignoredYears.push(y)
    }
    if (Object.keys(matched).length === 0) {
      setPasteWarning(`None of the pasted years match this table's years (${years.join(', ')}).`)
      return
    }
    setValues(v => ({ ...v, ...matched }))
    setPasteText('')
    if (ignoredYears.length) {
      // Leave the paste box open so this note stays visible — hiding it
      // immediately (the clean-match path below) would flash and vanish it.
      setPasteWarning(`Filled ${Object.keys(matched).length} year(s). Ignored year(s) not in this table: ${ignoredYears.join(', ')}.`)
    } else {
      setPasteWarning(''); setShowPaste(false)
    }
  }

  const canSubmit = label.trim().length > 0 && !labelTaken

  return (
    <div className="rounded-lg bg-navy-800/40 px-3 py-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-300">New custom line item</span>
        <button type="button" onClick={onCancel} className="text-slate-500 hover:text-bear text-xs">✕ Cancel</button>
      </div>

      <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Row label — e.g. Indemnification asset"
        className={'w-full bg-navy-800 border rounded px-2 py-1.5 text-xs text-slate-200 ' + (labelTaken ? 'border-bear' : 'border-navy-700')} />
      {labelTaken && (
        <p className="text-[11px] text-bear">A row named "{label.trim()}" already exists — pick a different name.</p>
      )}
      <AssignmentListEditor options={destOptions} rows={assignRows} onChange={setAssignRows} />
      {assignRows.some(r => r.destination) && (
        <p className="text-[11px] text-slate-500">
          Values entered below are applied to what's picked above immediately on create, same as pasting them through the restatement tool.
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500">Values ({years.join(', ')})</span>
        <button type="button" onClick={() => { setShowPaste(s => !s); setPasteWarning('') }}
          className="text-[11px] text-accent hover:text-accent-light">
          {showPaste ? 'Cancel paste' : '📋 Paste values'}
        </button>
      </div>

      {showPaste && (
        <div className="space-y-1.5 rounded-lg border border-navy-700 bg-navy-900/60 p-2">
          <textarea
            value={pasteText}
            onChange={e => { setPasteText(e.target.value); setPasteWarning('') }}
            rows={3}
            placeholder={'Paste a year header, then one row of values — same as any Screener paste, e.g.\n2022\t2023\t2024\n600\t400\t900'}
            className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />
          {pasteWarning && <p className="text-[11px] text-neutral">{pasteWarning}</p>}
          <button type="button" onClick={fillFromPaste} disabled={!pasteText.trim()}
            className="btn-primary text-xs w-full disabled:opacity-40 disabled:cursor-not-allowed">
            Fill values from paste
          </button>
        </div>
      )}

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

      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-ghost text-xs flex-1">Cancel</button>
        <button
          disabled={!canSubmit}
          onClick={() => {
            const assignments = assignRows
              .filter(r => r.destination)
              .map(r => {
                const d = parseDestination(r.destination)
                return d.kind === 'restatement'
                  ? { kind: 'restatement', target: d.target, sign: r.sign }
                  : { kind: 'formula', formula: d.formula, bucket: d.bucket, sign: r.sign }
              })
            onCreateCustom({ key: slug, label: label.trim(), assignments, valuesByYear: values })
          }}
          className="btn-primary text-xs flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
          Create row
        </button>
      </div>
    </div>
  )
}

/**
 * MergeRowsForm — combine several custom rows into one (e.g. several
 * restatement-tool rows that all landed as separate entries) into a single,
 * more readable row. Scoped to CUSTOM rows only — never a tracked metrics.js
 * field: those are read directly, by name, by ratios.js/valuation.js's own
 * formulas, so merging one away would silently sever a real calculation
 * rather than just tidy up a label.
 *
 * Two initial dropdowns (every custom row on this statement is a candidate
 * in both), with "+ add another row" to bring in more than two. Then either
 * "merge into a new row" (name it) or "merge into one of the selected rows"
 * (pick which — it keeps its own name and whatever it already fed; only its
 * values change). A new merged row inherits whatever the FIRST selected
 * source was feeding (MERGE_CUSTOM_FIELDS, AppContext.jsx). The merged value
 * per year is just the sum of whatever the selected rows currently hold
 * that year — computed fresh in the reducer from their live values, not
 * from anything cached here.
 */
function MergeRowsForm({ data, customFields, onCancel, onMerge }) {
  const [slots, setSlots] = useState(['', ''])
  const [mode, setMode] = useState('new')
  const [destKey, setDestKey] = useState('')
  const [newLabel, setNewLabel] = useState('')

  const selectedKeys = [...new Set(slots.filter(Boolean))]
  const newSlug = slugify(newLabel)
  const newLabelTaken = mode === 'new' && newLabel.trim().length > 0 && keyCollision(data, newSlug)
  const canSubmit = selectedKeys.length >= 2 && (mode === 'new' ? (newLabel.trim().length > 0 && !newLabelTaken) : !!destKey)

  const setSlot = (i, key) => setSlots(prev => prev.map((s, idx) => idx === i ? key : s))

  return (
    <div className="rounded-lg bg-navy-800/40 px-3 py-3 space-y-2.5">
      <p className="text-[11px] text-slate-500">Pick two or more rows to combine into one.</p>

      {slots.map((s, i) => (
        <select key={i} value={s} onChange={e => setSlot(i, e.target.value)}
          className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
          <option value="">Row {i + 1}…</option>
          {customFields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      ))}
      <button type="button" onClick={() => setSlots(prev => [...prev, ''])}
        disabled={slots.length >= customFields.length}
        className="text-[11px] text-accent hover:text-accent-light disabled:opacity-40 disabled:cursor-not-allowed">
        + Add another row to merge
      </button>

      <div className="flex gap-3 pt-1">
        {[['new', 'Merge into new row'], ['existing', 'Merge into this row']].map(([m, lbl]) => (
          <label key={m} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
            <input type="radio" name="mergeMode" checked={mode === m} onChange={() => setMode(m)} />
            {lbl}
          </label>
        ))}
      </div>

      {mode === 'new' ? (
        <>
          <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Name for the merged row"
            className={'w-full bg-navy-800 border rounded px-2 py-1.5 text-xs text-slate-200 ' + (newLabelTaken ? 'border-bear' : 'border-navy-700')} />
          {newLabelTaken && (
            <p className="text-[11px] text-bear">A row named "{newLabel.trim()}" already exists — pick a different name.</p>
          )}
        </>
      ) : (
        selectedKeys.length >= 2 && (
          <select value={destKey} onChange={e => setDestKey(e.target.value)}
            className="w-full bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
            <option value="">Which row keeps its name?</option>
            {selectedKeys.map(k => <option key={k} value={k}>{customFields.find(f => f.key === k)?.label}</option>)}
          </select>
        )
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-ghost text-xs flex-1">Cancel</button>
        <button
          disabled={!canSubmit}
          onClick={() => {
            if (mode === 'new') {
              const first = customFields.find(f => f.key === selectedKeys[0])
              const newField = { key: newSlug, label: newLabel.trim(), table: first?.table }
              onMerge(selectedKeys, { mode: 'new', newField })
            } else {
              onMerge(selectedKeys, { mode: 'existing', destKey })
            }
          }}
          className="btn-primary text-xs flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
          Merge
        </button>
      </div>
    </div>
  )
}

/**
 * FormulasTab — every formula this ticker can compute: which buckets it
 * has, what feeds each (field names only, never per-item numbers — the
 * makeup is inspectable one click away in the statement tabs themselves),
 * the equation those buckets combine into, and the live output for the
 * most recent year only.
 *
 * One row per formula, three parts: the bucket(s) (click to open a
 * checkbox list and change membership), the equation written out with
 * field names, and the output. The primary way to wire a NEW row into a
 * formula is still at creation time (AddRowForm's assignment list) — this
 * tab is for reviewing what's already assigned and adjusting an EXISTING
 * row's membership without re-creating it.
 *
 * A "restatement" formula (any field with data, or a custom row — see
 * availableTargets) is really a one-bucket formula whose output overwrites
 * the target's own {field}Normalized rather than producing a new figure —
 * shown here with the exact same shape as a genuine multi-bucket "derived"
 * formula (NWC) so the assignment mechanism doesn't need to know which kind
 * it's looking at.
 */
function FormulasTab({ data, div, focusField, setAssignmentsForField }) {
  // A plain reported line item is not a formula just because the
  // restatement tool COULD target it (kind: 'restatement') — those stay out
  // of this tab; that adjustment is already visible on the field's own row
  // (the "feeds X" note) and its "(Normalized)" audit row. Everything that
  // actually COMBINES fields into a new or fallback-derived figure — 'derived'
  // (Net Working Capital, Capital Employed, Net Debt) and 'fallback'
  // (Gross Profit, Profit Before Tax, Tax, EBITDA — reported wins if
  // present, buckets fill in when it's genuinely absent) — belongs here.
  const formulas = listFormulas(data).filter(f => f.kind === 'derived' || f.kind === 'fallback')
  const fmtNum = v => v == null ? '—' : Math.round(v / div).toLocaleString()
  const focusAssignments = focusField ? assignmentsForField(data, focusField) : []

  const assignedFieldsFor = (formula, bucket) =>
    (data.fieldAssignments || []).filter(a => a.kind === 'formula' && a.formula === formula.key && a.bucket === bucket.key)

  // A formula's own bucket shouldn't be able to pick up ANOTHER formula's
  // output as a raw ingredient via this generic checkbox (tax reading
  // profitBeforeTax is the one legitimate case, and it's wired as a fixed
  // default — see formulas.js — not something offered here for arbitrary
  // reassignment), nor its own key (self-reference).
  const formulaKeys = new Set(formulas.map(f => f.key))
  const candidatesFor = (formula) =>
    availableTargets(data).filter(t => t.table === formula.table && t.key !== formula.key && !formulaKeys.has(t.key))

  // "NWC = Trade Receivables + Inventories − Trade Payables − Advance from
  // Customers" — field names only, same regardless of basis (bucket
  // MEMBERSHIP doesn't change with the toggle, only the resolved VALUES do,
  // which is why this doesn't take a basis param).
  const equationFor = (formula) => {
    const terms = []
    for (const bucket of formula.buckets) {
      for (const a of assignedFieldsFor(formula, bucket)) {
        const effSign = (bucket.sign ?? 1) * (a.sign ?? 1)
        terms.push({ sign: effSign, text: fieldLabel(data, a.field) })
      }
    }
    if (!terms.length) return `${formula.label} = —`
    const rhs = terms.map((t, i) => {
      if (i === 0) return t.sign < 0 ? `− ${t.text}` : t.text
      return `${t.sign < 0 ? '−' : '+'} ${t.text}`
    }).join(' ')
    return `${formula.label} = ${rhs}`
  }

  const isFocused = (formula) => focusAssignments.some(a => a.formula === formula.key)

  const toggleMembership = (formula, bucket, field, checked) => {
    const current = assignmentsForField(data, field)
    if (checked) {
      setAssignmentsForField(field, [...current, { kind: 'formula', formula: formula.key, bucket: bucket.key, sign: 1 }])
    } else {
      const remaining = current.filter(a => !(a.kind === 'formula' && a.formula === formula.key && a.bucket === bucket.key))
      setAssignmentsForField(field, remaining)
    }
  }

  return (
    <div className="space-y-2">
      {focusField && (
        <div className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 text-xs text-slate-200">
          Focused on <strong>{fieldLabel(data, focusField)}</strong> — its current assignments are highlighted below.
        </div>
      )}
      {formulas.map(formula => (
        <FormulaRow key={formula.key} data={data} formula={formula} div={div}
          fmtNum={fmtNum} equation={equationFor(formula)} focused={isFocused(formula)}
          assignedFieldsFor={assignedFieldsFor} candidatesFor={candidatesFor}
          onToggleMembership={toggleMembership} />
      ))}
    </div>
  )
}

// One formula = one div, three parts (bucket chips | equation, with its own
// Reported/Normalized picker right beside it | output for that basis) — the
// picker lives in the SAME space the equation already occupies rather than
// adding a fourth part, since flipping it only changes which VALUES the
// existing equation's fields resolve to, not the fields themselves.
//
// The output itself is read the same way any other field is — a derived
// formula's result is materialized directly onto its row as
// {formula.key}/{formula.key}Normalized (formulas.js's materializeFormulas,
// run from computeAll) — so this is activeValue(row, key, basis), the exact
// call every other consumer in the app already makes, not a formulas.js-
// specific compute function.
function FormulaRow({ data, formula, div, fmtNum, equation, focused, assignedFieldsFor, candidatesFor, onToggleMembership }) {
  const [basis, setBasis] = useState(data?.basis === 'normalized' ? 'normalized' : 'reported')
  const hist = fieldHistory(data, formula.table)
  const realRows = hist.filter(r => /^\d{4}$/.test(String(r?.year ?? '').trim()))
  const latestRow = realRows[realRows.length - 1]
  const resolved = latestRow ? activeValue(latestRow, formula.key, basis) : null
  const output = resolved?.value != null ? { year: latestRow.year, value: resolved.value } : null

  return (
    <div className={'flex items-center gap-3 rounded-lg border px-3 py-2 text-xs ' + (focused ? 'border-accent/60 bg-navy-800/60' : 'border-navy-700 bg-navy-800/30')}>
      <span className="flex flex-wrap gap-1 flex-shrink-0 w-32">
        {formula.buckets.map(bucket => (
          <BucketChip key={bucket.key} formula={formula} bucket={bucket}
            assigned={assignedFieldsFor(formula, bucket)} candidates={candidatesFor(formula)}
            onToggle={(field, checked) => onToggleMembership(formula, bucket, field, checked)} />
        ))}
      </span>
      <span className="flex-1 flex items-center gap-2 min-w-0">
        <select value={basis} onChange={e => setBasis(e.target.value)}
          className="flex-shrink-0 bg-navy-800 border border-navy-700 rounded px-1 py-0.5 text-[11px] text-slate-300">
          <option value="reported">Reported</option>
          <option value="normalized">Normalized</option>
        </select>
        <span className="text-slate-400 font-mono truncate" title={equation}>{equation}</span>
      </span>
      {output
        ? <span className="flex-shrink-0 font-mono text-accent whitespace-nowrap">{fmtNum(output.value)} <span className="text-slate-500">(FY{output.year})</span></span>
        : <span className="flex-shrink-0 text-slate-600">—</span>}
    </div>
  )
}

// Rendered via a portal straight onto document.body, positioned from the
// trigger's own viewport rect — NOT `position: absolute` inside the modal's
// scrollable body. That nesting was the actual bug: a small dropdown
// absolutely positioned inside a tall scrolling ancestor gets clipped by
// that ancestor's overflow the moment it would extend past it, so the part
// that renders "past the edge" isn't just invisible, it isn't there for the
// pointer/wheel either — hence scrolling over what looks like the popup
// instead scrolls the modal underneath. A fixed-position portal has no such
// ancestor to be clipped by, and flips to open upward when there isn't
// room below, instead of always downward regardless of space.
function BucketChip({ formula, bucket, assigned, candidates, onToggle }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState(null)
  const btnRef = useRef(null)
  const label = formula.buckets.length > 1 ? bucket.label : formula.label

  const openPopup = () => {
    const r = btnRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow
    setRect({
      left: Math.min(r.left, window.innerWidth - 232),
      top: openUp ? null : r.bottom + 4,
      bottom: openUp ? window.innerHeight - r.top + 4 : null,
      maxHeight: Math.max(120, (openUp ? spaceAbove : spaceBelow) - 12),
    })
    setOpen(true)
  }

  // The list a user actually wants scrollable here is short and internal
  // (overflow-y-auto on the popup itself, unaffected by this) — a scroll of
  // the PAGE/modal behind it means the trigger has moved, so the popup's
  // now-stale position is closed rather than left floating in the wrong spot.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close) }
  }, [open])

  return (
    <span className="relative">
      <button ref={btnRef} type="button" onClick={() => (open ? setOpen(false) : openPopup())}
        className={'text-[11px] rounded px-1.5 py-0.5 border ' + (assigned.length ? 'border-accent/50 text-accent bg-accent/10' : 'border-navy-700 text-slate-500')}>
        {label} ({assigned.length})
      </button>
      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-56 overflow-y-auto rounded-lg border border-navy-700 bg-navy-900 p-2 space-y-1 shadow-lg"
            style={{ left: rect.left, top: rect.top ?? undefined, bottom: rect.bottom ?? undefined, maxHeight: rect.maxHeight }}>
            {candidates.length === 0 && <p className="text-[11px] text-slate-500">Nothing on this statement to assign yet.</p>}
            {candidates.map(c => {
              const checked = assigned.some(a => a.field === c.key)
              return (
                <label key={c.key} className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={checked} onChange={e => onToggle(c.key, e.target.checked)} />
                  {c.label}
                </label>
              )
            })}
          </div>
        </>,
        document.body
      )}
    </span>
  )
}
