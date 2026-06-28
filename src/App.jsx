import React, { useState } from 'react'
import Papa from 'papaparse'
import { AppProvider, useApp } from './store/AppContext.jsx'
import Header from './components/dashboard/Header.jsx'
import SummaryStrip from './components/dashboard/SummaryStrip.jsx'
import ValuationPanel from './components/dashboard/ValuationPanel.jsx'
import FundamentalsPanel from './components/dashboard/FundamentalsPanel.jsx'
import TechnicalsPanel from './components/dashboard/TechnicalsPanel.jsx'
import ScoringStudio from './components/studio/ScoringStudio.jsx'
import { EmptyState, LoadingSkeleton } from './components/dashboard/EmptyState.jsx'

// ── Upload prompt — shown when all auto sources fail ──────

function UploadPrompt({ ticker }) {
  const { actions } = useApp()

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return

    const ext = file.name.split('.').pop().toLowerCase()

    if (ext === 'csv') {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rawResult = csvToRawResult(results.data, ticker)
          actions.injectUploadedData(rawResult)
        },
        error: () => alert('CSV parsing failed. Please check the file format.')
      })
    } else if (ext === 'xlsx' || ext === 'xls') {
      alert('Please save your Excel file as CSV first (File → Save As → CSV), then upload the CSV.')
      e.target.value = ''
    } else {
      alert('Please upload a CSV or Excel (.xlsx) file.')
    }
  }

  return (
    <div className="card px-6 py-8 text-center space-y-4 max-w-lg mx-auto mt-8">
      <div className="text-4xl">📂</div>
      <div>
        <h3 className="font-display font-semibold text-slate-100 mb-1">Upload Financial Statements</h3>
        <p className="text-sm text-slate-400">
          Automatic data fetch failed for <span className="font-mono text-accent-cyan">{ticker}</span>.
          Upload a CSV or Excel file with financial data to continue.
        </p>
      </div>

      <label className="btn-primary cursor-pointer inline-block">
        Choose CSV File
        <input type="file" accept=".csv" onChange={handleFile} className="hidden" />
      </label>

      <p className="text-xs text-slate-500">
        Have an Excel file? Open it and use <span className="font-mono">File → Save As → CSV</span> first.
      </p>

      <div className="text-left card-inner px-4 py-3 space-y-1">
        <p className="label mb-2">Expected columns (any order)</p>
        {[
          'ticker, name, price, marketCap, sharesOutstanding',
          'revenue, grossProfit, ebitda, ebit, netIncome, eps',
          'totalAssets, totalDebt, totalEquity, cash, bookValuePerShare',
          'cfo, capex, fcf',
        ].map(line => (
          <p key={line} className="text-xs font-mono text-slate-400">{line}</p>
        ))}
        <p className="text-xs text-slate-500 mt-2">
          Each row = one fiscal year. Include a <span className="font-mono">date</span> or <span className="font-mono">year</span> column for trend charts.
        </p>
      </div>
    </div>
  )
}

// ── Minimal CSV → rawResult converter ────────────────────

function csvToRawResult(rows, ticker) {
  const latest = rows[rows.length - 1] ?? {}
  const n = (k) => parseFloat(latest[k]) || null

  return {
    raw: {
      profile: {
        symbol: ticker, companyName: latest.name ?? ticker,
        price: n('price'), mktCap: n('marketCap'),
        currency: latest.currency ?? 'USD', sector: latest.sector ?? '',
      },
      income:   rows.map(r => ({
        date: r.date ?? r.year ?? '',
        revenue: parseFloat(r.revenue) || null,
        grossProfit: parseFloat(r.grossProfit) || null,
        ebitda: parseFloat(r.ebitda) || null,
        operatingIncome: parseFloat(r.ebit) || null,
        netIncome: parseFloat(r.netIncome) || null,
        eps: parseFloat(r.eps) || null,
      })).reverse(),
      balance: rows.map(r => ({
        date: r.date ?? r.year ?? '',
        totalAssets: parseFloat(r.totalAssets) || null,
        totalDebt: parseFloat(r.totalDebt) || null,
        totalStockholdersEquity: parseFloat(r.totalEquity) || null,
        cashAndCashEquivalents: parseFloat(r.cash) || null,
        bookValuePerShare: parseFloat(r.bookValuePerShare) || null,
      })).reverse(),
      cashflow: rows.map(r => ({
        date: r.date ?? r.year ?? '',
        operatingCashFlow: parseFloat(r.cfo) || null,
        capitalExpenditure: parseFloat(r.capex) || null,
        freeCashFlow: parseFloat(r.fcf) || null,
        dividendsPaid: parseFloat(r.dividendsPaid) || null,
      })).reverse(),
      metrics: [],
      history: null,
      quote: {
        price: n('price'), marketCap: n('marketCap'),
        sharesOutstanding: n('sharesOutstanding'),
        eps: n('eps'), yearHigh: n('high52w'), yearLow: n('low52w'),
      },
    },
    source: 'Uploaded file',
    errors: [],
    fetchedAt: Date.now(),
  }
}



function Dashboard() {
  const { state } = useApp()
  const [showStudio, setShowStudio] = useState(false)

  const { status, data } = state

  return (
    <div className="min-h-screen bg-surface-900 font-display">
      <Header />

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        {status === 'idle' && <EmptyState />}
        {status === 'loading' && <LoadingSkeleton />}

        {status === 'needs_upload' && (
          <UploadPrompt ticker={state.pendingTicker} />
        )}

        {status === 'success' && data && (
          <>
            <SummaryStrip />
            <ValuationPanel />
            <FundamentalsPanel />
            <TechnicalsPanel />
          </>
        )}
      </main>

      {/* Floating Scoring Studio button */}
      {data && (
        <button
          onClick={() => setShowStudio(true)}
          className="fixed bottom-6 right-6 bg-surface-800 border border-slate-600 hover:border-accent-cyan
                     text-slate-300 hover:text-accent-cyan rounded-2xl px-4 py-3 text-sm font-medium
                     shadow-xl transition-all flex items-center gap-2 z-30"
        >
          ⚙️ <span className="hidden sm:block">Scoring Studio</span>
        </button>
      )}

      {/* Scoring Studio overlay */}
      {showStudio && <ScoringStudio onClose={() => setShowStudio(false)} />}

      {/* Disclaimer */}
      <footer className="max-w-6xl mx-auto px-4 py-6 border-t border-slate-800 mt-8">
        <p className="text-xs text-slate-700 text-center">
          StockVal is for research and educational purposes only. Not financial advice.
          All signals are model outputs — always conduct your own due diligence before making investment decisions.
        </p>
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Dashboard />
    </AppProvider>
  )
}
