import React, { useMemo, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { assessMoatQuality } from '../../engine/moatQuality.js'
import GuidanceModal from './GuidanceModal.jsx'
import ProvenanceTag from '../ProvenanceTag.jsx'

/**
 * MoatQualityPanel — Block 5 (Quality & Moat overlay).
 *
 * Always renders: computes ratios-only Moat/Quality tiers from data you already
 * have. The promoter-pledge / related-party / AR-evidence layer is STRICT-gated —
 * it only folds in when BOTH are present:
 *   • state.holdingsData  → parsed Screener shareholding (steps 3/4 populate this)
 *   • state.arData        → annual-report reader output (incl. rpt) (step 4)
 * Until both exist, a locked strip shows and governance signals are excluded.
 *
 * Moat override: the one human touch. Numbers can flag `veryWideEligible`, but
 * elevating to Very Wide (or any manual change) rests on a qualitative overlay
 * the engine can't grade, so it's a user action, clearly marked as override.
 */
export default function MoatQualityPanel({ open, onClose }) {
  const { state } = useApp()
  const { data, ratioResult } = state
  const [override, setOverride] = useState(null)     // { tier, reason }
  const [showEvidence, setShowEvidence] = useState(false)
  const [editing, setEditing] = useState(false)
  const [guidanceOpen, setGuidanceOpen] = useState(false)

  // Strict gate is derived inside the engine (promoter holdings + document data).
  const result = useMemo(() => {
    if (!ratioResult) return null
    return assessMoatQuality(data, ratioResult, {
      holdings: state.holdingsData || null,
      arData: state.arData || null,
      moatOverride: override,
    })
  }, [data, ratioResult, state.holdingsData, state.arData, override])

  if (!open || !result) return null
  const { moat, quality, implication, metrics, dataFlags } = result
  const bothPresent = result.gated

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">🏰 Quality &amp; Moat</h2>
        <div className="flex items-center gap-3">
          <button onClick={() => setGuidanceOpen(true)} className="text-xs text-accent hover:text-accent-light">
            ✎ Guidance &amp; documents →
          </button>
          <span className="text-[11px] text-slate-500">
            {bothPresent ? 'Full (Screener + AR)' : 'Ratios-only'}
          </span>
          {onClose && <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">✕</button>}
        </div>
      </div>

      <GuidanceModal open={guidanceOpen} onClose={() => setGuidanceOpen(false)} />

      {/* Three highlight rows */}
      <div className="space-y-2">
        <HighlightRow label="Moat Strength" value={moat.tier} badge={moatBadge(moat.tier)}
          extra={moat.source === 'override' && <span className="text-[10px] text-slate-500">(manual)</span>} />
        <HighlightRow label="Quality (subjective)" value={quality.tier} badge={qualityBadge(quality.tier)} />
        <div className="flex items-start justify-between gap-3 py-1.5 border-t border-navy-800">
          <span className="text-xs text-slate-400 uppercase tracking-wider pt-0.5">Implication for Valuation</span>
          <span className="text-sm text-slate-200 text-right max-w-[60%]">{implication}</span>
        </div>
      </div>

      {/* Very Wide upgrade prompt + override control */}
      {moat.veryWideEligible && moat.tier !== 'Very Wide' && !editing && (
        <button onClick={() => setEditing(true)}
          className="w-full text-xs text-accent hover:text-accent-light border border-accent/30 rounded-lg py-2">
          ⬆ Returns qualify for “Very Wide” — affirm a qualitative overlay (regulatory / network / scale)
        </button>
      )}

      {editing && (
        <div className="bg-navy-800/60 rounded-lg p-3 space-y-2">
          <div className="text-xs text-slate-400">Set moat tier (records a manual overlay judgement):</div>
          <div className="flex flex-wrap gap-1.5">
            {['None', 'Narrow', 'Wide', 'Very Wide'].map(t => (
              <button key={t} onClick={() => setOverride(o => ({ ...(o || {}), tier: t }))}
                className={`badge ${override?.tier === t ? 'bg-accent/30 text-accent-light' : 'bg-navy-700 text-slate-300'}`}>{t}</button>
            ))}
          </div>
          <input type="text" placeholder="Reason (e.g. regulatory monopoly, network effects)"
            defaultValue={override?.reason || ''}
            onChange={e => setOverride(o => ({ ...(o || { tier: moat.tier }), reason: e.target.value }))}
            className="input-field w-full text-xs" />
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="btn-primary text-xs flex-1">Apply</button>
            <button onClick={() => { setOverride(null); setEditing(false) }} className="btn-ghost text-xs">Reset to computed</button>
          </div>
        </div>
      )}

      {/* Metric strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Metric label="ROCE (median)" tier="calculated" val={pctTxt(metrics.roce.median)} sub={metrics.roce.hitRate != null ? `${metrics.roce.hitRate}% yrs ≥ thr` : null} />
        <Metric label={metrics.grossMargin.median != null ? (metrics.grossMargin.derived ? 'Gross margin (docs)' : 'Gross margin') : 'Op. margin'}
          tier={metrics.grossMargin.median != null ? (metrics.grossMargin.estimated ? 'estimated' : 'calculated') : 'calculated'}
          method={metrics.grossMargin.estimated ? 'estimated from documents' : metrics.grossMargin.derived ? 'from documents' : null}
          val={metrics.grossMargin.median != null ? (metrics.grossMargin.trend || '—') : (metrics.opMargin.trend || '—')}
          sub={metrics.grossMargin.median != null ? pctTxt(metrics.grossMargin.median)
            : (metrics.opMargin.median != null ? `${pctTxt(metrics.opMargin.median)} · gross n/a` : 'gross n/a')} />
        <Metric label="ROE (median)" tier="calculated" val={pctTxt(metrics.roe.median)} sub={metrics.roe.hitRate != null ? `${metrics.roe.hitRate}% yrs` : null} />
        <Metric label="FCF conversion" tier="calculated" val={pctTxt(metrics.fcfConv, 0)} />
        <Metric label="Leverage (D/E)" tier="calculated" val={numTxt(metrics.de, 2)} />
        <Metric label="Coverage" tier="calculated" val={metrics.icr != null ? `${numTxt(metrics.icr, 1)}×` : '—'} />
        <Metric label="Incremental ROCE" tier="calculated" val={metrics.incRoce.quality || '—'} />
        <Metric label="Dilution" tier="calculated" val={metrics.dilution.trend || '—'} sub={metrics.dilution.pct != null ? `${metrics.dilution.pct > 0 ? '+' : ''}${metrics.dilution.pct}%` : null} />
      </div>

      {/* Captured qualitative context from documents / notes (context only — does
          not move the tiers; pledge/RPT below do, once the gate is unlocked). */}
      <QualitativeContext arData={state.arData} />

      {/* Missing metrics — what couldn't be computed, and how to fill it */}
      {dataFlags.filter(f => f !== 'governance_locked').length > 0 && (
        <div className="text-[10px] text-slate-600 space-y-0.5">
          <p>Not available: {dataFlags.filter(f => f !== 'governance_locked').map(prettyFlag).join(' · ')}.</p>
          {dataFlags.includes('gross_margin_unavailable') && (
            <p className="text-slate-500">→ Add a document and keep the “cost of materials consumed” figure to derive gross margin.</p>
          )}
        </div>
      )}

      {/* Locked governance strip (strict: both required) */}
      {!bothPresent && (
        <div className="text-xs bg-navy-800/60 border border-navy-700 rounded-lg px-3 py-2 text-slate-400">
          🔒 Promoter pledge, promoter-holding trend &amp; related-party transactions unlock when
          <span className="text-slate-300"> Screener holdings </span> and an
          <span className="text-slate-300"> annual report </span> are both added.
        </div>
      )}

      {/* Evidence */}
      <div>
        <button onClick={() => setShowEvidence(v => !v)}
          className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
          {showEvidence ? '▲' : '▼'} Why these tiers
        </button>
        {showEvidence && (
          <div className="mt-2 space-y-2">
            <EvidenceList title="Moat" items={moat.evidence} />
            <EvidenceList title="Quality" items={quality.evidence} />
            {dataFlags.length > 0 && (
              <p className="text-[10px] text-slate-600">
                Not evidenced from current data: {dataFlags.filter(f => f !== 'governance_locked').map(prettyFlag).join(', ')}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── bits ──────────────────────────────────────────────────────────────────────
function QualitativeContext({ arData }) {
  if (!arData) return null
  const NARR = [
    ['outlook', 'Outlook'], ['pli', 'PLI / schemes'],
    ['initiatives', 'Initiatives'], ['runway', 'Growth runway'],
  ]
  const notes = NARR.filter(([k]) => arData[k]?.text)
  const pledge = arData.pledgeTrend || []
  const rpt = arData.rptTrend || []
  if (notes.length === 0 && pledge.length === 0 && rpt.length === 0) return null

  return (
    <div className="bg-navy-800/30 rounded-lg px-3 py-2 space-y-2">
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Qualitative context</div>
      {notes.map(([k, label]) => (
        <div key={k} className="text-xs">
          <span className="text-slate-500">{label}{arData[k].asOf ? ` (${arData[k].asOf})` : ''}: </span>
          <span className="text-slate-300">{truncate(arData[k].text, 160)}</span>
        </div>
      ))}
      {pledge.length > 0 && (
        <div className="text-xs">
          <span className="text-slate-500">Pledge trend: </span>
          <span className="text-slate-300">{pledge.map(r => `${r.asOf}: ${r.pct}%`).join(' → ')}</span>
        </div>
      )}
      {rpt.length > 0 && (
        <div className="text-xs">
          <span className="text-slate-500">Related-party trend: </span>
          <span className="text-slate-300">{rpt.map(r => `${r.asOf}: ${r.pctOfRevenue != null ? r.pctOfRevenue + '%' : 'disclosed'}`).join(' → ')}</span>
        </div>
      )}
    </div>
  )
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n).trim() + '…' : s)

function HighlightRow({ label, value, badge, extra }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-t border-navy-800 first:border-t-0">
      <span className="text-xs text-slate-400 uppercase tracking-wider">{label}</span>
      <span className="flex items-center gap-2">
        {extra}
        <span className={`badge ${badge}`}>{value}</span>
      </span>
    </div>
  )
}

function Metric({ label, val, sub, tier, method }) {
  return (
    <div className="bg-navy-800/40 rounded-lg px-2.5 py-1.5">
      <div className="text-[10px] text-slate-500 flex items-center justify-between gap-1">
        <span>{label}</span>
        {tier && <ProvenanceTag tier={tier} method={method} compact />}
      </div>
      <div className="text-sm text-slate-100 capitalize">{val}</div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  )
}

function EvidenceList({ title, items }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-slate-500 mb-1">{title}</div>
      <ul className="space-y-0.5">
        {items.map((e, i) => (
          <li key={i} className="text-xs flex gap-2">
            <span className={e.ok === null ? 'text-slate-500' : e.ok ? 'text-bull' : 'text-bear'}>
              {e.ok === null ? '·' : e.ok ? '✓' : '✗'}
            </span>
            <span className="text-slate-300">{e.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── formatting ────────────────────────────────────────────────────────────────
const moatBadge = t => t === 'Very Wide' || t === 'Wide' ? 'badge-bull' : t === 'Narrow' ? 'badge-neutral' : 'badge-bear'
const qualityBadge = t => t === 'High' ? 'badge-bull' : t === 'Medium' ? 'badge-neutral' : 'badge-bear'
const pctTxt = (v, d = 1) => (v == null ? '—' : `${Number(v).toFixed(d)}%`)
const numTxt = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d))
const prettyFlag = f => ({
  liquidity_unavailable: 'liquidity (current/quick ratios)',
  market_share_unavailable: 'market share trend',
  roce_series_unavailable: 'ROCE history',
  gross_margin_unavailable: 'gross margin (no COGS line in Indian P&L)',
}[f] || f)
