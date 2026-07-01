import React, { useState, useEffect } from 'react'
import { parsePastedTable, tagPastedRows } from '../../utils/pasteParser.js'
import { useApp } from '../../store/AppContext.jsx'

const TABLES = [
  { key: 'income',   label: 'Profit & Loss',  icon: '📊', hint: 'Revenue, Operating Profit, Net Profit, EPS, Interest, Depreciation' },
  { key: 'balance',  label: 'Balance Sheet',  icon: '⚖️', hint: 'Total Assets, Total Equity, Total Debt' },
  { key: 'cashflow', label: 'Cash Flow',      icon: '💵', hint: 'Operating Cash Flow, Free Cash Flow' },
]

// Labels for the verification preview, per table.
const FIELD_LABELS = {
  income:   { revenue: 'Revenue', operatingProfit: 'Operating Profit', depreciation: 'Depreciation', interest: 'Interest', netProfit: 'Net Profit', eps: 'EPS' },
  balance:  { equityCapital: 'Equity Capital', reserves: 'Reserves', totalEquity: 'Total Equity', totalDebt: 'Total Debt', totalAssets: 'Total Assets' },
  cashflow: { operatingCF: 'Operating Cash Flow', freeCashFlow: 'Free Cash Flow' },
}

const screenerUrl = (ticker) =>
  ticker
    ? `https://www.screener.in/company/${ticker.replace(/\.(NS|BO)$/i, '').toUpperCase()}/consolidated/`
    : null

// Screener reports financials in ₹ Crore; scale for Indian tickers to match Yahoo.
// Screener reports in ₹ Crore; the app stores absolute currency. Scale pasted
// numbers when the loaded stock is INR (Indian). Uses currency (reliable) with
// the exchange suffix as a fallback — the raw ticker often lacks .NS/.BO.
const pasteScale = (currency, ticker) =>
  (currency === 'INR' || /.(NS|BO)$/i.test(ticker || '')) ? 1e7 : 1

/**
 * General "I want more history/breadth" entry point — distinct from
 * GapFillModal (which only appears when specific metrics are missing).
 * Single screen, all 3 tables pasted at once.
 */
export default function AddHistoryModal({ open, onClose, ticker, onApplyAll }) {
  const { state: appState } = useApp()
  const currency = appState?.data?.currency
  const [pasteText, setPasteText] = useState({ income: '', balance: '', cashflow: '' })
  const [results, setResults]     = useState(null)
  const [applied, setApplied]     = useState(false)

  useEffect(() => {
    if (!open) return
    setPasteText({ income: '', balance: '', cashflow: '' })
    setResults(null)
    setApplied(false)
  }, [open])

  if (!open) return null

  const url = screenerUrl(ticker)

  const handleParseAll = () => {
    const out = {}
    for (const t of TABLES) {
      const text = pasteText[t.key].trim()
      if (!text) continue
      out[t.key] = parsePastedTable(text, t.key)
    }
    setResults(out)
  }

  const handleConfirm = () => {
    if (!results) return
    for (const [tableType, result] of Object.entries(results)) {
      if (result.matchedCount > 0) {
        const tagged = tagPastedRows(result.rows, tableType, { scale: pasteScale(currency, ticker) })
        onApplyAll(tableType, tagged)
      }
    }
    setApplied(true)
  }

  const handleClose = () => {
    setPasteText({ income: '', balance: '', cashflow: '' })
    setResults(null)
    setApplied(false)
    onClose()
  }

  const anyPasted = Object.values(pasteText).some(t => t.trim().length > 0)
  const totalMatched = results
    ? Object.values(results).reduce((s, r) => s + (r.matchedCount || 0), 0)
    : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && handleClose()}>
      <div className="card max-w-2xl w-full space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Add more history</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Extend years beyond Yahoo's data, or refresh to a more recent fiscal year
            </p>
          </div>
          <button onClick={handleClose} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
        </div>

        {!applied ? (
          <>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer"
                 className="btn-ghost text-sm w-full inline-flex items-center justify-center">
                Open Screener for {ticker} →
              </a>
            ) : (
              <p className="text-xs text-bear">No ticker available to open Screener.</p>
            )}
            <p className="text-xs text-slate-500">
              Copy whichever tables you want to add, paste each into its matching box below.
              You only need to fill in the ones you have.
            </p>

            <div className="space-y-3">
              {TABLES.map(t => (
                <div key={t.key} className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span>{t.icon}</span>
                    <span className="font-medium text-slate-300">{t.label}</span>
                    {results?.[t.key] && (
                      <span className={results[t.key].matchedCount > 0 ? 'text-bull' : 'text-bear'}>
                        {results[t.key].matchedCount > 0
                          ? `✓ ${results[t.key].matchedCount} fields parsed`
                          : '✗ nothing recognized'}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600">{t.hint}</p>
                  <textarea
                    value={pasteText[t.key]}
                    onChange={e => {
                      setPasteText(prev => ({ ...prev, [t.key]: e.target.value }))
                      setResults(null)
                    }}
                    placeholder={`Paste ${t.label} table here (optional)...`}
                    rows={3}
                    className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2
                               text-xs font-mono text-slate-200 placeholder-slate-600
                               focus:outline-none focus:border-accent resize-none"
                  />
                </div>
              ))}
            </div>

            {!results && (
              <button
                onClick={handleParseAll}
                disabled={!anyPasted}
                className="btn-primary text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed">
                Parse all
              </button>
            )}

            {results && (
              <>
                {Object.values(results).some(r => r.warnings?.length > 0) && (
                  <div className="bg-bear/10 border border-bear/30 rounded-lg p-2 text-xs text-bear space-y-0.5">
                    {Object.entries(results).flatMap(([k, r]) =>
                      (r.warnings || []).map((w, i) => <p key={k + i}>{TABLES.find(t => t.key === k)?.label}: {w}</p>)
                    )}
                  </div>
                )}

                {/* Verification preview — show exactly what was parsed, per table */}
                {Object.entries(results).map(([k, r]) => {
                  if (!r.rows?.length || r.matchedCount === 0) return null
                  const labels = FIELD_LABELS[k] || {}
                  const presentFields = Object.keys(labels).filter(
                    f => r.rows.some(row => row[f] != null)
                  )
                  if (presentFields.length === 0) return null
                  return (
                    <div key={k} className="space-y-1">
                      <div className="text-xs font-medium text-slate-300">
                        {TABLES.find(t => t.key === k)?.label} — parsed values
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-navy-700">
                              <th className="text-left py-1 text-slate-500">Field</th>
                              {r.years.map(y => (
                                <th key={y} className="text-right py-1 text-slate-500 px-2">{y}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {presentFields.map(f => (
                              <tr key={f} className="border-b border-navy-800/50">
                                <td className="py-1 text-slate-300">{labels[f]}</td>
                                {r.rows.map((row, i) => (
                                  <td key={i} className="text-right py-1 px-2 font-mono">
                                    {row[f] != null
                                      ? <span className="text-white">{row[f].toLocaleString()}</span>
                                      : <span className="text-slate-600">—</span>}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )
                })}

                <p className="text-xs text-slate-500">
                  Total fields recognized: {totalMatched}. Values shown as pasted (₹ Crore for Screener).
                  Check this against your Screener tab before confirming.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setResults(null)} className="btn-ghost text-sm flex-1">↺ Try again</button>
                  <button
                    onClick={handleConfirm}
                    disabled={totalMatched === 0}
                    className="btn-primary text-sm flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
                    Looks good, add it
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="text-center py-6 space-y-3">
            <div className="text-3xl">✅</div>
            <p className="text-sm text-slate-300">Data added and recalculated.</p>
            <button onClick={handleClose} className="btn-primary text-sm">Done</button>
          </div>
        )}
      </div>
    </div>
  )
}
