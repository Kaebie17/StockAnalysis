// api/quote.js — lightweight quote-only endpoint for the live-price poller.
// The full analysis fetch is heavy/slow; this returns just the current price and
// market cap so the price can refresh every minute without re-loading everything.
const YahooFinance = require('yahoo-finance2').default

// Try the symbol as given, then Indian exchange suffixes.
async function resolveQuote(ticker) {
  const base = ticker.trim().toUpperCase()
  const candidates = /\.(NS|BO)$/i.test(base) ? [base] : [base, `${base}.NS`, `${base}.BO`]
  for (const sym of candidates) {
    try {
      const q = await YahooFinance.quote(sym)
      if (q && q.regularMarketPrice != null) return q
    } catch { /* try next */ }
  }
  return null
}

module.exports = async function handler(req, res) {
  const ticker = req.query?.ticker || req.body?.ticker
  if (!ticker) { res.status(400).json({ price: null, error: 'no ticker' }); return }
  try {
    const q = await resolveQuote(ticker)
    if (!q) { res.status(200).json({ price: null }); return }
    res.status(200).json({
      price:     q.regularMarketPrice ?? null,
      marketCap: q.marketCap ?? null,
      volume:    q.regularMarketVolume ?? null,
      currency:  q.currency ?? null,
    })
  } catch (e) {
    res.status(200).json({ price: null, error: String(e?.message || e) })
  }
}
