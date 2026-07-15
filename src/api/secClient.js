/**
 * src/api/secClient.js — SEC EDGAR financial history (US tickers).
 * Fills Screener's slot for US stocks. Never throws in a way that breaks the
 * app: a failure returns null and the caller falls back to Yahoo-only.
 */
export async function fetchSec(ticker) {
  const t = String(ticker || '').trim().toUpperCase()
  if (!t || /\.(NS|BO)$/i.test(t)) return null      // Indian → Screener path
  const r = await fetch(`/api/sec?ticker=${encodeURIComponent(t)}`)
  if (!r.ok) throw new Error(`sec ${r.status}`)
  const d = await r.json()
  if (!d || d.error) throw new Error(d?.error || 'sec unavailable')
  if (!d.incomeHistory?.length) throw new Error('sec: no history')
  return d
}

export const isUsTicker = t => !!t && !/\.(NS|BO)$/i.test(String(t).trim())
