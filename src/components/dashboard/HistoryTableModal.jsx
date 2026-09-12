import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { METRICS, TABLE_SHAPE } from '../../engine/metrics.js'
import { SKIP_SCALE, parseRestatementRows } from '../../utils/pasteParser.js'
import { normalizedFieldValue, availableTargets } from '../../engine/normalizationTargets.js'
import { computeNormalizedRow } from '../../engine/dataQuality.js'
import { listFormulas, fieldLabel, fieldTable, assignmentsForField, computeDerivedFormulaLatest } from '../../engine/formulas.js'
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

  // 'pasted' = you put this number in yourself (Add History/Fill Gaps/this
  // grid) — everything else (Yahoo's 'source'/'cross-source', a scraper's
  // 'derived') is a lower-confidence fill you didn't supply. Surfaced as a
  // color, not just a tooltip, so a Yahoo-filled cell sitting inside years
  // you've otherwise fully pasted is obvious at a glance instead of
  // requiring an IndexedDB dump to find.
  const statusFor = (year, field) => {
    const row = history.find(r => String(r?.year) === year)
    return row?.[field]?.status ?? null
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
                  commitCell={commitCell} cellKey={cellKey} statusFor={statusFor}
                  assignmentNote={assignmentSummary(data, field)}
                  onNavigate={() => goToFormulas(field)}
                />
              ))}
              {customFields.map(f => (
                <EditableRow key={f.key} label={f.label} field={f.key} years={years}
                  cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                  commitCell={commitCell} cellKey={cellKey} statusFor={statusFor}
                  onRemove={() => {
                    if (window.confirm(`Remove "${f.label}" and all its values? This can't be undone.`)) removeCustomField(f.key)
                  }}
                  assignmentNote={assignmentSummary(data, f.key)}
                  onNavigate={() => goToFormulas(f.key)}
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
          shownTrackedKeys={shownTrackedKeys}
          div={div}
          onCancel={() => setAddingRow(false)}
          onCreateTracked={(field, valuesByYear) => {
            const edits = Object.entries(valuesByYear)
              .filter(([, v]) => v !== '')
              .map(([year, v]) => ({ year, field, value: Number(v) * (SKIP_SCALE.has(field) ? 1 : div) }))
            if (edits.length) editHistoryCells(table, edits)
            setAddingRow(false)
          }}
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

function EditableRow({ label, field, years, cellText, isDirty, editingKey, setEditingKey, commitCell, cellKey, onRemove, assignmentNote, onNavigate, statusFor }) {
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
      if (years.includes(y)) { commitCell(y, field, String(v)); matched++ }
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
      <td className="py-1 text-slate-300 sticky left-0 bg-navy-900 pr-2">
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
            ) : (() => {
              const status = statusFor?.(y, field)
              // Not something you pasted yourself — Yahoo's 'source'/
              // 'cross-source', or a scraper's 'derived'. Colored
              // separately so a lower-confidence fill sitting inside years
              // you've otherwise pasted is obvious without checking the
              // raw tag on every cell.
              const isFill = !dirty && text && status && status !== 'pasted'
              return (
                <button
                  onClick={() => setEditingKey(k)}
                  className={`w-full text-right px-1.5 py-1 rounded font-mono hover:bg-navy-800/60 ${dirty ? 'text-accent' : isFill ? 'text-neutral' : text ? 'text-white' : 'text-slate-600'}`}
                  title={dirty ? 'Unsaved edit — click to change' : isFill ? `Not pasted — filled from ${status} (Yahoo/scraper), not your own data. Click to correct.` : 'Click to edit'}>
                  {text || '—'}
                </button>
              )
            })()}
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
// see availableTargets), plus every derived formula's buckets that live on
// this table (currently just NWC's two). One flat list so a single dropdown
// covers both kinds; `value` round-trips through parseDestination below.
function destinationOptions(data, table) {
  const out = []
  for (const t of availableTargets(data)) {
    if (t.table !== table) continue
    out.push({ value: `restatement:${t.key}`, label: `Feeds ${t.label} (normalization)` })
  }
  for (const formula of listFormulas(data)) {
    if (formula.kind !== 'derived' || formula.table !== table) continue
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
          {r.destination && (
            <select value={r.sign} onChange={e => setRow(i, { sign: Number(e.target.value) })}
              className="bg-navy-800 border border-navy-700 rounded px-2 py-1.5 text-xs text-slate-200">
              <option value={1}>+ add</option>
              <option value={-1}>− subtract</option>
            </select>
          )}
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

function AddRowForm({ data, table, years, shownTrackedKeys, div, onCancel, onCreateTracked, onCreateCustom }) {
  const [kind, setKind] = useState('tracked')
  const [trackedField, setTrackedField] = useState('')
  const [label, setLabel] = useState('')
  const [assignRows, setAssignRows] = useState([{ destination: '', sign: 1 }])
  const [values, setValues] = useState({})
  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteWarning, setPasteWarning] = useState('')

  const destOptions = destinationOptions(data, table)
  const slug = slugify(label)
  const labelTaken = kind === 'custom' && label.trim().length > 0 && keyCollision(data, slug)

  const availableTracked = Object.keys(METRICS).filter(k => METRICS[k].table === table && !shownTrackedKeys.includes(k))

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
      if (years.includes(y)) matched[y] = String(v)
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

  const canSubmit = kind === 'tracked' ? !!trackedField : (label.trim().length > 0 && !labelTaken)

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
        </>
      )}

      {(kind === 'tracked' ? trackedField : true) && (
        <>
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
        </>
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-ghost text-xs flex-1">Cancel</button>
        <button
          disabled={!canSubmit}
          onClick={() => {
            if (kind === 'tracked') { onCreateTracked(trackedField, values); return }
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
          Add row
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
 * FormulasTab — every formula this ticker can compute, what feeds each of
 * its buckets (field names only, never per-item numbers — the makeup is
 * inspectable one click away in the statement tabs themselves), and the
 * live output for the most recent year only. This is the ONE place bucket
 * membership is assigned; a row's nav button (EditableRow's 🔗/🧮) just
 * lands here instead of opening a second, duplicate picker in the main
 * tabs.
 *
 * A "restatement" formula (any field with data, or a custom row — see
 * availableTargets) is really a one-bucket formula whose output overwrites
 * the target's own {field}Normalized rather than producing a new figure —
 * shown here with the exact same shape as a genuine multi-bucket "derived"
 * formula (NWC) so the assignment mechanism doesn't need to know which kind
 * it's looking at.
 */
function FormulasTab({ data, div, focusField, setAssignmentsForField }) {
  const formulas = listFormulas(data)
  const fmtNum = v => v == null ? '—' : (v / div).toLocaleString(undefined, { maximumFractionDigits: 1 })
  const focusAssignments = focusField ? assignmentsForField(data, focusField) : []

  const assignedFieldsFor = (formula, bucket) =>
    (data.fieldAssignments || []).filter(a =>
      formula.kind === 'restatement' ? (a.kind === 'restatement' && a.target === formula.key)
                                      : (a.kind === 'formula' && a.formula === formula.key && a.bucket === bucket.key))

  const candidatesFor = (formula) =>
    availableTargets(data).filter(t => t.table === formula.table && t.key !== formula.key)

  const outputFor = (formula) => {
    if (formula.kind === 'derived') {
      const r = computeDerivedFormulaLatest(data, formula.key)
      return r?.output != null ? { year: r.year, value: r.output } : null
    }
    const hist = formula.table === 'income' ? (data.reportedIncomeHistory || data.incomeHistory || [])
      : formula.table === 'balance' ? (data.balanceHistory || []) : (data.cashflowHistory || [])
    const realRows = hist.filter(r => /^\d{4}$/.test(String(r?.year ?? '').trim()))
    const row = realRows[realRows.length - 1]
    if (!row) return null
    const n = normalizedFieldValue(row, formula.key)
    return n?.value != null ? { year: row.year, value: n.value } : null
  }

  const isFocused = (formula) => focusAssignments.some(a =>
    formula.kind === 'restatement' ? a.target === formula.key : a.formula === formula.key)

  return (
    <div className="space-y-3">
      {focusField && (
        <div className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 text-xs text-slate-200">
          Focused on <strong>{fieldLabel(data, focusField)}</strong> — its current assignments are highlighted below.
        </div>
      )}
      {formulas.map(formula => (
        <div key={formula.key}
          className={'rounded-lg border px-3 py-2.5 space-y-2 ' + (isFocused(formula) ? 'border-accent/60 bg-navy-800/60' : 'border-navy-700 bg-navy-800/30')}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-200">{formula.label}</span>
            {(() => {
              const out = outputFor(formula)
              return out
                ? <span className="text-xs font-mono text-accent">{fmtNum(out.value)} <span className="text-slate-500">(FY{out.year})</span></span>
                : <span className="text-xs text-slate-600">—</span>
            })()}
          </div>
          {formula.buckets.map(bucket => {
            const assigned = assignedFieldsFor(formula, bucket)
            return (
              <div key={bucket.key} className="pl-2 border-l border-navy-700 space-y-1">
                {formula.buckets.length > 1 && <div className="text-[11px] text-slate-500">{bucket.label}</div>}
                <div className="flex flex-wrap gap-1.5">
                  {assigned.length === 0 && <span className="text-[11px] text-slate-600">Nothing assigned yet.</span>}
                  {assigned.map(a => (
                    <span key={a.field} className="inline-flex items-center gap-1 text-[11px] bg-navy-900/60 border border-navy-700 rounded px-1.5 py-0.5 text-slate-300">
                      {(a.sign ?? 1) > 0 ? '+' : '−'} {fieldLabel(data, a.field)}
                      <button onClick={() => {
                        const remaining = assignmentsForField(data, a.field).filter(x => x !== a)
                        setAssignmentsForField(a.field, remaining)
                      }} className="text-slate-600 hover:text-bear">✕</button>
                    </span>
                  ))}
                </div>
                <BucketAddControl
                  candidates={candidatesFor(formula).filter(c => !assigned.some(a => a.field === c.key))}
                  onAdd={(field, sign) => {
                    const entry = formula.kind === 'restatement'
                      ? { kind: 'restatement', target: formula.key, sign }
                      : { kind: 'formula', formula: formula.key, bucket: bucket.key, sign }
                    setAssignmentsForField(field, [...assignmentsForField(data, field), entry])
                  }}
                />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function BucketAddControl({ candidates, onAdd }) {
  const [field, setField] = useState('')
  const [sign, setSign] = useState(1)
  if (!candidates.length) return null
  return (
    <div className="flex gap-1.5 items-center">
      <select value={field} onChange={e => setField(e.target.value)}
        className="flex-1 bg-navy-800 border border-navy-700 rounded px-1.5 py-1 text-[11px] text-slate-200">
        <option value="">+ add a row…</option>
        {candidates.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      {field && (
        <>
          <select value={sign} onChange={e => setSign(Number(e.target.value))}
            className="bg-navy-800 border border-navy-700 rounded px-1.5 py-1 text-[11px] text-slate-200">
            <option value={1}>+</option>
            <option value={-1}>−</option>
          </select>
          <button type="button" onClick={() => { onAdd(field, sign); setField('') }}
            className="text-[11px] text-accent hover:text-accent-light">Add</button>
        </>
      )}
    </div>
  )
}
