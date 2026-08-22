// api/quote.js — lightweight quote-only endpoint for the live-price poller.
// The full analysis fetch is heavy/slow; this returns just the current price and
// market cap so the price can refresh every minute without re-loading everything.
const YahooFinance = require('yahoo-finance2').default
// v3 requires an instance — calling .quote() on the class itself throws
// "Call `const yahooFinance = new YahooFinance()` first" on every request,
// which resolveQuote's per-candidate try/catch swallowed silently, so this
// endpoint always returned { price: null } and the poller never had
// anything to dispatch.
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'], validation: { logErrors: false } })
const { checkOrigin, rateLimit } = require('./_lib.js')

// Try the symbol as given, then Indian exchange suffixes.
async function resolveQuote(ticker) {
  const base = ticker.trim().toUpperCase()
  const candidates = /\.(NS|BO)$/i.test(base) ? [base] : [base, `${base}.NS`, `${base}.BO`]
  for (const sym of candidates) {
    try {
      // validateResult belongs in the third (module) options argument, not
      // the second (query) one — passed there it fails schema validation
      // ("should NOT have additional properties") and throws instead of
      // just skipping strict validation.
      const q = await yf.quote(sym, {}, { validateResult: false })
      if (q && q.regularMarketPrice != null) return q
    } catch { /* try next */ }
  }
  return null
}

module.exports = async function handler(req, res) {
  if (!checkOrigin(req, res)) return
  // The poller ticks every 60s per open ticker, plus a poll on mount — one
  // caller rarely needs more than a handful of calls a minute.
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, keyPrefix: 'quote' })) return
  const ticker = req.query?.ticker || req.body?.ticker
  if (!ticker) { res.status(400).json({ price: null, error: 'no ticker' }); return }
  try {
    const q = await resolveQuote(ticker)
    if (!q) { res.status(200).json({ price: null }); return }
    res.status(200).json({
      price:     q.regularMarketPrice ?? null,
      marketCap: q.marketCap ?? null,
      volume:    q.regularMarketVolume ?? null,
      change:    q.regularMarketChangePercent ?? null,
      currency:  q.currency ?? null,
    })
  } catch (e) {
    res.status(200).json({ price: null, error: String(e?.message || e) })
  }
}
