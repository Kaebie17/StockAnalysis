import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { setManualGuidance } from '../../engine/reconcileDocs.js'
import DocumentReader from './DocumentReader.jsx'
import Modal from '../Modal.jsx'

/**
 * GuidanceModal — qualitative context + document intelligence, in a modal opened
 * from a link under the Quality & Moat pillar (mirrors "Add more history").
 * Shares one recency-governed slot store (state.arData) with the document reader.
 */

const FIELDS = [
  { key: 'outlook',     label: 'Outlook / guidance',   ph: 'Management outlook, demand commentary…' },
  { key: 'pli',         label: 'PLI / govt schemes',   ph: 'Scheme exposure, incentives, subsidies…' },
  { key: 'initiatives', label: 'New initiatives',      ph: 'New segments, capex, diversification…' },
  { key: 'runway',      label: 'Growth runway / TAM',  ph: 'Addressable market, penetration headroom…' },
]

export default function GuidanceModal({ open, onClose }) {
  const { state, setQualInputs } = useApp()
  const arData = state.arData || {}
  const [draft, setDraft] = useState({})
  const [docOpen, setDocOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const seed = {}
    for (const f of FIELDS) {
      const slot = (state.arData || {})[f.key]
      seed[f.key] = { text: slot?.text || '', asOf: slot?.manual ? (slot?.asOf || '') : '' }
    }
    setDraft(seed)
  }, [open, state.ticker, arData.lastDoc?.at]) // eslint-disable-line

  const save = (key) => {
    const d = draft[key] || { text: '', asOf: '' }
    const slot = arData[key]
    if ((slot?.text || '') === (d.text || '') && (slot?.manual ? (slot?.asOf || '') : '') === (d.asOf || '')) return
    setQualInputs({ arData: setManualGuidance(state.arData, key, d.text, d.asOf || null) })
  }

  if (!open) return null

  return (
    <>
    <Modal
      open={open}
      onClose={onClose}
      title="Guidance & documents"
      subtitle="Qualitative context for the Quality & Moat read"
      widthClass="sm:max-w-2xl"
      actions={
        <>
          <a
            href={`https://www.google.com/search?q=${encodeURIComponent((state.data?.name || state.ticker || '') + ' investor relations')}`}
            target="_blank" rel="noopener noreferrer"
            className="text-xs text-accent hover:text-accent-light">
            IR page ↗
          </a>
          <button onClick={() => setDocOpen(true)} className="btn-primary text-xs">📄 Documents</button>
        </>
      }
    >
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
              <div key={f.key} className="bg-navy-800/30 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-slate-300">{f.label}</label>
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
                  placeholder="Period (FY24, Q2 FY25) — undated notes are low-priority"
                  className="input-field w-full text-[11px] mt-1.5" />
              </div>
            )
          })}
        </div>

        <p className="text-[10px] text-slate-600">
          Notes are compared with document data by period date. A dated document overrides an
          undated or older note; a newer note overrides older document data.
        </p>
    </Modal>
    <DocumentReader open={docOpen} onClose={() => setDocOpen(false)} />
    </>
  )
}

function Provenance({ slot }) {
  const tag = slot.manual ? (slot.asOf ? `manual · ${slot.asOf}` : 'manual · undated')
    : (slot.asOf ? `from ${slot.asOf}` : `from ${slot.source || 'document'}`)
  return <span className="text-[10px] text-slate-500">{tag}</span>
}
