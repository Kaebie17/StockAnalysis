import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { recordBuy, recordSell, positionMath, previewFifo } from '../../store/usePositions.js'
import { EXIT_REASONS } from '../../engine/exitReview.js'

const cur = c => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[c]) || ''

// Market close, local time, by listing. Used to pick a sensible default time and
// to decide which day's close a back-dated purchase should price against.
const CLOSE = { IN: { h: 15, m: 30 }, US: { h: 16, m: 0 } }
const OPEN  = { IN: { h: 9, m: 15 },  US: { h: 9, m: 30 } }
const venueOf = t => (/\.(NS|BO)$/i.test(t || '') ? 'IN' : 'US')

const pad = n => String(n).padStart(2, '0')
const toLocalInput = d =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

/**
 * Default moment for a purchase: right now if the market is currently open,
 * otherwise today's close. Someone marking a buy mid-session means "just now";
 * someone doing it in the evening means "at today's close" — not 9pm, when no
 * trade could have happened.
 */
function defaultWhen(venue = 'IN') {
  const now = new Date()
  const o = OPEN[venue], c = CLOSE[venue]
  const mins = now.getHours() * 60 + now.getMinutes()
  const inSession = mins >= o.h * 60 + o.m && mins <= c.h * 60 + c.m
  if (inSession) return toLocalInput(now)
  const close = new Date(now)
  close.setHours(c.h, c.m, 0, 0)
  // Before the open, "today's close" hasn't happened — use the previous day's.
  if (mins < o.h * 60 + o.m) close.setDate(close.getDate() - 1)
  return toLocalInput(close)
}

/**
 * The traded price at a chosen moment, from the price history already loaded for
 * this ticker.
 *
 * Back-dating a purchase and leaving today's CMP in the price field would record
 * a cost basis that never existed, and every "since you bought" comparison would
 * inherit that error. Daily history is the finest resolution available, so an
 * intraday time still resolves to that day's close — stated plainly rather than
 * implied, since the user may have paid something different intraday and can
 * simply type over it.
 */
export function priceAt(priceHistory, whenMs, cmp, venue = 'IN') {
  const rows = (priceHistory || [])
    .filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date + 'T00:00:00'), close: p.close }))
    .filter(p => isFinite(p.t))
    .sort((a, b) => a.t - b.t)
  if (!rows.length || !isFinite(whenMs)) return { price: cmp ?? null, source: 'cmp' }

  const when = new Date(whenMs)
  const c = CLOSE[venue]
  const isToday = new Date().toDateString() === when.toDateString()
  const beforeClose = when.getHours() * 60 + when.getMinutes() < c.h * 60 + c.m

  // Today, mid-session → the live price is the best available reading.
  if (isToday && beforeClose && cmp != null) return { price: cmp, source: 'cmp' }

  const dayEnd = new Date(when); dayEnd.setHours(23, 59, 59, 999)
  const match = [...rows].reverse().find(r => r.t <= dayEnd.getTime())
  if (!match) return { price: cmp ?? null, source: 'cmp' }

  const onSameDay = new Date(match.t).toDateString() === when.toDateString()
  return {
    price: match.close,
    source: onSameDay ? 'close' : 'prev-close',
    asOf: new Date(match.t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }),
  }
}

/**
 * PositionModal — record a buy or a sale.
 *
 * Three modes, one component, because the fields are the same either way:
 *   'buy'  — one lot for the ticker currently loaded
 *   'sell' — close an existing lot
 *   'bulk' — several holdings at once, for setting up with a portfolio you own
 *
 * Back-dating is fully supported and normal — most people add holdings they
 * bought months ago. The price auto-fills from that day's close where history is
 * available, and the only thing flagged is that the health-bar comparison starts
 * from today rather than from the purchase date, because the app genuinely
 * didn't observe anything back then.
 */
export default function PositionModal({ open, mode = 'buy', position = null, lots = null, onClose, onSaved }) {
  const { state } = useApp()
  const venue = venueOf(state.ticker)
  const [rows, setRows] = useState(() => [blankRow(state, venue)])
  const [sell, setSell] = useState(() => ({
    price: '', when: defaultWhen(venue), shares: '', reason: '', note: '',
  }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  if (!open) return null

  const symbol = cur(state.data?.currency)
  const isBulk = mode === 'bulk'
  const isSell = mode === 'sell'
  const cmp = state.ratioResult?.price ?? null
  const history = state.data?.priceHistory || []

  // Changing the moment re-prices the row, unless the user has typed their own
  // figure — an edited price is a deliberate act and shouldn't be overwritten.
  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => {
    if (j !== i) return r
    const next = { ...r, ...patch }
    if (patch.when !== undefined && !r.priceEdited && isCurrentTicker(next.ticker, state.ticker)) {
      const looked = priceAt(history, Date.parse(patch.when), cmp, venue)
      if (looked.price != null) {
        next.price = String(Math.round(looked.price * 100) / 100)
        next.priceSource = looked
      }
    }
    return next
  }))

  const addRow = () => setRows(rs => [...rs, blankRow(null, venue)])
  const delRow = i => setRows(rs => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))

  const submitBuy = async () => {
    setErr(''); setBusy(true)
    try {
      const valid = rows.filter(r => r.ticker.trim() && +r.shares > 0 && +r.price > 0)
      if (valid.length === 0) { setErr('Enter a ticker, share count and price.'); setBusy(false); return }
      for (const r of valid) {
        const isCurrent = isCurrentTicker(r.ticker, state.ticker)
        await recordBuy({
          ticker: r.ticker.trim().toUpperCase(),
          name: isCurrent ? state.data?.name : null,
          shares: r.shares, buyPrice: r.price,
          buyDate: Date.parse(r.when) || Date.now(),
          note: r.note,
          // A snapshot needs a ratioResult in memory, which only exists for the
          // loaded ticker. Other rows get theirs when that stock is next opened.
          state: isCurrent ? state : null,
        })
      }
      onSaved?.(); onClose()
    } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
  }

  const sellLots = lots && lots.length ? lots : (position ? [position] : [])
  const fifo = isSell ? previewFifo(sellLots, sell.shares ? +sell.shares : null) : null

  const submitSell = async () => {
    setErr(''); setBusy(true)
    try {
      if (!(+sell.price > 0)) { setErr('Enter the price you sold at.'); setBusy(false); return }
      await recordSell(sellLots[0]?.ticker, {
        sellPrice: sell.price,
        sellDate: Date.parse(sell.when) || Date.now(),
        shares: sell.shares ? +sell.shares : undefined,
        exitReason: sell.reason || null,
        exitNote: sell.note || null,
      })
      onSaved?.(); onClose()
    } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
  }

  // Realised P/L across whatever FIFO actually consumes — not an average, since
  // lots bought at different prices realise different gains.
  const realised = (fifo && +sell.price > 0)
    ? fifo.take.reduce((s, t) => s + t.shares * (+sell.price - (Number(t.lot.buyPrice) || 0)), 0)
    : null
  const costOfSold = fifo ? fifo.take.reduce((s, t) => s + t.shares * (Number(t.lot.buyPrice) || 0), 0) : 0

  return (
    // Layout note: the sheet is a flex COLUMN capped at 90dvh with only the body
    // scrolling. Capping the body at 70vh instead let header + body + footer add
    // up past the viewport, which pushed the title off the top of the screen on a
    // phone. dvh rather than vh so the mobile URL bar collapsing doesn't crop it.
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center
                    p-0 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full sm:max-w-lg bg-navy-900 border border-navy-700
                      rounded-t-2xl sm:rounded-2xl shadow-2xl
                      flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700 shrink-0">
          <h2 className="font-semibold text-white">
            {isSell ? '📤 Record a sale' : isBulk ? '📥 Add holdings you own' : '📥 Record a purchase'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {isSell ? (
            <>
              <p className="text-xs text-slate-400">
                {sellLots[0]?.ticker} · {fifo?.held} share{fifo?.held === 1 ? '' : 's'} held
                across {sellLots.length} lot{sellLots.length === 1 ? '' : 's'}
              </p>
              <Field label="When did you sell?">
                <input type="datetime-local" value={sell.when}
                  onChange={e => {
                    const when = e.target.value
                    const looked = priceAt(history, Date.parse(when), cmp, venue)
                    setSell(s => ({ ...s, when, price: looked.price != null && !s.priceEdited
                      ? String(Math.round(looked.price * 100) / 100) : s.price }))
                  }}
                  className="input-field text-sm w-full" />
              </Field>
              <Field label={`Sold at (${symbol})`}>
                <input type="number" inputMode="decimal" value={sell.price}
                  onChange={e => setSell(s => ({ ...s, price: e.target.value, priceEdited: true }))}
                  className="input-field text-sm w-full" placeholder="e.g. 7400" />
              </Field>
              <Field label={`Shares sold (blank = all ${fifo?.held})`}>
                <input type="number" inputMode="numeric" value={sell.shares}
                  onChange={e => setSell(s => ({ ...s, shares: e.target.value }))}
                  className="input-field text-sm w-full" placeholder={String(fifo?.held ?? '')} />
              </Field>

              {/* FIFO breakdown. Shown whenever a sale spans more than one lot,
                  because the realised gain then isn't obvious from an average —
                  older shares usually carry a lower cost and a bigger gain. */}
              {fifo && fifo.take.length > 1 && (
                <div className="text-[11px] bg-navy-800/50 rounded-lg px-3 py-2 space-y-0.5">
                  <div className="text-slate-400">Oldest shares sell first:</div>
                  {fifo.take.map((t, i) => (
                    <div key={i} className="text-slate-500">
                      {t.shares} of {t.lot.shares} bought {dateShort(t.lot.buyDate)} at {symbol}{t.lot.buyPrice}
                      {!t.whole && <span className="text-slate-600"> — rest stays open</span>}
                    </div>
                  ))}
                </div>
              )}

              {realised != null && (
                <div className={`text-sm rounded-lg px-3 py-2 ${realised >= 0 ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                  Realised {realised >= 0 ? 'gain' : 'loss'} {symbol}
                  {Math.abs(Math.round(realised)).toLocaleString('en-IN')}
                  {costOfSold > 0 && <> ({realised >= 0 ? '+' : ''}{((realised / costOfSold) * 100).toFixed(1)}%)</>}
                </div>
              )}

              {/* Exit reason. Tagged at the point of sale because it can't be
                  reconstructed later — six months on, nobody remembers whether
                  they sold on a policy worry or just wanted the cash. The fixed
                  list is what makes the pattern countable ("4 of your 6 policy
                  exits kept rising"); free text alone can't be grouped. */}
              <div>
                <span className="text-xs text-slate-400 block mb-1.5">Why are you selling?</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {EXIT_REASONS.map(r => (
                    <button key={r.id} type="button"
                      onClick={() => setSell(s => ({ ...s, reason: s.reason === r.id ? '' : r.id }))}
                      className={`text-[11px] py-1.5 px-2 rounded-lg border text-left transition-colors ${
                        sell.reason === r.id
                          ? 'border-accent bg-navy-800 text-white'
                          : 'border-navy-700 text-slate-400 hover:border-navy-600'}`}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <input value={sell.note} onChange={e => setSell(s => ({ ...s, note: e.target.value }))}
                  placeholder="Anything worth remembering about this exit"
                  className="input-field text-xs w-full mt-2" />
              </div>

              <p className="text-[11px] text-slate-600">
                Sold lots stay in your history — a closed position is what tells you whether the
                call was right.
              </p>
            </>
          ) : (
            <>
              {rows.map((r, i) => (
                <div key={i} className="space-y-2 pb-3 border-b border-navy-800 last:border-0">
                  <div className="flex gap-2">
                    <input value={r.ticker} onChange={e => setRow(i, { ticker: e.target.value.toUpperCase() })}
                      placeholder="TICKER" className="input-field text-sm uppercase flex-1"
                      disabled={!isBulk && !!state.ticker} />
                    {isBulk && rows.length > 1 && (
                      <button onClick={() => delRow(i)} className="text-slate-600 hover:text-bear px-1">✕</button>
                    )}
                  </div>

                  <Field label="When did you buy?">
                    <input type="datetime-local" value={r.when}
                      onChange={e => setRow(i, { when: e.target.value })}
                      className="input-field text-sm w-full" />
                  </Field>

                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Shares">
                      <input type="number" inputMode="numeric" value={r.shares}
                        onChange={e => setRow(i, { shares: e.target.value })}
                        placeholder="Qty" className="input-field text-sm w-full" />
                    </Field>
                    <Field label={`Price ${symbol}`}>
                      <input type="number" inputMode="decimal" value={r.price}
                        onChange={e => setRow(i, { price: e.target.value, priceEdited: true })}
                        placeholder="Price" className="input-field text-sm w-full" />
                    </Field>
                  </div>

                  {r.priceSource && !r.priceEdited && (
                    <p className="text-[10px] text-slate-500">
                      {r.priceSource.source === 'cmp'
                        ? 'Filled from the current price.'
                        : r.priceSource.source === 'close'
                        ? `Filled from that day's close. Edit if you paid a different intraday price.`
                        : `No trading on that date — used the close from ${r.priceSource.asOf}.`}
                    </p>
                  )}

                  <input value={r.note} onChange={e => setRow(i, { note: e.target.value })}
                    placeholder="Why did you buy? (your trigger — useful later)"
                    className="input-field text-xs w-full" />

                  {isBackdated(r.when) && (
                    <p className="text-[10px] text-slate-500">
                      Back-dated purchase — recorded normally. The health bars will measure from
                      today, since the app has no reading of what it looked like back then.
                    </p>
                  )}
                </div>
              ))}
              {isBulk && (
                <button onClick={addRow} className="text-xs text-accent hover:text-accent-light">
                  + Add another holding
                </button>
              )}
            </>
          )}

          {err && <p className="text-xs text-bear">{err}</p>}
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-navy-700 shrink-0
                        pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button onClick={onClose} className="flex-1 text-sm text-slate-400 hover:text-white py-2">Cancel</button>
          <button onClick={isSell ? submitSell : submitBuy} disabled={busy}
            className="flex-1 btn-primary text-sm py-2">
            {busy ? 'Saving…' : isSell ? 'Record sale' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const dateShort = t => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '')

function isCurrentTicker(a, b) {
  return !!a && !!b && a.trim().toUpperCase() === b.toUpperCase()
}

function blankRow(state, venue) {
  return {
    ticker: state?.ticker || '',
    shares: '',
    // Pre-filled from CMP: the common case is marking a buy right after making
    // it. Changing the date re-prices this from history unless it's been edited.
    price: state?.ratioResult?.price != null
      ? String(Math.round(state.ratioResult.price * 100) / 100) : '',
    priceEdited: false,
    priceSource: state?.ratioResult?.price != null ? { source: 'cmp' } : null,
    when: defaultWhen(venue),
    note: '',
  }
}

function isBackdated(when) {
  const t = Date.parse(when)
  return isFinite(t) && (Date.now() - t) > 7 * 86400000
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400 block mb-1">{label}</span>
      {children}
    </label>
  )
}
