import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { listPositions } from '../../utils/db.js'
import { listRevisions } from '../../utils/db.js'
import { fetchNews } from '../../api/newsClient.js'
import { extractFacts } from '../../engine/factExtract.js'
import { keyOf, leverOf } from '../../store/useNewsFacts.js'

const SEEN_KEY = 'sa_news_seen'
const LAST_SHOWN_KEY = 'sa_news_brief_shown'

/**
 * PortfolioNews — what happened to the stocks you own, on app open.
 *
 * The per-ticker version only tells you something once you've already opened
 * that stock, which is useless for a holding you haven't looked at in a month —
 * exactly the one most likely to have moved without you. This polls every open
 * position instead.
 *
 * Shown ONCE per session, not on the 3-minute cycle. A modal that reappears every
 * few minutes gets dismissed reflexively within a day, and then it's worse than
 * nothing: it has trained you to ignore the one thing it exists to surface. The
 * refresh runs quietly in the background and only raises the count.
 *
 * Seen items are remembered, so the brief shows what's NEW since you last looked
 * rather than the same headlines every morning.
 */
export default function PortfolioNews({ onOpenTicker }) {
  const { state } = useApp()
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [seen, setSeen] = useState(() => loadSeen())

  useEffect(() => {
    let dead = false
    ;(async () => {
      const positions = await listPositions({ status: 'open' })
      const tickers = [...new Set(positions.map(p => p.ticker))]
      if (tickers.length === 0 || dead) return

      // Which items have already been acted on anywhere — applied, dismissed or
      // deferred. Those shouldn't reappear as if they were new.
      const handled = new Set()
      for (const t of tickers) {
        try {
          for (const r of await listRevisions({ ticker: t })) {
            if (r.sourceKey) handled.add(r.sourceKey)
          }
        } catch { /* a missing log shouldn't block the brief */ }
      }

      setLoading(true)
      const collected = []
      // Sequential rather than parallel: the news endpoint fans out to two
      // upstream sources per call, and firing a whole portfolio at once is what
      // gets a shared serverless IP throttled. The server-side cache makes the
      // repeat cost of this negligible anyway.
      for (const t of tickers) {
        if (dead) return
        const name = positions.find(p => p.ticker === t)?.name || t
        try {
          const { items: news } = await fetchNews(name, t, name)
          for (const item of (news || []).slice(0, 12)) {
            const key = keyOf(item)
            if (handled.has(key) || seen.has(key)) continue
            const parsed = extractFacts(item.title, { sectorType: null })
            collected.push({
              key, ticker: t, item,
              typeId: parsed.typeId,
              lever: leverOf(parsed.typeId),
              // Regulatory and guidance items lead: a rule change can reprice the
              // whole business, a routine mention can't.
              rank: parsed.typeId ? (HIGH.has(parsed.typeId) ? 0 : 1) : 2,
            })
          }
        } catch { /* one ticker failing shouldn't lose the rest */ }
      }
      if (dead) return
      collected.sort((a, b) => a.rank - b.rank || (b.item.date || 0) - (a.item.date || 0))
      setItems(collected)
      setLoading(false)

      // Open once per session, and only when something actually needs attention.
      const material = collected.filter(c => c.rank < 2)
      if (material.length > 0 && !shownThisSession()) {
        markShown()
        setOpen(true)
      }
    })()
    return () => { dead = true }
    // Deliberately runs once per mount: this is the on-open brief, not a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const material = useMemo(() => items.filter(c => c.rank < 2), [items])
  const rest = useMemo(() => items.filter(c => c.rank === 2), [items])

  const dismissAll = () => {
    const next = new Set(seen)
    for (const c of items) next.add(c.key)
    setSeen(next); saveSeen(next); setOpen(false)
  }
  const dismissOne = key => {
    const next = new Set(seen); next.add(key)
    setSeen(next); saveSeen(next)
    setItems(list => list.filter(c => c.key !== key))
  }

  if (items.length === 0 && !loading) return null

  return (
    <>
      {/* Collapsed indicator — stays reachable after the brief is closed, so
          nothing is lost by dismissing it. */}
      {!open && material.length > 0 && (
        <button onClick={() => setOpen(true)}
          className="w-11 h-11 rounded-full bg-navy-800 border border-neutral/50 shadow-lg
                     text-neutral hover:border-neutral active:scale-95 transition-all
                     flex items-center justify-center text-lg relative">
          📰
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full
                           bg-neutral text-navy-900 text-[10px] font-bold
                           flex items-center justify-center">
            {material.length}
          </span>
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center
                        p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
             onClick={e => e.target === e.currentTarget && setOpen(false)}>
          <div className="w-full sm:max-w-lg bg-navy-900 border border-navy-700
                          rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85dvh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700 shrink-0">
              <h2 className="font-semibold text-white">
                📰 On your holdings
                {material.length > 0 && <span className="text-neutral text-xs ml-2">{material.length} to look at</span>}
              </h2>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white text-lg">✕</button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 space-y-2
                            pb-[max(1.25rem,env(safe-area-inset-bottom))]">
              {loading && items.length === 0 && <p className="text-sm text-slate-500">Checking…</p>}

              {material.map(c => (
                <NewsRow key={c.key} c={c} highlight
                  onOpen={() => { onOpenTicker?.(c.ticker); setOpen(false) }}
                  onDismiss={() => dismissOne(c.key)} />
              ))}

              {rest.length > 0 && (
                <div className="pt-2 border-t border-navy-800 space-y-2">
                  <p className="text-[11px] text-slate-600">Other coverage</p>
                  {rest.slice(0, 8).map(c => (
                    <NewsRow key={c.key} c={c}
                      onOpen={() => { onOpenTicker?.(c.ticker); setOpen(false) }}
                      onDismiss={() => dismissOne(c.key)} />
                  ))}
                </div>
              )}

              <p className="text-[10px] text-slate-600 pt-2">
                Open a stock to price these into its estimate. Nothing here changes a number on
                its own.
              </p>
            </div>

            <div className="flex gap-2 px-5 py-4 border-t border-navy-700 shrink-0
                            pb-[max(1rem,env(safe-area-inset-bottom))]">
              <button onClick={dismissAll} className="flex-1 text-sm text-slate-400 hover:text-white py-2">
                Mark all seen
              </button>
              <button onClick={() => setOpen(false)} className="flex-1 btn-primary text-sm py-2">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function NewsRow({ c, highlight, onOpen, onDismiss }) {
  return (
    <div className={`rounded-lg p-2.5 border ${
      highlight ? 'border-neutral/40 bg-neutral/5' : 'border-navy-800'}`}>
      <div className="flex items-start gap-2">
        <button onClick={onOpen}
          className="font-mono text-[11px] text-accent hover:text-accent-light shrink-0">
          {c.ticker.replace(/\.(NS|BO)$/, '')}
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-slate-300">{c.item.title}</div>
          <div className="flex items-center gap-2 mt-1">
            {c.lever && (
              <span className="text-[10px] text-neutral">
                may affect {c.lever}
              </span>
            )}
            {c.item.source && <span className="text-[10px] text-slate-600">{c.item.source}</span>}
            <button onClick={onDismiss} className="text-[10px] text-slate-600 hover:text-slate-400 ml-auto">
              seen
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const HIGH = new Set(['segment_loss', 'nim_change', 'growth_guidance', 'margin_guidance'])

// Seen-item memory. localStorage rather than the sync store: this is per-device
// reading state, not portfolio data, and it shouldn't travel between devices or
// bloat the backup.
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')) }
  catch { return new Set() }
}
function saveSeen(set) {
  try {
    // Bounded: keep the most recent 300 so this can't grow without limit.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-300)))
  } catch { /* private mode — the brief just repeats, which is survivable */ }
}
function shownThisSession() {
  try { return sessionStorage.getItem(LAST_SHOWN_KEY) === '1' } catch { return false }
}
function markShown() {
  try { sessionStorage.setItem(LAST_SHOWN_KEY, '1') } catch { /* ignore */ }
}
