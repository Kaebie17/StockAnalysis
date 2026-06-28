/**
 * src/api/screener.js
 * Calls the /api/screener Vercel serverless function which proxies Screener.in
 */

export async function fetchScreener(ticker, consolidated = true) {
  const params = new URLSearchParams({ ticker, consolidated: String(consolidated) })
  const res = await fetch(`/api/screener?${params}`)

  if (res.status === 404) {
    throw new Error(`"${ticker}" not found on Screener.in`)
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Screener proxy error ${res.status}`)
  }

  return res.json()
}
