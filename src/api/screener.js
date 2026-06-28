// screener.js
// Parses HTML from Screener.in via the Vercel proxy
// Falls back to this when FMP API fails

const PROXY_URL = '/api/screener'

export async function fetchFromScreener(ticker) {
  const res = await fetch(`${PROXY_URL}?ticker=${ticker}`)

  if (!res.ok) throw new Error(`Screener proxy error: ${res.status}`)

  const html   = await res.text()
  const parser = new DOMParser()
  const doc    = parser.parseFromString(html, 'text/html')

  return parseScreenerHTML(doc, ticker)
}

function parseScreenerHTML(doc, ticker) {
  // Screener table structure: #profit-loss, #balance-sheet, #cash-flow
  // Each has rows with th (label) and td (values per year)

  const income  = parseTable(doc, '#profit-loss')
  const balance = parseTable(doc, '#balance-sheet')
  const cashflow= parseTable(doc, '#cash-flow')

  // Current price from .current-price span
  const priceEl  = doc.querySelector('.current-price .number')
  const price    = priceEl ? parseFloat(priceEl.textContent.replace(/,/g, '')) : null

  // Company name
  const nameEl   = doc.querySelector('h1.margin-0')
  const name     = nameEl?.textContent?.trim() ?? ticker

  // Market cap
  const mcapEl   = doc.querySelector('.company-ratios li:nth-child(1) .number')
  const marketCap= mcapEl ? parseFloat(mcapEl.textContent.replace(/,/g, '')) * 1e7 : null // Screener shows in Cr

  return {
    raw: {
      profile:  { symbol: ticker, companyName: name, price, mktCap: marketCap, currency: 'INR', country: 'IN' },
      income:   mapScreenerIncome(income),
      balance:  mapScreenerBalance(balance),
      cashflow: mapScreenerCashflow(cashflow),
      metrics:  [],
      history:  null,  // price history not available from Screener — FMP needed for technicals
      quote:    { price, marketCap, eps: null, yearHigh: null, yearLow: null },
    },
    source: 'Screener.in',
    errors: [],
  }
}

function parseTable(doc, selector) {
  const section = doc.querySelector(selector)
  if (!section) return {}

  const result = {}

  // Get year headers from thead
  const years = []
  section.querySelectorAll('thead tr th').forEach((th, i) => {
    if (i > 0) years.push(th.textContent.trim())
  })

  // Get each row
  section.querySelectorAll('tbody tr').forEach(row => {
    const cells = row.querySelectorAll('td, th')
    if (cells.length < 2) return
    const rowLabel = cells[0].textContent.trim().toLowerCase()
    const values   = []
    for (let i = 1; i < cells.length; i++) {
      const text = cells[i].textContent.replace(/,/g, '').trim()
      values.push(text === '' || text === '-' ? null : parseFloat(text))
    }
    result[rowLabel] = values
  })

  return { years, rows: result }
}

function mapScreenerIncome(data) {
  // Screener shows values in Cr (10 million INR)
  const SCALE = 1e7
  const { years = [], rows = {} } = data

  return years.map((date, i) => ({
    date:        date.includes('Mar') ? `${date.split(' ')[1]}-03-31` : date,
    revenue:     (rows['sales']?.[i] ?? rows['revenue']?.[i] ?? null) * SCALE,
    grossProfit: null, // Screener doesn't show gross profit directly
    ebitda:      (rows['operating profit']?.[i] ?? null) * SCALE,
    operatingIncome: (rows['operating profit']?.[i] ?? null) * SCALE,
    netIncome:   (rows['net profit']?.[i] ?? null) * SCALE,
    eps:         rows['eps in rs']?.[i] ?? null,
  })).filter(y => y.date).slice(0, 5)
}

function mapScreenerBalance(data) {
  const SCALE = 1e7
  const { years = [], rows = {} } = data

  return years.map((date, i) => ({
    date:                   date.includes('Mar') ? `${date.split(' ')[1]}-03-31` : date,
    totalAssets:            (rows['total assets']?.[i] ?? null) * SCALE,
    totalDebt:              (rows['borrowings']?.[i] ?? null) * SCALE,
    totalStockholdersEquity:(rows['equity capital']?.[i] ?? null) * SCALE,
    cashAndCashEquivalents: (rows['cash equivalents']?.[i] ?? null) * SCALE,
    bookValuePerShare:      rows['book value']?.[i] ?? null,
  })).filter(y => y.date).slice(0, 5)
}

function mapScreenerCashflow(data) {
  const SCALE = 1e7
  const { years = [], rows = {} } = data

  return years.map((date, i) => ({
    date:              date.includes('Mar') ? `${date.split(' ')[1]}-03-31` : date,
    operatingCashFlow: (rows['cash from operating activity']?.[i] ?? null) * SCALE,
    capitalExpenditure:(rows['capital expenditure']?.[i] ?? null) * SCALE,
    freeCashFlow:      null, // calculated in normalize.js from cfo + capex
    dividendsPaid:     null,
  })).filter(y => y.date).slice(0, 5)
}
