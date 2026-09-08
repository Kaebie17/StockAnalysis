import React, { useEffect, useState, useCallback } from 'react'
import { fetchPeers } from '../../api/peersClient.js'
import { analyzeTicker, analyzeMany } from '../../store/analyzeTicker.js'

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
 * way, one at a time (never a burst of requests), reusing the exact same
 * headless analyse pipeline (src/store/analyzeTicker.js) the Positions
 * page already uses for "get data for a stock without opening it."
 */
export default function PeerSelectModal({ open, onClose, ticker }) {
  const [peers, setPeers] = useState([])
  const [selected, setSelected] = useState(() => new Set())
  const [status, setStatus] = useState({})   // symbol -> 'available' | 'loading' | 'failed' | 'not-loaded'
  const [running, setRunning] = useState(false)

  // (Re)initialize every time the modal opens — a stale peer list from the
  // last ticker silently carrying over would be the same "stale state
  // bleeds into a new ticker" bug already fixed elsewhere in this app's
  // valuation assumptions.
  useEffect(() => {
    if (!open || !ticker) { setPeers([]); return }
    let cancelled = false
    fetchPeers(ticker).then(list => {
      if (cancelled) return
      setPeers(list)
      setSelected(new Set(list.map(p => p.symbol)))   // all pre-checked — opt OUT, not opt in
      const st = {}
      for (const p of list) st[p.symbol] = p.cached ? 'available' : 'not-loaded'
      setStatus(st)
    })
    return () => { cancelled = true }
  }, [open, ticker])

  const toggle = (symbol) => {
    if (running) return
    setSelected(prev => {
      const next = new Set(prev)
      next.has(symbol) ? next.delete(symbol) : next.add(symbol)
      return next
    })
  }

  const runLoad = useCallback(async () => {
    const toLoad = peers
      .filter(p => selected.has(p.symbol) && status[p.symbol] !== 'available')
      .map(p => p.symbol)
    if (toLoad.length === 0) { onClose?.(true); return }

    setRunning(true)
    setStatus(prev => {
      const next = { ...prev }
      for (const s of toLoad) next[s] = 'loading'
      return next
    })
    // concurrency: 1 — one Yahoo fetch in flight at a time, never a burst.
    // analyzeMany already handles cache-check-first, in-flight dedup, and
    // 10-minute failure memoization (analyzeTicker.js) — nothing new here.
    const results = await analyzeMany(toLoad, {
      concurrency: 1,
      onEach: (symbol) => setStatus(prev => ({ ...prev, [symbol]: 'available' })),
    })
    const failed = toLoad.filter(s => !results[s])
    setStatus(prev => {
      const next = { ...prev }
      for (const s of failed) next[s] = 'failed'
      return next
    })
    setRunning(false)
    // Only auto-close on a clean sweep — a failure stays on screen so the
    // user can see it and retry, rather than silently vanishing.
    if (failed.length === 0) onClose?.(true)
  }, [peers, selected, status, onClose])

  const retry = async (symbol) => {
    setStatus(prev => ({ ...prev, [symbol]: 'loading' }))
    const res = await analyzeTicker(symbol, { force: true })
    setStatus(prev => ({ ...prev, [symbol]: res ? 'available' : 'failed' }))
  }

  if (!open) return null

  const anyLoaded = peers.some(p => status[p.symbol] === 'available' && !p.cached)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-md space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white">Peer coverage</h3>
          <button onClick={() => onClose?.(anyLoaded)} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>
        <p className="text-xs text-slate-400">
          Peer-based multiples (EV/Revenue, EV/FCF, EV/EBITDA) need each peer's full financials, not just its
          price — free for a peer already analyzed here, otherwise one Yahoo fetch per peer. Choose which to
          load now; already-available ones cost nothing.
        </p>

        <div className="space-y-1 max-h-64 overflow-y-auto">
          {peers.map(p => (
            <label key={p.symbol} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
              <input type="checkbox" checked={selected.has(p.symbol)} onChange={() => toggle(p.symbol)}
                     disabled={running || status[p.symbol] === 'available'}
                     className="accent-accent" />
              <span className="flex-1 text-slate-300 truncate">{p.name || p.symbol}</span>
              <StatusBadge status={status[p.symbol]} onRetry={() => retry(p.symbol)} />
            </label>
          ))}
          {peers.length === 0 && <p className="text-xs text-slate-500 py-2">No peers found for this stock.</p>}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <button onClick={() => onClose?.(anyLoaded)} className="text-xs text-slate-500 hover:text-slate-300">
            Skip
          </button>
          <button onClick={runLoad} disabled={running || peers.length === 0}
            className="text-xs font-medium text-accent hover:text-accent-light
                       bg-accent/10 hover:bg-accent/20 px-3 py-1.5 rounded-md
                       disabled:opacity-50 transition-colors">
            {running ? 'Loading…' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status, onRetry }) {
  if (status === 'available') return <span className="text-[10px] text-bull shrink-0">✓ available</span>
  if (status === 'loading')   return <span className="text-[10px] text-slate-500 shrink-0">loading…</span>
  if (status === 'failed') return (
    <span className="text-[10px] text-bear shrink-0">
      failed <button onClick={(e) => { e.preventDefault(); onRetry() }} className="underline ml-1">retry</button>
    </span>
  )
  return <span className="text-[10px] text-slate-600 shrink-0">not loaded</span>
}
