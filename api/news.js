/**
 * api/news.js — Vercel serverless (CommonJS)
 *
 * Standalone company-news endpoint. Pulls headlines from two independent,
 * key-free sources IN PARALLEL and returns a merged, de-duplicated list.
 * Does NOT call Gemini and does NOT cache — freshness is the point; the client
 * fetches on panel-open and on a short interval.
 *
 *   GET /api/news?query=<user search text>&ticker=<resolved ticker>&company=<name>
 *
 * Response (HTTP 200 unless the query is missing):
 *   { items: [{ title, source, url, date, tier }], error: null }   // items may be []
 *   { items: [], error: 'fetch_failed' }                           // BOTH sources threw
 *
 * FILTERING PHILOSOPHY — demote, never delete.
 * Market-research pieces are kept (a sector report can be useful context). The
 * only thing we push down is a generic market report that doesn't even mention
 * the company — that's the "Naphtha Market to hit USD Xbn, tagged: Reliance"
 * case. Such items get tier:'sector' and the client tucks them into a collapsed
 * "Broader market & sector reports" group. Everything else is tier:'primary'.
 * Nothing is removed except exact cross-wire duplicates (dedup).
 *
 * `date` is epoch-millis (0 when unknown) so the client can sort/format freely.
 */

const YahooFinance = require('yahoo-finance2').default

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
})

const MAX_ITEMS = 100         // Google's own ceiling; small-caps keep everything
const YAHOO_COUNT = 12        // Yahoo search-news is a short, relevance-ranked head
const RSS_TIMEOUT_MS = 8000

// ── helpers ──────────────────────────────────────────────────────────────────

function normTitle(t) {
  return String(t || '')
    .replace(/\s+[-–—|]\s+[^-–—|]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

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

// Corporate-suffix / generic words that shouldn't anchor a company match.
const STOP = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation', 'plc', 'co',
  'company', 'group', 'holdings', 'holding', 'enterprises', 'enterprise',
  'industries', 'industrial', 'international', 'the', 'and', 'of',
])

// The brand anchor = first significant word of the company name (usually the
// brand in Indian names: "Reliance Industries" → reliance, "Bajaj Finance" →
// bajaj). Also keep the ticker base if it's alphabetic (skip numeric BSE codes).
function relevanceTokens(company, ticker) {
  const tokens = []
  const words = String(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w))
  if (words[0]) tokens.push(words[0])
  const base = String(ticker || '').replace(/\.(NS|BO)$/i, '').toLowerCase()
  if (base && /[a-z]/.test(base) && base.length >= 3) tokens.push(base)
  return [...new Set(tokens)]
}

function titleMentionsCompany(title, tokens) {
  const t = String(title || '').toLowerCase()
  return tokens.some(tok => t.includes(tok))
}

// Does the headline read like a generic market-research report?
const MARKET_PATTERNS = [
  /\bmarket\s+(size|share|report|forecast|outlook|analysis|research|trends?|growth|revenue|value|volume)\b/i,
  /\b(size|share)\s+(&|and)\s+(share|size|growth|trends?|forecast)\b/i,
  /\bCAGR\b/i,
  /\bforecast\s+(period|to\s+20\d\d)\b/i,
  /\bmarket\s+to\s+(reach|grow|hit|skyrocket|surge|witness|expand)\b/i,
  /\bUSD\s*[\d.,]+\s*(billion|million|trillion)\b/i,
  /\[\s*(latest|20\d\d)\s+report\s*\]/i,
]
function isMarketReport(title) {
  return MARKET_PATTERNS.some(re => re.test(String(title || '')))
}

// tier:'sector' ONLY when it's a generic market report AND the company isn't in
// the headline. Everything else (incl. company-mentioning market reports, and
// company news that happens not to use the exact token) stays 'primary'.
function classify(title, tokens) {
  if (isMarketReport(title) && !titleMentionsCompany(title, tokens)) return 'sector'
  return 'primary'
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
      title: String(n.title || '').trim(),
      source: n.publisher || 'Yahoo Finance',
      url: n.link,
      date: toMillis(n.providerPublishTime),
    }))
    .filter(x => x.title && x.url)
}

// ── source 2: Google News RSS (key-free, no date filter — all data through) ───
async function fromGoogle(query, indian) {
  const locale = indian
    ? { hl: 'en-IN', gl: 'IN', ceid: 'IN:en' }
    : { hl: 'en-US', gl: 'US', ceid: 'US:en' }

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
    return parseRss(await res.text())
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
    items.push({ title: stripPublisherSuffix(title), source, url: link, date: toMillis(pub) })
  }
  return items
}

function pick(chunk, tag) {
  const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  if (!m) return ''
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
}

// ── handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  res.setHeader('Cache-Control', 'no-store')

  const query = (req.query.query || req.query.ticker || '').toString().trim()
  const ticker = (req.query.ticker || '').toString().trim()
  const company = (req.query.company || '').toString().trim()
  if (!query) return res.status(400).json({ items: [], error: 'missing_query' })

  const indian = /\.(NS|BO)$/i.test(ticker)
  const tokens = relevanceTokens(company || query, ticker)

  const [y, g] = await Promise.allSettled([
    fromYahoo(query),
    fromGoogle(query, indian),
  ])

  // Only a genuine outage (BOTH sources threw) is a fetch failure.
  if (y.status === 'rejected' && g.status === 'rejected') {
    console.warn('[news] both sources failed:', y.reason?.message, g.reason?.message)
    return res.status(200).json({ items: [], error: 'fetch_failed' })
  }

  const yahoo = y.status === 'fulfilled' ? y.value : []
  const google = g.status === 'fulfilled' ? g.value : []

  // Merge Yahoo-first (clean source + direct links win on dupes), de-dup on
  // normalized title, tag each with a relevance tier.
  const seen = new Set()
  const merged = []
  for (const item of [...yahoo, ...google]) {
    const k = normTitle(item.title)
    if (!k || seen.has(k)) continue
    seen.add(k)
    merged.push({ ...item, tier: classify(item.title, tokens) })
  }

  // Sort: primary tier first, sector last; newest-first within each tier.
  const rank = t => (t === 'sector' ? 1 : 0)
  merged.sort((a, b) => rank(a.tier) - rank(b.tier) || b.date - a.date)

  return res.status(200).json({ items: merged.slice(0, MAX_ITEMS), error: null })
}
