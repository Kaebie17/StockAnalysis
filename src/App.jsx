import React, { useState, useRef } from 'react'
import Papa from 'papaparse'
import { AppProvider, useApp } from './store/AppContext.jsx'
import Header from './components/dashboard/Header.jsx'
import SummaryStrip from './components/dashboard/SummaryStrip.jsx'
import ValuationPanel from './components/dashboard/ValuationPanel.jsx'
import FundamentalsPanel from './components/dashboard/FundamentalsPanel.jsx'
import TechnicalsPanel from './components/dashboard/TechnicalsPanel.jsx'
import EmptyState from './components/dashboard/EmptyState.jsx'
import ScoringStudio from './components/studio/ScoringStudio.jsx'

function Dashboard() {
  const { state, loadFromCSV } = useApp()
  const [expanded, setExpanded] = useState(null) // 'valuation' | 'fundamentals' | 'technicals'
  const [studioOpen, setStudioOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const fileRef = useRef()

  const handleExpand = (panel) => {
    setExpanded(prev => prev === panel ? null : panel)
    // Scroll to panel
    setTimeout(() => {
      document.getElementById(`panel-${panel}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
  }

  const handleCSV = (file) => {
    Papa.parse(file, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
      complete: ({ data }) => {
        try {
          // Build normalized data object from CSV
          const incomeHistory = data.map(row => ({
            year:            String(row.year || row.Year || ''),
            revenue:         row.revenue || row.Revenue || null,
            grossProfit:     row.grossProfit || row.gross_profit || null,
            operatingProfit: row.operatingProfit || row.ebit || null,
            ebitda:          row.ebitda || row.EBITDA || null,
            netIncome:       row.netIncome || row.net_income || null,
            interest:        row.interest || row.interestExpense || null,
            depreciation:    row.depreciation || null,
            eps:             row.eps || row.EPS || null
          })).filter(r => r.year && r.revenue)

          const balanceHistory = data.map(row => ({
            year:        String(row.year || row.Year || ''),
            totalDebt:   row.totalDebt || row.total_debt || null,
            totalEquity: row.totalEquity || row.equity || null,
            cash:        row.cash || null,
            totalAssets: row.totalAssets || null
          })).filter(r => r.year)

          const cashflowHistory = data.map(row => ({
            year:         String(row.year || row.Year || ''),
            operatingCF:  row.operatingCF || row.operating_cashflow || null,
            freeCashFlow: row.freeCashFlow || row.fcf || null,
            capex:        row.capex || null
          })).filter(r => r.year)

          const latest = incomeHistory[incomeHistory.length - 1] || {}
          const latestB = balanceHistory[balanceHistory.length - 1] || {}

          const normalized = {
            ticker:   'CSV',
            name:     'Uploaded Data',
            source:   'csv',
            currency: 'USD',
            price:    data[0]?.price || null,
            marketCap: data[0]?.marketCap || null,
            sharesOutstanding: data[0]?.sharesOutstanding || null,
            priceHistory: [],
            incomeHistory,
            balanceHistory,
            cashflowHistory,
            ttm: {
              revenue:    latest.revenue,
              netIncome:  latest.netIncome,
              ebitda:     latest.ebitda,
              freeCashflow: cashflowHistory[cashflowHistory.length - 1]?.freeCashFlow,
              totalDebt:  latestB.totalDebt,
              totalCash:  latestB.cash
            },
            meta: { sector: null, industry: null, pe: null, pb: null }
          }
          loadFromCSV(normalized)
          setUploadOpen(false)
        } catch (err) {
          alert('CSV parse error: ' + err.message)
        }
      },
      error: (err) => alert('Could not read file: ' + err.message)
    })
  }

  const showDashboard = state.status === 'success'

  return (
    <div className="min-h-screen bg-navy-950">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-5">
        {!showDashboard ? (
          <EmptyState onUpload={() => setUploadOpen(true)} />
        ) : (
          <>
            <SummaryStrip onExpand={handleExpand} />

            {/* Expandable panels */}
            <div id="panel-valuation">
              <ValuationPanel open={expanded === 'valuation'} onClose={() => setExpanded(null)} />
            </div>
            <div id="panel-fundamentals">
              <FundamentalsPanel open={expanded === 'fundamentals'} onClose={() => setExpanded(null)} />
            </div>
            <div id="panel-technicals">
              <TechnicalsPanel open={expanded === 'technicals'} onClose={() => setExpanded(null)} />
            </div>
          </>
        )}
      </main>

      {/* Scoring Studio FAB */}
      {showDashboard && (
        <button
          onClick={() => setStudioOpen(true)}
          className="fixed bottom-6 right-6 w-12 h-12 rounded-full bg-accent shadow-lg hover:bg-accent-dark active:scale-95 transition-all flex items-center justify-center text-white text-lg z-40"
          title="Scoring Studio"
        >
          ⚙
        </button>
      )}

      <ScoringStudio open={studioOpen} onClose={() => setStudioOpen(false)} />

      {/* CSV Upload modal */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
             onClick={e => e.target === e.currentTarget && setUploadOpen(false)}>
          <div className="card max-w-md w-full space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-white">Upload Financial Data</h2>
              <button onClick={() => setUploadOpen(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>
            <p className="text-sm text-slate-400">
              CSV should have columns: <code className="text-accent">year, revenue, netIncome</code> (required),
              plus optional: <code className="text-accent">ebitda, freeCashFlow, totalDebt, totalEquity, eps, price</code>
            </p>
            <div
              className="border-2 border-dashed border-navy-700 rounded-xl p-8 text-center cursor-pointer hover:border-accent transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <div className="text-3xl mb-2">📂</div>
              <div className="text-sm text-slate-400">Click to select a CSV file</div>
              <input
                ref={fileRef} type="file" accept=".csv" className="hidden"
                onChange={e => { if (e.target.files[0]) handleCSV(e.target.files[0]) }}
              />
            </div>
          </div>
        </div>
      )}
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
