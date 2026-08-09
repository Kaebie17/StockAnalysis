import React, { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { listPositions } from '../../utils/db.js'
import { fetchQuotes } from '../../api/quotesClient.js'
import { reviewExit, exitStats, reasonLabel, EXIT_REASONS } from '../../engine/exitReview.js'

const sym = c => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[c]) || '₹'
const money = (v, c) => (v == null ? '—' : sym(c) + Math.abs(Math.round(v)).toLocaleString('en-IN'))
const dstr = t => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')

/**
 * SoldPositions — the exit record.
 *
 * Its own page rather than a tab, because it answers a different question from
 * the holdings view. Holdings ask "what should I do now?"; this asks "what did I
 * learn?" — and the second only becomes answerable once a position is closed.
 *
 * Prices come from the batch quote endpoint, not from visiting each stock. That
 * matters more here than anywhere else in the app: the whole point is what
 * happened to shares you stopped watching, so a visit-triggered refresh would
 * leave exactly the interesting cases frozen at their exit price.
 */
export default function SoldPositions({ open, onClose }) {
  const { state, load } = useApp()
  const [rows, setRows] = useState([])
  const [quotes, setQuotes] = useState({})
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    if (!open) return
    let dead = false
    setLoading(true)
    ;(async () => {
      const closed = await listPositions({ status: 'closed' })
      if (dead) return
      setRows(closed)
      const q = await fetchQuotes(closed.map(p => p.ticker))
      if (!dead) { setQuotes(q); setLoading(false) }
    })().catch(() => !dead && setLoading(false))
    return () => { dead = true }
  }, [open])

  const reviews = useMemo(
    () => rows.map(p => reviewExit(p, quotes[p.ticker]?.price ?? null)).filter(Boolean)
              .sort((a, b) => (b.sellDate || 0) - (a.sellDate || 0)),
    [rows, quotes])

  const stats = useMemo(() => exitStats(reviews), [reviews])
  const shown = filter === 'all' ? reviews : reviews.filter(r => (r.reason || 'untagged') === filter)
  const currency = state.data?.currency || 'INR'

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center
                    p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full sm:max-w-2xl bg-navy-900 border border-navy-700
                      rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700 shrink-0">
          <h2 className="font-semibold text-white">📕 Exit record</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4
                        pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : reviews.length === 0 ? (
            <div className="text-center py-8 space-y-1">
              <p className="text-slate-400 text-sm">No sales recorded yet.</p>
              <p className="text-slate-600 text-xs">
                Once you sell something, this page tracks what happened next — and whether
                your reasons for selling tend to hold up.
              </p>
            </div>
          ) : (
            <>
              {stats && <Summary stats={stats} currency={currency} />}

              {/* Filter by reason — the aggregate is only readable if you can
                  isolate one kind of exit and look at the cases behind it. */}
              {stats?.byReason?.length > 1 && (
                <div className="flex gap-1.5 flex-wrap">
                  <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
                    All {reviews.length}
                  </Chip>
                  {stats.byReason.map(b => (
                    <Chip key={b.reason} active={filter === b.reason} onClick={() => setFilter(b.reason)}>
                      {b.label} {b.count}
                    </Chip>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                {shown.map(r => (
                  <ExitCard key={r.id} r={r} currency={currency}
                            onOpen={() => { load(r.ticker); onClose() }} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Summary({ stats, currency }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Sales" value={stats.count} />
        <Stat label="Realised" value={money(stats.realisedTotal, currency)}
              tone={stats.realisedTotal >= 0 ? 'bull' : 'bear'} />
        <Stat label="Profitable" value={`${stats.winRate}%`} />
      </div>

      {/* The two readings that matter, kept apart on purpose: whether the
          analysis was right, and whether the exits were well-timed. You can be
          good at one and bad at the other, and most people are. */}
      <div className="grid grid-cols-2 gap-2">
        {stats.estimateAccuracy && (
          <Stat label="Estimates that held"
                value={`${stats.estimateAccuracy.pct}%`}
                sub={`${stats.estimateAccuracy.right} of ${stats.estimateAccuracy.scored}`} />
        )}
        {stats.roseAfterPct != null && (
          <Stat label="Kept rising after you sold"
                value={`${stats.roseAfterPct}%`}
                sub={stats.avgMoveAfterPct != null ? `avg ${stats.avgMoveAfterPct > 0 ? '+' : ''}${stats.avgMoveAfterPct}%` : null}
                tone={stats.roseAfterPct > 60 ? 'neutral' : null} />
        )}
      </div>

      {stats.weakestReason && stats.weakestReason.scored >= 3 && (
        <div className="text-[11px] bg-navy-800/50 rounded-lg px-3 py-2 text-slate-400">
          Across {stats.weakestReason.scored} sales tagged “{stats.weakestReason.label}”,{' '}
          {stats.weakestReason.roseAfter} kept rising afterwards
          {stats.weakestReason.avgMovePct != null && <> (avg {stats.weakestReason.avgMovePct > 0 ? '+' : ''}{stats.weakestReason.avgMovePct}%)</>}.
          {stats.weakestReason.roseAfter / stats.weakestReason.scored > 0.5 &&
            <span className="text-neutral"> This is your weakest exit reason.</span>}
        </div>
      )}
    </div>
  )
}

function ExitCard({ r, currency, onOpen }) {
  const up = r.realised >= 0
  return (
    <div className="bg-navy-800/40 rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <button onClick={onOpen} className="font-mono text-sm text-white hover:text-accent">
            {r.ticker.replace(/\.(NS|BO)$/, '')}
          </button>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {r.shares} × {money(r.buyPrice, currency)} {dstr(r.buyDate)} → {money(r.sellPrice, currency)} {dstr(r.sellDate)}
            {r.heldDays != null && <span className="text-slate-600"> · held {r.heldDays}d</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-sm font-mono ${up ? 'text-bull' : 'text-bear'}`}>
            {up ? '+' : '−'}{money(r.realised, currency)}
          </div>
          <div className="text-[11px] text-slate-500">{r.realisedPct >= 0 ? '+' : ''}{r.realisedPct}%</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Mini label="Since you exited"
              value={r.after?.movePct != null ? `${r.after.movePct >= 0 ? '+' : ''}${r.after.movePct}%` : '—'}
              tone={r.after?.movePct > 0 ? 'bear' : r.after?.movePct < 0 ? 'bull' : null}
              sub={r.after ? `${money(r.sellPrice, currency)} → ${money(r.after.price, currency)} in ${r.after.sinceDays}d` : 'no price yet'} />
        <Mini label="Your estimate said"
              value={r.estimateVerdict ? `${money(r.estimateVerdict.low, currency)}–${money(r.estimateVerdict.high, currency)}` : '—'}
              sub={r.estimateVerdict?.label || 'none recorded at purchase'}
              tone={r.estimateVerdict?.reached ? 'bull' : null} />
      </div>

      {r.timing?.flag && (
        <div className="text-[11px] bg-neutral/10 text-neutral rounded px-2 py-1.5">
          ⚑ {r.timing.label}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${
          r.reason ? 'bg-navy-700 text-slate-300' : 'bg-navy-800 text-slate-600'}`}>
          {reasonLabel(r.reason)}
        </span>
        {r.reasonNote && <span className="text-[11px] text-slate-500 italic truncate">“{r.reasonNote}”</span>}
      </div>

      {r.reentry?.candidate && (
        <div className="text-[11px] text-accent">
          ↩ Back inside your estimate range — worth a fresh look before a new name.
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone }) {
  const c = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : tone === 'neutral' ? 'text-neutral' : 'text-white'
  return (
    <div className="bg-navy-800/40 rounded-lg px-3 py-2">
      <div className="text-[10px] text-slate-500 leading-tight">{label}</div>
      <div className={`text-sm font-mono mt-0.5 ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600">{sub}</div>}
    </div>
  )
}

function Mini({ label, value, sub, tone }) {
  const c = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-slate-300'
  return (
    <div className="bg-navy-900/60 rounded px-2.5 py-1.5">
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-xs font-mono ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-600 truncate">{sub}</div>}
    </div>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${
        active ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-500 hover:text-slate-300'}`}>
      {children}
    </button>
  )
}
