/**
 * api/news.js — Vercel serverless (CommonJS)
 *
 * Standalone company-news endpoint. Pulls headlines from two independent,
 * key-free sources IN PARALLEL and returns a merged, de-duplicated, date-sorted
 * list. It deliberately does NOT call Gemini and does NOT cache — freshness is
 * the whole point; the client fetches on panel-open and on a short interval.
 *
 *   GET /api/news?query=<user search text>&ticker=<resolved ticker>
 *
 * Response (always HTTP 200 unless the query is missing):
 *   { items: [{ title, source, url, date }], error: null }      // success (items may be [])
 *   { items: [], error: 'fetch_failed' }                        // BOTH sources threw
 *
 * The zero-results-vs-both-failed distinction is what drives the client UI:
 *   items:[] + error:null            → "no news from our sources" → close modal
 *   items:[] + error:'fetch_failed'  → "couldn't reach sources"   → stay open, retry
 *
 * `date` is epoch-millis (0 when unknown) so the client can sort/format freely.
 */

const YahooFinance = require('yahoo-finance2').default

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
})

const MAX_ITEMS = 60          // plenty for infinite scroll; keeps payload small
const YAHOO_COUNT = 12        // Yahoo returns a short, fresh list
const RSS_TIMEOUT_MS = 8000

// ── helpers ──────────────────────────────────────────────────────────────────

// Normalize a headline for fuzzy de-dup across sources: drop a trailing
// " - Publisher", lowercase, strip non-alphanumerics, collapse whitespace.
function normTitle(t) {
  return String(t || '')
    .replace(/\s+[-–—|]\s+[^-–—|]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Google RSS titles are "Headline - Publisher"; strip the suffix for display.
function stripPublisherSuffix(t) {
  return String(t || '').replace(/\s+[-–—|]\s+[^-–—|]+$/, '').trim()
}

function toMillis(d) {
  if (d == null) return 0
  if (d instanceof Date) return d.getTime()
  if (typeof d === 'number') return d < 1e12 ? d * 1000 : d   // seconds vs ms
  const p = Date.parse(d)
  return isNaN(p) ? 0 : p
}

// ── source 1: Yahoo (via yahoo-finance2 — already a project dependency) ───────
async function fromYahoo(query) {
  const r = await yf.search(query, {
    quotesCount: 0,
    newsCount: YAHOO_COUNT,
    enableFuzzyQuery: false,
  })
  const news = Array.isArray(r?.news) ? r.news : []
  return news
    .map(n => ({
      title:  String(n.title || '').trim(),   // Yahoo keeps publisher separate
      source: n.publisher || 'Yahoo Finance',
      url:    n.link,
      date:   toMillis(n.providerPublishTime),
    }))
    .filter(x => x.title && x.url)
}

// ── source 2: Google News RSS (key-free) ──────────────────────────────────────
async function fromGoogle(query, indian) {
  const locale = indian
    ? { hl: 'en-IN', gl: 'IN', ceid: 'IN:en' }
    : { hl: 'en-US', gl: 'US', ceid: 'US:en' }

  // Yahoo handles the raw symbol natively; the .NS/.BO suffix is just noise in a
  // news search, so strip it for Google.
  const q = String(query).replace(/\.(NS|BO)$/i, '').trim()
  const url =
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}` +
    `&hl=${locale.hl}&gl=${locale.gl}&ceid=${locale.ceid}`

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), RSS_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockAnalyzr/1.0)' },
    })
    if (!res.ok) throw new Error(`google rss ${res.status}`)
    const xml = await res.text()
    return parseRss(xml)
  } finally {
    clearTimeout(t)
  }
}

function parseRss(xml) {
  const items = []
  const blocks = String(xml).split(/<item>/i).slice(1)
  for (const b of blocks) {
    const chunk = b.split(/<\/item>/i)[0]
    const title = decodeXml(pick(chunk, 'title'))
    const link = decodeXml(pick(chunk, 'link'))
    const pub = pick(chunk, 'pubDate')
    const source = decodeXml(pick(chunk, 'source')) || 'Google News'
    if (!title || !link) continue
    items.push({
      title: stripPublisherSuffix(title),
      source,
      url: link,
      date: toMillis(pub),
    })
  }
  return items
}

// Pull one tag's inner text; tolerant of attributes and CDATA.
function pick(chunk, tag) {
  const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  if (!m) return ''
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

// ── handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // No caching anywhere — the client wants the freshest headlines each fetch.
  res.setHeader('Cache-Control', 'no-store')

  const query = (req.query.query || req.query.ticker || '').toString().trim()
  const ticker = (req.query.ticker || '').toString().trim()
  if (!query) return res.status(400).json({ items: [], error: 'missing_query' })

  const indian = /\.(NS|BO)$/i.test(ticker)

  const [y, g] = await Promise.allSettled([
    fromYahoo(query),
    fromGoogle(query, indian),
  ])

  // Only a genuine outage (BOTH sources threw) is a fetch failure. If even one
  // source answered, we trust its result — including an honest empty list.
  if (y.status === 'rejected' && g.status === 'rejected') {
    console.warn('[news] both sources failed:', y.reason?.message, g.reason?.message)
    return res.status(200).json({ items: [], error: 'fetch_failed' })
  }

  const yahoo = y.status === 'fulfilled' ? y.value : []
  const google = g.status === 'fulfilled' ? g.value : []

  // Merge Yahoo-first (direct publisher links + clean source beat Google's
  // redirect links on duplicates), then Google. De-dup on normalized title.
  const seen = new Set()
  const merged = []
  for (const item of [...yahoo, ...google]) {
    const k = normTitle(item.title)
    if (!k || seen.has(k)) continue
    seen.add(k)
    merged.push(item)
  }

  merged.sort((a, b) => b.date - a.date)

  return res.status(200).json({ items: merged.slice(0, MAX_ITEMS), error: null })
}
