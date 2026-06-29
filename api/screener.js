/**
 * api/screener.js — Vercel serverless (CommonJS)
 * MUST use module.exports — Vercel /api/ functions are CommonJS by default
 *
 * 3-layer parsing strategy:
 * Layer 1: Semantic label matching with aliases (handles label changes)
 * Layer 2: Positional fallback (if < 3 fields matched semantically)
 * Layer 3: Invariant check — if core fields still null, flag as DEGRADED
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

const INCOME_ALIASES = {
  revenue:         ['sales', 'revenue', 'totalrevenue', 'netsales', 'incomefromoperations',
                    'netrevenue', 'totalincome', 'premiumearned', 'netpremiumearned',
                    'interestearned', 'totalinterestearned', 'revenuefromoperations',
                    'grossearnedincome', 'totalincomefromoperations'],
  expenses:        ['expenses', 'totalexpenses', 'costofrevenue', 'expenditure',
                    'totalexpenditure', 'benefitsandexpenses', 'totalcost'],
  operatingProfit: ['operatingprofit', 'ebit', 'operatingincome', 'profitfromoperations',
                    'pbdit', 'operatingsurplus', 'operatingprofitloss'],
  opm:             ['opm', 'operatingprofitmargin', 'operatingmargin'],
  otherIncome:     ['otherincome', 'otheroperatingincome', 'nonoperatingincome'],
  interest:        ['interest', 'interestexpense', 'financecosts', 'financecost',
                    'interestcost', 'interestpaid', 'borrowingcosts'],
  depreciation:    ['depreciation', 'depreciationandamortisation', 'depreciationamortization',
                    'da', 'depreciationamortisationandimpairment'],
  profitBeforeTax: ['profitbeforetax', 'pbt', 'earningsbeforetax',
                    'profitbeforeexceptionaltaxitems', 'profitbeforetaxandexceptionalitems'],
  tax:             ['tax', 'taxpercent', 'taxrate', 'incometax'],
  netProfit:       ['netprofit', 'profitaftertax', 'pat', 'netincome', 'netearnings',
                    'profitlossaftertax', 'netprofitloss', 'surplus', 'profitaftertaxpat'],
  eps:             ['epsinrs', 'eps', 'earningspershare', 'basiceps', 'dilutedeps',
                    'basicearningspershare', 'earningspersharebasic'],
  dividendPayout:  ['dividendpayout', 'dividend']
}

const BALANCE_ALIASES = {
  equityCapital:    ['equitycapital', 'sharecapital', 'paidupcapital', 'capitalstock',
                     'sharesinrs', 'sharesinrupees'],
  reserves:         ['reserves', 'reservesandsurplus', 'retainedearnings',
                     'surplusreserves', 'policyholderfunds', 'fundforpolicyholders',
                     'otherequity', 'reservesandotherequity'],
  borrowings:       ['borrowings', 'totaldebt', 'longtermborrowing', 'debt', 'loans',
                     'totalborrowings', 'longtermdebt', 'deposits', 'borrowingsdeposits'],
  otherLiabilities: ['otherliabilities', 'currentliabilities', 'othercurrentliabilities',
                     'othernoncurrentliabilities'],
  totalLiabilities: ['totalliabilities', 'totalliabilitiesandequity', 'totalequityandliabilities',
                     'totalliabilitiesandstockholdersequity'],
  fixedAssets:      ['fixedassets', 'netfixedassets', 'propertyplantequipment', 'ppe',
                     'tangibleassets', 'nettangibleassets', 'netblock'],
  cwip:             ['cwip', 'capitalworkinprogress', 'constructioninprogress'],
  investments:      ['investments', 'longtermfinancialinvestments', 'financialinvestments',
                     'noncurrentinvestments'],
  otherAssets:      ['otherassets', 'currentassets', 'othercurrentassets',
                     'othernoncurrentassets'],
  totalAssets:      ['totalassets', 'totalassetsproperties', 'totalassetsbalance']
}

const CASHFLOW_ALIASES = {
  operatingCF:  ['cashfromoperatingactivity', 'netcashfromoperatingactivities',
                 'operatingactivities', 'cashflowfromoperations',
                 'netcashprovidedbyoperatingactivities', 'cashgeneratedfromoperations',
                 'cashflowfromoperatingactivities'],
  investingCF:  ['cashfrominvestingactivity', 'netcashfrominvestingactivities',
                 'investingactivities', 'cashflowfrominvesting',
                 'cashflowfrominvestingactivities'],
  financingCF:  ['cashfromfinancingactivity', 'netcashfromfinancingactivities',
                 'financingactivities', 'cashflowfromfinancing',
                 'cashflowfromfinancingactivities'],
  netCashFlow:  ['netcashflow', 'netchangeincash', 'netincreasedecreasecash',
                 'netchangeincashandcashequivalents'],
  freeCashFlow: ['freecashflow', 'fcf', 'freecashflowfcf']
}

// Positional fallback — Screener P&L row order is stable
const INCOME_POSITIONS  = { revenue:0, expenses:1, operatingProfit:2, otherIncome:4, interest:5, depreciation:6, profitBeforeTax:7, netProfit:9, eps:10 }
const BALANCE_POSITIONS = { equityCapital:0, reserves:1, borrowings:2, totalLiabilities:4, fixedAssets:5, investments:7, totalAssets:9 }
const CF_POSITIONS      = { operatingCF:0, investingCF:1, financingCF:2, freeCashFlow:4 }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { ticker, consolidated = 'true' } = req.query
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' })

  const suffix = consolidated === 'false' ? '' : '/consolidated'
  const url = `https://www.screener.in/company/${encodeURIComponent(ticker.toUpperCase())}${suffix}/`

  let html
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.screener.in/',
        'Cache-Control': 'no-cache'
      }
    })
    if (r.status === 404) return res.status(404).json({ error: `"${ticker}" not found on Screener.in` })
    if (!r.ok) return res.status(r.status).json({ error: `Screener returned ${r.status}` })
    html = await r.text()

    // Detect Cloudflare challenge page - screener.in uses CF protection
    // CF challenge has no profit-loss section and shows "Just a moment" or cf-browser-verification
    const isCloudflare = html.includes('cf-browser-verification')
      || html.includes('Just a moment')
      || html.includes('_cf_chl_')
      || html.includes('challenge-platform')
      || !html.includes('id="profit-loss"')  // valid screener page always has this

    if (isCloudflare) {
      console.warn('[screener] Cloudflare challenge detected for', ticker)
      return res.status(503).json({
        error: `Screener.in blocked this request (Cloudflare). Data will come from Yahoo Finance only.`
      })
    }
  } catch (err) {
    return res.status(500).json({ error: `Network error: ${err.message}` })
  }

  const result = parseScreenerHTML(html, ticker)
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate')
  return res.status(200).json(result)
}

function parseScreenerHTML(html, ticker) {
  const nameMatch = html.match(/<h1[^>]*>\s*([^<\n]+?)\s*<\/h1>/)
  const name = nameMatch ? nameMatch[1].trim() : ticker

  const keyStats = extractKeyStats(html)

  const incomeTable   = parseSection(html, 'profit-loss',   INCOME_ALIASES)
  const balanceTable  = parseSection(html, 'balance-sheet', BALANCE_ALIASES)
  const cashflowTable = parseSection(html, 'cash-flow',     CASHFLOW_ALIASES)

  const years = incomeTable.headers.length ? incomeTable.headers
    : balanceTable.headers.length ? balanceTable.headers : []

  const incomeHistory = years.map((yr, i) => {
    const rev = getVal(incomeTable, 'revenue', i)
    const exp = getVal(incomeTable, 'expenses', i)
    const op  = getVal(incomeTable, 'operatingProfit', i)
    const dep = getVal(incomeTable, 'depreciation', i)
    const int = getVal(incomeTable, 'interest', i)
    const np  = getVal(incomeTable, 'netProfit', i)
    const eps = getVal(incomeTable, 'eps', i)
    const oth = getVal(incomeTable, 'otherIncome', i)
    const pbt = getVal(incomeTable, 'profitBeforeTax', i)
    const opDerived = op ?? (rev != null && exp != null ? rev - exp : null)
    const ebitda = (opDerived != null && dep != null) ? opDerived + dep
      : opDerived != null ? opDerived : null
    return {
      year: parseYear(yr),
      revenue:         tag(rev,       'source'),
      expenses:        tag(exp,       'source'),
      operatingProfit: tag(opDerived, op != null ? 'source' : 'derived', op != null ? null : 'Revenue − Expenses'),
      ebitda:          tag(ebitda,    dep != null && opDerived != null ? 'derived' : opDerived != null ? 'derived' : null,
                           dep != null ? 'Op.Profit + Depreciation' : 'Op.Profit proxy'),
      depreciation:    tag(dep,  'source'),
      interest:        tag(int,  'source'),
      otherIncome:     tag(oth,  'source'),
      profitBeforeTax: tag(pbt,  'source'),
      netProfit:       tag(np,   'source'),
      eps:             tag(eps,  'source'),
    }
  })

  const balanceHistory = years.map((yr, i) => {
    const eqCap  = getVal(balanceTable, 'equityCapital', i)
    const res    = getVal(balanceTable, 'reserves', i)
    const borr   = getVal(balanceTable, 'borrowings', i)
    const totAss = getVal(balanceTable, 'totalAssets', i)
    const totLia = getVal(balanceTable, 'totalLiabilities', i)
    const fixed  = getVal(balanceTable, 'fixedAssets', i)
    const invest = getVal(balanceTable, 'investments', i)
    const equity = (eqCap != null && res != null) ? eqCap + res : null
    return {
      year: parseYear(yr),
      equityCapital:    tag(eqCap,  'source'),
      reserves:         tag(res,    'source'),
      totalEquity:      tag(equity, equity != null ? 'derived' : null, 'Equity Capital + Reserves'),
      totalDebt:        tag(borr,   'source'),
      totalAssets:      tag(totAss, 'source'),
      totalLiabilities: tag(totLia, 'source'),
      fixedAssets:      tag(fixed,  'source'),
      investments:      tag(invest, 'source'),
    }
  })

  const cashflowHistory = years.map((yr, i) => {
    const opCF  = getVal(cashflowTable, 'operatingCF', i)
    const invCF = getVal(cashflowTable, 'investingCF', i)
    const finCF = getVal(cashflowTable, 'financingCF', i)
    const fcf   = getVal(cashflowTable, 'freeCashFlow', i)
    return {
      year: parseYear(yr),
      operatingCF:  tag(opCF,  'source'),
      investingCF:  tag(invCF, 'source'),
      financingCF:  tag(finCF, 'source'),
      freeCashFlow: tag(fcf,   'source'),
    }
  })

  const parserStatus = checkInvariants({ incomeHistory, balanceHistory, cashflowHistory })

  // Positional fallback if semantic matching failed
  if (parserStatus.degraded) {
    applyPositionalFallback(incomeHistory, balanceHistory, cashflowHistory,
      incomeTable, balanceTable, cashflowTable, years)
  }

  const price   = keyStats['currentprice']?.value ?? keyStats['cmp']?.value ?? null
  const mcapCr  = keyStats['marketcap']?.value ?? null
  const marketCap = mcapCr != null ? mcapCr * 1e7 : null

  return {
    source: 'screener', ticker: ticker.toUpperCase(), name,
    currency: 'INR', unit: 'Crores',
    keyStats, price, marketCap,
    incomeHistory:   incomeHistory.filter(r => r.year),
    balanceHistory:  balanceHistory.filter(r => r.year),
    cashflowHistory: cashflowHistory.filter(r => r.year),
    parserStatus
  }
}

function extractSectionHTML(html, sectionId) {
  // Find section by id - robust, handles nested tags correctly
  const idPattern = new RegExp(`id=["']${sectionId}["']`, 'i')
  const idMatch = idPattern.exec(html)
  if (!idMatch) return ''

  // Find start of the opening tag
  const tagStart = html.lastIndexOf('<', idMatch.index)
  if (tagStart === -1) return ''

  const afterTag = html.slice(tagStart)
  const contentStart = afterTag.indexOf('>') + 1

  // Walk forward tracking section nesting depth to find matching close
  const openRe  = /<section[\s\S]*?>/gi
  const closeRe = /<\/section>/gi
  let depth = 0, pos = 0, endPos = afterTag.length

  while (pos < afterTag.length) {
    openRe.lastIndex  = pos
    closeRe.lastIndex = pos
    const nextOpen  = openRe.exec(afterTag)
    const nextClose = closeRe.exec(afterTag)
    const openPos   = nextOpen  ? nextOpen.index  : Infinity
    const closePos  = nextClose ? nextClose.index : Infinity
    if (openPos === Infinity && closePos === Infinity) break
    if (openPos < closePos) {
      depth++; pos = openPos + 1
    } else {
      depth--; pos = closePos + 1
      if (depth === 0) { endPos = closePos; break }
    }
  }
  return afterTag.slice(contentStart, endPos)
}

function parseSection(html, sectionId, aliasMap) {
  const sectionHTML = extractSectionHTML(html, sectionId)
  if (!sectionHTML) return { headers: [], rows: {}, rawRows: [] }

  // Parse headers
  const theadMatch = sectionHTML.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)
  const headers = []
  if (theadMatch) {
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi
    let m
    while ((m = thRe.exec(theadMatch[1])) !== null) {
      const text = stripHTML(m[1]).trim()
      if (text) headers.push(text)
    }
    headers.shift() // remove label column header
  }

  // Parse rows
  const tbodyMatch = sectionHTML.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)
  const rawRows = []
  const rows = {}

  if (tbodyMatch) {
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch
    while ((trMatch = trRe.exec(tbodyMatch[1])) !== null) {
      const cells = []
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi
      let tdMatch
      while ((tdMatch = tdRe.exec(trMatch[1])) !== null) {
        cells.push(tdMatch[1])
      }
      if (cells.length < 2) continue
      const rawLabel = stripHTML(cells[0]).trim()
      const normalizedLabel = normalizeLabel(rawLabel)
      const values = cells.slice(1).map(c => parseScreenerNum(stripHTML(c)))
      rawRows.push({ rawLabel, normalizedLabel, values })

      for (const [field, aliases] of Object.entries(aliasMap)) {
        if (rows[field]) continue  // first match wins
        for (const alias of aliases) {
          if (normalizedLabel === alias || normalizedLabel.startsWith(alias)) {
            rows[field] = values
            break
          }
        }
      }
    }
  }

  return { headers, rows, rawRows }
}

function extractKeyStats(html) {
  const stats = {}
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let liMatch
  while ((liMatch = liRe.exec(html)) !== null) {
    const liContent = liMatch[1]
    const nameMatch = liContent.match(/<span[^>]*class="[^"]*name[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    if (!nameMatch) continue
    const name = stripHTML(nameMatch[1]).trim()
    if (!name) continue
    const valMatch = liContent.match(/<span[^>]*class="[^"]*(?:value|number)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    if (!valMatch) continue
    const rawVal = stripHTML(valMatch[1]).trim()
    const num = parseScreenerNum(rawVal)
    const key = normalizeLabel(name)
    stats[key] = { raw: rawVal, value: num }
  }
  return stats
}

function checkInvariants({ incomeHistory, balanceHistory, cashflowHistory }) {
  const issues = []
  if (!incomeHistory.some(r => r.revenue?.value != null && r.revenue.value > 0))  issues.push('revenue')
  if (!incomeHistory.some(r => r.netProfit?.value != null))                        issues.push('netProfit')
  if (!balanceHistory.some(r => r.totalAssets?.value != null && r.totalAssets.value > 0)) issues.push('totalAssets')
  return {
    degraded: issues.length >= 2,
    missingCore: issues,
    message: issues.length === 0 ? 'ok'
      : `Could not extract: ${issues.join(', ')}. Using positional fallback.`
  }
}

function applyPositionalFallback(incH, balH, cfH, incT, balT, cfT, years) {
  years.forEach((_, i) => {
    const row = incH[i]
    if (row.revenue?.value != null) return
    for (const [field, pos] of Object.entries(INCOME_POSITIONS)) {
      if (incT.rawRows[pos] && row[field]?.value == null) {
        const val = incT.rawRows[pos].values[i]
        if (val != null) row[field] = tag(val, 'positional', `Row ${pos+1} of P&L`)
      }
    }
    const op = row.operatingProfit?.value, dep = row.depreciation?.value
    if (op != null && row.ebitda?.value == null) {
      row.ebitda = tag(dep != null ? op+dep : op, 'derived',
        dep != null ? 'Op.Profit+Dep (positional)' : 'Op.Profit (positional)')
    }
  })
  years.forEach((_, i) => {
    const row = balH[i]
    if (row.totalAssets?.value != null) return
    for (const [field, pos] of Object.entries(BALANCE_POSITIONS)) {
      if (balT.rawRows[pos] && row[field]?.value == null) {
        const val = balT.rawRows[pos].values[i]
        if (val != null) row[field] = tag(val, 'positional', `Row ${pos+1} of Balance Sheet`)
      }
    }
    const ec = row.equityCapital?.value, res = row.reserves?.value
    if (ec != null && res != null && row.totalEquity?.value == null)
      row.totalEquity = tag(ec+res, 'derived', 'Equity Capital+Reserves (positional)')
  })
  years.forEach((_, i) => {
    const row = cfH[i]
    if (row.operatingCF?.value != null) return
    for (const [field, pos] of Object.entries(CF_POSITIONS)) {
      if (cfT.rawRows[pos] && row[field]?.value == null) {
        const val = cfT.rawRows[pos].values[i]
        if (val != null) row[field] = tag(val, 'positional', `Row ${pos+1} of Cash Flow`)
      }
    }
  })
}

function stripHTML(str) {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim()
}

function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function parseScreenerNum(str) {
  if (!str || str === '' || str === '-' || str === '--') return null
  const cleaned = String(str).replace(/,/g, '').replace(/%$/, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

function parseYear(header) {
  const m = header.match(/\d{4}/)
  return m ? m[0] : header
}

function getVal(table, field, colIndex) {
  const row = table.rows[field]
  if (!row) return null
  const v = row[colIndex]
  return v != null && !isNaN(v) ? v : null
}

function tag(value, status, formula = null) {
  if (value == null || status == null) return { value: null, status: 'unavailable', formula: null }
  return { value, status, formula }
}
