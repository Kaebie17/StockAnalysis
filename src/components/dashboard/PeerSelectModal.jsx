import React, { useEffect, useState, useRef } from 'react'
import { fetchPeerCandidates } from '../../api/peersClient.js'
import { analyzeTicker } from '../../store/analyzeTicker.js'

/**
 * PeerSelectModal — review real peer candidates, confirm which count, and
 * deliberately warm this ticker's peer cache along the way.
 *
 * Candidates come from two automatic sources, merged (peersClient.js's
 * fetchPeerCandidates) — Yahoo's recommendationsBySymbol was tried and
 * dropped entirely (confirmed empty for RELIANCE.NS, and the library's
 * own docs say international coverage is weak generally — it never
 * contributed a real candidate for this app's market):
 *   - NSE's own sectoral index constituents — real, exchange-maintained,
 *     but NSE-listed only, so a BSE-only comparable never appears here.
 *   - This browser's own analysis history in the same sector — covers
 *     what NSE's list structurally can't (BSE-only names, or anything
 *     else the user has independently analyzed), at the cost of only
 *     surfacing names this browser happens to have looked at before.
 * Neither is a guarantee of comparability — an index like Nifty Energy
 * mixes pure-play oil & gas names with Power names — so nothing is
 * pre-checked, including already-cached peers: confirming is what makes a
 * candidate count toward peerBand(), and that requires the user to
 * actually look at the list, not just have data for it sitting in cache
 * already.
 *
 * Peer-median P/E, P/B, EV/Revenue, EV/FCF and EV/EBITDA (valuation.js,
 * marketExpectation.js) all need each peer's own computed ratios, not a
 * live quote — read off each peer's own cached ratioResult (see
 * peersClient.js's enrichFromCache), never a network call. A peer that's
 * ALREADY been analyzed in this app already has that sitting in this
 * browser's IndexedDB for free; confirming an uncached candidate here
 * warms it via the same headless analyse pipeline
 * (src/store/analyzeTicker.js) the Positions page already uses for "get
 * data for a stock without opening it."
 *
 * Confirming fetches (if needed) immediately, not on some later "Done" —
 * a separate step just meant a long silent wait with no visible progress
 * until the whole batch finished. Fetches still run through a real
 * one-at-a-time queue (never parallel, never a burst against Yahoo) even
 * if several boxes are ticked in quick succession. A fetch failure simply
 * unconfirms the box — that IS the retry affordance, tick it again —
 * rather than a separate persistent "failed" state with its own button.
 *
 * Unconfirming (confirmedPeers, AppContext.jsx) never touches the peer
 * ticker's own cached data — it stays fully warmed and usable everywhere
 * else (its own analysis, or as a peer of some other stock); it only
 * stops counting toward THIS stock's peer-median calculations.
 */
export default function PeerSelectModal({ open, onClose, ticker, meta, sectorType, confirmedPeers = [], onToggleConfirm }) {
  const [peers, setPeers] = useState([])
  const [status, setStatus] = useState({})   // symbol -> 'available' | 'loading' (no other states — a failure just reverts)
  const [queue, setQueue] = useState([])     // symbols waiting their turn, in tick order
  const processingRef = useRef(false)
  const loadedAnyRef = useRef(false)         // true once ANY peer is freshly warmed this session, for the parent's refresh decision
  const confirmedSet = new Set(confirmedPeers)

  // (Re)initialize every time the modal opens — a stale candidate list
  // from the last ticker silently carrying over would be the same "stale
  // state bleeds into a new ticker" bug already fixed elsewhere in this
  // app's valuation assumptions. Nothing pre-checked here — confirmedSet
  // (derived from AppContext.jsx's persisted per-ticker state, not local
  // state) is what actually drives which boxes show checked.
  useEffect(() => {
    if (!open || !ticker) { setPeers([]); return }
    let cancelled = false
    loadedAnyRef.current = false
    setQueue([])
    fetchPeerCandidates({ ticker, meta, sectorType }).then(list => {
      if (cancelled) return
      setPeers(list)
      const st = {}
      for (const p of list) if (p.cached) st[p.symbol] = 'available'
      setStatus(st)
    })
    return () => { cancelled = true }
  }, [open, ticker])

  // The queue itself IS the sequencing: only one item processed at a time,
  // the next only starts once this one resolves — a real queue, not just a
  // concurrency cap on a batch.
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
        // Failure: back to "not loaded" AND unconfirmed — it was
        // optimistically confirmed the instant it was ticked (see toggle
        // below), so a failed fetch has to undo that too. Ticking it again
        // is the retry, no separate button needed.
        setStatus(prev => { const next = { ...prev }; delete next[symbol]; return next })
        onToggleConfirm?.(symbol)
      }
      setQueue(q => q.slice(1))
      processingRef.current = false
    })
  }, [queue])

  // The checkbox IS the confirm/unconfirm action (opt-in — see the module
  // docblock) — no separate control, one unambiguous toggle per row rather
  // than a checkbox plus a link that could drift out of sync with it.
  const toggle = (symbol) => {
    const isConfirming = !confirmedSet.has(symbol)
    onToggleConfirm?.(symbol)
    if (isConfirming) {
      if (status[symbol] !== 'available') setQueue(q => (q.includes(symbol) ? q : [...q, symbol]))
    } else {
      // Unticking before its turn simply drops it from the queue — nothing
      // to cancel, it never started.
      setQueue(q => q.filter(s => s !== symbol))
    }
  }

  const close = () => onClose?.(loadedAnyRef.current)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-md space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Peer coverage</h3>
          <button onClick={close} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>
        <p className="text-xs text-slate-400">
          Candidates from NSE's own sectoral index (real, exchange-maintained — but a mixed bag, not a
          guarantee of comparability) and stocks you've already analyzed in the same sector. Confirm the
          ones that are genuinely comparable — only confirmed peers count toward peer-median multiples.
          Confirming an uncached name fetches its financials now; fetches run one at a time.
        </p>

        <div className="space-y-1 max-h-64 overflow-y-auto">
          {peers.map(p => {
            const isConfirmed = confirmedSet.has(p.symbol)
            return (
              <div key={p.symbol} className="flex items-center gap-2 text-sm py-1">
                <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                  <input type="checkbox" checked={isConfirmed} onChange={() => toggle(p.symbol)}
                         disabled={status[p.symbol] === 'loading'}
                         title={isConfirmed ? 'Confirmed as a peer — untick to remove' : 'Confirm as a peer for this stock'}
                         className="accent-accent" />
                  <span className="flex-1 min-w-0 truncate">
                    <span className="text-slate-300">{p.name || p.symbol}</span>
                    <SourceTag sources={p.sources} industry={p.industry} />
                  </span>
                </label>
                <StatusBadge status={status[p.symbol]} queued={queue.includes(p.symbol) && status[p.symbol] !== 'loading'} />
              </div>
            )
          })}
          {peers.length === 0 && <p className="text-xs text-slate-500 py-2">No peer candidates found for this stock.</p>}
        </div>

        <div className="flex justify-end pt-1">
          <button onClick={close}
            className="text-xs font-medium text-accent hover:text-accent-light
                       bg-accent/10 hover:bg-accent/20 px-3 py-1.5 rounded-md transition-colors">
            Done
          </button>
        </div>
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

// Why this candidate is in the list — which source(s) surfaced it, and
// the NSE index's own industry sub-classification when there is one (a
// real distinction worth seeing while sifting: Nifty Energy, for example,
// mixes "Oil Gas & Consumable Fuels" with "Power").
function SourceTag({ sources, industry }) {
  if (!sources?.length) return null
  const label = sources.includes('nse-index')
    ? (industry || 'NSE sector index')
    : 'Previously analyzed, same sector'
  return <span className="block text-[10px] text-slate-500 truncate">{label}</span>
}
