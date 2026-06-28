// normalize.js
// Converts raw API/scrape data → clean standard financial object
// Handles FMP, Yahoo Finance, and Screener.in source shapes
// ALL derived metrics are calculated elsewhere (ratios.js)

export function normalizeRawData({ raw }) {
  const { profile, income, balance, cashflow, history, quote, ttm } = raw

  // ── Identity ─────────────────────────────────────────
  const normalized = {
    ticker:      profile?.symbol           ?? '',
    name:        profile?.companyName      ?? '',
    sector:      profile?.sector           ?? '',
    industry:    profile?.industry         ?? '',
    exchange:    profile?.exchangeShortName ?? '',
    description: profile?.description      ?? '',
    country:     profile?.country          ?? '',
    currency:    profile?.currency         ?? 'USD',
    beta:        profile?.beta             ?? null,

    // ── Market data ───────────────────────────────────
    price:        quote?.price                   ?? profile?.price ?? null,
    marketCap:    quote?.marketCap               ?? profile?.mktCap ?? null,
    sharesOut:    quote?.sharesOutstanding        ?? null,
    eps:          quote?.eps                     ?? null,
    high52w:      quote?.yearHigh                ?? null,
    low52w:       quote?.yearLow                 ?? null,
    avgVolume:    quote?.avgVolume               ?? null,
    volume:       quote?.volume                  ?? null,
    change1d:     quote?.change                  ?? null,
    changePct1d:  quote?.changesPercentage        ?? null,

    // ── Income history (newest first) ─────────────────
    incomeHistory: (income ?? []).map(y => ({
      date:        y.date,
      revenue:     y.revenue          ?? null,
      grossProfit: y.grossProfit       ?? null,
      ebitda:      y.ebitda            ?? null,
      ebit:        y.operatingIncome   ?? null,
      netIncome:   y.netIncome         ?? null,
      eps:         y.eps               ?? null,
    })).filter(y => y.date),

    // ── Balance sheet history (newest first) ──────────
    balanceHistory: (balance ?? []).map(y => ({
      date:              y.date,
      totalAssets:       y.totalAssets               ?? null,
      totalDebt:         y.totalDebt                 ?? null,
      totalEquity:       y.totalStockholdersEquity   ?? null,
      cash:              y.cashAndCashEquivalents     ?? null,
      bookValuePerShare: y.bookValuePerShare          ?? null,
    })).filter(y => y.date),

    // ── Cash flow history (newest first) ──────────────
    cashflowHistory: (cashflow ?? []).map(y => ({
      date:          y.date,
      cfo:           y.operatingCashFlow   ?? null,
      capex:         y.capitalExpenditure  ?? null,
      fcf:           y.freeCashFlow        ?? null,
      dividendsPaid: y.dividendsPaid       ?? null,
    })).filter(y => y.date),

    // ── Price history (oldest first, for TA) ──────────
    priceHistory: normalizePriceHistory(history),

    // ── TTM supplement (Yahoo financialData) ──────────
    // Passed through so ratios.js can fill gaps when balance/cashflow history is sparse
    ttm: ttm ?? null,
  }

  // ── Latest year snapshot ──────────────────────────────
  // For Yahoo: income history + balance may be sparse.
  // ttm supplements with TTM financial data from financialData module.
  normalized.latest = buildLatest(normalized, quote, profile, ttm)

  return normalized
}

function normalizePriceHistory(history) {
  if (!history?.historical) return []
  return [...history.historical]
    .filter(d => d.close != null && d.close > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date)) // oldest first for TA
    .map(d => ({
      date:   d.date,
      open:   d.open   ?? null,
      high:   d.high   ?? null,
      low:    d.low    ?? null,
      close:  d.close,
      volume: d.volume ?? null,
    }))
}

function buildLatest(data, quote, profile, ttm) {
  const i  = data.incomeHistory[0]  ?? {}
  const b  = data.balanceHistory[0] ?? {}
  const cf = data.cashflowHistory[0] ?? {}

  // ttm from Yahoo financialData supplements sparse Yahoo history
  const t = ttm ?? {}

  return {
    // Income — prefer history, fallback to TTM
    revenue:     i.revenue     ?? t.revenue     ?? null,
    grossProfit: i.grossProfit ?? t.grossProfit ?? null,
    ebitda:      i.ebitda      ?? t.ebitda      ?? null,
    ebit:        i.ebit        ?? null,
    netIncome:   i.netIncome   ?? t.netIncome   ?? null,
    eps:         i.eps         ?? t.eps         ?? quote?.eps ?? null,

    // Balance sheet
    totalAssets:       b.totalAssets       ?? null,
    totalDebt:         b.totalDebt         ?? t.totalDebt   ?? null,
    totalEquity:       b.totalEquity       ?? null,
    cash:              b.cash              ?? t.cash        ?? null,
    bookValuePerShare: b.bookValuePerShare ?? t.bookValuePerShare ?? null,

    // Cash flow
    cfo:           cf.cfo   ?? t.cfo   ?? null,
    capex:         cf.capex ?? null,
    fcf:           cf.fcf   ?? t.fcf   ?? null,
    dividendsPaid: cf.dividendsPaid ?? null,

    // Market
    price:      quote?.price     ?? profile?.price    ?? null,
    marketCap:  quote?.marketCap ?? profile?.mktCap   ?? null,
    sharesOut:  quote?.sharesOutstanding               ?? t.sharesOut ?? null,
  }
}
