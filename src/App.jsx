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
  const [expanded, setExpanded] = useState(null)
  const [studioOpen, setStudioOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const fileRef = useRef()

  const handleExpand = (panel) => {
    const next = expanded === panel ? null : panel
    setExpanded(next)
    if (next) {
      setTimeout(() => document.getElementById(`panel-${next}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
    }
  }

  const handleCSV = (file) => {
    Papa.parse(file, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
      complete: ({ data }) => {
        const incomeHistory = data.map(r => ({
          year: String(r.year || r.Year || ''),
          revenue: r.revenue || r.Revenue || null,
          grossProfit: r.grossProfit || null, operatingProfit: r.operatingProfit || null,
          ebitda: r.ebitda || null, netIncome: r.netIncome || null,
          interest: r.interest || null, depreciation: r.depreciation || null, eps: r.eps || null
        })).filter(r => r.year && r.revenue)
        const balanceHistory = data.map(r => ({
          year: String(r.year || ''), totalDebt: r.totalDebt || null,
          totalEquity: r.totalEquity || null, cash: r.cash || null, totalAssets: r.totalAssets || null
        })).filter(r => r.year)
        const cashflowHistory = data.map(r => ({
          year: String(r.year || ''), operatingCF: r.operatingCF || null,
          freeCashFlow: r.freeCashFlow || r.fcf || null, capex: r.capex || null
        })).filter(r => r.year)
        const latest = incomeHistory[incomeHistory.length - 1] || {}
        const latestB = balanceHistory[balanceHistory.length - 1] || {}
        loadFromCSV({
          ticker: 'CSV', name: 'Uploaded Data', source: 'csv', currency: 'USD',
          price: data[0]?.price || null, marketCap: data[0]?.marketCap || null, sharesOutstanding: null,
          priceHistory: [], incomeHistory, balanceHistory, cashflowHistory,
          ttm: { revenue: latest.revenue, netIncome: latest.netIncome, totalDebt: latestB.totalDebt, totalCash: latestB.cash },
          meta: { sector: null, industry: null, pe: null, pb: null }
        })
        setUploadOpen(false)
      }
    })
  }

  const showDashboard = state.status === 'success'

  return (
    <div className="min-h-screen bg-navy-950">
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        {!showDashboard
          ? <EmptyState onUpload={() => setUploadOpen(true)} />
          : <>
              <SummaryStrip onExpand={handleExpand} expanded={expanded} />

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
        }
      </main>

      {showDashboard && (
        <button onClick={() => setStudioOpen(true)}
          className="fixed bottom-6 right-6 w-12 h-12 rounded-full bg-accent shadow-xl hover:bg-accent-dark active:scale-95 transition-all flex items-center justify-center text-white text-xl z-40"
          title="Scoring Studio">⚙</button>
      )}

      <ScoringStudio open={studioOpen} onClose={() => setStudioOpen(false)} />

      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
             onClick={e => e.target === e.currentTarget && setUploadOpen(false)}>
          <div className="card max-w-md w-full space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-white">Upload Financial Data CSV</h2>
              <button onClick={() => setUploadOpen(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>
            <p className="text-xs text-slate-400">
              Required columns: <code className="text-accent">year, revenue, netIncome</code><br/>
              Optional: <code className="text-accent">ebitda, freeCashFlow, totalDebt, totalEquity, eps, price, marketCap</code>
            </p>
            <div className="border-2 border-dashed border-navy-700 rounded-xl p-8 text-center cursor-pointer hover:border-accent transition-colors"
                 onClick={() => fileRef.current?.click()}>
              <div className="text-3xl mb-2">📂</div>
              <div className="text-sm text-slate-400">Click to select CSV file</div>
              <input ref={fileRef} type="file" accept=".csv" className="hidden"
                onChange={e => { if (e.target.files[0]) handleCSV(e.target.files[0]) }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return <AppProvider><Dashboard /></AppProvider>
}
