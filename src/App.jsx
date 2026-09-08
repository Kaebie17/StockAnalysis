import React, { useState, useEffect, useRef } from 'react'
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
import PeerSelectModal from './components/dashboard/PeerSelectModal.jsx'
import ScoringStudio from './components/studio/ScoringStudio.jsx'
import MoatQualityPanel from './components/dashboard/MoatQualityPanel.jsx'
import BackupControls from './components/BackupControls.jsx'
import PositionFab from './components/dashboard/PositionFab.jsx'
import PortfolioNews from './components/dashboard/PortfolioNews.jsx'

// peerBand()'s own minSamples floor (peerBands.js) — the auto-open trigger
// below tracks the same threshold peer-tier logic actually needs, not an
// independently-chosen number.
const MIN_PEERS_FOR_BAND = 3

function Dashboard() {
  const { state, load, applyPastedTable, dismissGap, refreshPeers, togglePeerConfirmation } = useApp()
  const [expanded, setExpanded] = useState(null)
  const [studioOpen, setStudioOpen] = useState(false)
  const [gapFillOpen, setGapFillOpen] = useState(false)
  const [addHistoryOpen, setAddHistoryOpen] = useState(false)
  const [peerModalOpen, setPeerModalOpen] = useState(false)
  // Which ticker the auto-open has already fired (or been dismissed) for —
  // without this, closing the modal with coverage still below the floor
  // (e.g. the user Skipped, or some loads failed) would immediately reopen
  // it on the very next render, since the trigger condition is still true.
  const autoOpenedFor = useRef(null)

  // Opt-in: a candidate only counts toward peerBand() once explicitly
  // confirmed (AppContext.jsx's activePeers/confirmedPeers) — the full
  // candidate pool (state.assumptions.peers) always includes everything
  // NSE's sectoral index constituents plus this browser's own same-sector
  // analysis history surfaced, confirmed or not. An unconfirmed candidate
  // isn't going to contribute to peerBand() regardless of its cache
  // status, so it shouldn't count toward "need more coverage."
  const candidatePeers = state.assumptions?.peers || []
  const confirmedPeers = state.data?.confirmedPeers || []
  const confirmedSet = new Set(confirmedPeers)
  const confirmedCount = candidatePeers.filter(p => confirmedSet.has(p.symbol) && p.cached).length
  // Only meaningful when the floor is actually reachable — a stock with
  // fewer than 3 total peer candidates can never clear peerBand()'s
  // minSamples floor no matter how many get confirmed, so auto-opening
  // every single visit for something that can't be fixed would just be
  // repeatedly interrupting for nothing. That case declines gracefully
  // (no peer-tier multiple, same as any other model with real inputs it
  // doesn't have) rather than nagging.
  const floorReachable = candidatePeers.length >= MIN_PEERS_FOR_BAND
  const belowPeerFloor = floorReachable && confirmedCount < MIN_PEERS_FOR_BAND
  const hasMoreToLoad = candidatePeers.length > confirmedCount

  // Auto-opens once per ticker while confirmed peer coverage is genuinely
  // too thin for peerBand() to use at all AND the candidate pool is large
  // enough that confirming more could actually fix that. Once 3+ are
  // confirmed (from a prior visit already persisted on this ticker, or
  // completing this modal now), it stops auto-opening on later visits —
  // see the reopenable button rendered alongside DataGapBanner below
  // instead.
  useEffect(() => {
    if (!state.ticker || candidatePeers.length === 0) return
    if (belowPeerFloor && autoOpenedFor.current !== state.ticker) {
      autoOpenedFor.current = state.ticker
      setPeerModalOpen(true)
    }
  }, [state.ticker, candidatePeers.length, belowPeerFloor])

  const closePeerModal = (anyLoaded) => {
    setPeerModalOpen(false)
    if (anyLoaded) refreshPeers()
  }

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
                  {/* Shown whenever there's a candidate left to confirm, regardless
                      of whether the auto-open floor was ever reached — covers
                      "already sufficient, but more would still help" and
                      "floor unreachable, but individual peers still useful"
                      alike, without repeatedly interrupting (see the effect
                      above for the one-time auto-open case). */}
                  {hasMoreToLoad && (
                    <button onClick={() => setPeerModalOpen(true)}
                      className="text-[11px] text-slate-500 hover:text-accent">
                      🔗 {confirmedCount}/{candidatePeers.length} peers confirmed — review more
                    </button>
                  )}
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

      <PeerSelectModal
        open={peerModalOpen}
        onClose={closePeerModal}
        ticker={state.data?.ticker || state.ticker}
        meta={state.data?.meta}
        sectorType={state.sectorType}
        confirmedPeers={confirmedPeers}
        onToggleConfirm={togglePeerConfirmation}
      />

    </div>
  )
}

export default function App() {
  return <AppProvider><Dashboard /></AppProvider>
}
