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
    //
    // MIGRATION NOTE: quoteSummary's incomeStatementHistory / balanceSheetHistory
    // / cashflowStatementHistory submodules have provided almost no data since
    // Nov 2024 (confirmed by yahoo-finance2's own runtime warning — verified
    // against RELIANCE.NS returning a frozen 2023 snapshot). Replaced with
    // fundamentalsTimeSeries, Yahoo's current data pipeline.
    //
    // Type-string naming below is a best-effort match against Yahoo's documented
    // concept taxonomy — multiple alias candidates per metric are requested so a
    // naming mismatch on one doesn't lose the field. The DIAGNOSTIC block further
    // down logs the raw response so any wrong guesses can be corrected from real
    // data after first deploy.
    //
    // validateResult: false — yahoo-finance2 throws FailedYahooValidationError
    // and rejects the entire call if any field doesn't match its strict schema
    // (happens for loss-making/volatile companies — e.g. Zomato). This returns
    // the data as-is without throwing.
    if (endpoint === 'all') {
      const yfOpts = { validateResult: false }

      // NOTE on fundamentalsTimeSeries() usage (corrected):
      //   - `type` is the PERIOD ('annual' | 'quarterly' | 'trailing'), NOT a
      //     list of concept names. Passing an array of 'annualXxx' strings (as
      //     this code originally did) fails the library's type-enum check, so
      //     the whole call rejected and `fts` came back null — which silently
      //     forced normalize.js onto its TTM-synthesis fallback. That was the
      //     real reason real companies (e.g. RELIANCE.NS) showed base metrics
      //     as "unavailable".
      //   - The concept list is selected automatically by `module: 'all'`
      //     (income + balance sheet + cash flow). We don't (and can't) pass it.
      //   - In the response, yahoo-finance2 STRIPS the period prefix from every
      //     key (annualTotalRevenue -> totalRevenue, annualReconciledDepreciation
      //     -> reconciledDepreciation, etc). normalize.js reads those de-prefixed
      //     names. Verified against the library source (v3.x) + a replayed
      //     transform of its processResponse().

      const sixYearsAgo = new Date()
      sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 6)

      const [quoteResult, summaryResult, historyResult, ftsResult] = await Promise.allSettled([

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

        // QuoteSummary — TTM data + metadata only now (statement submodules dead since Nov 2024)
        yf.quoteSummary(ticker, {
          modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'earnings']
        }, yfOpts),

        // Historical — 2 years of daily OHLCV for technicals
        yf.historical(ticker, {
          period1: new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000),
          interval: '1d'
        }, yfOpts),

        // Fundamentals time series — current replacement for the dead statement submodules
        yf.fundamentalsTimeSeries(ticker, {
          period1: sixYearsAgo,
          period2: new Date(),
          type: 'annual',   // PERIOD, not a concept list (see note above)
          module: 'all'
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
      const fts     = recover(ftsResult)

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

      // ── TEMPORARY DIAGNOSTIC — remove once fundamentalsTimeSeries field
      // names below are confirmed against real data. Logs to Vercel function
      // logs only. Safe, read-only, no behavior change.
      try {
        const ftsArr = Array.isArray(fts) ? fts : (fts ? [fts] : [])
        const sample = ftsArr[ftsArr.length - 1] || ftsArr[0] || {}
        console.log(`[DIAGNOSTIC-FTS] ${ticker}`, JSON.stringify({
          fts_entries_count: ftsArr.length,
          fts_all_dates: ftsArr.map(e => e?.date || e?.asOfDate).slice(0, 10),
          latest_entry_raw_keys: Object.keys(sample),
          latest_entry_sample: sample,
        }, null, 2))
      } catch (e) {
        console.warn('[DIAGNOSTIC-FTS] logging failed:', e.message)
      }
      // ── END TEMPORARY DIAGNOSTIC ──────────────────────────────────────────────

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
      return res.status(200).json({ ticker, quote, summary, history, fts })
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  } catch (err) {
    console.error('[yahoo2 proxy]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
