/**
 * api/yahoo.js — Vercel serverless (CommonJS)
 *
 * Uses yahoo-finance2 npm package which handles cookies, crumbs,
 * and session management automatically. Works reliably from any
 * Node.js environment including Vercel serverless functions.
 *
 * Replaces broken manual crumb implementation entirely.
 */

const YahooFinance = require('yahoo-finance2').default

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false }
})

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, endpoint, query } = req.query

  try {
    // ── SEARCH ───────────────────────────────────────────────────────────────
    if (endpoint === 'search') {
      if (!query) return res.status(400).json({ error: 'Missing query' })
      const results = await yf.search(query, {
        quotesCount: 10,
        newsCount: 0,
        enableFuzzyQuery: false
      })
      res.setHeader('Cache-Control', 's-maxage=300')
      return res.status(200).json(results)
    }

    if (!ticker) return res.status(400).json({ error: 'Missing ticker' })

    // ── ALL DATA — single endpoint returns everything ──────────────────────
    // Client calls /api/yahoo?endpoint=all&ticker=TCS.NS
    // We run quote + quoteSummary + historical in parallel
    if (endpoint === 'all') {
      const [quoteResult, summaryResult, historyResult] = await Promise.allSettled([

        // Quote — live price, market data
        yf.quote(ticker, {
          fields: [
            'regularMarketPrice', 'regularMarketChangePercent',
            'regularMarketVolume', 'regularMarketDayHigh', 'regularMarketDayLow',
            'marketCap', 'sharesOutstanding', 'trailingPE', 'forwardPE',
            'priceToBook', 'trailingAnnualDividendYield',
            'fiftyTwoWeekHigh', 'fiftyTwoWeekLow',
            'averageDailyVolume3Month', 'beta',
            'currency', 'shortName', 'longName', 'exchange', 'symbol'
          ]
        }),

        // QuoteSummary — financial statements + TTM data
        yf.quoteSummary(ticker, {
          modules: [
            'financialData',           // TTM: revenue, ebitda, margins, roe, d/e, fcf
            'defaultKeyStatistics',    // shares, trailing eps, book value
            'summaryDetail',           // pe, pb, dividend
            'assetProfile',            // sector, industry
            'incomeStatementHistory',  // 4yr annual income statements
            'balanceSheetHistory',     // 4yr annual balance sheets
            'cashflowStatementHistory',// 4yr annual cash flows
            'earnings'                 // quarterly + annual EPS history
          ]
        }),

        // Historical — 2 years of daily OHLCV for technicals
        yf.historical(ticker, {
          period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000),
          interval: '1d'
        })
      ])

      const quote   = quoteResult.status   === 'fulfilled' ? quoteResult.value   : null
      const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null
      const history = historyResult.status === 'fulfilled' ? historyResult.value : null

      if (!quote && !summary && !history) {
        const err = [quoteResult, summaryResult, historyResult]
          .map(r => r.reason?.message).find(Boolean) || 'No data returned'
        return res.status(404).json({ error: `No data for "${ticker}": ${err}` })
      }

      if (quoteResult.status   === 'rejected') console.warn('[yf2] quote failed:',   quoteResult.reason?.message)
      if (summaryResult.status === 'rejected') console.warn('[yf2] summary failed:', summaryResult.reason?.message)
      if (historyResult.status === 'rejected') console.warn('[yf2] history failed:', historyResult.reason?.message)

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
      return res.status(200).json({ ticker, quote, summary, history })
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  } catch (err) {
    console.error('[yahoo2 proxy]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
