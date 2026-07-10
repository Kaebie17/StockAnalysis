/**
 * api/targets.js — Vercel serverless (CommonJS)
 *
 * Analyst price targets + recommendation. Yahoo's library `financialData` module
 * returns null targets for many Indian (.NS/.BO) tickers even though the numbers
 * appear on Yahoo's website, so this tries several sources in order and returns
 * the first that yields numbers:
 *   1. yahoo-finance2 quoteSummary(financialData)          (works for US names)
 *   2. raw quoteSummary JSON with a fresh crumb + browser UA (region=US)
 *   3. the JSON embedded in the Yahoo quote PAGE (markup-agnostic regex)
 * Indian suffixes (.NS/.BO) are tried when the bare symbol yields nothing.
 *
 *   GET /api/targets?ticker=RELIANCE.NS
 * Response: { ok:true, targets:{…}|null, via:'lib'|'crumb'|'page'|null }
 */

const YahooFinance = require('yahoo-finance2').default

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/json,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600')

  const raw = (req.query.ticker || '').toString().trim()
  if (!raw) return res.status(400).json({ ok: false, error: 'missing_ticker' })

  const base = raw.toUpperCase()
  const candidates = /\.(NS|BO)$/i.test(base) ? [base] : [base, `${base}.NS`, `${base}.BO`]

  for (const sym of candidates) {
    // 1) library
    try {
      const r = await YahooFinance.quoteSummary(sym, { modules: ['financialData', 'price'] })
      const t = fromFinancialData(r?.financialData, r?.price?.currency)
      if (t) return res.status(200).json({ ok: true, targets: t, via: 'lib' })
    } catch { /* next */ }

    // 2) raw quoteSummary JSON with crumb
    try {
      const t = await viaCrumb(sym)
      if (t) return res.status(200).json({ ok: true, targets: t, via: 'crumb' })
    } catch { /* next */ }

    // 3) page-embedded JSON
    try {
      const t = await viaPage(sym)
      if (t) return res.status(200).json({ ok: true, targets: t, via: 'page' })
    } catch { /* next */ }
  }

  return res.status(200).json({ ok: true, targets: null, via: null })
}

// ── shapers ───────────────────────────────────────────────────────────────────
function fromFinancialData(fd, currency) {
  if (!fd) return null
  const mean = num(fd.targetMeanPrice), high = num(fd.targetHighPrice),
        low = num(fd.targetLowPrice), median = num(fd.targetMedianPrice)
  if (mean == null && high == null && low == null && median == null) return null
  return { mean, high, low, median, count: num(fd.numberOfAnalystOpinions),
           recKey: fd.recommendationKey || null, recMean: num(fd.recommendationMean),
           currency: currency || fd.financialCurrency || null }
}

// ── strategy 2: manual crumb + query1 quoteSummary ─────────────────────────────
async function viaCrumb(sym) {
  const { cookie, crumb } = await crumbCookie()
  if (!crumb) return null
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}` +
    `?modules=financialData,price&region=US&lang=en-US&crumb=${encodeURIComponent(crumb)}`
  const r = await fetch(url, { headers: { ...UA, cookie } })
  if (!r.ok) return null
  const j = await r.json()
  const result = j?.quoteSummary?.result?.[0]
  const fd = unwrap(result?.financialData)
  return fromFinancialData(fd, result?.price?.currency)
}

async function crumbCookie() {
  // Seed cookies, then fetch a crumb bound to them.
  const seed = await fetch('https://fc.yahoo.com/', { headers: UA }).catch(() => null)
  let cookie = ''
  if (seed) {
    const sc = typeof seed.headers.getSetCookie === 'function' ? seed.headers.getSetCookie() : []
    cookie = sc.map(c => c.split(';')[0]).join('; ')
  }
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie } })
  const crumb = await cr.text()
  return { cookie, crumb: crumb && crumb.length < 40 ? crumb.trim() : null }
}

// Yahoo raw JSON is sometimes {raw:…,fmt:…}, sometimes plain.
const unwrap = obj => {
  if (!obj) return null
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = (v && typeof v === 'object' && 'raw' in v) ? v.raw : v
  return out
}

// ── strategy 3: scrape the numbers from the quote page's embedded JSON ─────────
async function viaPage(sym) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}?guccounter=1`
  const r = await fetch(url, { headers: UA })
  if (!r.ok) return null
  const html = await r.text()
  const mean = field(html, 'targetMeanPrice'), high = field(html, 'targetHighPrice'),
        low = field(html, 'targetLowPrice'), median = field(html, 'targetMedianPrice')
  if (mean == null && high == null && low == null && median == null) return null
  const recKeyM = html.match(/"recommendationKey"\s*:\s*"([a-z_]+)"/i)
  const curM = html.match(/"(?:financialCurrency|currency)"\s*:\s*"([A-Z]{3})"/)
  return { mean, high, low, median, count: field(html, 'numberOfAnalystOpinions'),
           recKey: recKeyM ? recKeyM[1] : null, recMean: field(html, 'recommendationMean'),
           currency: curM ? curM[1] : null }
}

// Pull a numeric field whether embedded as "field":{"raw":n} or "field":n.
function field(html, name) {
  const m = html.match(new RegExp(`"${name}"\\s*:\\s*(?:\\{\\s*"raw"\\s*:\\s*)?(-?[0-9.]+)`))
  return m ? num(m[1]) : null
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
