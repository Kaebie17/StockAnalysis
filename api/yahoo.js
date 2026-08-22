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
const { checkOrigin, rateLimit, ALLOWED_ORIGINS } = require('./_lib.js')

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
  validation: { logErrors: false }
})

module.exports = async function handler(req, res) {
  const origin = req.headers.origin
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0])
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!checkOrigin(req, res)) return
  // Generous: the Positions panel can legitimately burst ~10-20 calls here
  // (endpoint=all per stale holding) the moment it opens on a big portfolio.
  if (!rateLimit(req, res, { max: 90, windowMs: 60_000, keyPrefix: 'yahoo' })) return

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

    if (!ticker && endpoint !== 'quotes') return res.status(400).json({ error: 'Missing ticker' })

    // ── QUOTES — many symbols, one call ──────────────────────────────────────
    // /api/yahoo?endpoint=quotes&tickers=A.NS,B.NS,^INDIAVIX
    //
    // Exists for the positions pages, which need a current price for every
    // holding INCLUDING ones the user hasn't opened. Doing that through
    // `endpoint=all` would mean one heavy call per stock — financials, multi-year
    // history and metadata — to extract a single number. yf.quote() takes an
    // array and returns just the quote fields, so a whole portfolio costs about
    // what one ordinary request costs.
    //
    // Cached briefly at the CDN: a price is the same for every user, and the
    // page polls, so this collapses the repeats without making anything stale
    // enough to matter for a position review.
    // ── HISTORY — daily closes over a window ────────────────────────────────
    // /api/yahoo?endpoint=history&ticker=^INDIAVIX&from=2026-01-01&to=2026-01-15
    //
    // Used to reconstruct the market conditions a position was entered in. Kept
    // separate from `all` because that fetches a fixed 2-year window plus
    // financials and metadata; this needs a narrow slice of one series.
    if (endpoint === 'history') {
      const from = String(req.query.from || '')
      const to   = String(req.query.to || '')
      if (!from || !to) return res.status(400).json({ error: 'Missing from/to' })
      try {
        const ch = await yf.chart(ticker, { period1: from, period2: to, interval: '1d' })
        const rows = (ch?.quotes || [])
          .filter(q => q?.date && (q.adjclose != null || q.close != null))
          .map(q => ({
            date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
            close: q.adjclose ?? q.close,
          }))
        // Long cache: a past close never changes.
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800')
        return res.status(200).json({ history: rows })
      } catch (e) {
        console.info(`[yf2] history ${ticker} ${from}..${to}:`, e?.message)
        return res.status(200).json({ history: [], error: 'unavailable' })
      }
    }

    // ── PEERS — similar companies + their multiples ─────────────────────────
    // /api/yahoo?endpoint=peers&ticker=BAJFINANCE.NS
    //
    // Own-history multiples are blind to a SECTOR-wide re-rating: if every NBFC
    // de-rates, this company's own past says nothing about it and the estimate
    // keeps calling the stock cheap all the way down. Peers are the second
    // anchor that catches it.
    if (endpoint === 'peers') {
      let symbols = []
      try {
        const rec = await yf.recommendationsBySymbol(ticker)
        const list = Array.isArray(rec) ? rec[0] : rec
        symbols = (list?.recommendedSymbols || []).map(r => r.symbol).filter(Boolean).slice(0, 8)
      } catch (e) {
        console.info('[yahoo] peers unavailable:', e?.message)
      }
      if (symbols.length === 0) return res.status(200).json({ peers: [], error: 'no_peers' })

      // validateResult belongs in the third (module) options argument, not the
      // second (query) one — passed there it fails quote()'s own schema check
      // ("should NOT have additional properties") and throws, taking this
      // endpoint down with a 500 on every call.
      const rows = await yf.quote(symbols, {}, { validateResult: false })
      const list = Array.isArray(rows) ? rows : [rows]
      const peers = list
        .filter(q => q?.symbol && q.trailingPE > 0)
        .map(q => ({
          symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
          pe: q.trailingPE, forwardPe: q.forwardPE ?? null,
          marketCap: q.marketCap ?? null,
        }))
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
      return res.status(200).json({ peers })
    }

    if (endpoint === 'quotes') {
      const symbols = String(req.query.tickers || '')
        .split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
      if (symbols.length === 0) return res.status(400).json({ error: 'Missing tickers' })

      // Same fix as 'peers': validateResult goes in the third argument.
      const rows = await yf.quote(symbols, {}, { validateResult: false })
      const list = Array.isArray(rows) ? rows : [rows]
      const out = {}
      for (const q of list) {
        if (!q?.symbol) continue
        out[q.symbol] = {
          price: q.regularMarketPrice ?? null,
          changePct: q.regularMarketChangePercent ?? null,
          prevClose: q.regularMarketPreviousClose ?? null,
          currency: q.currency ?? null,
          fiftyDayAverage: q.fiftyDayAverage ?? null,
          time: q.regularMarketTime ?? null,
        }
      }
      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
      return res.status(200).json({ quotes: out })
    }

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
      sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 10)

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

        // Daily OHLCV for technicals (2yr).
        // NOTE: historical() is deprecated AND currently fails Yahoo's own
        // options validation (period2 schema) because Yahoo removed its backend.
        // chart() is the supported replacement and returns { quotes: [...] }.
        // Ten years, matched to the fundamentals window below.
        //
        // This was two years, which quietly capped every downstream calculation
        // that pairs prices with fiscal years: a multiple band could never have
        // more than two annual observations FOR ANY STOCK, however long it had
        // been listed. Trent's "median multiple over 2 years" — which produced a
        // 59-171x band and an absurd estimate — was this limit, not a young
        // company. Ten years spans a full cycle for a cyclical and gives a
        // percentile band something to be a percentile OF.
        yf.chart(ticker, {
          period1: new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000),
          period2: new Date(),
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

      // chart() returns { quotes: [{date,open,high,low,close,volume,adjclose}] }.
      // Flatten to the {date,open,high,low,close,adjClose,volume} shape normalize
      // expects (note adjclose -> adjClose).
      if (history && Array.isArray(history.quotes)) {
        history = history.quotes.map(q => ({
          date:     q.date,
          open:     q.open,
          high:     q.high,
          low:      q.low,
          close:    q.close,
          adjClose: q.adjclose ?? q.close,
          volume:   q.volume
        })).filter(d => d.close != null)
      }

      // Fallback to Yahoo's raw chart endpoint (no crumb needed, reliably 2yr
      // OHLCV for all tickers) whenever the library path gave us something we
      // can't compute technicals from.
      //
      // The trigger used to be `length < 30`, which missed the case that
      // actually happens: chart() returns rows, but with null OHLC — a quote-only
      // response, or an intraday-halted symbol. Those rows survive the
      // `close != null` filter if close alone is present, so the array looks
      // healthy while RSI, ATR and every candlestick pattern have nothing to
      // read. Checking that the bars are USABLE rather than merely present is
      // what stops a stock showing every metric except technicals.
      const usableBars = (history || []).filter(d =>
        d.close > 0 && d.high != null && d.low != null && d.open != null).length
      if (!history || history.length < 30 || usableBars < history.length * 0.8) {
        if (history?.length >= 30) {
          console.warn(`[yf2] ${ticker}: ${history.length} bars but only ${usableBars} have full OHLC — refetching`)
        }
        try {
          const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=10y&interval=1d&includePrePost=false`
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
              const full = history.filter(d => d.high != null && d.low != null && d.open != null).length
              console.log(`[yf2] chart fallback: ${history.length} days for ${ticker} (${full} with full OHLC)`)
            }
          }
        } catch(e) {
          console.warn('[yf2] chart fallback failed:', e.message)
        }
      }

      if (!quote && !summary && (!history || history.length === 0)) {
        return res.status(404).json({ error: `No data for "${ticker}"` })
      }

      // Permanent, one-line: technicals need 30+ daily closes and the SMA200
      // needs 200. When a ticker silently shows no technicals this is the first
      // thing to check, and without it there's nothing in the logs to look at.
      // One line whenever technicals will come out thin, naming which of the two
      // reasons applies — too few bars, or bars without the OHLC that patterns
      // and ATR need.
      {
        const n = history?.length ?? 0
        const full = (history || []).filter(d =>
          d.close > 0 && d.high != null && d.low != null && d.open != null).length
        if (n < 200 || full < n * 0.8) {
          console.warn(`[yf2] ${ticker}: ${n} daily bars, ${full} with full OHLC ` +
            `(need 30+ for technicals, 200 for SMA200, full OHLC for ATR and patterns)`)
        }
      }

      // ── DIAGNOSTIC — fundamentalsTimeSeries field names ──────────────────
      // The `pick()` aliases in normalize.js are best-effort guesses at Yahoo's
      // concept keys; this is how the real ones get confirmed. Kept, because
      // that reconciliation hasn't happened yet — but now opt-in, since it dumps
      // a full fundamentals entry on EVERY fetch and buries the rest of the log.
      //
      // Turn on with FTS_DIAGNOSTIC=1 (Vercel env), pull one US-ticker fetch from
      // the function logs, reconcile the aliases, then delete this block.
      if (process.env.FTS_DIAGNOSTIC === '1') try {
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
      // ── END DIAGNOSTIC ────────────────────────────────────────────────────────

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
      return res.status(200).json({ ticker, quote, summary, history, fts })
    }

    return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` })

  } catch (err) {
    console.error('[yahoo2 proxy]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
