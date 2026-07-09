import React, { useEffect, useRef, useState } from 'react'
import { fetchTargets } from '../../api/targetsClient.js'

/**
 * AnalystTargets — shows sell-side price targets BESIDE StockAnalyzr's own
 * fair-value range on a shared scale. Comparison context only; the two are never
 * combined. Renders a clean "no analyst coverage" state when Yahoo returns
 * nothing (common for thinly-covered Indian small-caps).
 *
 * Props:
 *   ticker      resolved symbol (e.g. 'RELIANCE.NS')
 *   cmp         current market price (number)
 *   fairLow     StockAnalyzr fair-value range low (number|null)
 *   fairHigh    StockAnalyzr fair-value range high (number|null)
 *   currency    ISO code from your data (e.g. 'INR'); falls back to Yahoo's
 */
export default function AnalystTargets({ ticker, cmp, fairLow, fairHigh, currency }) {
  const [state, setState] = useState({ status: 'loading', targets: null })
  const abortRef = useRef(null)

  useEffect(() => {
    if (!ticker) return
    setState({ status: 'loading', targets: null })
    const ctrl = new AbortController()
    abortRef.current = ctrl
    fetchTargets(ticker, ctrl.signal)
      .then(res => {
        if (ctrl.signal.aborted) return
        if (!res.ok) setState({ status: 'error', targets: null })
        else if (!res.targets) setState({ status: 'empty', targets: null })
        else setState({ status: 'ready', targets: res.targets })
      })
      .catch(() => { if (!ctrl.signal.aborted) setState({ status: 'error', targets: null }) })
    return () => ctrl.abort()
  }, [ticker])

  const { status, targets } = state
  const cur = symbolFor(targets?.currency || currency)

  if (status === 'loading') {
    return <Shell><p className="text-xs text-slate-500 animate-pulse">Loading analyst targets…</p></Shell>
  }
  if (status === 'error') {
    return <Shell><p className="text-xs text-slate-600">Couldn't load analyst targets right now.</p></Shell>
  }
  if (status === 'empty' || !targets) {
    return <Shell><p className="text-xs text-slate-500">No analyst coverage found for this ticker.</p></Shell>
  }

  // Shared scale across every value we have, so the two ranges are comparable.
  const pts = [cmp, fairLow, fairHigh, targets.low, targets.high, targets.mean, targets.median]
    .filter(v => typeof v === 'number' && isFinite(v) && v > 0)
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const pad = (max - min) * 0.08 || max * 0.05
  const lo = Math.max(0, min - pad)
  const hi = max + pad
  const pos = v => `${clamp(((v - lo) / (hi - lo)) * 100, 0, 100)}%`

  const rec = recLabel(targets.recKey, targets.recMean)
  const upside = targets.mean && cmp ? ((targets.mean - cmp) / cmp) * 100 : null

  return (
    <Shell>
      <div className="space-y-3">
        {/* Our fair-value range */}
        {fairLow != null && fairHigh != null && (
          <Track label="StockAnalyzr fair value" colorClass="bg-accent/70"
                 lo={pos(fairLow)} hi={pos(fairHigh)}
                 loText={`${cur}${fmt(fairLow)}`} hiText={`${cur}${fmt(fairHigh)}`} />
        )}

        {/* Analyst target range */}
        <Track label={`Analyst targets${targets.count ? ` · ${targets.count} analysts` : ''}`}
               colorClass="bg-neutral/70"
               lo={pos(targets.low ?? targets.mean)} hi={pos(targets.high ?? targets.mean)}
               mark={targets.mean != null ? pos(targets.mean) : null}
               loText={targets.low != null ? `${cur}${fmt(targets.low)}` : ''}
               hiText={targets.high != null ? `${cur}${fmt(targets.high)}` : ''} />

        {/* CMP marker line + legend */}
        <div className="relative h-5">
          <div className="absolute top-0 bottom-0 w-px bg-white/70" style={{ left: pos(cmp) }} />
          <div className="absolute -top-0.5 text-[10px] text-slate-300 -translate-x-1/2 whitespace-nowrap"
               style={{ left: pos(cmp) }}>
            CMP {cur}{fmt(cmp)}
          </div>
        </div>

        {/* Recommendation + upside */}
        <div className="flex items-center gap-3 flex-wrap text-xs pt-1">
          {rec && <span className={`badge ${rec.cls}`}>{rec.text}</span>}
          {targets.mean != null && (
            <span className="text-slate-400">
              Mean target {cur}{fmt(targets.mean)}
              {upside != null && (
                <span className={upside >= 0 ? 'text-bull' : 'text-bear'}>
                  {' '}({upside >= 0 ? '+' : ''}{upside.toFixed(1)}% vs CMP)
                </span>
              )}
            </span>
          )}
        </div>

        <p className="text-[10px] text-slate-600 leading-snug">
          Sell-side targets shown for comparison only — not combined into StockAnalyzr's fair value,
          and structurally optimistic.
        </p>
      </div>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div className="card border-navy-700 bg-navy-900/50 py-3 px-4">
      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
        Fair value vs analyst targets
      </div>
      {children}
    </div>
  )
}

function Track({ label, colorClass, lo, hi, mark, loText, hiText }) {
  const left = pctNum(lo), right = pctNum(hi)
  const l = Math.min(left, right), w = Math.max(0.8, Math.abs(right - left))
  return (
    <div>
      <div className="flex justify-between text-[11px] text-slate-500 mb-1">
        <span>{label}</span>
      </div>
      <div className="relative h-3 rounded bg-navy-800">
        <div className={`absolute h-3 rounded ${colorClass}`} style={{ left: `${l}%`, width: `${w}%` }} />
        {mark && <div className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-white" style={{ left: mark }} />}
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 mt-0.5">
        <span>{loText}</span><span>{hiText}</span>
      </div>
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const pctNum = s => parseFloat(String(s)) || 0
const fmt = v => (v == null ? '' : Number(v).toLocaleString(undefined, { maximumFractionDigits: v < 100 ? 1 : 0 }))

function symbolFor(code) {
  if (!code) return ''
  const m = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }
  return m[code] || `${code} `
}

function recLabel(key, mean) {
  const k = (key || '').toLowerCase()
  if (k.includes('strong_buy') || (mean != null && mean <= 1.5)) return { text: 'Strong Buy', cls: 'badge-bull' }
  if (k.includes('buy') || (mean != null && mean <= 2.5)) return { text: 'Buy', cls: 'badge-bull' }
  if (k.includes('hold') || (mean != null && mean <= 3.5)) return { text: 'Hold', cls: 'badge-neutral' }
  if (k.includes('sell')) return { text: 'Sell', cls: 'badge-bear' }
  return null
}
