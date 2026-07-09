import React, { useRef, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { extractSections, detectScanned } from '../../engine/arExtract.js'

/**
 * ARReader — annual-report reader (step 4). Full-screen review workflow.
 *
 * Flow: upload PDF → extract the text LAYER in-browser via pdf.js (no OCR, no AI)
 * → keyword section-finder proposes candidate passages grouped by target field →
 * user keeps/edits/removes each → Apply routes kept text into guidance fields and
 * writes state.arData (incl. the related-party signal), flipping the Block-5 gate.
 *
 * Scanned PDFs have no text layer → graceful "paste manually" fallback.
 *
 * Requires:  npm install pdfjs-dist
 */

// pdf.js (Vite ESM worker). If your bundler differs, adjust the worker import.
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const blockId = b => `${b.field}:${b.page}:${b.idx}`

export default function ARReader({ open, onClose }) {
  const { state, setQualInputs } = useApp()
  const [status, setStatus] = useState('idle')   // idle | extracting | review | scanned | error
  const [progress, setProgress] = useState(0)
  const [groups, setGroups] = useState([])
  const [decisions, setDecisions] = useState({}) // id → { status:'pending'|'kept'|'removed', text }
  const [fileName, setFileName] = useState('')
  const fileRef = useRef(null)

  if (!open) return null

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name); setStatus('extracting'); setProgress(0)
    try {
      const pages = await extractPdfText(file, setProgress)
      if (detectScanned(pages)) { setStatus('scanned'); return }
      const { groups } = extractSections(pages)
      if (!groups.length) { setStatus('review'); setGroups([]); return }
      // Seed decisions: every block starts pending, textbox pre-filled with snippet.
      const seed = {}
      groups.forEach(g => g.blocks.forEach(b => { seed[blockId(b)] = { status: 'pending', text: b.snippet } }))
      setGroups(groups); setDecisions(seed); setStatus('review')
    } catch (err) {
      console.warn('[ARReader] extract failed:', err?.message)
      setStatus('error')
    }
  }

  const setBlock = (id, patch) => setDecisions(d => ({ ...d, [id]: { ...d[id], ...patch } }))

  const apply = () => {
    // Collect kept blocks, route by field.
    const guidancePatch = { ...(state.guidance || {}) }
    const evidence = []
    let rpt = { present: false, pctOfRevenue: null }

    groups.forEach(g => g.blocks.forEach(b => {
      const dec = decisions[blockId(b)]
      if (dec?.status !== 'kept') return
      const text = (dec.text || '').trim()
      if (!text) return

      evidence.push({ field: b.field, page: b.page, text })

      if (b.field === 'rpt') {
        rpt = { present: true, pctOfRevenue: b.rpt?.pctOfRevenue ?? null }
      } else {
        const tagged = `[AR p.${b.page}] ${text}`
        guidancePatch[b.field] = guidancePatch[b.field]
          ? `${guidancePatch[b.field]}\n${tagged}`
          : tagged
      }
    }))

    setQualInputs({
      guidance: guidancePatch,
      arData: { sourceName: fileName, rpt, evidence, savedAt: Date.now() },
    })
    onClose()
  }

  const keptCount = Object.values(decisions).filter(d => d.status === 'kept').length

  return (
    <div className="fixed inset-0 z-[60] bg-navy-950 flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-navy-800 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <span>📄</span><span className="truncate">Annual report reader</span>
          </h2>
          {fileName && <p className="text-[11px] text-slate-500 truncate">{fileName}</p>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {status === 'review' && (
            <button onClick={apply} disabled={keptCount === 0}
              className="btn-primary text-sm disabled:opacity-40">
              Apply {keptCount ? `(${keptCount})` : ''}
            </button>
          )}
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white text-2xl leading-none px-1">✕</button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4">
          {status === 'idle' && (
            <div className="text-center py-16 space-y-4">
              <div className="text-4xl">📄</div>
              <p className="text-sm text-slate-300">Upload the annual report PDF. It's read in your browser — the file never leaves your device.</p>
              <button onClick={() => fileRef.current?.click()} className="btn-primary text-sm">Choose PDF</button>
              <p className="text-[11px] text-slate-600">Text-based PDFs only. Scanned reports can't be read (no text layer) — you'll paste manually.</p>
            </div>
          )}

          {status === 'extracting' && (
            <div className="text-center py-20 space-y-3">
              <div className="text-sm text-slate-400 animate-pulse">Reading report… {progress}%</div>
              <div className="h-1.5 bg-navy-800 rounded max-w-sm mx-auto overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {status === 'scanned' && (
            <div className="text-center py-16 space-y-3">
              <div className="text-4xl">🚫</div>
              <p className="text-sm text-slate-300">This PDF has no readable text layer (likely scanned).</p>
              <p className="text-xs text-slate-500">We don't OCR. Open the report yourself and paste the relevant passages into the guidance fields.</p>
              <button onClick={onClose} className="btn-primary text-sm">Close</button>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center py-16 space-y-3">
              <div className="text-4xl">⚠️</div>
              <p className="text-sm text-slate-300">Couldn't read that PDF.</p>
              <button onClick={() => setStatus('idle')} className="btn-primary text-sm">Try another file</button>
            </div>
          )}

          {status === 'review' && groups.length === 0 && (
            <div className="text-center py-16 space-y-3">
              <div className="text-4xl">🔍</div>
              <p className="text-sm text-slate-300">No matching sections found (outlook, related-party, capex, PLI, market opportunity).</p>
              <button onClick={onClose} className="btn-primary text-sm">Close</button>
            </div>
          )}

          {status === 'review' && groups.length > 0 && (
            <div className="space-y-6">
              <p className="text-xs text-slate-500">
                Keep the passages that matter, trim the text if needed, remove false positives. Kept text routes to the matching guidance field; related-party feeds the Quality &amp; Moat pillar.
              </p>
              {groups.map(g => (
                <div key={g.field}>
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                    {g.label} · {g.blocks.length}
                  </h3>
                  <div className="space-y-3">
                    {g.blocks.map(b => {
                      const id = blockId(b)
                      const dec = decisions[id] || { status: 'pending', text: b.snippet }
                      if (dec.status === 'removed') return null
                      const kept = dec.status === 'kept'
                      return (
                        <div key={id} className={`rounded-lg border p-3 ${kept ? 'border-bull/40 bg-bull/5' : 'border-navy-700 bg-navy-900/50'}`}>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] text-slate-500">
                              p.{b.page} · matched “{b.keyword}”{b.rpt?.pctOfRevenue != null && ` · ~${b.rpt.pctOfRevenue}% of revenue`}
                            </span>
                            <div className="flex gap-1">
                              <button onClick={() => setBlock(id, { status: kept ? 'pending' : 'kept' })}
                                className={`badge ${kept ? 'badge-bull' : 'bg-navy-700 text-slate-300'}`}>{kept ? '✓ kept' : '✓ keep'}</button>
                              <button onClick={() => setBlock(id, { status: 'removed' })}
                                className="badge bg-navy-700 text-slate-400 hover:text-bear">✕</button>
                            </div>
                          </div>
                          <p className="text-xs text-slate-400 mb-2 leading-relaxed">{highlight(b.snippet, b.keyword)}</p>
                          <textarea
                            value={dec.text}
                            onChange={e => setBlock(id, { text: e.target.value })}
                            rows={2}
                            className="input-field w-full text-xs resize-y"
                            placeholder="Edit the passage to keep only what's relevant…" />
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={onFile} className="hidden" />
    </div>
  )
}

// ── pdf.js text-layer extraction ──────────────────────────────────────────────
async function extractPdfText(file, onProgress) {
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const pages = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const text = content.items.map(it => it.str).join(' ')
    pages.push({ page: i, text })
    if (onProgress) onProgress(Math.round((i / pdf.numPages) * 100))
  }
  return pages
}

// Highlight the matched keyword within the snippet (case-insensitive).
function highlight(snippet, keyword) {
  if (!keyword) return snippet
  const i = snippet.toLowerCase().indexOf(keyword.toLowerCase())
  if (i === -1) return snippet
  return (
    <>
      {snippet.slice(0, i)}
      <mark className="bg-accent/30 text-accent-light rounded px-0.5">{snippet.slice(i, i + keyword.length)}</mark>
      {snippet.slice(i + keyword.length)}
    </>
  )
}
