/**
 * api/yahoo.js — Vercel serverless (CommonJS)
 * MUST use module.exports — Vercel /api/ functions are CommonJS by default
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
  const cookieStr = rawCookies.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ')

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/finance/getCrumb', {
    headers: {
      'User-Agent': UA, 'Cookie': cookieStr,
      'Accept': 'text/plain, */*', 'Referer': 'https://finance.yahoo.com/'
    }
  })
  if (!crumbRes.ok) throw new Error(`Crumb fetch failed: ${crumbRes.status}`)
  const crumb = (await crumbRes.text()).trim()
  if (!crumb || crumb.includes('{')) throw new Error(`Invalid crumb`)
  return { cookieStr, crumb }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, endpoint, query } = req.query
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' })

  try {
    // SEARCH — no auth needed
    if (endpoint === 'search') {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`
      const r = await fetch(url, { headers: { 'User-Agent': UA } })
      return res.status(200).json(await r.json())
    }

    if (!ticker) return res.status(400).json({ error: 'Missing ticker' })

    // CHART — no auth needed
    if (endpoint === 'chart') {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d&includePrePost=false&events=div%2Csplit`
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
      if (!r.ok) return res.status(r.status).json({ error: `Chart failed: ${r.status}` })
      res.setHeader('Cache-Control', 's-maxage=900')
      return res.status(200).json(await r.json())
    }

    // QUOTE (v7) — no auth needed, returns live price + ratios
    if (endpoint === 'quote') {
      const fields = 'regularMarketPrice,regularMarketVolume,regularMarketChangePercent,marketCap,trailingPE,forwardPE,priceToBook,trailingAnnualDividendYield,fiftyTwoWeekHigh,fiftyTwoWeekLow,averageDailyVolume3Month,sharesOutstanding,beta,currency,shortName,longName,exchange'
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=${fields}`
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
      if (!r.ok) return res.status(r.status).json({ error: `Quote failed: ${r.status}` })
      res.setHeader('Cache-Control', 's-maxage=300')
      return res.status(200).json(await r.json())
    }

    // FUNDAMENTALS — needs crumb + cookie
    if (endpoint === 'fundamentals') {
      const { cookieStr, crumb } = await getSessionCookieAndCrumb()
      const modules = [
        'financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile',
        'incomeStatementHistory', 'balanceSheetHistory', 'cashflowStatementHistory', 'earnings'
      ].join('%2C')
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA, 'Cookie': cookieStr,
          'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/'
        }
      })
      if (!r.ok) {
        const txt = await r.text()
        return res.status(r.status).json({ error: `Fundamentals failed: ${r.status}`, details: txt.slice(0, 300) })
      }
      res.setHeader('Cache-Control', 's-maxage=3600')
      return res.status(200).json(await r.json())
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })
  } catch (err) {
    console.error('[yahoo proxy]', err)
    return res.status(500).json({ error: err.message })
  }
}
