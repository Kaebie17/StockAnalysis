// screener.js — Screener.in scraper
// HTML structure verified from screener-scraper-pro open source library
// Selectors: #profit-loss, #balance-sheet, #cash-flow, #ratios
// Table structure: table.data-table > thead (years) + tbody (rows)
// Values: Screener shows in Cr (1 Cr = 10,000,000 INR) for most fields

// In local dev, Vite proxies /api/screener → screener.in (see vite.config.js)
// On Vercel, /api/screener.js serverless function handles the proxy
const PROXY = '/api/screener'

export async function fetchFromScreener(ticker) {
  const res = await fetch(`${PROXY}?ticker=${encodeURIComponent(ticker)}`, {
    headers: { 'Accept': 'text/html' }
  })
  if (!res.ok) throw new Error(`Screener proxy ${res.status}: ${res.statusText}`)

  const html = await res.text()
  if (!html || html.length < 1000) throw new Error('Screener returned empty response')
  if (html.includes('Page not found') || html.includes('404')) throw new Error(`Ticker "${ticker}" not found on Screener.in`)

  return parseScreenerHTML(html, ticker)
}

function parseScreenerHTML(html, ticker) {
  const parser = new DOMParser()
  const doc    = parser.parseFromString(html, 'text/html')

  // ── Company name ──────────────────────────────────────
  const nameEl = doc.querySelector('h1.margin-0') ?? doc.querySelector('.company-name') ?? doc.querySelector('h1')
  const name   = nameEl?.textContent?.trim() ?? ticker

  // ── Current price ─────────────────────────────────────
  // Screener shows price in the top-ratios or company-info section
  const priceEl = doc.querySelector('#top-ratios span[id="current-price"] span.number')
               ?? doc.querySelector('.current-price .number')
               ?? doc.querySelector('[data-field="current_price"]')
  const price   = parseNum(priceEl?.textContent)

  // ── Market cap from top ratios ─────────────────────────
  // First li in #top-ratios is Market Cap
  const ratioItems = doc.querySelectorAll('#top-ratios li')
  let marketCapCr = null
  ratioItems.forEach(li => {
    const label = li.querySelector('.name')?.textContent?.trim()?.toLowerCase()
    const val   = li.querySelector('.number')?.textContent?.trim()
    if (label?.includes('market cap')) marketCapCr = parseNum(val)
  })
  const marketCap = marketCapCr != null ? marketCapCr * CR : null

  // ── Parse financial tables ────────────────────────────
  const plData  = parseTable(doc, '#profit-loss')
  const bsData  = parseTable(doc, '#balance-sheet')
  const cfData  = parseTable(doc, '#cash-flow')
  const ratData = parseTable(doc, '#ratios')

  // ── Build years array (from P&L headers) ─────────────
  // Headers look like: "Mar 2019", "Mar 2020", ..., "TTM"
  const years = plData.headers.filter(h => h && h !== 'TTM')

  // ── Income Statement ─────────────────────────────────
  // Row labels from Screener P&L (verified):
  // "Sales", "Expenses", "Operating Profit", "OPM %", "Other Income",
  // "Interest", "Depreciation", "Profit before tax", "Tax %",
  // "Net Profit", "EPS in Rs", "Dividend Payout %"
  const income = years.map(year => ({
    date:            screenerYearToDate(year),
    revenue:         getCr(plData, 'Sales',                year) ?? getCr(plData, 'Revenue', year),
    grossProfit:     null,  // not directly available; derive from Sales - Expenses if needed
    ebitda:          null,  // not directly available
    operatingIncome: getCr(plData, 'Operating Profit',     year),
    netIncome:       getCr(plData, 'Net Profit',           year),
    eps:             getVal(plData, 'EPS in Rs',           year),
  })).filter(y => y.date && y.revenue != null)

  // ── Balance Sheet ─────────────────────────────────────
  // Row labels: "Share Capital", "Reserves", "Borrowings", "Other Liabilities",
  //             "Total Liabilities", "Fixed Assets", "CWIP", "Investments",
  //             "Other Assets", "Total Assets"
  const balance = years.map(year => {
    const borrowings = getCr(bsData, 'Borrowings', year)
    const shareCapital = getCr(bsData, 'Share Capital', year)
    const reserves     = getCr(bsData, 'Reserves', year)
    const equity = shareCapital != null && reserves != null ? (shareCapital + reserves) * CR : null

    return {
      date:                    screenerYearToDate(year),
      totalAssets:             getCr(bsData, 'Total Assets', year),
      totalDebt:               borrowings,
      totalStockholdersEquity: equity,
      cashAndCashEquivalents:  null,  // not directly in Screener BS
      bookValuePerShare:       null,  // calculate from equity / shares if needed
    }
  }).filter(y => y.date)

  // ── Cash Flow ─────────────────────────────────────────
  // Row labels: "Cash from Operating Activity", "Cash from Investing Activity",
  //             "Cash from Financing Activity", "Net Cash Flow"
  const cashflow = years.map(year => {
    const cfo   = getCr(cfData, 'Cash from Operating Activity',  year)
    const cfi   = getCr(cfData, 'Cash from Investing Activity',  year)
    // Capex is typically the investing activity (negative = outflow)
    // Screener doesn't break capex out separately in free view
    return {
      date:              screenerYearToDate(year),
      operatingCashFlow: cfo,
      capitalExpenditure:null,  // not itemised in Screener free tier
      freeCashFlow:      cfo != null && cfi != null ? cfo + cfi : null,
      dividendsPaid:     null,
    }
  }).filter(y => y.date)

  // ── Key ratios ────────────────────────────────────────
  // Row labels: "Debtor Days", "Inventory Days", "Days Payable",
  //             "Cash Conversion Cycle", "Working Capital Days", "ROCE %", "ROE %"
  // (Store for potential future use; not mapped to rawResult currently)

  return {
    raw: {
      profile: {
        symbol:           ticker.toUpperCase(),
        companyName:      name,
        sector:           null,
        industry:         null,
        exchangeShortName:'NSE',
        currency:         'INR',
        country:          'IN',
        beta:             null,
        price,
        mktCap:           marketCap,
        description:      '',
      },
      income:   income.reverse(),   // newest first (matches FMP/Yahoo convention)
      balance:  balance.reverse(),
      cashflow: cashflow.reverse(),
      metrics:  [],
      history:  null,               // price history not available from Screener
      quote: {
        price,
        marketCap,
        sharesOutstanding: null,
        eps:               getVal(plData, 'EPS in Rs', years[years.length - 1]),
        yearHigh:          null,
        yearLow:           null,
        avgVolume:         null,
        volume:            null,
        change:            null,
        changesPercentage: null,
      },
    },
    source:    'Screener.in',
    errors:    [],
    fetchedAt: Date.now(),
  }
}

// ── Table parser ──────────────────────────────────────────
// Parses Screener's table.data-table structure
// Returns { headers: ['Mar 2020', ...], data: { 'Row Label': { 'Mar 2020': 123, ... } } }

function parseTable(doc, sectionId) {
  const section = doc.querySelector(sectionId)
  if (!section) return { headers: [], data: {} }

  const table = section.querySelector('table.data-table')
  if (!table) return { headers: [], data: {} }

  // Headers from thead
  const headers = []
  table.querySelectorAll('thead tr th').forEach(th => {
    headers.push(th.textContent?.trim() ?? '')
  })

  // Data rows from tbody
  const data = {}
  table.querySelectorAll('tbody tr').forEach(row => {
    const cells = Array.from(row.querySelectorAll('td'))
    if (cells.length < 2) return

    // First cell = row label (may contain a button with text)
    const firstCell = cells[0]
    const btn = firstCell.querySelector('button')
    let label = btn ? btn.textContent?.trim() : firstCell.textContent?.trim()
    // Clean label — remove extra whitespace and special chars from button
    label = label?.replace(/\s+/g, ' ').replace(/[+\-▲▼]/g, '').trim() ?? ''
    if (!label || label === 'Raw PDF') return

    const rowData = {}
    cells.slice(1).forEach((cell, i) => {
      const header = headers[i + 1]
      if (!header) return
      const text = cell.textContent?.trim() ?? ''
      rowData[header] = text
    })

    data[label] = rowData
  })

  return { headers: headers.slice(1), data }
}

// ── Helpers ───────────────────────────────────────────────

const CR = 10_000_000  // 1 Crore = 10 million

// Get value in Crores and convert to absolute INR
function getCr(table, rowLabel, year) {
  const row = findRow(table.data, rowLabel)
  if (!row) return null
  const val = row[year]
  if (val == null || val === '') return null
  const num = parseNum(String(val))
  return num != null ? num * CR : null
}

// Get raw value (e.g. EPS, %, ratios — already in final units)
function getVal(table, rowLabel, year) {
  const row = findRow(table.data, rowLabel)
  if (!row) return null
  const val = row[year]
  if (val == null || val === '') return null
  return parseNum(String(val))
}

// Case-insensitive partial match for row labels
// (Screener sometimes has slightly different labels)
function findRow(data, label) {
  const lower = label.toLowerCase()
  // Exact match first
  if (data[label]) return data[label]
  // Case-insensitive match
  const key = Object.keys(data).find(k => k.toLowerCase() === lower)
  if (key) return data[key]
  // Partial match
  const partial = Object.keys(data).find(k => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))
  return partial ? data[partial] : null
}

// Parse numeric strings like "1,23,456.78" or "1234.56"
function parseNum(str) {
  if (str == null) return null
  const cleaned = String(str).replace(/,/g, '').trim()
  if (cleaned === '' || cleaned === '-' || cleaned === '--') return null
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

// Convert Screener year header "Mar 2022" → "2022-03-31"
function screenerYearToDate(header) {
  if (!header) return null
  const match = header.match(/(\w+)\s+(\d{4})/)
  if (!match) return null
  const monthMap = {
    Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
    Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12'
  }
  const month = monthMap[match[1]] ?? '03'
  return `${match[2]}-${month}-31`
}
