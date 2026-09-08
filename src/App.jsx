import React, { useState } from 'react'
import { AppProvider, useApp } from './store/AppContext.jsx'
import Header from './components/dashboard/Header.jsx'
import SummaryStrip from './components/dashboard/SummaryStrip.jsx'
import GrowthWindowPicker from './components/dashboard/GrowthWindowPicker.jsx'
import BetaWindowPicker from './components/dashboard/BetaWindowPicker.jsx'
import ValuationPanel from './components/dashboard/ValuationPanel.jsx'
import FundamentalsPanel from './components/dashboard/FundamentalsPanel.jsx'
import TechnicalsPanel from './components/dashboard/TechnicalsPanel.jsx'
import MarketExpectationPanel from './components/dashboard/MarketExpectationPanel.jsx'
import EmptyState from './components/dashboard/EmptyState.jsx'
import DataGapBanner from './components/dashboard/DataGapBanner.jsx'
import GapFillModal from './components/dashboard/GapFillModal.jsx'
import AddHistoryModal from './components/dashboard/AddHistoryModal.jsx'
import ScoringStudio from './components/studio/ScoringStudio.jsx'
import MoatQualityPanel from './components/dashboard/MoatQualityPanel.jsx'
import BackupControls from './components/BackupControls.jsx'
import PositionFab from './components/dashboard/PositionFab.jsx'
import PortfolioNews from './components/dashboard/PortfolioNews.jsx'

function Dashboard() {
  const { state, load, applyPastedTable, dismissGap } = useApp()
  const [expanded, setExpanded] = useState(null)
  const [studioOpen, setStudioOpen] = useState(false)
  const [gapFillOpen, setGapFillOpen] = useState(false)
  const [addHistoryOpen, setAddHistoryOpen] = useState(false)

  const handleExpand = (panel) => {
    const next = expanded === panel ? null : panel
    setExpanded(next)
    if (next) setTimeout(() =>
      document.getElementById(`panel-${next}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }

  const showDashboard = state.status === 'success'

  return (
    <div className="min-h-screen bg-navy-950 overflow-x-hidden">
      <Header />

      <main className="max-w-5xl mx-auto px-4 space-y-4">
        {!showDashboard
          ? <EmptyState />
          : <>
              <SummaryStrip onExpand={handleExpand} expanded={expanded} onAddHistory={() => setAddHistoryOpen(true)} detail={
                <div className="space-y-4">
                  <GrowthWindowPicker />
                  <BetaWindowPicker />
                  <div className="flex items-center justify-between gap-2">
                    <DataGapBanner
                      ratioResult={state.ratioResult}
                      data={state.data}
                      dismissed={state.arData?.dismissedGaps || []}
                      onDismiss={dismissGap}
                      onFix={() => setGapFillOpen(true)}
                    />
                  </div>
                  <div id="panel-valuation">
                    <ValuationPanel open={expanded === 'valuation'} onClose={() => setExpanded(null)} />
                  </div>
                  <div id="panel-fundamentals">
                    <FundamentalsPanel open={expanded === 'fundamentals'} onClose={() => setExpanded(null)} />
                  </div>
                  <div id="panel-moat">
                    <MoatQualityPanel open={expanded === 'moat'} onClose={() => setExpanded(null)} />
                  </div>
                  <div id="panel-technicals">
                    <TechnicalsPanel open={expanded === 'technicals'} onClose={() => setExpanded(null)} />
                  </div>
                  <div id="panel-market-expectation">
                    <MarketExpectationPanel
                      open={expanded === 'market-expectation'}
                      onClose={() => setExpanded(null)} />
                  </div>
                </div>
              } />
            </>
        }
      </main>

      {/* Backup FABs — landing page only */}
      {!showDashboard && (
        <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-40 items-end">
          <PortfolioNews onOpenTicker={t => load(t)} />
          <BackupControls />
        </div>
      )}

      {/* FAB buttons */}
      {showDashboard && (
        <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-40 items-end">
          {/* Portfolio-wide news brief — opens once per session when something
              on a holding needs attention, then collapses to a badge. */}
          <PortfolioNews onOpenTicker={t => load(t)} />
          {/* Positions — same cluster as Studio rather than a second stack in
              the same corner, which would just overlap them. */}
          <PositionFab />
          {/* Scoring studio */}
          <button
            onClick={() => setStudioOpen(true)}
            title="Guidance"
            className="w-11 h-11 rounded-full bg-accent shadow-lg hover:bg-accent-dark
                       active:scale-95 transition-all flex items-center justify-center text-white text-xl">
            ⚙
          </button>
        </div>
      )}

      <ScoringStudio open={studioOpen} onClose={() => setStudioOpen(false)} />

      <GapFillModal
        open={gapFillOpen}
        onClose={() => setGapFillOpen(false)}
        ratioResult={state.ratioResult}
        ticker={state.ticker}
        onApply={applyPastedTable}
      />

      <AddHistoryModal
        open={addHistoryOpen}
        onClose={() => setAddHistoryOpen(false)}
        ticker={state.ticker}
        onApplyAll={applyPastedTable}
      />

    </div>
  )
}

export default function App() {
  return <AppProvider><Dashboard /></AppProvider>
}
