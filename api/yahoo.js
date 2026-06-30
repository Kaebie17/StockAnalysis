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
    //
    // validateResult: false — yahoo-finance2 throws FailedYahooValidationError
    // and REJECTS THE ENTIRE CALL if any field doesn't match its strict schema.
    // This happens for companies with volatile/non-standard financials (loss-making,
    // recently listed, negative PE etc — e.g. Zomato). Setting validateResult:false
    // returns the data as-is without throwing, so we always get whatever Yahoo
    // actually has instead of an all-or-nothing failure.
    if (endpoint === 'all') {
      const yfOpts = { validateResult: false }

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
        }, yfOpts),

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
        }, yfOpts),

        // Historical — 2 years of daily OHLCV for technicals
        yf.historical(ticker, {
          period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000),
          interval: '1d'
        }, yfOpts)
      ])

      // Even on 'rejected', yahoo-finance2's FailedYahooValidationError carries
      // a partial result on error.result — recover it instead of losing all data
      const recover = (r) => {
        if (r.status === 'fulfilled') return r.value
        if (r.reason?.result) {
          console.warn(`[yf2] using partial result after validation error: ${r.reason.message}`)
          return r.reason.result
        }
        console.warn('[yf2] no data, full failure:', r.reason?.message)
        return null
      }

      const quote   = recover(quoteResult)
      const summary = recover(summaryResult)
      let   history = recover(historyResult)

      // Fallback: if yahoo-finance2 historical() failed, use Yahoo v8/finance/chart directly
      // This endpoint needs no crumb and reliably returns 2yr OHLCV for all tickers
      if (!history || history.length < 30) {
        try {
          const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d&includePrePost=false`
          const chartRes = await fetch(chartUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' }
          })
          if (chartRes.ok) {
            const chartData = await chartRes.json()
            const result    = chartData?.chart?.result?.[0]
            const ts        = result?.timestamp || []
            const ohlcv     = result?.indicators?.quote?.[0] || {}
            const adj       = result?.indicators?.adjclose?.[0]?.adjclose || []
            if (ts.length > 0) {
              history = ts.map((t, i) => ({
                date:     new Date(t * 1000),
                open:     ohlcv.open?.[i]   ?? null,
                high:     ohlcv.high?.[i]   ?? null,
                low:      ohlcv.low?.[i]    ?? null,
                close:    ohlcv.close?.[i]  ?? null,
                adjClose: adj[i]            ?? ohlcv.close?.[i] ?? null,
                volume:   ohlcv.volume?.[i] ?? null
              })).filter(d => d.close != null)
              console.log(`[yf2] chart fallback: got ${history.length} days for ${ticker}`)
            }
          }
        } catch(e) {
          console.warn('[yf2] chart fallback failed:', e.message)
        }
      }

      if (!quote && !summary && (!history || history.length === 0)) {
        return res.status(404).json({ error: `No data for "${ticker}"` })
      }

      // ── TEMPORARY DIAGNOSTIC — remove after debugging Net Profit / Interest gaps ──
      // Logs to Vercel function logs only. Safe, read-only, no behavior change.
      try {
        const fin = summary?.financialData || {}
        const incHist = summary?.incomeStatementHistory?.incomeStatementHistory || []
        const balHist = summary?.balanceSheetHistory?.balanceSheetStatements || []
        const latestInc = incHist[incHist.length - 1] || {}
        const latestBal = balHist[balHist.length - 1] || {}

        console.log(`[DIAGNOSTIC] ${ticker}`, JSON.stringify({
          incomeStatementHistory_length: incHist.length,
          balanceSheetHistory_length: balHist.length,
          latestIncomeStatement_endDate: latestInc.endDate,
          latestIncomeStatement_totalRevenue: latestInc.totalRevenue,
          latestIncomeStatement_operatingIncome: latestInc.operatingIncome,
          latestIncomeStatement_netIncome: latestInc.netIncome,        // ← Net Profit source
          latestIncomeStatement_interestExpense: latestInc.interestExpense, // ← Interest source
          latestBalanceSheet_totalAssets: latestBal.totalAssets,       // ← Total Assets source
          latestBalanceSheet_totalStockholderEquity: latestBal.totalStockholderEquity,
          financialData_netIncomeToCommon: fin.netIncomeToCommon,      // ← Net Profit TTM fallback source
          financialData_totalRevenue: fin.totalRevenue,
          financialData_keys_present: Object.keys(fin),
        }, null, 2))
      } catch (e) {
        console.warn('[DIAGNOSTIC] logging failed:', e.message)
      }
      // ── END TEMPORARY DIAGNOSTIC ──────────────────────────────────────────────

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
      return res.status(200).json({ ticker, quote, summary, history })
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  } catch (err) {
    console.error('[yahoo2 proxy]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
