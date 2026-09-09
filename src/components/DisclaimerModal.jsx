import React, { useState } from 'react'
import Modal from './Modal.jsx'

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
    <Modal
      open
      onClose={onAccept}
      dismissible={false}
      showClose={false}
      solid
      zIndexClass="z-[100]"
      title="Before you begin"
      icon="📊"
      widthClass="sm:max-w-lg"
      footer={
        <button onClick={onAccept} className="btn-primary w-full">
          I understand — continue
        </button>
      }
    >
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
    </Modal>
  )
}

export default DisclaimerModal
