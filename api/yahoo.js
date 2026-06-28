/**
 * /api/yahoo.js — Vercel serverless proxy for Yahoo Finance
 *
 * Yahoo Finance requires:
 *   1. A valid session cookie (obtained by hitting finance.yahoo.com)
 *   2. A crumb token appended to every data API call
 *
 * Both must originate server-side. Browser fetch is blocked by CORS + cookie rules.
 *
 * Usage: /api/yahoo?ticker=AAPL&endpoint=quote
 *        /api/yahoo?ticker=RELIANCE.NS&endpoint=chart
 *        /api/yahoo?ticker=TCS.NS&endpoint=timeseries
 *        /api/yahoo?query=RELIANCE&endpoint=search
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function getSessionCookieAndCrumb() {
  // Step 1: Hit Yahoo Finance homepage to establish session cookie
  const homeRes = await fetch('https://finance.yahoo.com', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow'
  })

  // Collect all Set-Cookie headers
  const rawCookies = homeRes.headers.getSetCookie
    ? homeRes.headers.getSetCookie()
    : (homeRes.headers.get('set-cookie') || '').split(/,(?=[^ ])/)

  // Parse into name=value pairs only (strip attributes)
  const cookieStr = rawCookies
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')

  // Step 2: Fetch crumb — Yahoo returns a short string like "Bqh/7Jpnr29"
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/finance/getCrumb', {
    headers: {
      'User-Agent': UA,
      'Cookie': cookieStr,
      'Accept': 'text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/'
    }
  })

  if (!crumbRes.ok) {
    throw new Error(`Crumb fetch failed: ${crumbRes.status} ${crumbRes.statusText}`)
  }

  const crumb = (await crumbRes.text()).trim()
  if (!crumb || crumb.includes('{')) {
    throw new Error(`Invalid crumb received: ${crumb.slice(0, 50)}`)
  }

  return { cookieStr, crumb }
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, endpoint, query } = req.query

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' })
  }

  try {
    // Search endpoint doesn't need crumb
    if (endpoint === 'search') {
      if (!query) return res.status(400).json({ error: 'Missing query parameter' })
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0&listsCount=0`
      const searchRes = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' }
      })
      const data = await searchRes.json()
      return res.status(200).json(data)
    }

    if (!ticker) return res.status(400).json({ error: 'Missing ticker parameter' })

    // Get session + crumb for all data endpoints
    const { cookieStr, crumb } = await getSessionCookieAndCrumb()
    const encodedCrumb = encodeURIComponent(crumb)

    const endpoints = {
      chart: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d&includePrePost=false&crumb=${encodedCrumb}`,

      quote: `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price%2CfinancialData%2CdefaultKeyStatistics%2CsummaryDetail%2CassetProfile%2CincomeStatementHistory%2CbalanceSheetHistory%2CcashflowStatementHistory&crumb=${encodedCrumb}`,

      timeseries: `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?type=annualTotalRevenue%2CannualNetIncome%2CannualTotalDebt%2CannualCashAndCashEquivalents%2CannualFreeCashFlow%2CannualEbitda%2CannualGrossProfit%2CannualStockholdersEquity%2CannualOperatingIncome&period1=1451606400&period2=9999999999&crumb=${encodedCrumb}`
    }

    const url = endpoints[endpoint]
    if (!url) return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

    const dataRes = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Cookie': cookieStr,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/'
      }
    })

    if (!dataRes.ok) {
      const errText = await dataRes.text()
      return res.status(dataRes.status).json({
        error: `Yahoo returned ${dataRes.status}`,
        details: errText.slice(0, 200)
      })
    }

    const data = await dataRes.json()
    // Cache for 1 hour
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
    return res.status(200).json(data)

  } catch (err) {
    console.error('[yahoo proxy]', err)
    return res.status(500).json({ error: err.message })
  }
}
