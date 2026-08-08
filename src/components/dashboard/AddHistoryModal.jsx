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
  // Quarterly is the same P&L rows sliced by quarter. It's what makes an
  // in-year read possible at all — the annual table can't say anything about
  // how the current year is tracking until the year is over.
  { key: 'quarterly', label: 'Quarterly Results', icon: '🗓️',
    hint: 'Same rows as P&L, one column per quarter. Switch Screener to the quarterly view.', expanders: 'income' },
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
// Quarterly previews the same fields as the annual P&L — same rows, different
// column periods — so it reuses that label set rather than duplicating it.
FIELD_LABELS.quarterly = FIELD_LABELS.income

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
  const [pasteText, setPasteText] = useState({ income: '', quarterly: '', balance: '', cashflow: '', holdings: '' })
  const [results, setResults] = useState(null)      // { income:{…}, …, holdings:{ok,…} }
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    if (!open) return
    setPasteText({ income: '', quarterly: '', balance: '', cashflow: '', holdings: '' })
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
    // Annual financials → history series.
    // Quarterly is deliberately NOT sent here: incomeHistory is keyed by fiscal
    // year and every consumer (ratios, CAGR, the DCF) reads it as full years.
    // Merging quarters in would silently corrupt all of them — a Q2 revenue
    // figure sitting in a year slot reads as a catastrophic collapse.
    for (const [tableType, result] of Object.entries(results)) {
      if (tableType === 'holdings' || tableType === 'quarterly') continue
      if (result.matchedCount > 0) {
        onApplyAll(tableType, tagPastedRows(result.rows, tableType, { scale: pasteScale(currency, ticker) }))
      }
    }
    // Quarterly → its own series, alongside (not inside) the annual history.
    const q = results.quarterly
    if (q?.matchedCount > 0 && !q.rejected) {
      const scale = pasteScale(currency, ticker)
      const money = new Set(['revenue', 'operatingProfit', 'netProfit', 'interest', 'depreciation'])
      setQualInputs({
        quarterlyData: {
          // Keep the raw shape: period label, FY placement and quarter index all
          // travel with the row so guidance tracking and seasonality don't have
          // to re-derive which fiscal year a March quarter belongs to.
          rows: q.rows.map(r => {
            const out = { period: r.period ?? r.year, fiscalYear: r.fiscalYear,
                          quarterIndex: r.quarterIndex }
            for (const [k, v] of Object.entries(r)) {
              if (k === 'year' || k === 'period' || k === 'fiscalYear' ||
                  k === 'quarterIndex' || k === 'fiscalYearFull' || k === 'assumedIndianFY') continue
              out[k] = (v != null && money.has(k)) ? v * scale : v
            }
            return out
          }),
          savedAt: Date.now(),
        },
      })
    }
    // Shareholding → store (promoter holding, Block-5 gate input)
    const h = results.holdings
    if (h?.ok && h.promoterSeries?.length) {
      setQualInputs({
        holdingsData: {
          promoterSeries: h.promoterSeries,
          fiiSeries: h.fiiSeries || [],
          diiSeries: h.diiSeries || [],
          quarters: h.quarters,
          savedAt: Date.now(),
        },
      })
    }
    setApplied(true)
  }

  const handleClose = () => {
    setPasteText({ income: '', quarterly: '', balance: '', cashflow: '', holdings: '' })
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
                  <div className="text-xs text-slate-600 space-y-0.5">
                    <p>{t.hint}</p>
                    {/* Which "+" to click, straight from the dictionary. The old
                        hard-written tip named only the Expenses row — the one
                        expander anyone had noticed — and missed cash and capex. */}
                    {expandersFor(ALL_METRICS, t.key).map(h => (
                      <p key={h.expand} className="text-accent/80">
                        Click the <strong>+</strong> on <strong>{h.expand}</strong> before copying — it reveals {h.metrics.join(', ')}
                      </p>
                    ))}
                  </div>
                  {/* Font stays at xs: a 16px monospace blob shows barely half
                      the columns, which defeats the point of eyeballing the
                      paste before confirming. Mobile will zoom on focus as a
                      result, so Clear sits BELOW the box instead of above it —
                      the zoom scrolls the focused field into view and anything
                      under it comes along, whereas the old position above the
                      field was pushed off-screen. */}
                  <textarea
                    value={pasteText[t.key]}
                    onChange={e => { setPasteText(prev => ({ ...prev, [t.key]: e.target.value })); setResults(null) }}
                    placeholder={`Paste ${t.label} table here (optional)...`}
                    rows={3}
                    className="w-full bg-navy-800 border border-navy-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-accent resize-none" />
                  {pasteText[t.key].trim().length > 0 && (
                    <div className="flex justify-end">
                      <button type="button"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { setPasteText(prev => ({ ...prev, [t.key]: '' })); setResults(null) }}
                        className="text-[11px] px-2 py-1 rounded border border-navy-700 text-slate-400 hover:text-bear hover:border-bear/50 transition-colors">
                        ✕ Clear
                      </button>
                    </div>
                  )}
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
  if (r.rejected) return '✗ ' + (r.warnings?.[0] || 'not accepted')
  if (key === 'quarterly' && r.matchedCount > 0) {
    // Quarters covered matters more here than field count: the point of this
    // table is how much of the current year has actually reported.
    const fys = [...new Set(r.rows.map(x => x.fiscalYear).filter(Boolean))]
    return `✓ ${r.rows.length} quarters${fys.length ? ` (${fys.join(', ')})` : ''}`
  }
  return r.matchedCount > 0 ? `✓ ${r.matchedCount} fields parsed` : '✗ nothing recognized'
}

