import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { recordBuy, recordSell, positionMath } from '../../store/usePositions.js'

const today = () => new Date().toISOString().slice(0, 10)
const cur = c => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[c]) || ''

/**
 * PositionModal — record a buy or a sale.
 *
 * Three modes, one component, because the fields are the same either way and
 * splitting them would mean three places to keep in step:
 *   'buy'  — one lot for the ticker currently loaded
 *   'sell' — close an existing lot
 *   'bulk' — several holdings at once, for someone setting the app up with a
 *            portfolio they already own
 *
 * The date defaults to today but is editable, because the common case for bulk
 * entry is stocks bought months ago. When the buy date is well in the past the
 * snapshot can't describe conditions at purchase, and the app says so rather
 * than pretending otherwise — see the warning below and `isLate` in the snapshot.
 */
export default function PositionModal({ open, mode = 'buy', position = null, onClose, onSaved }) {
  const { state } = useApp()
  const [rows, setRows] = useState(() => [blankRow(state)])
  const [sell, setSell] = useState({ price: '', date: today(), shares: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  if (!open) return null

  const symbol = cur(state.data?.currency)
  const isBulk = mode === 'bulk'
  const isSell = mode === 'sell'

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, blankRow(null)])
  const delRow = i => setRows(rs => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))

  const submitBuy = async () => {
    setErr(''); setBusy(true)
    try {
      const valid = rows.filter(r => r.ticker.trim() && +r.shares > 0 && +r.price > 0)
      if (valid.length === 0) { setErr('Enter a ticker, share count and price.'); setBusy(false); return }
      for (const r of valid) {
        const isCurrent = r.ticker.trim().toUpperCase() === (state.ticker || '').toUpperCase()
        await recordBuy({
          ticker: r.ticker.trim().toUpperCase(),
          name: isCurrent ? state.data?.name : null,
          shares: r.shares, buyPrice: r.price,
          buyDate: Date.parse(r.date) || Date.now(),
          note: r.note,
          // A snapshot is only meaningful for the ticker actually loaded — for
          // any other row there's no ratioResult in memory to freeze. Those get
          // a snapshot when the app next opens that ticker, flagged isLate.
          state: isCurrent ? state : null,
        })
      }
      onSaved?.(); onClose()
    } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
  }

  const submitSell = async () => {
    setErr(''); setBusy(true)
    try {
      if (!(+sell.price > 0)) { setErr('Enter the price you sold at.'); setBusy(false); return }
      await recordSell(position.id, {
        sellPrice: sell.price,
        sellDate: Date.parse(sell.date) || Date.now(),
        sharesSold: sell.shares ? +sell.shares : undefined,
      })
      onSaved?.(); onClose()
    } catch (e) { setErr(String(e?.message || e)) } finally { setBusy(false) }
  }

  const m = isSell && position ? positionMath(position, +sell.price || null) : null

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-navy-900 border border-navy-700 rounded-2xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700">
          <h2 className="font-semibold text-white">
            {isSell ? '📤 Record a sale' : isBulk ? '📥 Add holdings you own' : '📥 Record a purchase'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto space-y-4">
          {isSell ? (
            <>
              <p className="text-xs text-slate-400">
                {position?.ticker} · {position?.shares} shares bought at {symbol}{position?.buyPrice}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Sold at (${symbol})`}>
                  <input type="number" inputMode="decimal" value={sell.price}
                    onChange={e => setSell(s => ({ ...s, price: e.target.value }))}
                    className="input-field text-sm w-full" placeholder="e.g. 7400" />
                </Field>
                <Field label="Date">
                  <input type="date" value={sell.date}
                    onChange={e => setSell(s => ({ ...s, date: e.target.value }))}
                    className="input-field text-sm w-full" />
                </Field>
              </div>
              <Field label={`Shares sold (blank = all ${position?.shares})`}>
                <input type="number" inputMode="numeric" value={sell.shares}
                  onChange={e => setSell(s => ({ ...s, shares: e.target.value }))}
                  className="input-field text-sm w-full" placeholder={String(position?.shares ?? '')} />
              </Field>
              {m?.pnl != null && (
                <div className={`text-sm rounded-lg px-3 py-2 ${m.pnl >= 0 ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                  {m.pnl >= 0 ? 'Gain' : 'Loss'} {symbol}{Math.abs(Math.round(m.pnl)).toLocaleString('en-IN')}
                  {' '}({m.pnlPct >= 0 ? '+' : ''}{m.pnlPct.toFixed(1)}%)
                </div>
              )}
              <p className="text-[11px] text-slate-600">
                The lot stays in your history after selling — a closed position is what tells you
                whether the call was right.
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
                  <div className="grid grid-cols-3 gap-2">
                    <input type="number" inputMode="numeric" value={r.shares}
                      onChange={e => setRow(i, { shares: e.target.value })}
                      placeholder="Shares" className="input-field text-sm" />
                    <input type="number" inputMode="decimal" value={r.price}
                      onChange={e => setRow(i, { price: e.target.value })}
                      placeholder={`Price ${symbol}`} className="input-field text-sm" />
                    <input type="date" value={r.date}
                      onChange={e => setRow(i, { date: e.target.value })}
                      className="input-field text-sm" />
                  </div>
                  <input value={r.note} onChange={e => setRow(i, { note: e.target.value })}
                    placeholder="Why did you buy? (your trigger — useful later)"
                    className="input-field text-xs w-full" />
                  {isPast(r.date) && (
                    <p className="text-[10px] text-neutral">
                      ⚠ Bought over a week ago — the app will record today's numbers as the
                      starting point, not the ones from your actual purchase date.
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

        <div className="flex gap-2 px-5 py-4 border-t border-navy-700">
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

function blankRow(state) {
  return {
    ticker: state?.ticker || '',
    shares: '',
    // Pre-fill the price from CMP: the overwhelmingly common case is marking a
    // buy right after making it. Still editable for a back-dated entry.
    price: state?.ratioResult?.price != null ? String(Math.round(state.ratioResult.price * 100) / 100) : '',
    date: today(),
    note: '',
  }
}

function isPast(dateStr) {
  const t = Date.parse(dateStr)
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
