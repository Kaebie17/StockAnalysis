
/**
 * api/news.js — Vercel serverless (CommonJS)
 *
 * Standalone company-news endpoint. Pulls headlines from two independent,
 * key-free sources IN PARALLEL and returns a merged, de-duplicated list.
 * Does NOT call Gemini. Results are cached briefly (see "caching" below) — short
 * enough that nothing the client would have seen is withheld, long enough that
 * polling many held positions doesn't hammer the upstream sources.
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

// ── caching ──────────────────────────────────────────────────────────────────
// The original design cached nothing on purpose ("freshness is the point"), and
// that was right when one open panel polled one ticker. It stops being right the
// moment the app polls every position a user holds on the same 3-minute timer:
// 15 positions × 2 upstream sources × every 3 min is ~600 outbound requests an
// hour from a SHARED serverless IP, multiplied by every user. Google News RSS
// throttles an IP that looks like that, and when it does, news breaks for
// everyone — not just the person who triggered it.
//
// A ~2.5-minute TTL is shorter than the client's own poll interval, so nothing
// the user would have seen gets withheld; it only collapses the duplicate
// requests that the poll loop generates for the same ticker.
//
// Two layers, because they cover different cases:
//   1. CDN (s-maxage) — shared across ALL users and all instances. Does the real
//      work: the second user asking about RELIANCE never reaches this function.
//   2. In-memory Map — per warm instance, covers requests the CDN passes through
//      (cache miss, revalidation) before they become upstream calls.
const CACHE_TTL_MS  = 150 * 1000    // 2.5 min
const CACHE_SWR_MS  = 300 * 1000    // serve stale up to 5 min while revalidating
const CACHE_MAX_KEYS = 300          // bounded: a warm instance must not grow forever

const memCache = new Map()          // key -> { at, payload }

function cacheGet(key) {
  const hit = memCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { memCache.delete(key); return null }
  // Refresh recency for the LRU eviction below.
  memCache.delete(key); memCache.set(key, hit)
  return hit.payload
}

function cacheSet(key, payload) {
  memCache.set(key, { at: Date.now(), payload })
  // Map preserves insertion order, so the first key is the least recently used.
  while (memCache.size > CACHE_MAX_KEYS) {
    memCache.delete(memCache.keys().next().value)
  }
}

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
  const words = String(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w))

  // The FULL name, and the first two words as a phrase — not the first word
  // alone. Indian company names are overwhelmingly family names ("Bajaj",
  // "Birla", "Tata", "Godrej", "Adani"), so a single-word match pulls in
  // obituaries, weddings, politics and every unrelated group company. Requiring
  // two adjacent words is what separates "Bajaj Finance posts results" from
  // "Rahul Bajaj passes away".
  const phrases = []
  if (words.length >= 2) phrases.push(`${words[0]} ${words[1]}`)
  if (words.length >= 1) phrases.push(words.join(' '))

  const base = String(ticker || '').replace(/\.(NS|BO)$/i, '').toLowerCase()
  const tickerToken = (base && /[a-z]/.test(base) && base.length >= 4) ? base : null

  return { phrases: [...new Set(phrases)], single: words[0] || null, ticker: tickerToken }
}

// Names that are people first and companies second. A headline carrying one of
// these plus a person-shaped verb is about a person, whatever else it contains.
const PERSON_CONTEXT = /\b(passes away|passed away|dies|died|death|obituary|funeral|condolence|born|birthday|wedding|marries|married|daughter|son of|widow|memoir|biography|arrested|bail|summoned|acquitted)\b/i

function titleMentionsCompany(title, tokens) {
  const t = String(title || '').toLowerCase()
  // A two-word phrase or the ticker is a real match.
  if (tokens.phrases?.some(p => t.includes(p))) return true
  if (tokens.ticker && t.includes(tokens.ticker)) return true
  return false
}

/**
 * Is this about a PERSON who shares the company's name? Checked before anything
 * else, because no amount of relevance scoring downstream can rescue an
 * obituary that was let in at the top.
 */
function looksPersonal(title, tokens) {
  const t = String(title || '')
  if (!PERSON_CONTEXT.test(t)) return false
  // Only when the sole connection is the family name, not the full company name.
  const lower = t.toLowerCase()
  const hasPhrase = tokens.phrases?.some(p => lower.includes(p))
  const hasTicker = tokens.ticker && lower.includes(tokens.ticker)
  return !hasPhrase && !hasTicker
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
  // A person sharing the company's family name is not company news. Dropped
  // rather than demoted: an obituary in a stock feed is noise however it's
  // labelled, and letting it through cost the whole feed credibility.
  if (looksPersonal(title, tokens)) return 'excluded'
  if (isMarketReport(title) && !titleMentionsCompany(title, tokens)) return 'sector'
  // Nothing tying it to this company at all — a name collision or a stray match.
  if (!titleMentionsCompany(title, tokens) && !isMarketReport(title)) return 'unrelated'
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

  const query = (req.query.query || req.query.ticker || '').toString().trim()
  const ticker = (req.query.ticker || '').toString().trim()
  const company = (req.query.company || '').toString().trim()
  if (!query) {
    res.setHeader('Cache-Control', 'no-store')      // never cache a bad request
    return res.status(400).json({ items: [], error: 'missing_query' })
  }

  // Everything that changes the RESULT belongs in the key: `company` feeds the
  // relevance tokens, so two callers passing different company names for the
  // same ticker must not share a cache entry.
  const cacheKey = [query, ticker, company].join('\u0000').toLowerCase()

  // Let the CDN absorb the repeat traffic from the poll loop across all users.
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${Math.floor(CACHE_TTL_MS / 1000)}, ` +
    `stale-while-revalidate=${Math.floor(CACHE_SWR_MS / 1000)}`
  )

  const cached = cacheGet(cacheKey)
  if (cached) {
    res.setHeader('X-Cache', 'HIT')
    return res.status(200).json(cached)
  }
  res.setHeader('X-Cache', 'MISS')

  const indian = /\.(NS|BO)$/i.test(ticker)
  const tokens = relevanceTokens(company || query, ticker)

  const [y, g] = await Promise.allSettled([
    fromYahoo(query),
    fromGoogle(query, indian),
  ])

  // Only a genuine outage (BOTH sources threw) is a fetch failure.
  if (y.status === 'rejected' && g.status === 'rejected') {
    console.warn('[news] both sources failed:', y.reason?.message, g.reason?.message)
    // A transient failure must not be cached — the client shows a retry, and
    // that retry has to be able to actually reach the sources again.
    res.setHeader('Cache-Control', 'no-store')
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
    const tier = classify(item.title, tokens)
    if (tier === 'excluded' || tier === 'unrelated') continue   // never surfaced
    merged.push({ ...item, tier })
  }

  // Sort: primary tier first, sector last; newest-first within each tier.
  const rank = t => (t === 'sector' ? 1 : 0)
  merged.sort((a, b) => rank(a.tier) - rank(b.tier) || b.date - a.date)

  const payload = { items: merged.slice(0, MAX_ITEMS), error: null }

  // Only cache a result that actually has something in it. An empty list is
  // usually one source degrading rather than genuine silence, and pinning that
  // for the TTL would hide news that's already there.
  if (payload.items.length > 0) cacheSet(cacheKey, payload)
  else res.setHeader('Cache-Control', 'no-store')

  return res.status(200).json(payload)
}
