/**
 * /api/yahoo.js — Vercel serverless proxy for Yahoo Finance
 *
 * KEY FACTS (verified June 2026):
 * - v8/finance/chart: does NOT need crumb/cookie. Works with just User-Agent.
 * - v10/finance/quoteSummary: needs crumb + cookie.
 * - fundamentalsTimeSeries: sparse/empty for Indian stocks — do NOT rely on it.
 *   Use incomeStatementHistory, balanceSheetHistory, cashflowStatementHistory instead.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function getSessionCookieAndCrumb() {
  const homeRes = await fetch('https://finance.yahoo.com', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow'
  })

  const rawCookies = homeRes.headers.getSetCookie
    ? homeRes.headers.getSetCookie()
    : (homeRes.headers.get('set-cookie') || '').split(/,(?=[^ ])/)

  const cookieStr = rawCookies
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/finance/getCrumb', {
    headers: {
      'User-Agent': UA,
      'Cookie': cookieStr,
      'Accept': 'text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/'
    }
  })

  if (!crumbRes.ok) throw new Error(`Crumb fetch failed: ${crumbRes.status}`)
  const crumb = (await crumbRes.text()).trim()
  if (!crumb || crumb.includes('{')) throw new Error(`Invalid crumb: ${crumb.slice(0, 50)}`)

  return { cookieStr, crumb }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, endpoint, query } = req.query

  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' })

  try {
    // --- SEARCH: no crumb needed ---
    if (endpoint === 'search') {
      if (!query) return res.status(400).json({ error: 'Missing query' })
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      return res.status(200).json(await r.json())
    }

    if (!ticker) return res.status(400).json({ error: 'Missing ticker' })

    // --- CHART: no crumb needed, just User-Agent ---
    if (endpoint === 'chart') {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d&includePrePost=false&events=div%2Csplit`
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      })
      if (!r.ok) return res.status(r.status).json({ error: `Chart fetch failed: ${r.status}` })
      const data = await r.json()
      res.setHeader('Cache-Control', 's-maxage=900') // 15 min for price data
      return res.status(200).json(data)
    }

    // --- QUOTESUMMARY: needs crumb + cookie ---
    if (endpoint === 'quote') {
      const { cookieStr, crumb } = await getSessionCookieAndCrumb()

      // Request the statement history modules directly — more reliable than timeseries,
      // especially for Indian stocks where timeseries is frequently empty.
      const modules = [
        'price',
        'financialData',
        'defaultKeyStatistics',
        'summaryDetail',
        'assetProfile',
        'incomeStatementHistory',       // annual, last 4 years
        'incomeStatementHistoryQuarterly',
        'balanceSheetHistory',          // annual
        'cashflowStatementHistory',     // annual
        'earnings'                      // EPS history
      ].join('%2C')

      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`

      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Cookie': cookieStr,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://finance.yahoo.com/'
        }
      })

      if (!r.ok) {
        const errText = await r.text()
        return res.status(r.status).json({ error: `QuoteSummary failed: ${r.status}`, details: errText.slice(0, 300) })
      }

      const data = await r.json()
      res.setHeader('Cache-Control', 's-maxage=3600')
      return res.status(200).json(data)
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  } catch (err) {
    console.error('[yahoo proxy]', err)
    return res.status(500).json({ error: err.message })
  }
}
