/**
 * api/nseIndices.js — Vercel serverless (CommonJS)
 *
 * Real NSE sectoral index constituents, for real peer candidates — see
 * src/api/peersClient.js's fetchSectorConstituents() for why this exists:
 * Yahoo's own recommendationsBySymbol() has documented weak coverage for
 * international stocks (confirmed empty for RELIANCE.NS, and for
 * BHARTIARTL.NS the "recommendations" it does return are five unrelated
 * large-caps with nothing to do with telecom) and there's no custom
 * sector+region filter available through yahoo-finance2's screener()
 * either. NSE Indices Ltd (niftyindices.com — a separate, much less
 * defended property from nseindia.com's main site, which DOES require a
 * real browser session and 403s a bare request) publishes real,
 * exchange-maintained sectoral index constituent lists as plain CSVs.
 *
 * /api/nseIndices?index=oilGas
 * -> https://niftyindices.com/IndexConstituent/ind_niftyoilgaslist.csv
 *
 * `index` must be a key in INDEX_FILES below — every one of NSE's 28
 * published SECTORAL indices (niftyindices.com/indices/equity/
 * sectoral-indices — enumerated and each CSV individually confirmed live
 * on 2026-09-08), not a hand-picked subset. There is no single filename
 * pattern to construct from a slug: most are ind_nifty<name>list.csv
 * (lowercase, no separator), but many are ind_nifty<CamelCase>_list.csv,
 * one capitalizes "Nifty" itself (ind_NiftyCement_list.csv), and one puts
 * the underscore before the name instead of after
 * (ind_nifty_privatebanklist.csv) — guessing a template silently 404s (or
 * worse, hits niftyindices.com's disguised-404-as-200 page, see below) for
 * most of these, so every filename here is copied from a verified fetch,
 * not derived. A lookup table also means an unknown key is simply
 * rejected rather than used to construct some arbitrary niftyindices.com
 * URL.
 *
 * "Nifty Energy" is deliberately NOT in this list — niftyindices.com
 * itself files it under /thematic-indices/, not /sectoral-indices/, and
 * confirmed live it mixes oil & gas with Power and Capital Goods (three
 * different sectoral indices below) under one broader theme. Real peer
 * comparison wants the precise sectoral index (oilGas), not the thematic
 * grouping.
 */

const { checkOrigin, rateLimit, ALLOWED_ORIGINS } = require('./_lib.js')

// A plain server-side fetch without a browser-like User-Agent risks being
// blocked the same way nseindia.com's main site blocks bare requests (see
// the module docblock) — niftyindices.com has been more permissive in
// testing, but there's no reason to make that worse than necessary.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// Confirmed live: niftyindices.com serves 404 error PAGES with an HTTP 200
// status — status-code checking alone would silently accept a 404 as if
// it were real data. Real CSVs from this endpoint always start with this
// exact header.
const CSV_HEADER_PREFIX = 'Company Name,Industry,Symbol'

// Every filename below was fetched directly and confirmed to return a
// real CSV (not the disguised-404 page) before being added — see the
// module docblock for why a template can't generate these.
const INDEX_FILES = {
  auto: 'ind_niftyautolist.csv',
  bank: 'ind_niftybanklist.csv',
  capitalGoods: 'ind_niftyCapitalGoods_list.csv',
  cement: 'ind_NiftyCement_list.csv',
  chemicals: 'ind_niftyChemicals_list.csv',
  commercialTransport: 'ind_niftyCommercialTransportServices_list.csv',
  construction: 'ind_niftyConstruction_list.csv',
  consumerDurables: 'ind_niftyconsumerdurableslist.csv',
  consumerServices: 'ind_niftyConsumerServices_list.csv',
  financialServices: 'ind_niftyfinancelist.csv',
  fmcg: 'ind_niftyfmcglist.csv',
  healthcare: 'ind_niftyhealthcarelist.csv',
  hospitals: 'ind_niftyHospitals_list.csv',
  housingFinance: 'ind_niftyHousingFinance_list.csv',
  insurance: 'ind_niftyInsurance_list.csv',
  it: 'ind_niftyitlist.csv',
  media: 'ind_niftymedialist.csv',
  metal: 'ind_niftymetallist.csv',
  nbfc: 'ind_niftyNBFC_list.csv',
  oilGas: 'ind_niftyoilgaslist.csv',
  pharma: 'ind_niftypharmalist.csv',
  power: 'ind_niftyPower_list.csv',
  privateBank: 'ind_nifty_privatebanklist.csv',
  psuBank: 'ind_niftypsubanklist.csv',
  realty: 'ind_niftyrealtylist.csv',
  reitsRealty: 'ind_niftyREITsRealty_list.csv',
  retail: 'ind_niftyRetail_list.csv',
  telecom: 'ind_niftyTelecommunications_list.csv',
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return []
  // No quoted/embedded-comma fields observed in this feed (company names,
  // industry labels, symbols, series, ISIN codes are all comma-free) — a
  // plain split is enough for this specific, verified-simple format.
  const header = lines[0].split(',').map(h => h.trim())
  const nameIdx = header.indexOf('Company Name')
  const industryIdx = header.indexOf('Industry')
  const symbolIdx = header.indexOf('Symbol')
  if (nameIdx === -1 || symbolIdx === -1) return []
  return lines.slice(1).map(line => {
    const cols = line.split(',')
    return {
      name: (cols[nameIdx] || '').trim(),
      industry: industryIdx >= 0 ? (cols[industryIdx] || '').trim() : null,
      symbol: (cols[symbolIdx] || '').trim(),
    }
  }).filter(row => row.symbol)
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.has(origin) ? origin : [...ALLOWED_ORIGINS][0])
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!checkOrigin(req, res)) return
  if (!rateLimit(req, res, { max: 60, windowMs: 60_000, keyPrefix: 'nseIndices' })) return

  const index = String(req.query.index || '').trim()
  const filename = INDEX_FILES[index]
  if (!filename) return res.status(400).json({ error: 'Unknown index' })

  const url = `https://niftyindices.com/IndexConstituent/${filename}`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/csv,*/*' } })
    if (!r.ok) {
      return res.status(200).json({ constituents: [], error: `upstream_${r.status}` })
    }
    const text = await r.text()
    if (!text.trimStart().startsWith(CSV_HEADER_PREFIX)) {
      // The disguised-404-as-200 case (or any other non-CSV response) —
      // decline rather than parse HTML as if it were data.
      return res.status(200).json({ constituents: [], error: 'not_found' })
    }
    const constituents = parseCsv(text)
    // Index reconstitution is infrequent (NSE's own periodic review, not
    // something this app tracks) — a day fresh, a week stale-tolerant is
    // generous to this third-party dependency without going stale in any
    // way that matters for peer discovery.
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800')
    return res.status(200).json({ constituents })
  } catch (e) {
    console.info(`[nseIndices] ${index}:`, e?.message)
    return res.status(200).json({ constituents: [], error: 'fetch_failed' })
  }
}
