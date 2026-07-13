import React, { useRef, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { extractSections, detectScanned, sniffAmount, sniffPledge, sniffRpt } from '../../engine/arExtract.js'
import { reconcile } from '../../engine/reconcileDocs.js'

/**
 * DocumentReader — reads ANY filing (annual report, quarterly result, investor
 * presentation, concall transcript) in-browser via pdf.js (no OCR, no AI), finds
 * candidate passages by keyword, lets the user keep/edit/remove, then reconciles
 * the kept intelligence into state.arData:
 *   • outlook / PLI / initiatives / runway → single-value slots (recency wins)
 *   • pledge / related-party               → dated rows in trend tables
 * The source file is never stored — only the selected, reconciled signals.
 *
 * A document period (type + as-of, e.g. "Q2 FY25") is required so recency and the
 * trend tables work. Requires: npm install pdfjs-dist
 */

import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const DOC_TYPES = ['Annual report', 'Quarterly result', 'Investor presentation', 'Concall transcript', 'Other']

// Fiscal-year options: current FY back ~12 years. (Indian FY ends Mar; label by end-year.)
function fyOptions() {
  const now = new Date()
  const endYear = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear()  // Apr onward → next FY end
  const out = []
  for (let y = endYear; y >= endYear - 12; y--) out.push(y)
  return out
}
const blockId = b => `${b.field}:${b.page}:${b.idx}`
const SINGLE = new Set(['outlook', 'pli', 'initiatives', 'runway'])

export default function DocumentReader({ open, onClose }) {
  const { state, setQualInputs } = useApp()
  const [status, setStatus] = useState('idle')   // idle | extracting | review | scanned | error
  const [progress, setProgress] = useState(0)
  const [groups, setGroups] = useState([])
  const [decisions, setDecisions] = useState({})
  const [fileName, setFileName] = useState('')
  const [docType, setDocType] = useState(DOC_TYPES[0])
  const [fy, setFy] = useState('')
  const [quarter, setQuarter] = useState('')
  const isQuarterly = docType === 'Quarterly result' || docType === 'Concall transcript'
  // Canonical period string that dateKey/reconcile parse cleanly.
  const docDate = fy
    ? (isQuarterly && quarter ? `Q${quarter} FY${String(fy).slice(-2)}` : `FY${String(fy).slice(-2)}`)
    : ''
  const [diag, setDiag] = useState(null)
  const fileRef = useRef(null)

  if (!open) return null

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setStatus('extracting'); setProgress(0)
    try {
      const pages = await extractPdfText(file, setProgress)
      const chars = pages.reduce((s, p) => s + (p.text?.length || 0), 0)
      setDiag({ pages: pages.length, chars, perPage: pages.length ? Math.round(chars / pages.length) : 0 })
      if (detectScanned(pages)) { setStatus('scanned'); return }
      const { groups } = extractSections(pages)
      const seed = {}
      groups.forEach(g => g.blocks.forEach(b => { seed[blockId(b)] = { status: 'pending', text: b.snippet } }))
      setGroups(groups); setDecisions(seed); setStatus('review')
    } catch (err) {
      console.warn('[DocumentReader] extract failed:', err?.message)
      setStatus('error')
    }
  }

  const setBlock = (id, patch) => setDecisions(d => ({ ...d, [id]: { ...d[id], ...patch } }))

  const keptBlocks = () => {
    const out = []
    groups.forEach(g => g.blocks.forEach(b => {
      if (decisions[blockId(b)]?.status === 'kept') out.push(b)
    }))
    return out
  }
  const kept = keptBlocks()
  const keptTrendWithoutDate = !docDate && kept.some(b => b.field === 'pledge' || b.field === 'rpt')

  const apply = () => {
    const slots = {}
    const textByField = {}
    for (const b of kept) {
      const dec = decisions[blockId(b)]
      const text = (dec.text || '').trim()
      if (b.field === 'pledge') {
        const p = sniffPledge(text || b.snippet)
        if (p.pct != null) slots.pledge = { pct: p.pct }
      } else if (b.field === 'rpt') {
        const rr = sniffRpt(text || b.snippet)
        slots.rpt = { present: true, pctOfRevenue: rr.pctOfRevenue }
      } else if (b.field === 'materialCost') {
        const a = sniffAmount(text || b.snippet)
        if (a.value != null) slots.materialCost = { value: a.value }
      } else if (SINGLE.has(b.field) && text) {
        textByField[b.field] = textByField[b.field] ? `${textByField[b.field]} ${text}` : text
      }
    }
    for (const [field, text] of Object.entries(textByField)) slots[field] = { text }

    const merged = reconcile(state.arData, {
      docType, docDate: docDate || null, name: fileName, slots, at: Date.now(),
    })
    setQualInputs({ arData: merged })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] bg-navy-950 flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-navy-800 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-white flex items-center gap-2"><span>📄</span><span className="truncate">Document reader</span></h2>
          {fileName && <p className="text-[11px] text-slate-500 truncate">{fileName}</p>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {status === 'review' && (
            <button onClick={apply} disabled={kept.length === 0} className="btn-primary text-sm disabled:opacity-40">
              Apply {kept.length ? `(${kept.length})` : ''}
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white text-2xl leading-none px-1">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4">
          {status === 'idle' && (
            <div className="text-center py-16 space-y-4">
              <div className="text-4xl">📄</div>
              <p className="text-sm text-slate-300">Upload any filing — annual report, quarterly result, investor presentation, or concall transcript. Read in your browser; the file never leaves your device.</p>
              <button onClick={() => fileRef.current?.click()} className="btn-primary text-sm">Choose PDF</button>
              <p className="text-[11px] text-slate-600">Text-based PDFs only. Scanned files have no text layer and can't be read.</p>
            </div>
          )}

          {status === 'extracting' && (
            <div className="text-center py-20 space-y-3">
              <div className="text-sm text-slate-400 animate-pulse">Reading document… {progress}%</div>
              <div className="h-1.5 bg-navy-800 rounded max-w-sm mx-auto overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {status === 'scanned' && (
            <Center icon="🚫" title="No readable text layer (likely scanned)."
              sub="We don't OCR. Open the document yourself and paste the relevant passages into the guidance fields." onClose={onClose} />
          )}
          {status === 'error' && (
            <div className="text-center py-16 space-y-3"><div className="text-4xl">⚠️</div>
              <p className="text-sm text-slate-300">Couldn't read that PDF.</p>
              <button onClick={() => setStatus('idle')} className="btn-primary text-sm">Try another file</button></div>
          )}

          {status === 'review' && (
            <div className="space-y-5">
              {/* Document period — needed for recency + trend placement */}
              <div className="bg-navy-800/50 rounded-lg p-3 space-y-2">
                <div className="text-xs font-semibold text-slate-300">What document is this?</div>
                <div className="flex flex-wrap gap-1.5">
                  {DOC_TYPES.map(t => (
                    <button key={t} onClick={() => setDocType(t)}
                      className={`badge ${docType === t ? 'bg-accent/30 text-accent-light' : 'bg-navy-700 text-slate-300'}`}>{t}</button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select value={fy} onChange={e => setFy(e.target.value)}
                    className="input-field text-xs py-1">
                    <option value="">Fiscal year…</option>
                    {fyOptions().map(y => (
                      <option key={y} value={y}>{`FY${String(y).slice(-2)} (year ended Mar ${y})`}</option>
                    ))}
                  </select>
                  {isQuarterly && (
                    <select value={quarter} onChange={e => setQuarter(e.target.value)}
                      className="input-field text-xs py-1">
                      <option value="">Quarter…</option>
                      {['1', '2', '3', '4'].map(q => <option key={q} value={q}>{`Q${q}`}</option>)}
                    </select>
                  )}
                  {docDate && <span className="text-[11px] text-slate-400">Period: <span className="text-slate-200">{docDate}</span></span>}
                </div>
                {diag && (
                  <p className="text-[10px] text-slate-500">
                    Read {diag.pages} pages · ~{diag.chars.toLocaleString()} characters ({diag.perPage}/page).
                    {diag.perPage < 300 && ' Low text density — this PDF may be image-heavy, so keyword matches will be sparse.'}
                  </p>
                )}
                {keptTrendWithoutDate && (
                  <p className="text-[11px] text-bear">Add a period so the pledge/related-party figures can be placed on their trend tables.</p>
                )}
              </div>

              {groups.length === 0 ? (
                <Center icon="🔍" title="No matching sections found." sub="Nothing on outlook, related-party, pledge, capex, PLI or market opportunity." onClose={onClose} />
              ) : (
                <>
                  <p className="text-xs text-slate-500">Keep what matters, trim the text, remove false positives. Outlook/PLI/initiatives/runway update the matching guidance field by recency; pledge and related-party add dated rows to their trend.</p>
                  {groups.map(g => (
                    <div key={g.field}>
                      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{g.label} · {g.blocks.length}</h3>
                      <div className="space-y-3">
                        {g.blocks.map(b => {
                          const id = blockId(b)
                          const dec = decisions[id] || { status: 'pending', text: b.snippet }
                          if (dec.status === 'removed') return null
                          const isKept = dec.status === 'kept'
                          const fig = b.rpt?.pctOfRevenue != null ? ` · ~${b.rpt.pctOfRevenue}% of revenue`
                            : b.pledge?.pct != null ? ` · ${b.pledge.pct}% pledged`
                            : b.amount?.value != null ? ` · ₹${b.amount.value.toLocaleString()}` : ''
                          const isNumeric = b.amount != null || b.pledge != null || b.rpt != null
                          const basisTag = b.field === 'materialCost'
                            ? (b.basis === 'consolidated' ? '[Consolidated]' : b.basis === 'standalone' ? '[Standalone]' : '[Basis unclear]')
                            : null
                          return (
                            <div key={id} className={`rounded-lg border p-3 ${isKept ? 'border-bull/40 bg-bull/5' : 'border-navy-700 bg-navy-900/50'}`}>
                              <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[10px] text-slate-500">
                                  p.{b.page} · matched “{b.keyword}”{fig}
                                  {basisTag && <span className={`ml-1 ${b.basis === 'standalone' ? 'text-bear' : b.basis === 'consolidated' ? 'text-bull' : 'text-neutral'}`}>{basisTag}</span>}
                                </span>
                                <div className="flex gap-1">
                                  <button onClick={() => setBlock(id, { status: isKept ? 'pending' : 'kept' })}
                                    className={`badge ${isKept ? 'badge-bull' : 'bg-navy-700 text-slate-300'}`}>{isKept ? '✓ kept' : '✓ keep'}</button>
                                  <button onClick={() => setBlock(id, { status: 'removed' })} className="badge bg-navy-700 text-slate-400 hover:text-bear">✕</button>
                                </div>
                              </div>
                              <p className="text-xs text-slate-400 mb-2 leading-relaxed">{highlight(b.snippet, b.keyword)}</p>
                              <textarea value={dec.text} onChange={e => setBlock(id, { text: e.target.value })} rows={2}
                                className="input-field w-full text-xs resize-y"
                                placeholder={isNumeric ? 'Trim to the precise figure (the number is re-read from this text)…' : 'Edit to keep only what\'s relevant…'} />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={onFile} className="hidden" />
    </div>
  )
}

function Center({ icon, title, sub, onClose }) {
  return (
    <div className="text-center py-16 space-y-3">
      <div className="text-4xl">{icon}</div>
      <p className="text-sm text-slate-300">{title}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
      <button onClick={onClose} className="btn-primary text-sm">Close</button>
    </div>
  )
}

async function extractPdfText(file, onProgress) {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push({ page: i, text: content.items.map(it => it.str).join(' ') })
    if (onProgress) onProgress(Math.round((i / pdf.numPages) * 100))
  }
  return pages
}

function highlight(snippet, keyword) {
  if (!keyword) return snippet
  const i = snippet.toLowerCase().indexOf(keyword.toLowerCase())
  if (i === -1) return snippet
  return (<>{snippet.slice(0, i)}<mark className="bg-accent/30 text-accent-light rounded px-0.5">{snippet.slice(i, i + keyword.length)}</mark>{snippet.slice(i + keyword.length)}</>)
}
