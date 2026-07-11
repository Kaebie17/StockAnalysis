import React, { useState } from 'react'

/**
 * DisclaimerModal + DisclaimerGate — a startup accept-to-proceed gate.
 *
 * Shown once per version: bump DISCLAIMER_VERSION when you want every user to
 * re-accept (e.g. after a major change). Acceptance is stored in localStorage.
 * Wrap the app: <DisclaimerGate><App/></DisclaimerGate> — children render only
 * after acceptance.
 */

export const DISCLAIMER_VERSION = '1'   // bump to force re-acceptance
const KEY = 'sa_disclaimer_accepted'

export function DisclaimerGate({ children }) {
  const [accepted, setAccepted] = useState(() => {
    try { return localStorage.getItem(KEY) === DISCLAIMER_VERSION } catch { return false }
  })
  if (accepted) return children
  return (
    <DisclaimerModal onAccept={() => {
      try { localStorage.setItem(KEY, DISCLAIMER_VERSION) } catch {}
      setAccepted(true)
    }} />
  )
}

function DisclaimerModal({ onAccept }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-navy-950">
      <div className="card max-w-lg w-full space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">📊</span>
          <h2 className="text-lg font-semibold text-white">Before you begin</h2>
        </div>

        <div className="space-y-3 text-sm text-slate-300 leading-relaxed">
          <p>
            StockAnalyzr computes valuations from company financials and uses AI to interpret
            the numbers. It is an <span className="text-white">analytical and educational tool</span> —
            a starting point for your own research.
          </p>
          <p className="bg-navy-800/60 rounded-lg px-3 py-2 text-slate-300">
            💡 For the most out of it, add <span className="text-white">Screener data</span> and the
            company's <span className="text-white">latest reports</span> — the analysis is only as
            good as the data you give it.
          </p>
          <p className="text-slate-400">
            This is <span className="text-white">not investment advice</span> and not a substitute for
            professional advice or your own due diligence. Figures may be incomplete, delayed, or wrong,
            and markets carry risk. Any decisions you make are your own responsibility.
          </p>
        </div>

        <button onClick={onAccept} className="btn-primary w-full">
          I understand — continue
        </button>
      </div>
    </div>
  )
}

export default DisclaimerModal
