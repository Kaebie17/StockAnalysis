/**
 * src/api/news.js — browser-side client for the standalone news layer.
 *
 * One request, no caching. Mirrors the { items, error } contract of /api/news so
 * the modal can distinguish "no news" from "sources unreachable". A non-200 or a
 * thrown fetch is surfaced as a transient 'fetch_failed' (client shows retry).
 */
export async function fetchNews(query, ticker, signal) {
  const params = new URLSearchParams()
  if (query) params.set('query', query)
  if (ticker) params.set('ticker', ticker)

  const r = await fetch(`/api/news?${params}`, { signal })
  if (!r.ok) return { items: [], error: 'fetch_failed' }
  return r.json()   // { items: [{ title, source, url, date }], error }
}
