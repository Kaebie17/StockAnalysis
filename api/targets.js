/**
 * api/targets.js — Vercel serverless (CommonJS)
 *
 * Analyst price targets + recommendation, from Yahoo's `financialData` module.
 * COMPARISON CONTEXT ONLY — this is never blended into StockAnalyzr's own fair
 * value. Sell-side targets are structurally optimistic; we show them beside our
 * range, not inside it.
 *
 *   GET /api/targets?ticker=RELIANCE.NS
 *
 * Response:
 *   { ok: true,  targets: { mean, high, low, median, count, recKey, recMean, currency } }
 *   { ok: true,  targets: null }        // module returned nothing (no coverage)
 *   { ok: false, error: '…' }           // fetch failed
 *
 * All target fields are optional in Yahoo's schema, so `null`s are expected and
 * the client renders a "no analyst coverage" state rather than blanks.
 */

const YahooFinance = require('yahoo-finance2').default

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
})

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  // Targets move slowly; a short edge cache is fine and cuts Yahoo load.
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800')

  const ticker = (req.query.ticker || '').toString().trim()
  if (!ticker) return res.status(400).json({ ok: false, error: 'missing_ticker' })

  try {
    const r = await yf.quoteSummary(ticker, { modules: ['financialData', 'price'] })
    const fd = r?.financialData || {}
    const currency = r?.price?.currency || fd?.financialCurrency || null

    const has =
      fd.targetMeanPrice != null || fd.targetHighPrice != null ||
      fd.targetLowPrice != null || fd.targetMedianPrice != null

    const targets = has
      ? {
          mean: num(fd.targetMeanPrice),
          high: num(fd.targetHighPrice),
          low: num(fd.targetLowPrice),
          median: num(fd.targetMedianPrice),
          count: num(fd.numberOfAnalystOpinions),
          recKey: fd.recommendationKey || null,     // 'buy' | 'hold' | 'sell' | 'strong_buy' …
          recMean: num(fd.recommendationMean),       // 1 (strong buy) … 5 (sell)
          currency,
        }
      : null

    return res.status(200).json({ ok: true, targets })
  } catch (e) {
    console.warn('[targets] failed:', e?.message)
    return res.status(200).json({ ok: false, error: 'fetch_failed' })
  }
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
