/**
 * src/api/targetsClient.js — browser-side client for analyst price targets.
 * Comparison context only; never blended into fair value.
 */
export async function fetchTargets(ticker, signal) {
  if (!ticker) return { ok: false, error: 'missing_ticker' }
  const r = await fetch(`/api/targets?ticker=${encodeURIComponent(ticker)}`, { signal })
  if (!r.ok) return { ok: false, error: 'fetch_failed' }
  return r.json()   // { ok, targets: { mean, high, low, median, count, recKey, recMean, currency } | null }
}
