/**
 * src/api/newsClient.js — browser-side client for the standalone news layer.
 *
 * One request, no caching. Mirrors the { items, error } contract of /api/news so
 * the modal can distinguish "no news" from "sources unreachable". A non-200 or a
 * thrown fetch is surfaced as a transient 'fetch_failed' (client shows retry).
 *
 * `company` (resolved name) sharpens relevance matching so a generic market
 * report tagged to the ticker gets demoted rather than shown as company news.
 */
export async function fetchNews(query, ticker, company, signal) {
  const params = new URLSearchParams()
  if (query) params.set('query', query)
  if (ticker) params.set('ticker', ticker)
  if (company) params.set('company', company)

  const r = await fetch(`/api/news?${params}`, { signal })
  if (!r.ok) return { items: [], error: 'fetch_failed' }
  return r.json()   // { items: [{ title, source, url, date, tier }], error }
}
