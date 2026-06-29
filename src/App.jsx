import React, { useState, useRef, useCallback } from 'react'
import { AppProvider, useApp } from './store/AppContext.jsx'
import Header from './components/dashboard/Header.jsx'
import SummaryStrip from './components/dashboard/SummaryStrip.jsx'
import ValuationPanel from './components/dashboard/ValuationPanel.jsx'
import FundamentalsPanel from './components/dashboard/FundamentalsPanel.jsx'
import TechnicalsPanel from './components/dashboard/TechnicalsPanel.jsx'
import MarketExpectationPanel from './components/dashboard/MarketExpectationPanel.jsx'
import EmptyState from './components/dashboard/EmptyState.jsx'
import ScoringStudio from './components/studio/ScoringStudio.jsx'
import { parseCSV } from './utils/csv.js'
import { requestFolderAccess, exportOverrideJSON, openFilePicker, importOverrideFile } from './utils/csv.js'

function Dashboard() {
  const { state, applyCSV, setFolderHandle } = useApp()
  const [expanded, setExpanded] = useState(null)
  const [studioOpen, setStudioOpen] = useState(false)
  const [csvModal, setCsvModal] = useState(false)  // 'upload' | 'gap-fill' | false
  const fileRef = useRef()

  const handleExpand = (panel) => {
    const next = expanded === panel ? null : panel
    setExpanded(next)
    if (next) setTimeout(() =>
      document.getElementById(`panel-${next}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }

  const handleCSVUpload = useCallback(async (file) => {
    try {
      const csvData = await parseCSV(file)

      // Request folder access on first CSV upload (Chrome/Android)
      let handle = state.folderHandle
      if (!handle && window.showDirectoryPicker) {
        const granted = window.confirm(
          'Allow StockVal to save this data in a "StockVal Data" folder?\n\n' +
          'This lets the app auto-load your data next time without re-uploading.'
        )
        if (granted) {
          handle = await requestFolderAccess()
          if (handle) await setFolderHandle(handle)
        }
      }

      // Export JSON for persistence
      if (handle || !window.showDirectoryPicker) {
        await exportOverrideJSON(state.ticker, csvData, handle)
      }

      applyCSV(csvData)
      setCsvModal(false)
    } catch (err) {
      alert(`CSV error: ${err.message}`)
    }
  }, [state.folderHandle, state.ticker, applyCSV, setFolderHandle])

  // Manual JSON import (Safari/iOS)
  const handleJSONImport = useCallback(async (file) => {
    try {
      const { importOverrideFile: importFn } = await import('./utils/csv.js')
      const csvData = await importFn(file)
      if (csvData) applyCSV(csvData)
      setCsvModal(false)
    } catch (err) {
      alert(`Import error: ${err.message}`)
    }
  }, [applyCSV])

  const showDashboard = state.status === 'success'

  return (
    <div className="min-h-screen bg-navy-950">
      <Header />

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        {!showDashboard
          ? <EmptyState onUpload={() => setCsvModal('upload')} />
          : <>
              {/* CSV active banner */}
              {state.csvActive && (
                <div className="flex items-center justify-between px-3 py-2 bg-accent/10
                                border border-accent/30 rounded-lg text-xs">
                  <span className="text-accent">
                    📎 CSV data active for {state.ticker} — some fields use your uploaded data
                  </span>
                  <button
                    onClick={() => setCsvModal('gap-fill')}
                    className="text-accent hover:text-accent-light underline">
                    Manage
                  </button>
                </div>
              )}

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
              <div id="panel-market-expectation">
                <MarketExpectationPanel
                  open={expanded === 'market-expectation'}
                  onClose={() => setExpanded(null)} />
              </div>
            </>
        }
      </main>

      {/* FAB buttons */}
      {showDashboard && (
        <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-40">
          {/* CSV upload */}
          <button
            onClick={() => setCsvModal('upload')}
            title="Upload CSV data"
            className={`w-11 h-11 rounded-full shadow-lg active:scale-95 transition-all
                        flex items-center justify-center text-sm font-bold
                        ${state.csvActive
                          ? 'bg-accent text-white'
                          : 'bg-navy-800 border border-navy-600 text-slate-400 hover:text-white hover:border-accent'}`}>
            📎
          </button>
          {/* Scoring studio */}
          <button
            onClick={() => setStudioOpen(true)}
            title="Scoring Studio"
            className="w-11 h-11 rounded-full bg-accent shadow-lg hover:bg-accent-dark
                       active:scale-95 transition-all flex items-center justify-center text-white text-xl">
            ⚙
          </button>
        </div>
      )}

      <ScoringStudio open={studioOpen} onClose={() => setStudioOpen(false)} />

      {/* CSV Modal */}
      {csvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
             onClick={e => e.target === e.currentTarget && setCsvModal(false)}>
          <div className="card max-w-md w-full space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-white">
                {csvModal === 'gap-fill' ? 'CSV Data Management' : 'Upload Financial Data'}
              </h2>
              <button onClick={() => setCsvModal(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>

            {csvModal === 'upload' && (
              <>
                <div className="text-xs text-slate-400 space-y-1">
                  <p>CSV data takes priority over Yahoo and Screener for raw financial fields.</p>
                  <p>Calculated metrics (ROE, margins, ratios) always use our formulas.</p>
                  <p className="text-slate-500">
                    Required: <code className="text-accent">year, revenue</code> or <code className="text-accent">year, netProfit</code><br/>
                    Optional: operatingProfit, depreciation, interest, totalDebt, totalAssets,
                    cash, currentAssets, currentLiabilities, operatingCF, freeCashFlow, eps
                  </p>
                  <p className="text-slate-500">Add a row with year="unit" and value="Crores" or "Absolute"</p>
                </div>

                {/* CSV upload */}
                <div
                  className="border-2 border-dashed border-navy-700 rounded-xl p-6 text-center
                             cursor-pointer hover:border-accent transition-colors"
                  onClick={() => fileRef.current?.click()}>
                  <div className="text-3xl mb-2">📊</div>
                  <div className="text-sm text-slate-400">Click to select CSV file</div>
                  <input ref={fileRef} type="file" accept=".csv" className="hidden"
                    onChange={e => { if (e.target.files[0]) handleCSVUpload(e.target.files[0]) }} />
                </div>

                {/* JSON import (load previously exported data) */}
                <div className="border-t border-navy-800 pt-3">
                  <p className="text-xs text-slate-500 mb-2">
                    Previously uploaded data for {state.ticker}?
                  </p>
                  <button
                    onClick={() => openFilePicker(handleJSONImport)}
                    className="btn-ghost text-sm w-full">
                    📂 Load saved StockVal file (.json)
                  </button>
                </div>
              </>
            )}

            {csvModal === 'gap-fill' && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">
                  CSV data is active for {state.ticker}. Fields with 📎 are using your CSV data.
                  Click any 📎 field in the dashboard to swap between CSV and source values.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setCsvModal('upload') }}
                    className="btn-ghost text-sm flex-1">
                    Re-upload CSV
                  </button>
                  <button
                    onClick={() => {
                      // Clear CSV — re-normalize from original source data
                      // For now just reload the ticker
                      window.location.reload()
                    }}
                    className="btn-ghost text-sm flex-1 text-bear hover:text-bear">
                    Remove CSV
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  return <AppProvider><Dashboard /></AppProvider>
}
