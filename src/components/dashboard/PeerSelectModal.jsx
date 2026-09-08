import React, { useEffect, useState, useRef } from 'react'
import { fetchPeers } from '../../api/peersClient.js'
import { analyzeTicker } from '../../store/analyzeTicker.js'

/**
 * PeerSelectModal — deliberately warm this ticker's peer cache.
 *
 * Peer-median EV/Revenue, EV/FCF and EV/EBITDA (marketExpectation.js,
 * valuation.js) need each peer's full financials, not just its price —
 * fields only on Yahoo's per-symbol quoteSummary(), which can't be
 * batched. Getting that live for up to 8 peers would mean 8 extra Yahoo
 * calls on every single analysis. Instead: a peer that's ALREADY been
 * analyzed in this app has its full financials sitting in this browser's
 * IndexedDB for free (see peersClient.js's enrichFromCache) — this modal
 * lets the user choose which of the current stock's peers to warm that
 * way, reusing the exact same headless analyse pipeline
 * (src/store/analyzeTicker.js) the Positions page already uses for "get
 * data for a stock without opening it."
 *
 * Ticking a box fetches that peer immediately, not on some later "Done" —
 * a separate confirm step just meant a long silent wait with no visible
 * progress until the whole batch finished. Fetches still run through a
 * real one-at-a-time queue (never parallel, never a burst against Yahoo)
 * even if several boxes are ticked in quick succession. A failure simply
 * unchecks the box — that IS the retry affordance, tick it again — rather
 * than a separate persistent "failed" state with its own button.
 *
 * A peer can also be marked irrelevant for THIS stock (excludedPeers,
 * AppContext.jsx) — Yahoo's own suggested-peer list isn't always a good
 * comparable. That's a per-ticker preference only: it removes the peer
 * from THIS stock's peer-median calculations, never the excluded ticker's
 * own cached data — it stays fully warmed and usable everywhere else
 * (its own analysis, or as a peer of some other stock).
 */
export default function PeerSelectModal({ open, onClose, ticker, excludedPeers = [], onToggleExclude }) {
  const [peers, setPeers] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [status, setStatus] = useState({})   // symbol -> 'available' | 'loading' (no other states — a failure just reverts)
  const [queue, setQueue] = useState([])     // symbols waiting their turn, in tick order
  const processingRef = useRef(false)
  const loadedAnyRef = useRef(false)         // true once ANY peer is freshly warmed this session, for the parent's refresh decision

  // (Re)initialize every time the modal opens — a stale peer list from the
  // last ticker silently carrying over would be the same "stale state
  // bleeds into a new ticker" bug already fixed elsewhere in this app's
  // valuation assumptions. Already-cached peers show pre-checked (nothing
  // to do); everything else starts UNCHECKED — checking one is now itself
  // the "fetch this" action, so pre-checking it would auto-fire a fetch
  // nobody explicitly asked for.
  useEffect(() => {
    if (!open || !ticker) { setPeers([]); return }
    let cancelled = false
    loadedAnyRef.current = false
    setQueue([])
    fetchPeers(ticker).then(list => {
      if (cancelled) return
      setPeers(list)
      setSelected(new Set(list.filter(p => p.cached).map(p => p.symbol)))
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
        // Failure: unchecked and back to "not loaded" — ticking it again
        // is the retry, no separate button needed.
        setStatus(prev => { const next = { ...prev }; delete next[symbol]; return next })
        setSelected(prev => { const next = new Set(prev); next.delete(symbol); return next })
      }
      setQueue(q => q.slice(1))
      processingRef.current = false
    })
  }, [queue])

  const toggle = (symbol) => {
    const isChecking = !selected.has(symbol)
    setSelected(prev => {
      const next = new Set(prev)
      isChecking ? next.add(symbol) : next.delete(symbol)
      return next
    })
    if (isChecking) {
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
          Peer-based multiples (EV/Revenue, EV/FCF, EV/EBITDA) need each peer's full financials, not just its
          price — free for a peer already analyzed here, otherwise one Yahoo fetch. Tick a peer to fetch it now;
          fetches run one at a time.
        </p>

        <div className="space-y-1 max-h-64 overflow-y-auto">
          {peers.map(p => {
            const isExcluded = excludedPeers.includes(p.symbol)
            return (
              <div key={p.symbol} className={`flex items-center gap-2 text-sm py-1 ${isExcluded ? 'opacity-40' : ''}`}>
                <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                  <input type="checkbox" checked={selected.has(p.symbol)} onChange={() => toggle(p.symbol)}
                         disabled={status[p.symbol] === 'available' || status[p.symbol] === 'loading'}
                         className="accent-accent" />
                  <span className="flex-1 text-slate-300 truncate">{p.name || p.symbol}</span>
                </label>
                {!isExcluded && (
                  <StatusBadge status={status[p.symbol]} queued={queue.includes(p.symbol) && status[p.symbol] !== 'loading'} />
                )}
                {/* Explicit verbs, not an icon the user has to decode — "restore"
                    reads as an action regardless of whether the row's dimming or
                    the icon swap is noticed. */}
                <button onClick={() => onToggleExclude?.(p.symbol)}
                  title={isExcluded ? 'Include this peer again' : "Not a good comparable — exclude from this stock's peer group"}
                  className={`text-[10px] shrink-0 underline underline-offset-2 ${
                    isExcluded ? 'text-accent hover:text-accent-light' : 'text-slate-600 hover:text-bear'}`}>
                  {isExcluded ? 'restore' : 'exclude'}
                </button>
              </div>
            )
          })}
          {peers.length === 0 && <p className="text-xs text-slate-500 py-2">No peers found for this stock.</p>}
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
