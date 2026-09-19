import React, { useEffect, useState, useRef } from 'react'
import { fetchPeerCandidates, suggestPeers, confirmPeerRelationship, ownNseIndustry, getCachedSuggestions } from '../../api/peersClient.js'
import { classifyCompany } from '../../api/businessProfileClient.js'
import { analyzeTicker } from '../../store/analyzeTicker.js'
import { getClassification, saveClassification } from '../../utils/db.js'
import { getAiKey } from '../../utils/aiKey.js'
import { assessValuationPeerEligibility, financialsFromRatioResult } from '../../engine/peerCompatibility.js'
import { BUSINESS_MODELS, END_MARKETS, REVENUE_MODELS, PRODUCTION_PROFILES, CAPITAL_INTENSITY } from '../../engine/businessProfileEnums.js'
import Modal from '../Modal.jsx'

// Merges AI-suggested peers (fresh from suggestPeers, or restored from the
// peerSuggestions cache on modal open) into whatever candidate list already
// exists — used by both, so a reopen and a fresh "Discover" click land on
// an identical shape.
function mergeAiPeers(base, aiPeers) {
  const bySymbol = new Map(base.map(p => [p.symbol, p]))
  for (const s of aiPeers) {
    const key = s.symbol || `unresolved:${s.name}`
    const existing = bySymbol.get(key)
    const merged = existing
      ? { ...existing, ...s, sources: [...new Set([...existing.sources, 'ai-suggested'])] }
      : { ...s, symbol: key, unresolved: !s.symbol, sources: ['ai-suggested'] }
    bySymbol.set(key, merged)
  }
  return [...bySymbol.values()]
}

/**
 * PeerSelectModal — review real peer candidates, confirm which count, and
 * deliberately warm this ticker's peer cache along the way.
 *
 * Discovery has two parts, deliberately kept separate:
 *   - AI SUGGESTS real peer companies directly (suggestPeers, "Discover
 *     peers with AI" below) — given this company's name and real business
 *     description only (no sector/industry label of any kind — NSE's own
 *     label is still too coarse and risked biasing the model even with
 *     instructions not to lean on it), name actual candidates, not just
 *     match against whatever's already sitting in the classification store.
 *     This is the real discovery step. Confirming a suggestion saves the
 *     relationship BIDIRECTIONALLY (src/utils/db.js's peerRelationships
 *     store) — confirm Kaynes as Dixon's peer once, and Kaynes's own page
 *     already shows Dixon, no re-discovery needed.
 *   - Classification (business model / end markets / production profile)
 *     is supporting infrastructure, not how peers get found — it EXPLAINS
 *     and VALIDATES a discovered peer, and lets the financial-eligibility
 *     check run, but nothing here requires classifying a company before it
 *     can appear as a candidate.
 * Also still merged in: NSE's own sectoral index constituents, and this
 * browser's own analysis history in the same sector — neither requires an
 * AI call, both are free background candidates. Nothing is pre-checked;
 * confirming is what makes any candidate count toward peerBand().
 */
export default function PeerSelectModal({ open, onClose, ticker, name, meta, sectorType, ratioResult, confirmedPeers = [], onToggleConfirm }) {
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState({})   // symbol -> 'available' | 'loading'
  const [queue, setQueue] = useState([])
  const processingRef = useRef(false)
  const loadedAnyRef = useRef(false)
  const confirmedSet = new Set(confirmedPeers)

  const [discovering, setDiscovering] = useState(false)
  const [discoverError, setDiscoverError] = useState(null)
  const [nseIndustry, setNseIndustry] = useState(undefined)   // undefined = not yet looked up, null = not NSE-indexed

  const [targetClassification, setTargetClassification] = useState(null)
  const [showEnrich, setShowEnrich] = useState(false)
  const [draft, setDraft] = useState(null)          // pending AI classification under review, or null
  const [classifyBusy, setClassifyBusy] = useState(null)
  const [classifyError, setClassifyError] = useState(null)

  useEffect(() => {
    if (!open || !ticker) { setPeers([]); setTargetClassification(null); setNseIndustry(undefined); return }
    let cancelled = false
    loadedAnyRef.current = false
    setQueue([]); setDiscoverError(null)
    ;(async () => {
      const cls = await getClassification(ticker).catch(() => null)
      if (cancelled) return
      setTargetClassification(cls)
      // Cache-only, no network call — restores any AI suggestions from a
      // previous "Discover" run that were never confirmed (and so never
      // written to peerRelationships). Without this, closing and reopening
      // the modal silently dropped every unconfirmed suggestion, even
      // though they were sitting safely in the peerSuggestions cache the
      // whole time — the cache was being written, just never read back here.
      const [list, cachedAi] = await Promise.all([
        fetchPeerCandidates({ ticker, meta, sectorType, classification: cls }),
        getCachedSuggestions(ticker),
      ])
      if (cancelled) return
      setPeers(mergeAiPeers(list, cachedAi))
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

  const refetchCandidates = async (cls) => {
    // Same gap as the open effect: fetchPeerCandidates alone knows nothing
    // about peerSuggestions, so replacing `peers` with only its result would
    // silently drop any AI-suggested candidates already on screen. Re-merge
    // the cache (no network call) on top, same as on open.
    const [list, cachedAi] = await Promise.all([
      fetchPeerCandidates({ ticker, meta, sectorType, classification: cls }),
      getCachedSuggestions(ticker),
    ])
    setPeers(mergeAiPeers(list, cachedAi))
    const st = {}
    for (const p of list) if (p.cached) st[p.symbol] = 'available'
    setStatus(prev => ({ ...st, ...prev }))
  }

  // The actual discovery step — asks Gemini directly for real peer
  // companies. Only ever runs on this explicit click.
  const runDiscover = async () => {
    setDiscovering(true); setDiscoverError(null)
    const res = await suggestPeers({ ticker, name, meta, userKey: getAiKey() })
    setDiscovering(false)
    if (res.nseIndustry !== undefined) setNseIndustry(res.nseIndustry)
    if (!res.peers) { setDiscoverError({ error: res.error, detail: res.detail }); return }
    setPeers(prev => mergeAiPeers(prev, res.peers))
  }

  const toggle = (symbol) => {
    const isConfirming = !confirmedSet.has(symbol)
    onToggleConfirm?.(symbol)
    if (isConfirming) {
      const p = peers.find(x => x.symbol === symbol)
      if (status[symbol] !== 'available') setQueue(q => (q.includes(symbol) ? q : [...q, symbol]))
      // AI-suggested peer being confirmed for the first time: save the
      // relationship bidirectionally so the OTHER side already has it too.
      if (p?.sources?.includes('ai-suggested')) confirmPeerRelationship(ticker, name, p).catch(() => {})
    } else {
      setQueue(q => q.filter(s => s !== symbol))
    }
  }

  // ── Classification (secondary, optional enrichment) ─────────────────────
  const runClassify = async (symbol, candName, { force = false } = {}) => {
    setClassifyBusy(symbol); setClassifyError(null)
    const existingBefore = await getClassification(symbol).catch(() => null)
    const industry = await ownNseIndustry(symbol)
    const candMeta = symbol === ticker ? meta : peers.find(p => p.symbol === symbol)?.meta
    const res = await classifyCompany({ symbol, name: candName, nseIndustry: industry, businessSummary: candMeta?.businessSummary, userKey: getAiKey(), force })
    setClassifyBusy(null)
    if (res.error) { setClassifyError({ symbol, error: res.error, detail: res.detail }); return }
    if (res.skipped === 'user-owned') {
      setClassifyError({ symbol, error: 'user-owned',
        detail: 'This was corrected by hand and is kept as-is. Use "Re-run AI classification" to review a fresh suggestion without losing the correction.' })
      return
    }
    if (res.skipped === 'unchanged') return
    setDraft({ symbol, name: candName, ...res.result, _previous: existingBefore, _industry: industry })
  }

  const saveDraft = async (fields, { edited }) => {
    if (!draft) return
    const nse = draft._previous?.nse
      || (draft._industry ? { sector: null, industry: draft._industry, basicIndustry: null, source: 'nse-index', updatedAt: Date.now() } : null)
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

  const targetFin = financialsFromRatioResult(ratioResult)

  // Two separate groups, not one sorted list — a candidate validated by AI
  // (or an already-known relationship) is a different kind of claim than one
  // that merely shares NSE's coarse sector label or a loose cached-sector
  // regex match. Anything in the AI group is REMOVED from the other group
  // entirely — no duplicate row split across both.
  const isAiGroup = p => p.sources?.includes('ai-suggested') || p.sources?.includes('known-relationship')
  const aiPeers = peers.filter(isAiGroup)
  const otherPeers = peers.filter(p => !isAiGroup(p)).sort((a, b) => {
    const rank = p => p.businessRelationship === 'DIRECT_BUSINESS_MODEL' ? 0
      : p.businessRelationship === 'BROAD_BUSINESS_MODEL' ? 1 : 2
    return rank(a) - rank(b)
  })

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
        <div className="bg-navy-800/40 rounded-lg p-3 space-y-1.5">
          <p className="text-[11px] text-slate-400">
            Ask AI to name real peer companies directly — uses your Gemini key, and confirming a match saves it
            both ways, so {name || ticker}'s peers already show up on their own pages too.
          </p>
          <button onClick={runDiscover} disabled={discovering}
            className="text-[11px] font-medium text-accent hover:text-accent-light disabled:opacity-50">
            {discovering ? 'Discovering…' : '✨ Discover peers with AI'}
          </button>
          {nseIndustry !== undefined && (
            <p className="text-[10px] text-slate-600">
              {nseIndustry ? `NSE labels this "${nseIndustry}" (shown for comparison only — not sent to the AI)` : 'Not a member of any NSE sectoral index.'}
            </p>
          )}
          {discoverError && <p className="text-[10px] text-bear">{discoverError.detail || discoverError.error}</p>}
        </div>

        <button onClick={() => setShowEnrich(s => !s)} className="text-[10px] text-slate-500 hover:text-slate-300">
          {showEnrich ? '▲' : '▼'} Business-model detail for {name || ticker} (optional)
        </button>
        {showEnrich && (
          <TargetClassificationBox
            ticker={ticker} name={name}
            classification={targetClassification}
            draft={draft?.symbol === ticker ? draft : null}
            busy={classifyBusy === ticker}
            error={classifyError?.symbol === ticker ? classifyError : null}
            onClassify={() => runClassify(ticker, name)}
            onReclassify={() => runClassify(ticker, name, { force: true })}
            onSaveDraft={saveDraft}
            onCancelDraft={() => setDraft(null)}
          />
        )}

        <div className="max-h-72 overflow-y-auto">
          {aiPeers.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-accent/70">AI-validated</div>
              {aiPeers.map(p => (
                <PeerRow key={p.symbol} p={p} confirmedSet={confirmedSet} status={status} queue={queue}
                  targetFin={targetFin} targetClassification={targetClassification}
                  toggle={toggle} runClassify={runClassify} classifyBusy={classifyBusy} classifyError={classifyError}
                  draft={draft} saveDraft={saveDraft} setDraft={setDraft} />
              ))}
            </div>
          )}

          {aiPeers.length > 0 && otherPeers.length > 0 && (
            // The "75%" divider — a soft break signalling a drop in context/
            // confidence, not a hard section boundary.
            <div className="my-2 border-t border-navy-700/75" />
          )}

          {otherPeers.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-600">Other NSE-based candidates</div>
              {otherPeers.map(p => (
                <PeerRow key={p.symbol} p={p} confirmedSet={confirmedSet} status={status} queue={queue}
                  targetFin={targetFin} targetClassification={targetClassification}
                  toggle={toggle} runClassify={runClassify} classifyBusy={classifyBusy} classifyError={classifyError}
                  draft={draft} saveDraft={saveDraft} setDraft={setDraft} />
              ))}
            </div>
          )}

          {peers.length === 0 && <p className="text-xs text-slate-500 py-2">No peer candidates yet — try "Discover peers with AI" above.</p>}
        </div>
    </Modal>
  )
}

function PeerRow({ p, confirmedSet, status, queue, targetFin, targetClassification, toggle, runClassify, classifyBusy, classifyError, draft, saveDraft, setDraft }) {
  const isConfirmed = confirmedSet.has(p.symbol) && !p.unresolved
  // 'pe' — not 'ev_ebitda' as this was previously hardcoded. App Target's
  // P/E ladder (and Fair Value's/Market Expectation's own P/E models)
  // screen peers on 'pe' (rerating.js's peerBandFrom); showing an
  // EV/EBITDA-based badge here meant the modal's verdict could disagree
  // with the ACTUAL screening decision driving the P/E multiple a user is
  // looking at — the one thing this badge is supposed to be honest about.
  const eligibility = targetFin
    ? assessValuationPeerEligibility(targetClassification, p, targetFin, p, { metric: 'pe' }) : null
  return (
    <div className="py-1 border-b border-navy-800/60 last:border-0">
      <div className="flex items-center gap-2 text-sm">
        <label className={`flex items-center gap-2 flex-1 min-w-0 ${p.unresolved ? '' : 'cursor-pointer'}`}>
          <input type="checkbox" checked={isConfirmed} onChange={() => !p.unresolved && toggle(p.symbol)}
                 disabled={status[p.symbol] === 'loading' || p.unresolved}
                 title={p.unresolved ? 'No confirmed ticker symbol for this suggestion yet'
                   : isConfirmed ? 'Confirmed as a peer — untick to remove' : 'Confirm as a peer for this stock'}
                 className="accent-accent" />
          <span className="flex-1 min-w-0 truncate">
            <span className="text-slate-300">{p.name || p.symbol}</span>
            <SourceTag p={p} />
          </span>
        </label>
        {eligibility && eligibility.valuationEligibility !== 'UNASSESSED' && (
          <EligibilityBadge eligibility={eligibility.valuationEligibility} reasons={eligibility.reasons} />
        )}
        <StatusBadge status={status[p.symbol]} queued={queue.includes(p.symbol) && status[p.symbol] !== 'loading'} unresolved={p.unresolved} />
      </div>
      {p.cached && (
        <div className="pl-6 text-[10px] text-slate-500">
          P/E {p.pe != null ? `${p.pe.toFixed(1)}×` : '—'}
          {p.forwardPe != null ? ` (fwd ${p.forwardPe.toFixed(1)}×${p.forwardPeSource === 'yahoo' ? ', Yahoo consensus' : ''})` : ''}
          {' '}· Net margin {p.netMargin != null ? `${p.netMargin.toFixed(1)}%` : '—'}
          {' '}· ROE {p.roe != null ? `${p.roe.toFixed(1)}%` : '—'}
          {' '}· Rev CAGR {p.revCagr != null ? `${p.revCagr.toFixed(1)}%` : '—'}
          {' '}· Revenue {p.revenue != null ? `₹${Math.round(p.revenue / 1e7).toLocaleString('en-IN')}Cr` : '—'}
        </div>
      )}
      {eligibility?.reasons?.length > 0 && eligibility.valuationEligibility !== 'ELIGIBLE' && (
        <div className="pl-6 text-[10px] text-neutral">{eligibility.reasons.join('; ')}</div>
      )}
      <div className="pl-6 flex items-center gap-2">
        {!p.unresolved && !p.businessRelationship && classifyBusy !== p.symbol && (
          <button onClick={() => runClassify(p.symbol, p.name)} className="text-[10px] text-slate-500 hover:text-slate-300">
            add business-model detail
          </button>
        )}
        {classifyBusy === p.symbol && <span className="text-[10px] text-slate-500">classifying…</span>}
        {classifyError?.symbol === p.symbol && <span className="text-[10px] text-bear">{classifyError.detail || classifyError.error}</span>}
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
}

function TargetClassificationBox({ ticker, name, classification, draft, busy, error, onClassify, onReclassify, onSaveDraft, onCancelDraft }) {
  if (draft) {
    return (
      <div className="bg-navy-800/40 rounded-lg p-3 space-y-2">
        <p className="text-[11px] text-slate-400">Review before saving — nothing is applied until you save.</p>
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
        <button onClick={onClassify} disabled={busy} className="text-[11px] font-medium text-accent hover:text-accent-light disabled:opacity-50">
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
        <textarea value={fields.rationale} onChange={e => set('rationale', e.target.value)} className="input-field text-[11px] w-full" rows={2} />
      </label>
      <div className="flex items-center gap-3 pt-1">
        <button onClick={() => (edited ? onSaveEdited : onSave)(fields)} className="text-accent hover:text-accent-light font-medium">Save</button>
        <button onClick={onCancel} className="text-slate-500 hover:text-slate-300">Cancel</button>
      </div>
    </div>
  )
}

function Field({ label, changed, was, children }) {
  return (
    <label className="block">
      <span className="text-slate-500 block mb-0.5">{label}{changed && was && <span className="text-neutral"> (was: {was})</span>}</span>
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

function StatusBadge({ status, queued, unresolved }) {
  if (unresolved) return <span className="text-[10px] text-slate-600 shrink-0">no ticker yet</span>
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

// Why this candidate is in the list. AI-suggested/known-relationship
// candidates show the AI's own relationship phrase and rationale directly
// (the real discovery signal); others show NSE/own-cache source plus a
// classification badge if one happens to exist.
function SourceTag({ p }) {
  const { sources, industry, relationship, rationale, aiConfidence, businessRelationship, reasons } = p
  if (!sources?.length) return null
  if (sources.includes('ai-suggested') || sources.includes('known-relationship')) {
    return (
      <span title={rationale} className="block text-[10px] text-accent/80 truncate">
        {relationship || 'AI-suggested peer'}{aiConfidence && ` · ${aiConfidence} confidence`}
      </span>
    )
  }
  const label = sources.includes('nse-index') ? (industry || 'NSE sector index') : 'Previously analyzed, same sector'
  const relLabel = businessRelationship === 'DIRECT_BUSINESS_MODEL' ? 'Direct business-model match'
    : businessRelationship === 'BROAD_BUSINESS_MODEL' ? 'Broad business-model match' : null
  return (
    <span className="block text-[10px] text-slate-500 truncate">
      {label}
      {relLabel && <span title={reasons?.join('; ')} className="text-accent/80"> · {relLabel}</span>}
    </span>
  )
}

function enumLabel(v) {
  if (!v) return ''
  return v.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}
