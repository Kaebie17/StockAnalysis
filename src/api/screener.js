/**
 * src/api/screener.js
 * Calls the /api/screener Vercel serverless function which proxies Screener.in
 */

export async function fetchScreener(ticker, consolidated = true) {
  // Appending a dynamic timestamp cache-buster to completely bypass Vercel's s-maxage caching
  const params = new URLSearchParams({ 
    ticker, 
    consolidated: String(consolidated),
    _cb: String(Date.now()) 
  })
  
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