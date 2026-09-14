import React, { useState, useEffect, useRef } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { METRICS, TABLE_SHAPE } from '../../engine/metrics.js'
import { SKIP_SCALE, parseRestatementRows } from '../../utils/pasteParser.js'
import { computeNormalizedRow, activeValue } from '../../engine/dataQuality.js'
import { normalizedFieldValue, availableTargets, listFormulas, fieldLabel, fieldHistory, assignmentsForField, INPUT_FORMULAS, computedRowEquation, formulaTerms } from '../../engine/formulas.js'
import { marketOf } from '../../engine/requiredReturn.js'
import { getRiskFreeRate, refreshRiskFreeRate } from '../../api/riskFreeClient.js'
import { getEquityRiskPremium, refreshEquityRiskPremium } from '../../api/erpClient.js'
import { getAiKey } from '../../utils/aiKey.js'
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
// restatement targets and computed-row terms — replaces the old single
// "feeds X" note, which could only ever describe one destination.
//
// A computed row's terms all live directly in data.fieldAssignments now —
// there's no separate "live default" layer to merge in any more (that
// existed only for the old code-declared bucket shapes); this is a plain
// read of what's actually assigned.
function assignmentSummary(data, field) {
  const list = assignmentsForField(data, field).filter(a => !a.removed)
  if (!list.length) return null
  return list.map(a => {
    const sign = (a.sign ?? 1) > 0 ? '+' : '−'
    if (a.kind === 'restatement') return `${sign} feeds ${fieldLabel(data, a.target)}`
    const formula = listFormulas(data).find(f => f.key === a.formula && f.kind !== 'restatement')
    const side = a.bucket === 'numerator' ? ' (numerator)' : a.bucket === 'denominator' ? ' (denominator)' : ''
    return `${sign} feeds ${formula?.label ?? a.formula}${side}`
  }).join('; ')
}

export default function HistoryTableModal({ open, onClose }) {
  const { state, editHistoryCells, addCustomField, removeCustomField, mergeCustomFields, setGrowthMethodWindow } = useApp()
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
  // The last output value the user actually saw for each formula, per
  // basis: { [formulaKey]: { reported, normalized } } — session-only
  // (plain component state, never persisted to data/storage), and
  // deliberately NOT reset by the effect below: it survives closing and
  // reopening this modal within the same page session, and only resets on
  // an actual reload. A formula's output renders red whenever it differs
  // from this stored watermark — ANY change (new data arriving, an edit,
  // a bucket reassignment, a genuine restatement), not specifically
  // normalization — since the point is noticing something changed at all,
  // not just why. A loose, low-precision "have you looked since this
  // changed" check, not a durable per-value audit trail.
  const [lastSeenOutputs, setLastSeenOutputs] = useState({})

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
  // Merge candidates for this statement — reported/tracked rows with data,
  // same as custom rows: there's no reason merge should be custom-only, a
  // reported field's values live the exact same way (row[key].value) and
  // MERGE_CUSTOM_FIELDS already sums/strips by key generically either way.
  const mergeCandidates = [
    ...shownTrackedKeys.map(k => ({ key: k, label: METRICS[k]?.label || k, table })),
    ...customFields.map(f => ({ key: f.key, label: f.label, table: f.table })),
  ]

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
    const yoyRow = (field, label, anchor) => {
      const series = seriesOf(field)
      const cells = years.map((y, i) => {
        const prev = series[i - 1], cur = series[i]
        return (prev != null && prev !== 0 && cur != null) ? ((cur / prev - 1) * 100) : null
      })
      if (cells.every(c => c == null)) return null
      return { label, cells, fmt: v => v == null ? null : `${v.toFixed(1)}%`, anchor }
    }
    // Operating Margin/Net Margin used to be computed right here, inline,
    // from raw (never basis-resolved) values — superseded below by the
    // same 'ratio' formulas every other consumer reads, which actually
    // respect normalization.
    ;[
      yoyRow('revenue', 'Revenue YoY', 'revenue'),
      yoyRow('netProfit', 'Net Profit YoY', 'netProfit'),
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
      computedRows.push({ label: 'Net Profit (Normalized)', cells: npNorm, fmt: v => v == null ? null : Math.round(v / div).toLocaleString(), anchor: 'netProfit' })
    }
    const epsNorm = years.map(y => {
      const row = history.find(r => String(r.year) === y)
      const n = row ? computeNormalizedRow(row) : null
      return n ? val(n.eps) : null
    })
    if (epsNorm.some(v => v != null)) {
      computedRows.push({ label: 'EPS (Normalized)', cells: epsNorm, fmt: v => v == null ? null : v.toFixed(2), anchor: 'eps' })
    }
  }
  // Restatement-tool Normalized siblings — a real, stored row
  // (recomputeNormalizedTargets, called from computeAll) for any target on
  // THIS statement that currently has at least one custom row feeding it —
  // not just the curated ten, since Part C let the restatement tool target
  // any field with data (or a custom row), and hiding one here would defeat
  // this table's whole point of showing what's actually stored. Anchored
  // to the target's own key, so it renders directly under that field's row
  // rather than in an undifferentiated block at the bottom.
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
      computedRows.push({ label: `${meta.label} (Normalized)`, cells, fmt: v => v == null ? null : (SKIP_SCALE.has(key) ? v.toFixed(2) : Math.round(v / div).toLocaleString()), anchor: key })
    }
  }
  // NWC/PBT/EBITDA/every margin/ROE/FCFF/etc. used to be pushed here as a
  // separate "computed" row layer, anchored under whichever raw field they
  // read most naturally as an extension of — they're `computed: true`
  // custom fields now (see formulas.js's STANDARD_FORMULA_ROWS), so they
  // already render through the ordinary customFields row loop below, in
  // whatever position a custom row normally sorts, same as any other row
  // in the table. Nothing left to inject here.

  // Group computed rows under whichever shown row they're anchored to, so
  // they render immediately below it (Revenue, then Revenue YoY; EBITDA,
  // then EBITDA Margin) instead of in one undifferentiated block at the
  // bottom. Anything with no anchor, or whose anchor isn't actually a row
  // shown on this statement, falls through to the leftover bucket at the
  // very end — the same place every computed row used to render.
  const computedRowsByAnchor = {}
  const leftoverComputedRows = []
  const shownRowKeys = new Set([...shownTrackedKeys, ...customFields.map(f => f.key)])
  for (const r of computedRows) {
    if (r.anchor && shownRowKeys.has(r.anchor)) (computedRowsByAnchor[r.anchor] ??= []).push(r)
    else leftoverComputedRows.push(r)
  }
  const renderComputedRow = r => (
    <tr key={r.label} className="border-b border-navy-800/50">
      <td className="py-1 text-slate-500 italic sticky left-0 bg-navy-900 pr-2 min-w-[11rem]">{r.label}</td>
      {r.cells.map((v, i) => (
        <td key={i} className="text-right py-1 px-2 font-mono text-slate-500 whitespace-nowrap min-w-[6.5rem]">
          {r.fmt(v) ?? '—'}
        </td>
      ))}
    </tr>
  )

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
        <FormulasTab data={data} div={div} focusField={focusField}
          setGrowthMethodWindow={setGrowthMethodWindow}
          lastSeenOutputs={lastSeenOutputs} setLastSeenOutputs={setLastSeenOutputs} />
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
                <React.Fragment key={field}>
                  <EditableRow label={METRICS[field]?.label || field} field={field} years={years}
                    cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                    commitCell={commitCell} cellKey={cellKey}
                    assignmentNote={assignmentSummary(data, field)}
                    onNavigate={() => goToFormulas(field)}
                  />
                  {(computedRowsByAnchor[field] || []).map(renderComputedRow)}
                </React.Fragment>
              ))}
              {customFields.map(f => (
                <React.Fragment key={f.key}>
                  <EditableRow label={f.label} field={f.key} years={years}
                    cellText={cellText} isDirty={isDirty} editingKey={editingKey} setEditingKey={setEditingKey}
                    commitCell={commitCell} cellKey={cellKey}
                    onRemove={() => {
                      if (window.confirm(`Remove "${f.label}" and all its values? This can't be undone.`)) removeCustomField(f.key)
                    }}
                    assignmentNote={assignmentSummary(data, f.key)}
                    onNavigate={() => goToFormulas(f.key)}
                  />
                  {(computedRowsByAnchor[f.key] || []).map(renderComputedRow)}
                </React.Fragment>
              ))}
              {leftoverComputedRows.map(renderComputedRow)}
            </tbody>
          </table>
        </div>
      )}

      {!addingRow && !merging && (
        <div className="flex gap-4">
          <button onClick={() => setAddingRow(true)} className="text-xs text-accent hover:text-accent-light">
            + Add row
          </button>
          {mergeCandidates.length >= 2 && (
            <button onClick={() => setMerging(true)} className="text-xs text-accent hover:text-accent-light">
              ⇄ Merge rows
            </button>
          )}
        </div>
      )}

      {merging && (
        <MergeRowsForm
          data={data}
          fields={mergeCandidates}
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
// see availableTargets), plus every EXISTING TERM of every computed formula
// row (NWC, PBT, EBITDA, ...) — picking one attaches the new row as an
// ADDITIONAL term alongside it, inheriting its sign (formulaTerms,
// formulas.js), never replacing or altering the term it's attached to. One
// flat list so a single dropdown covers all kinds; `value` round-trips
// through parseDestination below.
function destinationOptions(data, table) {
  const out = []
  for (const t of availableTargets(data)) {
    if (t.table !== table) continue
    out.push({ value: `restatement:${t.key}`, label: t.label })
  }
  for (const formula of listFormulas(data)) {
    if (formula.kind !== 'computed' || formula.table !== table) continue
    for (const term of formulaTerms(data, formula.key)) {
      out.push({ value: `formula:${formula.key}:${term.bucket}:${term.sign}`, label: `${formula.label} → ${term.label}` })
    }
  }
  return out
}
function parseDestination(value) {
  const [kind, a, b, c] = String(value).split(':')
  return kind === 'restatement' ? { kind, target: a } : { kind, formula: a, bucket: b, sign: c ? Number(c) : undefined }
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
  // Selecting a formula-term destination pre-fills the sign with the
  // attached-to term's own sign (still editable) — a restatement target has
  // no such term to inherit from, so its sign is left as-is.
  const pickDestination = (i, value) => {
    const d = parseDestination(value)
    setRow(i, d.sign != null ? { destination: value, sign: d.sign } : { destination: value })
  }
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 items-center">
          <select value={r.destination} onChange={e => pickDestination(i, e.target.value)}
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
                if (d.kind === 'restatement') return { kind: 'restatement', target: d.target, sign: r.sign }
                // The term resolves against the row it's attached to, not
                // necessarily this new row's own table — an explicit
                // override is only needed when they differ (see
                // rowForTerm, formulas.js).
                const formulaTable = listFormulas(data).find(f => f.key === d.formula)?.table
                return { kind: 'formula', formula: d.formula, bucket: d.bucket, sign: r.sign, table: formulaTable !== table ? table : undefined }
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
 * MergeRowsForm — combine several rows on this statement into one (e.g.
 * several restatement-tool rows that all landed as separate entries) into a
 * single, more readable row. Available for ANY row with data on this
 * statement, tracked/reported fields included, not just custom ones —
 * MERGE_CUSTOM_FIELDS (AppContext.jsx) sums and strips by key generically
 * either way, reading row[key].value the same way regardless of whether the
 * key is a metrics.js field or a custom one.
 *
 * Two initial dropdowns (every candidate row on this statement is an option
 * in both), with "+ add another row" to bring in more than two. Then either
 * "merge into a new row" (name it) or "merge into one of the selected rows"
 * (pick which — it keeps its own name and whatever it already fed; only its
 * values change). A new merged row inherits whatever the FIRST selected
 * source was feeding (MERGE_CUSTOM_FIELDS, AppContext.jsx). The merged value
 * per year is just the sum of whatever the selected rows currently hold
 * that year — computed fresh in the reducer from their live values, not
 * from anything cached here.
 */
function MergeRowsForm({ data, fields, onCancel, onMerge }) {
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
          {fields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      ))}
      <button type="button" onClick={() => setSlots(prev => [...prev, ''])}
        disabled={slots.length >= fields.length}
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
            {selectedKeys.map(k => <option key={k} value={k}>{fields.find(f => f.key === k)?.label}</option>)}
          </select>
        )
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-ghost text-xs flex-1">Cancel</button>
        <button
          disabled={!canSubmit}
          onClick={() => {
            if (mode === 'new') {
              const first = fields.find(f => f.key === selectedKeys[0])
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
 * FormulasTab — read-only display of every computed formula this ticker
 * has (NWC, PBT, EBITDA, every margin, ROE, FCFF, ...), plus growth/CAGR
 * and the two AI-fetched market inputs. The row itself IS the definition
 * now (a `computed: true` custom field, its terms in data.fieldAssignments
 * — see formulas.js's STANDARD_FORMULA_ROWS/materializeCustomRows), so
 * there's nothing to edit here: the equation (field names only — the
 * per-item numbers are one click away in the statement tabs) and the
 * latest output are just read straight off it. Editing happens through the
 * data table itself — add/remove a term the same way any custom row's
 * contributors are edited, or attach a new row to an existing formula at
 * creation time (AddRowForm's assignment list).
 */
function FormulasTab({ data, div, focusField, setGrowthMethodWindow, lastSeenOutputs, setLastSeenOutputs }) {
  // Every formula with a real bucket structure ('derived' — NWC, Capital
  // Employed, Net Debt — and 'fallback' — Gross Profit, Profit Before Tax,
  // Tax, EBITDA), no matter how trivial or how often the fallback never
  // even fires: this tab is the one place to scan all of them and see
  // which are actually normalized (the output goes red — see FormulaRow)
  // without checking each one's row in three different statement tabs.
  // 'restatement' formulas (revenue, interest, capex, ...) stay excluded —
  // those are plain reported fields with a single implicit bucket, already
  // fully visible via their own row's "feeds X" note and "(Normalized)"
  // audit row; nothing here would add to that.
  const formulas = listFormulas(data).filter(f => f.kind !== 'restatement')
  const fmtNum = v => v == null ? '—' : Math.round(v / div).toLocaleString()
  const focusAssignments = focusField ? assignmentsForField(data, focusField) : []

  const isFocused = (formula) => focusAssignments.some(a => a.formula === formula.key)

  return (
    <div className="space-y-2">
      {focusField && (
        <div className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 text-xs text-slate-200">
          Focused on <strong>{fieldLabel(data, focusField)}</strong> — its current assignments are highlighted below.
        </div>
      )}
      {INPUT_FORMULAS.map(formula => (
        <InputFormulaRow key={formula.key} data={data} formula={formula} />
      ))}
      {formulas.map(formula => (
        formula.kind === 'growth' ? (
          <React.Fragment key={formula.key}>
            <GrowthMethodRow data={data} formula={formula} methodKey="fullPeriodCagr" label="Full-period CAGR"
              setGrowthMethodWindow={setGrowthMethodWindow}
              lastSeen={lastSeenOutputs[formula.key]}
              markSeen={(basis, value) => setLastSeenOutputs(prev => ({ ...prev, [formula.key]: { ...prev[formula.key], [basis]: value } }))} />
            <GrowthMethodRow data={data} formula={formula} methodKey="medianYoY" label="Median YoY"
              setGrowthMethodWindow={setGrowthMethodWindow}
              lastSeen={lastSeenOutputs[formula.key]}
              markSeen={(basis, value) => setLastSeenOutputs(prev => ({ ...prev, [formula.key]: { ...prev[formula.key], [basis]: value } }))} />
            <GrowthMethodRow data={data} formula={formula} methodKey="recentMedianYoY" label="Recent median YoY"
              setGrowthMethodWindow={setGrowthMethodWindow}
              lastSeen={lastSeenOutputs[formula.key]}
              markSeen={(basis, value) => setLastSeenOutputs(prev => ({ ...prev, [formula.key]: { ...prev[formula.key], [basis]: value } }))} />
          </React.Fragment>
        ) : (
          <FormulaRow key={formula.key} data={data} formula={formula}
            fmtNum={fmtNum} focused={isFocused(formula)}
            lastSeen={lastSeenOutputs[formula.key]}
            markSeen={(basis, value) => setLastSeenOutputs(prev => ({ ...prev, [formula.key]: { ...prev[formula.key], [basis]: value } }))} />
        )
      ))}
    </div>
  )
}

// Read-only display for a computed custom row (NWC, PBT, EBITDA, every
// margin, ROE, FCFF, ...) — the ROW itself is the definition now (see
// formulas.js's STANDARD_FORMULA_ROWS/materializeCustomRows), edited
// through the data table (add/remove a term the same way any custom row's
// contributors are edited) or the "attach to an existing formula" option
// when creating a new row, never through a picker here — there is nothing
// left for this row to toggle.
//
// The output itself is read the same way any other field is — a computed
// row's result is materialized directly onto its row as
// {formula.key}/{formula.key}Normalized (formulas.js's materializeCustomRows,
// run from computeAll) — so this is activeValue(row, key, basis), the exact
// call every other consumer in the app already makes.
function FormulaRow({ data, formula, fmtNum, focused, lastSeen, markSeen }) {
  const hist = fieldHistory(data, formula.table)
  const realRows = hist.filter(r => !r?.synthetic && /^\d{4}$/.test(String(r?.year ?? '').trim()))
  const latestRow = realRows[realRows.length - 1]
  // Default to Normalized only if THIS row's own output actually differs
  // under it — materializeCustomRows only ever writes {formula.key}Normalized
  // when at least one of its own terms has a real override, so its
  // presence/absence here is exactly the right signal. NOT data?.basis (the
  // app-wide toggle): that flips to 'normalized' the moment ANYTHING on the
  // ticker is restated, which has nothing to do with whether THIS row's
  // own inputs are.
  const hasOwnNormalization = latestRow?.[`${formula.key}Normalized`]?.value != null
  const [basis, setBasis] = useState(hasOwnNormalization ? 'normalized' : 'reported')
  const resolved = latestRow ? activeValue(latestRow, formula.key, basis) : null
  const output = resolved?.value != null ? { year: latestRow.year, value: resolved.value } : null

  // Red means "this differs from the value you last actually looked at" —
  // ANY change (new data arriving, an edit, a term added/removed, a real
  // restatement), not specifically normalization; the point is catching
  // that something moved, then letting you judge whether it's expected.
  const currentValue = output?.value ?? null
  const changed = lastSeen?.[basis] === undefined || lastSeen[basis] !== currentValue

  // Marked seen on UNMOUNT, not mount — see GrowthMethodRow's own comment
  // for why (marking on mount would flip it back before the render settles).
  const latestRef = useRef({ basis, value: currentValue })
  latestRef.current = { basis, value: currentValue }
  useEffect(() => () => markSeen(latestRef.current.basis, latestRef.current.value), [markSeen])

  const equation = computedRowEquation(data, formula)

  return (
    <fieldset className={'flex items-center gap-3 rounded-lg border px-3 py-2 text-xs min-w-0 ' + (focused ? 'border-accent/60 bg-navy-800/60' : 'border-navy-700 bg-navy-800/30')}>
      <legend className="px-1 text-[11px] text-slate-400">{formula.label}</legend>
      <span className="flex-1 flex items-center gap-2 min-w-0">
        <select value={basis} onChange={e => setBasis(e.target.value)}
          className="flex-shrink-0 bg-navy-800 border border-navy-700 rounded px-1 py-0.5 text-[11px] text-slate-300">
          <option value="reported">Reported</option>
          <option value="normalized">Normalized</option>
        </select>
        <span className="text-slate-400 font-mono truncate min-w-0" title={equation}>{equation}</span>
      </span>
      {output
        ? <span className={'flex-shrink-0 font-mono whitespace-nowrap ' + (changed ? 'text-bear' : 'text-accent')} title={changed ? 'Different from what you last saw here' : undefined}>{fmtNum(output.value)} <span className="text-slate-500">(FY{output.year})</span></span>
        : <span className="flex-shrink-0 text-slate-600">—</span>}
    </fieldset>
  )
}

// Risk-free rate / ERP aren't per-ticker (see INPUT_FORMULAS, formulas.js)
// — fetched live from the existing monthly-cached clients (the same ones
// requiredReturn.js/AppContext already use for CAPM) rather than
// materialized from data, with the same explicit refresh trigger those
// clients already expose.
const INPUT_FETCHERS = {
  riskFreeRate: { get: getRiskFreeRate, refresh: refreshRiskFreeRate,
    shape: r => ({ value: r?.ratePct, asOf: r?.asOf, stale: r?.stale, note: r?.note }) },
  equityRiskPremium: { get: getEquityRiskPremium, refresh: refreshEquityRiskPremium,
    shape: r => ({ value: r?.erpPct, asOf: r?.asOf, stale: r?.stale, note: r?.note }) },
}

function InputFormulaRow({ data, formula }) {
  const market = marketOf(data?.currency)
  const fetcher = INPUT_FETCHERS[formula.key]
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let live = true
    fetcher.get({ market, userKey: getAiKey() }).then(r => { if (live) setResult(fetcher.shape(r)) })
    return () => { live = false }
  }, [market])

  const doRefresh = async () => {
    setLoading(true)
    try {
      const r = await fetcher.refresh({ market, userKey: getAiKey() })
      setResult(fetcher.shape(r))
    } finally { setLoading(false) }
  }

  return (
    <fieldset className="flex items-center gap-3 rounded-lg border border-navy-700 bg-navy-800/30 px-3 py-2 text-xs min-w-0">
      <legend className="px-1 text-[11px] text-slate-400">{formula.label}</legend>
      <span className="flex-1 min-w-0 text-slate-400 truncate" title={formula.formula}>{formula.formula}</span>
      {result?.value != null
        ? <span className="flex-shrink-0 font-mono text-accent" title={result.note || (result.asOf ? `As of ${result.asOf}` : undefined)}>
            {result.value.toFixed(2)}%{result.stale ? <span className="text-slate-500"> (stale)</span> : null}
          </span>
        : <span className="flex-shrink-0 text-slate-600">{result ? '—' : 'loading…'}</span>}
      <button type="button" onClick={doRefresh} disabled={loading}
        className="flex-shrink-0 rounded bg-navy-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-navy-600 disabled:opacity-50">
        {loading ? '…' : 'Refresh'}
      </button>
    </fieldset>
  )
}

// A growth formula (revenueGrowth, netProfitGrowth — see formulas.js's
// 'growth' kind) isn't a bucket combination, so it doesn't render as one
// row: GrowthMethodRow renders EACH method as its own separate, ordinary-
// looking formula row — "Revenue Growth (Full-period CAGR)", "Revenue
// Growth (Median YoY)", etc. — same shape as every other formula in this
// tab, each with its own start-year AND end-year dropdown (populated from
// the years this field actually has data for — the real data breadth, not
// an arbitrary range), so excluding any year — including the latest, in-
// progress one — is just picking a start/end pair around it; no separate
// "perimeter break" concept. The one thing that changes which method feeds
// valuation is the header's GrowthMethodBadge; nothing here sets that.
function growthMethodsFor(data, formula) {
  const hist = fieldHistory(data, formula.table)
  const realRows = hist.filter(r => !r?.synthetic && /^\d{4}$/.test(String(r?.year ?? '').trim()))
  const latestRow = realRows[realRows.length - 1]
  // computeGrowthBundle already reads Normalized-over-Reported per field
  // internally (activeValue's own rule) — no separate basis picker needed.
  const resolved = latestRow ? activeValue(latestRow, formula.key, 'normalized') : null
  return { realRows, methods: resolved?.methods || null }
}

function GrowthMethodRow({ data, formula, methodKey, label, setGrowthMethodWindow, lastSeen, markSeen }) {
  const { methods } = growthMethodsFor(data, formula)
  const value = methods?.[methodKey]
  const equation = methods?.[`${methodKey}Equation`]
  const startYear = methods?.[`${methodKey}StartYear`] ?? ''
  const endYear = methods?.[`${methodKey}EndYear`] ?? ''
  const availableStartYears = methods?.availableStartYears || []
  const availableEndYears = methods?.availableEndYears || []
  const isActive = methods?.methodOverride
    ? methods.methodOverride === methodKey
    : methods?.selected === value

  // Only the SELECTED method's card tracks red-if-changed — that's the one
  // figure actually consumed elsewhere; the other cards are inspection only.
  const trackChange = methods?.methodOverride ? isActive : methodKey === 'medianYoY'
  const currentValue = trackChange ? value : null
  const changed = trackChange && (lastSeen?.normalized === undefined || lastSeen.normalized !== currentValue)
  const latestRef = useRef(currentValue)
  latestRef.current = currentValue
  useEffect(() => {
    if (!trackChange) return
    return () => markSeen('normalized', latestRef.current)
  }, [markSeen, trackChange])

  if (value == null) return null

  return (
    <fieldset className={'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs min-w-0 ' + (isActive ? 'border-accent/50 bg-accent/10' : 'border-navy-700 bg-navy-800/30')}>
      <legend className="px-1 text-[11px] text-slate-400">{formula.label} ({label})</legend>
      <select value={startYear}
        title="Window start year — populated from the years this field actually has data for"
        onChange={e => setGrowthMethodWindow(formula.key, methodKey, 'start', e.target.value === '' ? null : Number(e.target.value))}
        className="flex-shrink-0 bg-navy-800 border border-navy-700 rounded px-1 py-0.5 text-[11px] text-slate-300">
        {availableStartYears.map(y => <option key={y} value={y}>from FY{y}</option>)}
      </select>
      <select value={endYear}
        title="Window end year — defaults to the latest year, but not pinned to it (an in-progress/bad latest year can be excluded)"
        onChange={e => setGrowthMethodWindow(formula.key, methodKey, 'end', e.target.value === '' ? null : Number(e.target.value))}
        className="flex-shrink-0 bg-navy-800 border border-navy-700 rounded px-1 py-0.5 text-[11px] text-slate-300">
        {availableEndYears.map(y => <option key={y} value={y}>to FY{y}</option>)}
      </select>
      <span className="flex-1 text-slate-400 font-mono truncate min-w-0" title={equation || ''}>{equation || '—'}</span>
      <span className={'flex-shrink-0 font-mono whitespace-nowrap ' + (trackChange && changed ? 'text-bear' : 'text-slate-300')}
        title={trackChange && changed ? 'Different from what you last saw here' : undefined}>
        {value.toFixed(1)}%
      </span>
    </fieldset>
  )
}
