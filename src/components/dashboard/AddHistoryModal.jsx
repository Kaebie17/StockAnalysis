
import React, { useState, useEffect } from 'react'
import { parsePastedTable, tagPastedRows } from '../../utils/pasteParser.js'
import { expandHints as expandersFor, METRICS } from '../../engine/metrics.js'
import { parseHoldings } from '../../engine/parseHoldings.js'
import { useApp } from '../../store/AppContext.jsx'

const ALL_METRICS = Object.keys(METRICS)

const TABLES = [
  // The "+" tips come from the dictionary (src/engine/metrics.js), not from
  // whatever someone remembered. Every metric behind an expander is listed there
  // with its parent row, so this can never drift out of date the way the old
  // hand-written "expand the Expenses row" tip did — that one named the only
  // expander anyone had noticed, and missed cash and capex entirely.
  { key: 'income',   label: 'Profit & Loss',  icon: '📊',
    hint: 'Revenue, Operating Profit, Net Profit, EPS, Interest, Depreciation.', expanders: 'income' },
  { key: 'balance',  label: 'Balance Sheet',  icon: '⚖️',
    hint: 'Total Assets, Total Equity, Total Debt.', expanders: 'balance' },
  { key: 'cashflow', label: 'Cash Flow',      icon: '💵',
    hint: 'Operating Cash Flow, Free Cash Flow.', expanders: 'cashflow' },
  { key: 'holdings', label: 'Shareholding',   icon: '👥', hint: 'Quarter row + Promoters row (promoter holding %)' },
]

const FIELD_LABELS = {
  income:   { revenue: 'Revenue', operatingProfit: 'Operating Profit', depreciation: 'Depreciation', interest: 'Interest', netProfit: 'Net Profit', eps: 'EPS' },
  balance:  { equityCapital: 'Equity Capital', reserves: 'Reserves', totalEquity: 'Total Equity', totalDebt: 'Total Debt', totalAssets: 'Total Assets' },
  cashflow: { operatingCF: 'Operating Cash Flow', freeCashFlow: 'Free Cash Flow' },
}

const screenerUrl = (ticker) =>
  ticker ? `https://www.screener.in/company/${ticker.replace(/\.(NS|BO)$/i, '').toUpperCase()}/consolidated/` : null

const pasteScale = (currency, ticker) =>
  (currency === 'INR' || /.(NS|BO)$/i.test(ticker || '')) ? 1e7 : 1

/**
 * "Add more history" — one paste surface for everything Screener gives. Paste
 * whichever tables you have (P&L / Balance / Cash Flow / Shareholding), hit Parse
 * all, review, and one confirm routes each to where it belongs: financials extend
 * the history series, promoter holding is saved to the store (Block-5 gate input).
 */
export default function AddHistoryModal({ open, onClose, ticker, onApplyAll }) {
  const { state: appState, setQualInputs } = useApp()
  const currency = appState?.data?.currency
  const [pasteText, setPasteText] = useState({ income: '', balance: '', cashflow: '', holdings: '' })
  const [results, setResults] = useState(null)      // { income:{…}, …, holdings:{ok,…} }
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    if (!open) return
    setPasteText({ income: '', balance: '', cashflow: '', holdings: '' })
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
      out[t.key] = t.key === 'holdings' ? parseHoldings(text) : parsePastedTable(text, t.key)
    }
    setResults(out)
  }

  const handleConfirm = () => {
    if (!results) return
    // Financials → history series
    for (const [tableType, result] of Object.entries(results)) {
      if (tableType === 'holdings') continue
      if (result.matchedCount > 0) {
        onApplyAll(tableType, tagPastedRows(result.rows, tableType, { scale: pasteScale(currency, ticker) }))
      }
    }
    // Shareholding → store (promoter holding, Block-5 gate input)
    const h = results.holdings
    if (h?.ok && h.promoterSeries?.length) {
      setQualInputs({ holdingsData: { promoterSeries: h.promoterSeries, quarters: h.quarters, savedAt: Date.now() } })
    }
    setApplied(true)
  }

  const handleClose = () => {
    setPasteText({ income: '', balance: '', cashflow: '', holdings: '' })
    setResults(null); setApplied(false); onClose()
  }

  const anyPasted = Object.values(pasteText).some(t => t.trim().length > 0)
  const finMatched = results
    ? Object.entries(results).filter(([k]) => k !== 'holdings').reduce((s, [, r]) => s + (r.matchedCount || 0), 0)
    : 0
  const holdingsOk = results?.holdings?.ok
  const totalOk = finMatched + (holdingsOk ? 1 : 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && handleClose()}>
      <div className="card max-w-2xl w-full space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Add more history</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Paste any Screener tables — financials extend history, shareholding feeds Quality &amp; Moat
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
              Copy whichever tables you want to add, paste each into its box. Fill only the ones you have.
            </p>

            <div className="space-y-3">
              {TABLES.map(t => (
                <div key={t.key} className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span>{t.icon}</span>
                    <span className="font-medium text-slate-300">{t.label}</span>
                    {results?.[t.key] && (
                      <span className={parsedOk(results[t.key], t.key) ? 'text-bull' : 'text-bear'}>
                        {parsedNote(results[t.key], t.key)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600">{t.hint}}
                  {expandersFor(ALL_METRICS, t.key).map(h => (
                    <span key={h.expand} className="block text-accent/80">
                      Click the + on <strong>{h.expand}</strong> before copying — it reveals {h.metrics.join(', ')}
                    </span>
                  ))}
                  {'</p>
                  <textarea
                    value={pasteText[t.key]}
                    onChange={e => { setPasteText(prev => ({ ...prev, [t.key]: e.target.value })); setResults(null) }}
                    placeholder={`Paste ${t.label} table here (optional)...`}
                    rows={3}
                    className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />
                </div>
              ))}
            </div>

            {!results && (
              <button onClick={handleParseAll} disabled={!anyPasted}
                className="btn-primary text-sm w-full disabled:opacity-40 disabled:cursor-not-allowed">
                Parse all
              </button>
            )}

            {results && (
              <>
                {/* Financial preview */}
                {Object.entries(results).map(([k, r]) => {
                  if (k === 'holdings' || !r.rows?.length || r.matchedCount === 0) return null
                  const labels = FIELD_LABELS[k] || {}
                  const present = Object.keys(labels).filter(f => r.rows.some(row => row[f] != null))
                  if (present.length === 0) return null
                  return (
                    <div key={k} className="space-y-1">
                      <div className="text-xs font-medium text-slate-300">{TABLES.find(t => t.key === k)?.label} — parsed values</div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead><tr className="border-b border-navy-700">
                            <th className="text-left py-1 text-slate-500">Field</th>
                            {r.years.map(y => <th key={y} className="text-right py-1 text-slate-500 px-2">{y}</th>)}
                          </tr></thead>
                          <tbody>
                            {present.map(f => (
                              <tr key={f} className="border-b border-navy-800/50">
                                <td className="py-1 text-slate-300">{labels[f]}</td>
                                {r.rows.map((row, i) => (
                                  <td key={i} className="text-right py-1 px-2 font-mono">
                                    {row[f] != null ? <span className="text-white">{row[f].toLocaleString()}</span> : <span className="text-slate-600">—</span>}
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

                {/* Holdings preview */}
                {results.holdings && (
                  <div className={`text-xs rounded-lg px-3 py-2 ${results.holdings.ok ? 'bg-navy-800/50 text-slate-300' : 'bg-bear/10 text-bear'}`}>
                    {results.holdings.ok
                      ? `Promoter holding: ${results.holdings.promoterSeries[0].pct}% → ${results.holdings.promoterSeries[results.holdings.promoterSeries.length - 1].pct}% over ${results.holdings.quarters.length} quarters`
                      : results.holdings.note}
                  </div>
                )}

                <p className="text-xs text-slate-500">
                  Financial fields recognized: {finMatched}{holdingsOk ? ' · promoter holding parsed' : ''}. Check against your Screener tab before confirming.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setResults(null)} className="btn-ghost text-sm flex-1">↺ Try again</button>
                  <button onClick={handleConfirm} disabled={totalOk === 0}
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

function parsedOk(r, key) {
  return key === 'holdings' ? r.ok : r.matchedCount > 0
}
function parsedNote(r, key) {
  if (key === 'holdings') return r.ok ? '✓ promoter holding parsed' : '✗ ' + r.note
  return r.matchedCount > 0 ? `✓ ${r.matchedCount} fields parsed` : '✗ nothing recognized'
}