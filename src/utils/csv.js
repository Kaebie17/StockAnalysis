/**
 * src/utils/csv.js
 *
 * Handles all CSV/file operations:
 *   1. Parse uploaded CSV into structured raw data
 *   2. Export override data as JSON to file system
 *   3. Import JSON override from file system
 *   4. File System Access API (Chrome/Android auto-fetch)
 *      with fallback to manual file picker (Safari/iOS)
 *
 * CSV data priority: CSV > Screener > Yahoo for raw foundational fields
 * Calculated metrics are NEVER overridden by CSV — always engine-computed
 */

import Papa from 'papaparse'

const FOLDER_NAME = 'StockVal Data'
const FILE_PREFIX = 'stockval_'

// Fields that CSV can provide (raw foundational only — not calculated)
export const CSV_RAW_FIELDS = [
  'revenue', 'operatingProfit', 'depreciation', 'interest',
  'netProfit', 'eps', 'equityCapital', 'reserves', 'totalDebt',
  'totalAssets', 'cash', 'currentAssets', 'currentLiabilities',
  'inventory', 'receivables', 'payables',
  'operatingCF', 'investingCF', 'financingCF', 'freeCashFlow', 'capex',
  'price', 'sharesOutstanding'
]

// Fields that are ALWAYS calculated — CSV cannot override these
export const CALCULATED_FIELDS = [
  'roe', 'roce', 'roa', 'netMargin', 'operatingMargin', 'ebitdaMargin',
  'grossMargin', 'de', 'icr', 'pe', 'pb', 'ps', 'evEbitda', 'evRevenue',
  'grahamNumber', 'revCagr', 'fcfYield', 'fcfConversion', 'bookPerShare',
  'ebitda', 'ev', 'netDebt', 'capitalEmployed'
]

// ─── CSV Parser ───────────────────────────────────────────────────────────────

/**
 * Parse uploaded CSV file into structured data object.
 * Expected columns: year, revenue, netProfit, [optional fields...]
 * Numbers can be in absolute INR, Crores, or Millions — user specifies
 */
export function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: ({ data, errors }) => {
        if (errors.length > 0 && data.length === 0) {
          reject(new Error(`CSV parse error: ${errors[0].message}`))
          return
        }

        try {
          const parsed = buildFromCSVRows(data)
          resolve(parsed)
        } catch (err) {
          reject(new Error(`CSV structure error: ${err.message}`))
        }
      },
      error: (err) => reject(new Error(`File read error: ${err.message}`))
    })
  })
}

function buildFromCSVRows(rows) {
  if (!rows.length) throw new Error('CSV has no data rows')

  // Detect scale from header or first row metadata
  // CSV can include a row: unit, Crores (or Millions, Absolute)
  const unitRow = rows.find(r =>
    String(r.year || r.Year || '').toLowerCase().includes('unit') ||
    String(r.year || r.Year || '').toLowerCase().includes('scale')
  )
  const unit = unitRow
    ? String(Object.values(unitRow)[1] || '').toLowerCase()
    : 'crores'  // default assumption for Indian companies
  const multiplier = unit.includes('absolute') || unit.includes('inr') ? 1
    : unit.includes('million') || unit.includes('mn') ? 1e6
    : 1e7  // crores default

  const dataRows = rows.filter(r => {
    const yr = r.year || r.Year
    return yr && !isNaN(parseInt(yr))
  })

  if (!dataRows.length) throw new Error('No valid year rows found. Ensure a "year" column exists.')

  // Map flexible column names
  const col = (row, ...names) => {
    for (const n of names) {
      const v = row[n] ?? row[n.toLowerCase()] ?? row[n.toUpperCase()]
        ?? row[n.replace(/([A-Z])/g, '_$1').toLowerCase()]  // camelCase → snake_case
      if (v != null && v !== '') return typeof v === 'number' ? v * multiplier : null
    }
    return null
  }

  const incomeHistory = dataRows.map(r => ({
    year:            String(r.year || r.Year),
    revenue:         col(r, 'revenue', 'Revenue', 'Sales', 'sales', 'totalRevenue'),
    operatingProfit: col(r, 'operatingProfit', 'operating_profit', 'EBIT', 'ebit', 'operatingIncome'),
    depreciation:    col(r, 'depreciation', 'Depreciation', 'DA', 'da'),
    interest:        col(r, 'interest', 'Interest', 'interestExpense', 'financeCosts'),
    netProfit:       col(r, 'netProfit', 'net_profit', 'PAT', 'pat', 'netIncome', 'NetProfit'),
    eps:             col(r, 'eps', 'EPS', 'earningsPerShare'),
    ebitda:          col(r, 'ebitda', 'EBITDA'),  // if provided directly
    grossProfit:     col(r, 'grossProfit', 'gross_profit', 'GrossProfit'),
  })).filter(r => r.revenue != null || r.netProfit != null)

  const balanceHistory = dataRows.map(r => ({
    year:             String(r.year || r.Year),
    equityCapital:    col(r, 'equityCapital', 'equity_capital', 'shareCapital', 'paidUpCapital'),
    reserves:         col(r, 'reserves', 'Reserves', 'reservesAndSurplus'),
    totalDebt:        col(r, 'totalDebt', 'total_debt', 'debt', 'borrowings', 'Borrowings'),
    totalAssets:      col(r, 'totalAssets', 'total_assets', 'TotalAssets'),
    cash:             col(r, 'cash', 'Cash', 'cashAndEquivalents'),
    currentAssets:    col(r, 'currentAssets', 'current_assets', 'CurrentAssets'),
    currentLiabilities: col(r, 'currentLiabilities', 'current_liabilities', 'CurrentLiabilities'),
    inventory:        col(r, 'inventory', 'Inventory'),
    receivables:      col(r, 'receivables', 'debtors', 'Debtors', 'accountsReceivable'),
    payables:         col(r, 'payables', 'creditors', 'Creditors', 'accountsPayable'),
  })).filter(r => r.totalAssets != null || r.totalDebt != null)

  const cashflowHistory = dataRows.map(r => ({
    year:         String(r.year || r.Year),
    operatingCF:  col(r, 'operatingCF', 'operating_cf', 'cashFromOperations', 'CFO'),
    investingCF:  col(r, 'investingCF', 'investing_cf', 'cashFromInvesting', 'CFI'),
    financingCF:  col(r, 'financingCF', 'financing_cf', 'cashFromFinancing', 'CFF'),
    freeCashFlow: col(r, 'freeCashFlow', 'fcf', 'FCF', 'free_cash_flow'),
    capex:        col(r, 'capex', 'CAPEX', 'capitalExpenditure'),
  })).filter(r => r.operatingCF != null || r.freeCashFlow != null)

  // Metadata from first row or separate metadata rows
  const meta = rows.find(r => String(r.year || '').toLowerCase() === 'meta' || String(r.year || '').toLowerCase() === 'info')
  const price         = meta ? col(meta, 'price', 'Price', 'CMP') : col(dataRows[dataRows.length-1], 'price', 'Price', 'CMP')
  const sharesOutstanding = meta ? col(meta, 'sharesOutstanding', 'shares', 'Shares') : null

  return {
    source: 'csv',
    unit,
    multiplier,
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    price: price ? price / multiplier : null,  // price is per share, not scaled
    sharesOutstanding: sharesOutstanding ? sharesOutstanding / multiplier : null,
    uploadedAt: new Date().toISOString()
  }
}

// ─── Merge CSV into normalized data ──────────────────────────────────────────

/**
 * Apply CSV data on top of existing normalized data.
 * CSV wins for all raw fields it provides.
 * Source tracking updated to show CSV origin.
 */
export function applyCSVOverrides(normalizedData, csvData) {
  if (!csvData) return normalizedData

  const merged = { ...normalizedData }

  // Price — only if CSV provides it AND it's more recent
  if (csvData.price != null) {
    merged.csvPrice = csvData.price  // store separately — don't override live price
  }

  if (csvData.sharesOutstanding != null) {
    merged.shares = csvData.sharesOutstanding
  }

  // Merge income history — CSV year data wins over source data
  merged.incomeHistory = mergeHistoryWithCSV(
    normalizedData.incomeHistory,
    csvData.incomeHistory,
    ['revenue','operatingProfit','depreciation','interest','netProfit','eps','ebitda','grossProfit']
  )

  merged.balanceHistory = mergeHistoryWithCSV(
    normalizedData.balanceHistory,
    csvData.balanceHistory,
    ['equityCapital','reserves','totalDebt','totalAssets','cash',
     'currentAssets','currentLiabilities','inventory','receivables','payables']
  )

  merged.cashflowHistory = mergeHistoryWithCSV(
    normalizedData.cashflowHistory,
    csvData.cashflowHistory,
    ['operatingCF','investingCF','financingCF','freeCashFlow','capex']
  )

  merged.csvData    = csvData       // keep original for swap UI
  merged.csvActive  = true

  return merged
}

function mergeHistoryWithCSV(existing, csvRows, fields) {
  if (!csvRows?.length) return existing

  const map = {}
  // Start with existing data
  for (const row of (existing || [])) {
    if (row.year) map[row.year] = { ...row }
  }

  // CSV wins for any field it provides
  for (const csvRow of csvRows) {
    if (!csvRow.year) continue
    if (!map[csvRow.year]) map[csvRow.year] = { year: csvRow.year }

    for (const field of fields) {
      if (csvRow[field] != null) {
        const prev = map[csvRow.year][field]
        map[csvRow.year][field] = {
          value: csvRow[field],
          status: 'csv',
          formula: null,
          // Store previous source value for swap UI
          sourceValue: prev?.value ?? null,
          sourceStatus: prev?.status ?? 'unavailable'
        }
      }
    }
  }

  return Object.values(map).sort((a, b) => a.year.localeCompare(b.year))
}

// ─── Field-level swap ────────────────────────────────────────────────────────

/**
 * Swap a single field for a specific year between CSV and source value.
 * Returns updated normalized data — caller must re-run ratios + valuation.
 */
export function swapField(normalizedData, year, historyType, field) {
  const histKey = historyType + 'History'
  const history = normalizedData[histKey]
  if (!history) return normalizedData

  const updated = history.map(row => {
    if (row.year !== year) return row
    const current = row[field]
    if (!current || current.sourceValue === undefined) return row

    // Swap current and source values
    return {
      ...row,
      [field]: {
        value:       current.sourceValue,
        status:      current.sourceStatus,
        formula:     null,
        sourceValue: current.value,
        sourceStatus: current.status
      }
    }
  })

  return { ...normalizedData, [histKey]: updated }
}

// ─── File System Export ───────────────────────────────────────────────────────

/**
 * Export CSV override data as JSON file.
 * Uses File System Access API on Chrome/Android for folder persistence.
 * Falls back to standard download on Safari/iOS.
 */
export async function exportOverrideJSON(ticker, csvData, folderHandle = null) {
  const filename = `${FILE_PREFIX}${ticker.replace(/[^A-Z0-9]/gi, '_')}.json`
  const payload  = JSON.stringify({ ticker, csvData, exportedAt: new Date().toISOString() }, null, 2)

  // Try File System Access API first (Chrome/Android)
  if (folderHandle) {
    try {
      const fileHandle = await folderHandle.getFileHandle(filename, { create: true })
      const writable   = await fileHandle.createWritable()
      await writable.write(payload)
      await writable.close()
      return { method: 'filesystem', filename }
    } catch (err) {
      console.warn('[csv] File System API write failed, falling back to download:', err)
    }
  }

  // Fallback: standard download (Safari/iOS)
  const blob = new Blob([payload], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return { method: 'download', filename }
}

// ─── File System Import ───────────────────────────────────────────────────────

/**
 * Try to auto-load override JSON for a ticker.
 * If folderHandle exists (Chrome/Android), read directly.
 * Otherwise return null — caller shows manual file picker.
 */
export async function autoLoadOverride(ticker, folderHandle) {
  if (!folderHandle) return null

  const filename = `${FILE_PREFIX}${ticker.replace(/[^A-Z0-9]/gi, '_')}.json`
  try {
    const fileHandle = await folderHandle.getFileHandle(filename)
    const file       = await fileHandle.getFile()
    const text       = await file.text()
    const parsed     = JSON.parse(text)
    return parsed.csvData ?? null
  } catch {
    return null  // file doesn't exist for this ticker
  }
}

/**
 * Request folder access (Chrome/Android only).
 * Returns folder handle or null if not supported/denied.
 */
export async function requestFolderAccess() {
  if (!window.showDirectoryPicker) return null  // not supported (Safari)

  try {
    const handle = await window.showDirectoryPicker({
      id: 'stockval-data',
      mode: 'readwrite',
      startIn: 'documents'
    })
    return handle
  } catch (err) {
    if (err.name === 'AbortError') return null  // user cancelled
    console.warn('[csv] Folder access failed:', err)
    return null
  }
}

/**
 * Parse a manually selected JSON override file (Safari/iOS fallback).
 */
export async function importOverrideFile(file) {
  const text   = await file.text()
  const parsed = JSON.parse(text)
  return parsed.csvData ?? null
}

/**
 * Open file picker for manual JSON import.
 * Accepts: .json files only.
 */
export function openFilePicker(onFile) {
  const input    = document.createElement('input')
  input.type     = 'file'
  input.accept   = '.json,application/json'
  input.onchange = e => {
    const file = e.target.files[0]
    if (file) onFile(file)
  }
  input.click()
}
