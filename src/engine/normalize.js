// normalize.js
// Converts raw API data → clean standard financial object
// ALL derived metrics are calculated elsewhere (ratios.js, valuation.js)
// This file only extracts and structures raw reported numbers

export function normalizeRawData({ raw }) {
  const { profile, income, balance, cashflow, metrics, history, quote } = raw

  return {
    // ── Identity ───────────────────────────────────────
    ticker:       profile?.symbol        ?? '',
    name:         profile?.companyName   ?? '',
    sector:       profile?.sector        ?? '',
    industry:     profile?.industry      ?? '',
    exchange:     profile?.exchangeShortName ?? '',
    description:  profile?.description   ?? '',
    country:      profile?.country       ?? '',
    currency:     profile?.currency      ?? 'USD',
    beta:         profile?.beta          ?? null,

    // ── Current Market Data (raw, from quote) ──────────
    price:        quote?.price           ?? profile?.price ?? null,
    marketCap:    quote?.marketCap       ?? profile?.mktCap ?? null,
    sharesOut:    quote?.sharesOutstanding ?? null,
    eps:          quote?.eps             ?? null,
    pe:           null,  // calculated in ratios.js
    high52w:      quote?.yearHigh        ?? null,
    low52w:       quote?.yearLow         ?? null,
    avgVolume:    quote?.avgVolume       ?? null,
    volume:       quote?.volume          ?? null,
    change1d:     quote?.change          ?? null,
    changePct1d:  quote?.changesPercentage ?? null,

    // ── Income Statement (5 years, newest first) ───────
    // Each year: { date, revenue, grossProfit, ebitda, ebit, netIncome, eps }
    incomeHistory: (income ?? []).map(y => ({
      date:        y.date,
      revenue:     y.revenue              ?? null,
      grossProfit: y.grossProfit          ?? null,
      ebitda:      y.ebitda               ?? null,
      ebit:        y.operatingIncome      ?? null,
      netIncome:   y.netIncome            ?? null,
      eps:         y.eps                  ?? null,
    })),

    // ── Balance Sheet (5 years, newest first) ──────────
    // Each year: { date, totalAssets, totalDebt, totalEquity, cash, bookValuePerShare }
    balanceHistory: (balance ?? []).map(y => ({
      date:             y.date,
      totalAssets:      y.totalAssets               ?? null,
      totalDebt:        y.totalDebt                 ?? null,
      totalEquity:      y.totalStockholdersEquity   ?? null,
      cash:             y.cashAndCashEquivalents     ?? null,
      bookValuePerShare: y.bookValuePerShare         ?? null,
    })),

    // ── Cash Flow (5 years, newest first) ──────────────
    // Each year: { date, cfo, capex, fcf, dividendsPaid }
    cashflowHistory: (cashflow ?? []).map(y => ({
      date:          y.date,
      cfo:           y.operatingCashFlow   ?? null,
      capex:         y.capitalExpenditure  ?? null,
      fcf:           y.freeCashFlow        ?? null,
      dividendsPaid: y.dividendsPaid       ?? null,
    })),

    // ── OHLCV Price History (for technicals) ───────────
    // Array of { date, open, high, low, close, volume } newest first
    priceHistory: normalizePriceHistory(history),

    // ── Convenience: latest year snapshot ──────────────
    latest: buildLatestSnapshot(income, balance, cashflow, quote, profile),
  }
}

function normalizePriceHistory(history) {
  if (!history?.historical) return []
  return [...history.historical]
    .sort((a, b) => new Date(a.date) - new Date(b.date)) // oldest first for TA calculations
    .map(d => ({
      date:   d.date,
      open:   d.open,
      high:   d.high,
      low:    d.low,
      close:  d.close,
      volume: d.volume,
    }))
}

function buildLatestSnapshot(income, balance, cashflow, quote, profile) {
  const i  = income?.[0]    ?? {}
  const b  = balance?.[0]   ?? {}
  const cf = cashflow?.[0]  ?? {}

  return {
    // Income
    revenue:     i.revenue           ?? null,
    grossProfit: i.grossProfit       ?? null,
    ebitda:      i.ebitda            ?? null,
    ebit:        i.operatingIncome   ?? null,
    netIncome:   i.netIncome         ?? null,
    eps:         i.eps ?? quote?.eps ?? null,

    // Balance sheet
    totalAssets:       b.totalAssets                  ?? null,
    totalDebt:         b.totalDebt                    ?? null,
    totalEquity:       b.totalStockholdersEquity      ?? null,
    cash:              b.cashAndCashEquivalents        ?? null,
    bookValuePerShare: b.bookValuePerShare             ?? null,

    // Cash flow
    cfo:           cf.operatingCashFlow   ?? null,
    capex:         cf.capitalExpenditure  ?? null,
    fcf:           cf.freeCashFlow        ?? null,
    dividendsPaid: cf.dividendsPaid       ?? null,

    // Market
    price:      quote?.price     ?? profile?.price  ?? null,
    marketCap:  quote?.marketCap ?? profile?.mktCap ?? null,
    sharesOut:  quote?.sharesOutstanding             ?? null,
  }
}
