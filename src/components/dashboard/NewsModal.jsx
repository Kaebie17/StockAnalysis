import React, { useEffect, useRef, useState, useCallback } from 'react'
import { fetchNews } from '../../api/newsClient.js'

/**
 * NewsModal — a standalone, full-screen headline layer.
 *
 * Design (agreed spec):
 *  • Lazy: nothing fetches until the modal opens.
 *  • Refresh: every 3 min while open AND the tab is visible; paused when hidden,
 *    with one immediate refresh when the tab regains focus.
 *  • No cache. The only in-memory state is a concurrency guard (in-flight flag +
 *    AbortController) so the interval and a manual retry can't race.
 *  • Refresh replaces on success only; on failure the last good list stays put.
 *    Genuinely-new headlines prepend at the top — silently if the user is at the
 *    top, or behind a "N new" pill if they've scrolled down (so nothing jumps).
 *  • Infinite scroll reveals BATCH items at a time (depth comes mostly from
 *    Google; Yahoo supplies the freshest few up top).
 *  • Empty (both sources reachable, zero stories) → message, then auto-close.
 *  • Both sources unreachable → stay open with a Retry.
 */

const REFRESH_MS = 3 * 60 * 1000   // 3 min
const BATCH = 8                    // headlines revealed per scroll
const AUTO_CLOSE_MS = 3200         // dwell on the "no news" message before closing
const NEAR_TOP_PX = 80             // "at the top" threshold for silent prepend

function relTime(ms) {
  if (!ms) return ''
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString()
}

const idOf = (it) => it.url || it.title

function NewsRow({ it }) {
  return (
    <li className="py-3">
      <a href={it.url} target="_blank" rel="noopener noreferrer" className="block group">
        <p className="text-sm text-slate-100 leading-snug group-hover:text-accent-light transition-colors">
          {it.title}
        </p>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500">
          <span className="truncate max-w-[55%]">{it.source}</span>
          {it.date > 0 && (<><span>·</span><span className="shrink-0">{relTime(it.date)}</span></>)}
          <span className="ml-auto shrink-0 text-slate-600 group-hover:text-accent-light">↗</span>
        </div>
      </a>
    </li>
  )
}

export default function NewsModal({ open, onClose, query, ticker, company }) {
  const [items, setItems] = useState([])
  const [visible, setVisible] = useState(BATCH)
  const [status, setStatus] = useState('loading')   // loading | ready | empty | error
  const [updatedAt, setUpdated] = useState(null)
  const [buffer, setBuffer] = useState([])           // new items waiting behind the pill
  const [sectorOpen, setSectorOpen] = useState(false) // collapsed "sector reports" group
  const [, forceTick] = useState(0)                  // re-render for "updated Xs ago"

  const abortRef = useRef(null)
  const inFlight = useRef(false)
  const bodyRef = useRef(null)
  const closeTimer = useRef(null)

  // Refs mirror the latest list/buffer so the refresh path can diff against them
  // without nesting state setters.
  const itemsRef = useRef([])
  const bufferRef = useRef([])
  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { bufferRef.current = buffer }, [buffer])

  const run = useCallback(async (isFirst) => {
    if (inFlight.current) return                     // concurrency guard
    inFlight.current = true
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const { items: fresh, error } = await fetchNews(query, ticker, company, ctrl.signal)
      if (ctrl.signal.aborted) return

      if (error === 'fetch_failed') {
        if (isFirst) setStatus('error')              // first load failed → show retry
        return                                       // refresh failure → keep last good list
      }
      if (!fresh || fresh.length === 0) {
        if (isFirst) setStatus('empty')              // genuinely no news → message + close
        return                                       // refresh empty → ignore, keep list
      }

      if (isFirst) {
        setItems(fresh)
        setVisible(BATCH)
        setBuffer([])
        setStatus('ready')
        setUpdated(Date.now())
        return
      }

      // Refresh: which items are genuinely new (not already shown or buffered)?
      const known = new Set([...itemsRef.current, ...bufferRef.current].map(idOf))
      const added = fresh.filter(it => !known.has(idOf(it)))
      setUpdated(Date.now())
      if (added.length === 0) return

      const el = bodyRef.current
      const atTop = !el || el.scrollTop <= NEAR_TOP_PX
      if (atTop) {
        // Seamless: prepend into the list and grow the revealed count so nothing
        // already visible drops off (count primary-tier items only — the sector
        // group isn't part of the scroll window).
        const addedPrimary = added.filter(it => it.tier !== 'sector').length
        setItems(list => [...added, ...list])
        setVisible(v => v + addedPrimary)
      } else {
        // Scrolled down: hold new items behind the "N new" pill — no jump.
        setBuffer(buf => [...added, ...buf])
      }
    } catch {
      if (!ctrl.signal.aborted && isFirst) setStatus('error')
    } finally {
      inFlight.current = false
    }
  }, [query, ticker, company])

  // Open lifecycle: first fetch + interval (paused when hidden) + cleanup.
  useEffect(() => {
    if (!open) return
    setStatus('loading'); setItems([]); setBuffer([]); setVisible(BATCH); setUpdated(null)
    run(true)

    let intervalId = null
    const start = () => { if (intervalId == null) intervalId = setInterval(() => run(false), REFRESH_MS) }
    const stop = () => { if (intervalId != null) { clearInterval(intervalId); intervalId = null } }
    const onVis = () => {
      if (document.hidden) stop()
      else { run(false); start() }                   // immediate refresh on return, then resume
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVis)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      if (abortRef.current) abortRef.current.abort()
      if (closeTimer.current) clearTimeout(closeTimer.current)
      inFlight.current = false
    }
  }, [open, run])

  // "Updated Xs ago" keeps ticking without a refetch.
  useEffect(() => {
    if (!open || status !== 'ready') return
    const id = setInterval(() => forceTick(t => t + 1), 15000)
    return () => clearInterval(id)
  }, [open, status])

  // No news → let the message breathe, then close.
  useEffect(() => {
    if (open && status === 'empty') {
      closeTimer.current = setTimeout(() => onClose(), AUTO_CLOSE_MS)
      return () => clearTimeout(closeTimer.current)
    }
  }, [open, status, onClose])

  const onScroll = () => {
    const el = bodyRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      const primaryLen = itemsRef.current.filter(it => it.tier !== 'sector').length
      setVisible(v => Math.min(v + BATCH, primaryLen))
    }
  }

  const flushBuffer = () => {
    if (buffer.length === 0) return
    const addedPrimary = buffer.filter(it => it.tier !== 'sector').length
    setItems(list => [...buffer, ...list])
    setVisible(v => v + addedPrimary)
    setBuffer([])
    if (bodyRef.current) bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!open) return null

  // Relevance tiers: company-relevant headlines scroll normally; generic market
  // reports with no company mention collapse into a separate group at the bottom.
  const primary = items.filter(it => it.tier !== 'sector')
  const sector = items.filter(it => it.tier === 'sector')

  return (
    <div className="fixed inset-0 z-[60] bg-navy-950 flex flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-navy-800 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-white flex items-center gap-2">
            <span>📰</span>
            <span className="truncate">News — {ticker || query}</span>
          </h2>
          {status === 'ready' && updatedAt && (
            <p className="text-[11px] text-slate-500 mt-0.5">
              Updated {relTime(updatedAt)} · refreshes every 3 min
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close news"
          className="text-slate-400 hover:text-white text-2xl leading-none shrink-0 px-2 active:scale-90 transition-transform">
          ✕
        </button>
      </div>

      {/* "N new" pill (only when refresh found items while scrolled down) */}
      {status === 'ready' && buffer.length > 0 && (
        <div className="relative">
          <button
            onClick={flushBuffer}
            className="absolute left-1/2 -translate-x-1/2 top-2 z-10 btn-primary text-xs px-3 py-1 shadow-lg">
            ▲ {buffer.length} new
          </button>
        </div>
      )}

      {/* Body */}
      <div ref={bodyRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-3">
          {status === 'loading' && (
            <div className="py-16 text-center text-sm text-slate-500 animate-pulse">
              Fetching the latest headlines…
            </div>
          )}

          {status === 'empty' && (
            <div className="py-16 text-center space-y-2">
              <div className="text-3xl">📭</div>
              <p className="text-sm text-slate-300">
                No news available for {ticker || query} from our sources right now.
              </p>
              <p className="text-xs text-slate-600">Closing…</p>
            </div>
          )}

          {status === 'error' && (
            <div className="py-16 text-center space-y-3">
              <div className="text-3xl">📡</div>
              <p className="text-sm text-slate-300">Couldn't reach our news sources right now.</p>
              <button
                onClick={() => { setStatus('loading'); run(true) }}
                className="btn-primary text-sm">
                Try again
              </button>
            </div>
          )}

          {status === 'ready' && (
            <>
              <ul className="divide-y divide-navy-800">
                {primary.slice(0, visible).map((it, i) => <NewsRow key={idOf(it) + i} it={it} />)}
              </ul>

              {visible < primary.length && (
                <p className="py-4 text-center text-xs text-slate-600">Scroll for more…</p>
              )}

              {visible >= primary.length && (
                <>
                  {sector.length > 0 && (
                    <div className="mt-4 border-t border-navy-800 pt-3">
                      <button
                        onClick={() => setSectorOpen(o => !o)}
                        className="w-full flex items-center justify-between text-left text-xs font-semibold text-slate-400 hover:text-slate-200 uppercase tracking-wider py-1">
                        <span>Broader market &amp; sector reports · {sector.length}</span>
                        <span className="text-slate-500">{sectorOpen ? '▲' : '▼'}</span>
                      </button>
                      {sectorOpen && (
                        <ul className="divide-y divide-navy-800 mt-1">
                          {sector.map((it, i) => <NewsRow key={idOf(it) + i} it={it} />)}
                        </ul>
                      )}
                    </div>
                  )}

                  <p className="py-5 text-center text-[11px] text-slate-700">
                    End of headlines · {primary.length}{sector.length ? ` + ${sector.length} sector` : ''} stories
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
