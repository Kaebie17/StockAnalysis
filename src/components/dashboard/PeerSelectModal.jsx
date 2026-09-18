import React, { useEffect, useState, useRef } from 'react'
import { fetchPeerCandidates } from '../../api/peersClient.js'
import { classifyCompany } from '../../api/businessProfileClient.js'
import { analyzeTicker } from '../../store/analyzeTicker.js'
import { getClassification, saveClassification } from '../../utils/db.js'
import { getAiKey } from '../../utils/aiKey.js'
import { assessValuationPeerEligibility, summarizePeerSet } from '../../engine/peerCompatibility.js'
import { BUSINESS_MODELS, END_MARKETS, REVENUE_MODELS, PRODUCTION_PROFILES, CAPITAL_INTENSITY } from '../../engine/businessProfileEnums.js'
import Modal from '../Modal.jsx'

/**
 * PeerSelectModal — review real peer candidates, confirm which count, and
 * deliberately warm this ticker's peer cache along the way.
 *
 * Candidates come from THREE automatic sources, merged (peersClient.js's
 * fetchPeerCandidates):
 *   - NSE's own sectoral index constituents — real, exchange-maintained,
 *     but NSE-listed only, so a BSE-only comparable never appears here, and
 *     limited to NSE's own flat Industry label (Dixon and Havells share one
 *     label despite very different business models).
 *   - This browser's own analysis history in the same sector — covers what
 *     NSE's list structurally can't (BSE-only names).
 *   - The central business-model classification store — see the "Classify"
 *     affordances below. A company classified once (by AI, reviewed/edited
 *     by hand, or corrected outright) is reused as a peer-discovery signal
 *     for EVERY ticker from then on, not just this one — recovering
 *     candidates the other two sources structurally can't (Kaynes, labelled
 *     "Industrial Products" by NSE, still surfaces for Dixon here).
 * None of the three is a guarantee of comparability, so nothing is
 * pre-checked, including already-cached peers: confirming is what makes a
 * candidate count toward peerBand().
 *
 * Classification is NEVER triggered automatically — it costs real tokens
 * (BYOK Gemini). Every classify action here is an explicit click, and the
 * result is cached centrally (src/utils/db.js's `classifications` store) so
 * it's a one-time cost per company, not per ticker that reviews it.
 */
export default function PeerSelectModal({ open, onClose, ticker, name, meta, sectorType, ratioResult, confirmedPeers = [], onToggleConfirm }) {
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState({})   // symbol -> 'available' | 'loading'
  const [queue, setQueue] = useState([])
  const processingRef = useRef(false)
  const loadedAnyRef = useRef(false)
  const confirmedSet = new Set(confirmedPeers)

  const [targetClassification, setTargetClassification] = useState(null)
  const [draft, setDraft] = useState(null)          // pending AI result under review, or null
  const [classifyBusy, setClassifyBusy] = useState(null)   // symbol currently being classified
  const [classifyError, setClassifyError] = useState(null) // { symbol, error, detail }

  useEffect(() => {
    if (!open || !ticker) { setPeers([]); setTargetClassification(null); return }
    let cancelled = false
    loadedAnyRef.current = false
    setQueue([])
    ;(async () => {
      const cls = await getClassification(ticker).catch(() => null)
      if (cancelled) return
      setTargetClassification(cls)
      const list = await fetchPeerCandidates({ ticker, meta, sectorType, classification: cls })
      if (cancelled) return
      setPeers(list)
      const st = {}
      for (const p of list) if (p.cached) st[p.symbol] = 'available'
      setStatus(st)
    })()
    return () => { cancelled = true }
  }, [open, ticker])

  useEffect(() => {
    if (processingRef.current || queue.length === 0) return
    const symbol = queue[0]
    processingRef.current = true
    setStatus(prev => ({ ...prev, [symbol]: 'loading' }))
    analyzeTicker(symbol).then(res => {
      if (res) {
        loadedAnyRef.current = true
        setStatus(prev => ({ ...prev, [symbol]: 'available' }))
      } else {
        setStatus(prev => { const next = { ...prev }; delete next[symbol]; return next })
        onToggleConfirm?.(symbol)
      }
      setQueue(q => q.slice(1))
      processingRef.current = false
    })
  }, [queue])

  const toggle = (symbol) => {
    const isConfirming = !confirmedSet.has(symbol)
    onToggleConfirm?.(symbol)
    if (isConfirming) {
      if (status[symbol] !== 'available') setQueue(q => (q.includes(symbol) ? q : [...q, symbol]))
    } else {
      setQueue(q => q.filter(s => s !== symbol))
    }
  }

  const refetchCandidates = async (cls) => {
    const list = await fetchPeerCandidates({ ticker, meta, sectorType, classification: cls })
    setPeers(list)
    const st = {}
    for (const p of list) if (p.cached) st[p.symbol] = 'available'
    setStatus(prev => ({ ...st, ...prev }))
  }

  const runClassify = async (symbol, candName, candMeta, { force = false } = {}) => {
    setClassifyBusy(symbol); setClassifyError(null)
    const existingBefore = await getClassification(symbol).catch(() => null)
    const res = await classifyCompany({ symbol, name: candName, meta: candMeta, userKey: getAiKey(), force })
    setClassifyBusy(null)
    if (res.error) { setClassifyError({ symbol, error: res.error, detail: res.detail }); return }
    if (res.skipped === 'user-owned') {
      setClassifyError({ symbol, error: 'user-owned',
        detail: 'This was corrected by hand and is kept as-is. Use "Re-run AI classification" to review a fresh AI suggestion without losing the correction.' })
      return
    }
    if (res.skipped === 'unchanged') return   // already current, nothing to review
    setDraft({ symbol, name: candName, ...res.result, _previous: existingBefore, _meta: candMeta })
  }

  const saveDraft = async (fields, { edited }) => {
    if (!draft) return
    const nse = draft._previous?.nse
      || (draft._meta ? { sector: draft._meta.sector, industry: draft._meta.industry, basicIndustry: null, source: 'yahoo-meta', updatedAt: Date.now() } : null)
    const rec = await saveClassification({
      symbol: draft.symbol, name: draft.name,
      nse,
      ...fields,
      source: edited ? 'user' : 'ai',
      userEdited: edited || !!draft._previous?.userEdited,
      model: draft.model || null,
      fingerprint: draft.fingerprint || null,
      classifiedAt: draft.classifiedAt || Date.now(),
      lastReviewedAt: Date.now(),
    })
    const savedSymbol = draft.symbol
    setDraft(null)
    if (savedSymbol === ticker) setTargetClassification(rec)
    await refetchCandidates(savedSymbol === ticker ? rec : targetClassification)
  }

  const close = () => onClose?.(loadedAnyRef.current)

  if (!open) return null

  const targetFin = ratioResult ? {
    ebitdaMargin: ratioResult.ratios?.ebitdaMargin?.value ?? null,
    netMargin: ratioResult.ratios?.netMargin?.value ?? null,
    netDebtEbitda: ratioResult.ratios?.netDebtRatio?.value ?? null,
    revenue: ratioResult.revenue ?? null,
  } : null

  const sortedPeers = [...peers].sort((a, b) => {
    const rank = r => r === 'DIRECT_BUSINESS_MODEL' ? 0 : r === 'BROAD_BUSINESS_MODEL' ? 1 : r === 'SECTOR_OR_THEME_ONLY' ? 3 : 2
    return rank(a.businessRelationship) - rank(b.businessRelationship)
  })

  const confirmedScored = peers.filter(p => confirmedSet.has(p.symbol) && p.businessRelationship)
  const peerSet = targetClassification ? summarizePeerSet(confirmedScored) : null

  return (
    <Modal
      open={open}
      onClose={close}
      title="Peer coverage"
      widthClass="sm:max-w-md"
      footer={
        <button onClick={close}
          className="w-full text-xs font-medium text-accent hover:text-accent-light
                     bg-accent/10 hover:bg-accent/20 px-3 py-1.5 rounded-md transition-colors">
          Done
        </button>
      }
    >
        <p className="text-xs text-slate-400">
          Candidates from NSE's own sectoral index, stocks you've already analyzed in the same sector, and
          companies classified as the same business model. Confirm the ones that are genuinely comparable —
          only confirmed peers count toward peer-median multiples.
        </p>

        <TargetClassificationBox
          ticker={ticker} name={name}
          classification={targetClassification}
          draft={draft?.symbol === ticker ? draft : null}
          busy={classifyBusy === ticker}
          error={classifyError?.symbol === ticker ? classifyError : null}
          onClassify={() => runClassify(ticker, name, meta)}
          onReclassify={() => runClassify(ticker, name, meta, { force: true })}
          onSaveDraft={saveDraft}
          onCancelDraft={() => setDraft(null)}
        />

        {peerSet && (
          <p className={`text-[11px] rounded-lg px-3 py-2 ${
            peerSet.relevance === 'strong' ? 'bg-bull/10 text-bull'
            : peerSet.relevance === 'weak' || peerSet.relevance === 'unscored' ? 'bg-neutral/10 text-neutral'
            : 'bg-navy-800/60 text-slate-400'}`}>
            {peerSet.primaryPeerCount} direct peer{peerSet.primaryPeerCount === 1 ? '' : 's'}, {peerSet.broadPeerCount} broad
            {peerSet.reason ? ` — ${peerSet.reason}` : ' — solid business-model composition'}
          </p>
        )}

        <div className="space-y-1 max-h-64 overflow-y-auto">
          {sortedPeers.map(p => {
            const isConfirmed = confirmedSet.has(p.symbol)
            const eligibility = (targetClassification && targetFin && p.businessRelationship)
              ? assessValuationPeerEligibility(targetClassification, p, targetFin, p, { metric: 'ev_ebitda' }) : null
            const lowConfidence = isConfirmed && (p.businessRelationship === 'SECTOR_OR_THEME_ONLY' || eligibility?.valuationEligibility === 'NOT_ELIGIBLE')
            return (
              <div key={p.symbol} className="py-1 border-b border-navy-800/60 last:border-0">
                <div className="flex items-center gap-2 text-sm">
                  <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                    <input type="checkbox" checked={isConfirmed} onChange={() => toggle(p.symbol)}
                           disabled={status[p.symbol] === 'loading'}
                           title={isConfirmed ? 'Confirmed as a peer — untick to remove' : 'Confirm as a peer for this stock'}
                           className="accent-accent" />
                    <span className="flex-1 min-w-0 truncate">
                      <span className="text-slate-300">{p.name || p.symbol}</span>
                      <SourceTag sources={p.sources} industry={p.industry} businessRelationship={p.businessRelationship} reasons={p.reasons} />
                    </span>
                  </label>
                  {lowConfidence && (
                    <span title={eligibility?.reasons?.join('; ') || p.reasons?.join('; ')}
                          className="text-[10px] text-neutral shrink-0">⚠ low match</span>
                  )}
                  {eligibility && eligibility.valuationEligibility !== 'UNASSESSED' && (
                    <EligibilityBadge eligibility={eligibility.valuationEligibility} reasons={eligibility.reasons} />
                  )}
                  <StatusBadge status={status[p.symbol]} queued={queue.includes(p.symbol) && status[p.symbol] !== 'loading'} />
                </div>
                <div className="pl-6 flex items-center gap-2">
                  {!p.businessRelationship && classifyBusy !== p.symbol && (
                    <button onClick={() => runClassify(p.symbol, p.name, p.meta)}
                            className="text-[10px] text-accent hover:text-accent-light">
                      classify business model
                    </button>
                  )}
                  {classifyBusy === p.symbol && <span className="text-[10px] text-slate-500">classifying…</span>}
                  {p.businessRelationship && classifyBusy !== p.symbol && (
                    <button onClick={() => runClassify(p.symbol, p.name, p.meta, { force: true })}
                            className="text-[10px] text-slate-600 hover:text-slate-400">
                      ↻ re-run AI classification
                    </button>
                  )}
                  {classifyError?.symbol === p.symbol && (
                    <span className="text-[10px] text-bear">{classifyError.detail || classifyError.error}</span>
                  )}
                </div>
                {draft?.symbol === p.symbol && (
                  <div className="pl-6 mt-1">
                    <ClassificationForm draft={draft} onSave={fields => saveDraft(fields, { edited: false })}
                                        onSaveEdited={fields => saveDraft(fields, { edited: true })}
                                        onCancel={() => setDraft(null)} />
                  </div>
                )}
              </div>
            )
          })}
          {peers.length === 0 && <p className="text-xs text-slate-500 py-2">No peer candidates found for this stock.</p>}
        </div>
    </Modal>
  )
}

function TargetClassificationBox({ ticker, name, classification, draft, busy, error, onClassify, onReclassify, onSaveDraft, onCancelDraft }) {
  if (draft) {
    return (
      <div className="bg-navy-800/40 rounded-lg p-3 space-y-2">
        <p className="text-[11px] text-slate-400">
          Review {name || ticker}'s classification before saving — nothing is applied until you save.
        </p>
        <ClassificationForm draft={draft}
          onSave={fields => onSaveDraft(fields, { edited: false })}
          onSaveEdited={fields => onSaveDraft(fields, { edited: true })}
          onCancel={onCancelDraft} />
      </div>
    )
  }

  if (!classification) {
    return (
      <div className="bg-navy-800/40 rounded-lg p-3 space-y-1.5">
        <p className="text-[11px] text-slate-400">
          Classify this company's business model — uses your Gemini key, reused everywhere this company
          shows up as a peer.
        </p>
        <button onClick={onClassify} disabled={busy}
          className="text-[11px] font-medium text-accent hover:text-accent-light disabled:opacity-50">
          {busy ? 'Classifying…' : 'Classify business model'}
        </button>
        {error && <p className="text-[10px] text-bear">{error.detail || error.error}</p>}
      </div>
    )
  }

  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-300">
          {enumLabel(classification.businessModel)}
          {classification.secondaryBusinessModels?.length > 0 && ` + ${classification.secondaryBusinessModels.map(enumLabel).join(', ')}`}
        </span>
        <button onClick={onReclassify} disabled={busy} className="text-[10px] text-slate-500 hover:text-slate-300 disabled:opacity-50">
          {busy ? 'classifying…' : '↻ re-run AI classification'}
        </button>
      </div>
      <p className="text-[10px] text-slate-500">{classification.endMarkets?.map(enumLabel).join(', ')}</p>
      {classification.rationale && <p className="text-[10px] text-slate-600 italic">"{classification.rationale}"</p>}
      <p className="text-[10px] text-slate-600">
        {classification.source === 'user' ? 'Set by hand' : `AI classified · ${classification.confidence} confidence, ${classification.evidenceQuality} evidence`}
      </p>
      {error && <p className="text-[10px] text-bear">{error.detail || error.error}</p>}
    </div>
  )
}

function ClassificationForm({ draft, onSave, onSaveEdited, onCancel }) {
  const [fields, setFields] = useState(() => ({
    businessModel: draft.businessModel, secondaryBusinessModels: draft.secondaryBusinessModels || [],
    endMarkets: draft.endMarkets || [], revenueModel: draft.revenueModel,
    productionProfile: draft.productionProfile, capitalIntensity: draft.capitalIntensity,
    rationale: draft.rationale || '', evidence: draft.evidence || [],
    status: draft.status || 'classified', confidence: draft.confidence || 'medium', evidenceQuality: draft.evidenceQuality || 'moderate',
  }))
  const [edited, setEdited] = useState(false)
  const prev = draft._previous

  const set = (key, val) => { setFields(f => ({ ...f, [key]: val })); setEdited(true) }
  const toggleMulti = (key, val) => set(key, fields[key].includes(val) ? fields[key].filter(v => v !== val) : [...fields[key], val])

  const changedFrom = (key) => prev && prev[key] != null && JSON.stringify(prev[key]) !== JSON.stringify(fields[key])

  return (
    <div className="space-y-2 text-[11px]">
      <Field label="Business model" changed={changedFrom('businessModel')} was={prev && enumLabel(prev.businessModel)}>
        <select value={fields.businessModel} onChange={e => set('businessModel', e.target.value)} className="input-field text-[11px] w-full">
          {BUSINESS_MODELS.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
        </select>
      </Field>
      <ChipField label="Secondary models (optional)" options={BUSINESS_MODELS} selected={fields.secondaryBusinessModels}
                 onToggle={v => toggleMulti('secondaryBusinessModels', v)} />
      <ChipField label="End markets" options={END_MARKETS} selected={fields.endMarkets}
                 onToggle={v => toggleMulti('endMarkets', v)} />
      <Field label="Revenue model" changed={changedFrom('revenueModel')} was={prev && enumLabel(prev.revenueModel)}>
        <select value={fields.revenueModel} onChange={e => set('revenueModel', e.target.value)} className="input-field text-[11px] w-full">
          {REVENUE_MODELS.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
        </select>
      </Field>
      <Field label="Production profile" changed={changedFrom('productionProfile')} was={prev && enumLabel(prev.productionProfile)}>
        <select value={fields.productionProfile} onChange={e => set('productionProfile', e.target.value)} className="input-field text-[11px] w-full">
          {PRODUCTION_PROFILES.map(v => <option key={v} value={v}>{enumLabel(v)}</option>)}
        </select>
      </Field>
      <Field label="Capital intensity" changed={changedFrom('capitalIntensity')} was={prev && prev.capitalIntensity}>
        <select value={fields.capitalIntensity} onChange={e => set('capitalIntensity', e.target.value)} className="input-field text-[11px] w-full">
          {CAPITAL_INTENSITY.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </Field>
      <label className="block">
        <span className="text-slate-500 block mb-0.5">Rationale</span>
        <textarea value={fields.rationale} onChange={e => set('rationale', e.target.value)}
                  className="input-field text-[11px] w-full" rows={2} />
      </label>
      <div className="flex items-center gap-3 pt-1">
        <button onClick={() => (edited ? onSaveEdited : onSave)(fields)}
                className="text-accent hover:text-accent-light font-medium">Save</button>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-300">Cancel</button>
      </div>
    </div>
  )
}

function Field({ label, changed, was, children }) {
  return (
    <label className="block">
      <span className="text-slate-500 block mb-0.5">
        {label}{changed && was && <span className="text-neutral"> (was: {was})</span>}
      </span>
      {children}
    </label>
  )
}

function ChipField({ label, options, selected, onToggle }) {
  return (
    <div>
      <span className="text-slate-500 block mb-0.5">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(v => (
          <button key={v} type="button" onClick={() => onToggle(v)}
            className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
              selected.includes(v) ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-500 hover:text-slate-300'}`}>
            {enumLabel(v)}
          </button>
        ))}
      </div>
    </div>
  )
}

function StatusBadge({ status, queued }) {
  if (status === 'available') return <span className="text-[10px] text-bull shrink-0">✓ available</span>
  if (status === 'loading')   return <span className="text-[10px] text-slate-500 shrink-0">loading…</span>
  if (queued)                 return <span className="text-[10px] text-slate-600 shrink-0">queued…</span>
  return <span className="text-[10px] text-slate-600 shrink-0">not loaded</span>
}

function EligibilityBadge({ eligibility, reasons }) {
  const label = eligibility === 'ELIGIBLE' ? 'eligible'
    : eligibility === 'ELIGIBLE_WITH_CAVEAT' ? 'caveat'
    : eligibility === 'NOT_ELIGIBLE' ? 'not eligible' : null
  if (!label) return null
  const tone = eligibility === 'ELIGIBLE' ? 'text-bull' : eligibility === 'NOT_ELIGIBLE' ? 'text-bear' : 'text-neutral'
  return <span title={reasons?.join('; ')} className={`text-[10px] shrink-0 ${tone}`}>{label}</span>
}

// Why this candidate is in the list — which source(s) surfaced it, the NSE
// index's own industry sub-classification where there is one, and the
// business-model relationship once either side is classified.
function SourceTag({ sources, industry, businessRelationship, reasons }) {
  if (!sources?.length) return null
  const label = sources.includes('nse-index') ? (industry || 'NSE sector index')
    : sources.includes('business-model') ? 'Business-model match'
    : 'Previously analyzed, same sector'
  const relLabel = businessRelationship === 'DIRECT_BUSINESS_MODEL' ? 'Direct business-model peer'
    : businessRelationship === 'BROAD_BUSINESS_MODEL' ? 'Broad business-model peer'
    : businessRelationship === 'SECTOR_OR_THEME_ONLY' ? 'Sector/theme only' : null
  return (
    <span className="block text-[10px] text-slate-500 truncate">
      {label}
      {relLabel && <span title={reasons?.join('; ')} className={businessRelationship === 'SECTOR_OR_THEME_ONLY' ? ' text-slate-600' : ' text-accent/80'}> · {relLabel}</span>}
    </span>
  )
}

function enumLabel(v) {
  if (!v) return ''
  return v.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}
