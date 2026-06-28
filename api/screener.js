/**
 * /api/screener.js — Vercel serverless proxy for Screener.in
 *
 * Screener.in serves financial tables in static HTML (no JS required for the table data).
 * Tables are inside <section id="profit-loss">, <section id="balance-sheet">, <section id="cash-flow">
 *
 * URL: /api/screener?ticker=RELIANCE&consolidated=true
 *
 * Returns parsed JSON with incomeHistory, balanceHistory, cashflowHistory arrays.
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, consolidated } = req.query
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' })

  const suffix = consolidated === 'false' ? '' : '/consolidated'
  const url = `https://www.screener.in/company/${encodeURIComponent(ticker.toUpperCase())}${suffix}/`

  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.screener.in/',
        'Cache-Control': 'no-cache'
      }
    })

    if (pageRes.status === 404) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found on Screener.in` })
    }
    if (!pageRes.ok) {
      return res.status(pageRes.status).json({ error: `Screener returned ${pageRes.status}` })
    }

    const html = await pageRes.text()

    // Parse tables using regex (no DOM available in serverless)
    const result = parseScreenerHTML(html, ticker)

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
    return res.status(200).json(result)

  } catch (err) {
    console.error('[screener proxy]', err)
    return res.status(500).json({ error: err.message })
  }
}

/**
 * Parse Screener HTML tables using regex.
 * Tables are in: <section id="profit-loss">, <section id="balance-sheet">, <section id="cash-flow">
 * Numbers are in Crores (INR × 10,000,000).
 */
function parseScreenerHTML(html, ticker) {
  // Extract company name from title
  const nameMatch = html.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/)
  const name = nameMatch ? nameMatch[1].trim() : ticker

  // Extract current price
  const priceMatch = html.match(/class="[^"]*current-price[^"]*"[^>]*>\s*[₹]?\s*([\d,\.]+)/) ||
                     html.match(/<span[^>]*itemprop="price"[^>]*>([\d,\.]+)/)
  const price = priceMatch ? parseNum(priceMatch[1]) : null

  // Extract market cap from key stats
  const mcapMatch = html.match(/Market Cap[^<]*<\/[^>]+>\s*[₹\s]*([\d,\.]+)\s*Cr/i)
  const marketCap = mcapMatch ? parseNum(mcapMatch[1]) * 1e7 : null // Cr → absolute INR

  // Parse each financial section
  const incomeSection = extractSection(html, 'profit-loss')
  const balanceSection = extractSection(html, 'balance-sheet')
  const cashflowSection = extractSection(html, 'cash-flow')

  const incomeTable = parseTable(incomeSection)
  const balanceTable = parseTable(balanceSection)
  const cashflowTable = parseTable(cashflowSection)

  // Map row labels → standard fields (values are in Crores)
  const years = incomeTable.headers || []

  const incomeHistory = years.map((year, i) => ({
    year,
    revenue:       getVal(incomeTable, ['Sales', 'Revenue from Operations', 'Net Sales'], i),
    operatingProfit: getVal(incomeTable, ['Operating Profit', 'EBIT', 'EBITDA'], i),
    netIncome:     getVal(incomeTable, ['Net Profit', 'Profit after tax', 'PAT'], i),
    interest:      getVal(incomeTable, ['Interest', 'Finance Costs'], i),
    depreciation:  getVal(incomeTable, ['Depreciation', 'D&A'], i),
    tax:           getVal(incomeTable, ['Tax %'], i), // percentage
    eps:           getVal(incomeTable, ['EPS in Rs', 'EPS'], i)
  })).filter(r => r.revenue !== null)

  const balanceHistory = years.map((year, i) => ({
    year,
    totalAssets:     getVal(balanceTable, ['Total Assets'], i),
    totalDebt:       getVal(balanceTable, ['Borrowings', 'Total Debt', 'Long Term Borrowings'], i),
    totalEquity:     getVal(balanceTable, ["Share Capital", "Shareholders' Equity", 'Net Worth', 'Total Equity'], i),
    cash:            getVal(balanceTable, ['Cash Equivalents', 'Cash & Bank', 'Cash and Bank Balances'], i),
    totalLiabilities: getVal(balanceTable, ['Total Liabilities'], i)
  })).filter(r => r.totalAssets !== null)

  const cashflowHistory = years.map((year, i) => ({
    year,
    operatingCF: getVal(cashflowTable, ['Cash from Operating Activity', 'Operating Activities', 'Net Cash from Operating'], i),
    investingCF: getVal(cashflowTable, ['Cash from Investing Activity', 'Investing Activities'], i),
    financingCF: getVal(cashflowTable, ['Cash from Financing Activity', 'Financing Activities'], i),
    capex:       getVal(cashflowTable, ['Capital Expenditure', 'Capex', 'Purchase of Fixed Assets'], i),
    freeCashFlow: getVal(cashflowTable, ['Free Cash Flow', 'FCF'], i)
  })).filter(r => r.operatingCF !== null)

  // Summary ratios from the key stats block
  const pe =    extractRatio(html, 'Stock P/E')
  const pb =    extractRatio(html, 'Price to Book')
  const roce =  extractRatio(html, 'ROCE')
  const roe =   extractRatio(html, 'ROE')
  const divYield = extractRatio(html, 'Dividend Yield')
  const bookVal =  extractRatio(html, 'Book Value')

  return {
    source: 'screener',
    ticker,
    name,
    price,
    marketCap,
    currency: 'INR',
    unit: 'Crores',
    ratios: { pe, pb, roce, roe, divYield, bookValue: bookVal },
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    years
  }
}

/** Extract HTML of a section by its id attribute */
function extractSection(html, sectionId) {
  // Match <section id="profit-loss" ...>...</section>
  const re = new RegExp(`<section[^>]+id=["']${sectionId}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i')
  const m = html.match(re)
  return m ? m[0] : ''
}

/** Parse an HTML table string into { headers, rows: [{label, values}] } */
function parseTable(sectionHtml) {
  if (!sectionHtml) return { headers: [], rows: [] }

  // Extract header row (th elements)
  const theadMatch = sectionHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
  const headers = []
  if (theadMatch) {
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi
    let m
    while ((m = thRe.exec(theadMatch[1])) !== null) {
      const text = stripTags(m[1]).trim()
      if (text) headers.push(text)
    }
  }
  // Remove first header (it's the row-label column, e.g. empty or "")
  if (headers.length > 0) headers.shift()

  // Extract tbody rows
  const rows = []
  const tbodyMatch = sectionHtml.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
  if (tbodyMatch) {
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch
    while ((trMatch = trRe.exec(tbodyMatch[1])) !== null) {
      const cells = []
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
      let tdMatch
      while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
        cells.push(stripTags(tdMatch[1]).trim())
      }
      if (cells.length > 1) {
        const label = cells[0].replace(/\+$/, '').replace(/\s+/g, ' ').trim()
        const values = cells.slice(1).map(v => parseNum(v))
        rows.push({ label, values })
      }
    }
  }

  return { headers, rows }
}

/** Get a value by trying multiple possible row labels */
function getVal(table, labels, colIndex) {
  for (const label of labels) {
    const row = table.rows.find(r =>
      r.label.toLowerCase().includes(label.toLowerCase())
    )
    if (row && row.values[colIndex] !== undefined && row.values[colIndex] !== null) {
      return row.values[colIndex]
    }
  }
  return null
}

/** Extract a ratio value from key stats block */
function extractRatio(html, label) {
  // Pattern: label text followed by value, common in Screener's li/td pairs
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(escaped + '[^<]*<\\/[^>]+>[^<]*<[^>]+>\\s*([\\d,\\.]+)', 'i')
  const m = html.match(re)
  return m ? parseNum(m[1]) : null
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#[^;]+;/g, '').replace(/\s+/g, ' ')
}

function parseNum(str) {
  if (!str) return null
  const cleaned = String(str).replace(/,/g, '').replace(/%/g, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}
