import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { setManualGuidance } from '../../engine/reconcileDocs.js'
import DocumentReader from './DocumentReader.jsx'

/**
 * GuidancePanel — qualitative context, sharing ONE slot store with the document
 * reader (state.arData). Each field is a single-value slot (outlook / PLI /
 * initiatives / runway) with a text box AND a period date. Manual edits write via
 * setManualGuidance — they do NOT auto-count as newest; they're compared by their
 * date against document data (an undated note has no recency claim and a dated
 * document overrides it). Provenance ("manual" / "FY24") is shown on each field.
 *
 * Holdings paste lives in "Add more history" now — not here.
 */

const FIELDS = [
  { key: 'outlook',     label: 'Outlook / guidance',   ph: 'Management outlook, demand commentary…' },
  { key: 'pli',         label: 'PLI / govt schemes',   ph: 'Scheme exposure, incentives, subsidies…' },
  { key: 'initiatives', label: 'New initiatives',      ph: 'New segments, capex, diversification…' },
  { key: 'runway',      label: 'Growth runway / TAM',  ph: 'Addressable market, penetration headroom…' },
]

export default function GuidancePanel() {
  const { state, setQualInputs } = useApp()
  const arData = state.arData || {}
  const [draft, setDraft] = useState({})
  const [docOpen, setDocOpen] = useState(false)

  // Seed local drafts from the stored slots when the ticker changes.
  useEffect(() => {
    const seed = {}
    for (const f of FIELDS) {
      const slot = (state.arData || {})[f.key]
      seed[f.key] = { text: slot?.text || '', asOf: slot?.manual ? (slot?.asOf || '') : '' }
    }
    setDraft(seed)
  }, [state.ticker]) // eslint-disable-line

  const save = (key) => {
    const d = draft[key] || { text: '', asOf: '' }
    const slot = arData[key]
    // Only write if the text actually changed from what's stored.
    if ((slot?.text || '') === (d.text || '') && (slot?.manual ? (slot?.asOf || '') : '') === (d.asOf || '')) return
    const nextAr = setManualGuidance(state.arData, key, d.text, d.asOf || null)
    setQualInputs({ arData: nextAr })
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">📝 Guidance &amp; Qualitative</h2>
        <button onClick={() => setDocOpen(true)} className="btn-primary text-xs">📄 Documents</button>
      </div>

      {arData.lastDoc?.name && (
        <p className="text-[11px] text-slate-500">
          Last document: <span className="text-slate-300">{arData.lastDoc.name}</span>
          {arData.lastDoc.docDate ? ` · ${arData.lastDoc.docDate}` : ''}
        </p>
      )}

      <div className="space-y-3">
        {FIELDS.map(f => {
          const slot = arData[f.key]
          const d = draft[f.key] || { text: '', asOf: '' }
          return (
            <div key={f.key}>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-slate-400">{f.label}</label>
                {slot && <Provenance slot={slot} />}
              </div>
              <textarea
                value={d.text}
                onChange={e => setDraft(s => ({ ...s, [f.key]: { ...d, text: e.target.value } }))}
                onBlur={() => save(f.key)}
                placeholder={f.ph}
                rows={2}
                className="input-field w-full text-sm resize-y" />
              <input
                type="text"
                value={d.asOf}
                onChange={e => setDraft(s => ({ ...s, [f.key]: { ...d, asOf: e.target.value } }))}
                onBlur={() => save(f.key)}
                placeholder="Period (e.g. FY24, Q2 FY25) — undated notes are low-priority"
                className="input-field w-full text-[11px] mt-1" />
            </div>
          )
        })}
        <p className="text-[10px] text-slate-600">
          Notes are compared with document data by their period date. A dated document will
          override an undated or older note; a newer note overrides older document data.
        </p>
      </div>

      <DocumentReader open={docOpen} onClose={() => setDocOpen(false)} />
    </div>
  )
}

function Provenance({ slot }) {
  const tag = slot.manual ? (slot.asOf ? `manual · ${slot.asOf}` : 'manual · undated')
    : (slot.asOf ? `from ${slot.asOf}` : `from ${slot.source || 'document'}`)
  return <span className="text-[10px] text-slate-500">{tag}</span>
}
