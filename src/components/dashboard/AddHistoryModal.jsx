import React, { useState, useEffect } from 'react'
import { parsePastedTable, tagPastedRows } from '../../utils/pasteParser.js'
import { expandHints as expandersFor, METRICS } from '../../engine/metrics.js'
import { parseHoldings } from '../../engine/parseHoldings.js'
import { useApp } from '../../store/AppContext.jsx'
import { getAliasOverrides, saveAliasOverride, deleteAliasOverride } from '../../utils/db.js'
import AliasReconcile from './AliasReconcile.jsx'
import Modal from '../Modal.jsx'

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
  income:   { revenue: 'Revenue', operatingProfit: 'Operating Profit', depreciation: 'Depreciation', interest: 'Interest', netProfit: 'Net Profit', eps: 'EPS', dividendPayout: 'Dividend Payout %',
              otherIncome: 'Other Income', profitBeforeTax: 'Profit Before Tax',
              exceptionalItems: 'Exceptional Items', exceptionalItemsAT: 'Exceptional Items (After Tax)',
              profitExclExceptional: 'Profit excl. Exceptional Items', profitForEPS: 'Profit for EPS',
              profitForPE: 'Profit for PE', profitFromAssociates: 'Profit from Associates',
              minorityInterest: 'Minority Share' },
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
export default function AddHistoryModal({ open, onClose, ticker, onApplyAll, focusTable = null }) {
  const { state: appState, setQualInputs } = useApp()
  const currency = appState?.data?.currency
  const [pasteText, setPasteText] = useState({ income: '', quarterly: '', balance: '', cashflow: '', holdings: '' })
  const [results, setResults] = useState(null)      // { income:{…}, …, holdings:{ok,…} }
  const [applied, setApplied] = useState(false)
  // Gap fill is the safe default and always available, not just conditionally
  // shown when an overlap happens to exist — it never overwrites a field that
  // already has a value, regardless of that value's origin (auto-fetched,
  // pasted earlier, or hand-corrected through the data-table editor). That
  // means it needs no special case for "first paste on an empty ticker" vs.
  // "adding a new year to an existing one" — on an empty table every cell is
  // missing, so gap fill already behaves as a full population; once anything
  // exists, it only fills the blanks. Replace is the explicit, visibly
  // destructive alternative — confirmed before it runs (see handleConfirm).
  const [pasteMode, setPasteMode] = useState('gapFill')
  const overwrite = pasteMode === 'replace'
  // Screener row-label -> field mappings the user has already confirmed,
  // keyed by table — full rows (not just the flattened label->field map
  // parsePastedTable wants), so AliasReconcile can actually display and
  // revise them rather than only applying them silently.
  const [overrideRowsByTable, setOverrideRowsByTable] = useState({})
  const flatOverrides = tableKey =>
    Object.fromEntries((overrideRowsByTable[tableKey] || []).map(r => [r.normalizedLabel, r.field]))

  // Scroll to the table the caller asked for. A data-quality flag names where
  // the answer lives, and dropping the user at the top of a five-table modal
  // makes them hunt for it.
  useEffect(() => {
    if (!open || !focusTable) return
    const id = setTimeout(() => {
      document.getElementById(`paste-table-${focusTable}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    return () => clearTimeout(id)
  }, [open, focusTable])

  useEffect(() => {
    if (!open) return
    setPasteText({ income: '', quarterly: '', balance: '', cashflow: '', holdings: '' })
    setResults(null)
    setApplied(false)
    setPasteMode('gapFill')
    ;(async () => {
      const next = {}
      for (const t of TABLES) {
        if (t.key === 'holdings') continue
        next[t.key] = await getAliasOverrides(t.key)
      }
      setOverrideRowsByTable(next)
    })()
  }, [open])

  if (!open) return null
  const url = screenerUrl(ticker)
  // A data-quality flag names exactly one table where the answer lives — showing
  // the other four alongside it just makes the user hunt for the one that
  // matters. General "Add more history" (no focusTable) still gets everything.
  // A hint that doesn't match a real table key falls back to everything too,
  // rather than silently rendering zero paste boxes.
  const focusedMatch = focusTable ? TABLES.filter(t => t.key === focusTable) : []
  const visibleTables = focusedMatch.length ? focusedMatch : TABLES
  const focusLabel = focusedMatch.length ? focusedMatch[0].label : null

  // What's actually stored right now, per table, keyed by year — so the
  // preview can say which parsed fields are new vs. already set (and would
  // be silently kept unless Overwrite is checked) instead of leaving that
  // invisible until after confirming.
  const existingHistoryFor = (tableType) => {
    if (tableType === 'income' || tableType === 'quarterly')
      return appState?.data?.reportedIncomeHistory || appState?.data?.incomeHistory || []
    if (tableType === 'balance')  return appState?.data?.balanceHistory  || []
    if (tableType === 'cashflow') return appState?.data?.cashflowHistory || []
    return []
  }
  const existingVal = (tableType, year, field) => {
    const row = existingHistoryFor(tableType).find(r => r.year === year)
    const v = row?.[field]
    return v && typeof v === 'object' ? v.value : v
  }

  const handleParseAll = () => {
    const out = {}
    for (const t of TABLES) {
      const text = pasteText[t.key].trim()
      if (!text) continue
      out[t.key] = t.key === 'holdings' ? parseHoldings(text)
        : parsePastedTable(text, t.key, { overrides: flatOverrides(t.key) })
    }
    setResults(out)
  }

  // A row's meaning confirmed in the reconciliation prompt: save it (so the
  // exact same wording never asks again) and re-parse just that table with
  // the mapping applied. `field === null` means "ignore this row" — not
  // persisted, since that's a per-paste call rather than a durable fact
  // about what the label means.
  const handleMap = async (tableKey, u, field) => {
    let rowsForTable = overrideRowsByTable[tableKey] || []
    if (field) {
      await saveAliasOverride({ tableType: tableKey, normalizedLabel: u.normalizedLabel, rawLabel: u.rawLabel, field })
      rowsForTable = [...rowsForTable.filter(r => r.normalizedLabel !== u.normalizedLabel),
                      { tableType: tableKey, normalizedLabel: u.normalizedLabel, rawLabel: u.rawLabel, field }]
      setOverrideRowsByTable(prev => ({ ...prev, [tableKey]: rowsForTable }))
    }
    const text = pasteText[tableKey].trim()
    if (!text) return
    const nextForTable = Object.fromEntries(rowsForTable.map(r => [r.normalizedLabel, r.field]))
    setResults(prev => ({
      ...prev,
      [tableKey]: field
        ? parsePastedTable(text, tableKey, { overrides: nextForTable })
        : { ...prev[tableKey], unmatched: (prev[tableKey]?.unmatched || []).filter(x => x.normalizedLabel !== u.normalizedLabel) },
    }))
  }

  // A previously-confirmed mapping, changed or forgotten. Unlike handleMap
  // above (a fresh label, never persisted until confirmed), this is always
  // acting on a record that already exists in aliasOverrides — reassigning
  // writes the new field over it (same id, saveAliasOverride upserts),
  // forgetting deletes it outright. Re-parses immediately if there's pasted
  // text for this table, so a correction is visible without re-pasting.
  const handleRevise = async (tableKey, override, newField) => {
    let rowsForTable
    if (newField) {
      await saveAliasOverride({ tableType: tableKey, normalizedLabel: override.normalizedLabel, rawLabel: override.rawLabel, field: newField })
      rowsForTable = (overrideRowsByTable[tableKey] || []).map(r =>
        r.normalizedLabel === override.normalizedLabel ? { ...r, field: newField } : r)
    } else {
      await deleteAliasOverride({ tableType: tableKey, normalizedLabel: override.normalizedLabel })
      rowsForTable = (overrideRowsByTable[tableKey] || []).filter(r => r.normalizedLabel !== override.normalizedLabel)
    }
    setOverrideRowsByTable(prev => ({ ...prev, [tableKey]: rowsForTable }))
    const text = pasteText[tableKey].trim()
    if (!text) return
    const nextForTable = Object.fromEntries(rowsForTable.map(r => [r.normalizedLabel, r.field]))
    setResults(prev => (prev ? { ...prev, [tableKey]: parsePastedTable(text, tableKey, { overrides: nextForTable }) } : prev))
  }

  const handleConfirm = () => {
    if (!results) return
    // Replace is deliberately, visibly destructive — confirmed here, once,
    // right before it actually runs, rather than relying on the radio choice
    // alone to carry that weight. Same pattern as the existing "delete cached
    // data and re-fetch" confirmation elsewhere in the app (Header.jsx).
    if (overwrite && !window.confirm(
      `Replace mode will overwrite every matching field shown above with this paste's values — including anything manually corrected earlier. This can't be undone. Continue?`
    )) return
    // Annual financials → history series.
    // Quarterly is deliberately NOT sent here: incomeHistory is keyed by fiscal
    // year and every consumer (ratios, CAGR, the DCF) reads it as full years.
    // Merging quarters in would silently corrupt all of them — a Q2 revenue
    // figure sitting in a year slot reads as a catastrophic collapse.
    for (const [tableType, result] of Object.entries(results)) {
      if (tableType === 'holdings' || tableType === 'quarterly') continue
      if (result.matchedCount > 0) {
        onApplyAll(tableType, tagPastedRows(result.rows, tableType, { scale: pasteScale(currency, ticker) }), { overwrite })
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

  // How many parsed fields already have a stored value — computed once so
  // both the checkbox copy and the per-cell preview styling agree, and so
  // it's visible BEFORE confirming rather than discovered never, since the
  // fill-only default leaves no trace of what it skipped.
  let overlapCount = 0
  if (results) {
    for (const [k, r] of Object.entries(results)) {
      if (k === 'holdings' || !r.rows?.length) continue
      for (const row of r.rows) {
        for (const [f, v] of Object.entries(row)) {
          if (f === 'year' || v == null) continue
          if (existingVal(k, row.year, f) != null) overlapCount++
        }
      }
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={focusLabel ? `Re-paste ${focusLabel}` : 'Add more history'}
      subtitle={focusLabel
        ? 'Expand the sub-rows Screener collapses by default, then paste the table again.'
        : 'Paste any Screener tables — financials extend history, shareholding feeds Quality & Moat'}
      widthClass="sm:max-w-4xl"
    >
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
              {focusLabel
                ? `Copy the ${focusLabel} table and paste it below.`
                : 'Copy whichever tables you want to add, paste each into its box. Fill only the ones you have.'}
            </p>

            <div className="space-y-3">
              {visibleTables.map(t => (
                <div key={t.key} id={`paste-table-${t.key}`}
                     className={`space-y-1 scroll-mt-4 rounded-lg transition-colors ${
                       focusTable === t.key ? 'ring-1 ring-accent/50 p-2 -m-2' : ''}`}>
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
                  {/* Saved mappings for this table are shown here, always —
                      not gated on this paste currently having unmatched rows
                      — since "revise a wrong mapping" has to be reachable
                      whether or not you're mid-paste. Unmatched rows from a
                      completed parse show in the same block once there are
                      any (AliasReconcile renders each section independently). */}
                  {t.key !== 'holdings' && (
                    <AliasReconcile tableType={t.key} unmatched={results?.[t.key]?.unmatched || []}
                      onMap={(u, field) => handleMap(t.key, u, field)}
                      savedOverrides={overrideRowsByTable[t.key] || []}
                      onRevise={(o, field) => handleRevise(t.key, o, field)} />
                  )}
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
                                {r.rows.map((row, i) => {
                                  const ex = existingVal(k, row.year, f)
                                  const has = ex != null
                                  const kept = has && !overwrite
                                  const replacing = has && overwrite && row[f] != null && ex !== row[f]
                                  const title = kept ? `Already ${ex.toLocaleString()} — kept (check Overwrite to replace)`
                                    : replacing ? `Replaces ${ex.toLocaleString()}` : ''
                                  return (
                                    <td key={i} className="text-right py-1 px-2 font-mono" title={title}>
                                      {row[f] != null
                                        ? <span className={kept ? 'text-slate-600 line-through' : replacing ? 'text-accent' : 'text-white'}>
                                            {row[f].toLocaleString()}
                                          </span>
                                        : <span className="text-slate-600">—</span>}
                                    </td>
                                  )
                                })}
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

                <div className="rounded-lg bg-navy-800/40 px-3 py-2 space-y-1.5">
                  <div className="flex gap-3">
                    {[['gapFill', 'Gap fill'], ['replace', 'Replace']].map(([m, lbl]) => (
                      <label key={m} className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                        <input type="radio" name="pasteMode" checked={pasteMode === m} onChange={() => setPasteMode(m)} />
                        {lbl}
                      </label>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {pasteMode === 'replace'
                      ? overlapCount > 0
                        ? `Replace will overwrite ${overlapCount} field${overlapCount > 1 ? 's' : ''} already set (shown struck through) with this paste's values, including anything corrected by hand. You'll be asked to confirm before it runs.`
                        : "Replace will overwrite matching fields with this paste's values wherever they overlap — nothing overlaps yet for what's parsed above."
                      : 'Gap fill only adds values where nothing exists yet — anything already set, however it got there, is left untouched.'}
                  </p>
                </div>

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
    </Modal>
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

