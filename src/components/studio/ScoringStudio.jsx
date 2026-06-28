import React, { useState } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { saveProfile, loadProfile, listProfiles, deleteProfile } from '../../utils/db.js'

export default function ScoringStudio({ open, onClose }) {
  const { state, recalc } = useApp()
  const [activeTab, setActiveTab] = useState('fundamental')
  const [profileName, setProfileName] = useState('')
  const [profiles, setProfiles] = useState([])
  const [profilesLoaded, setProfilesLoaded] = useState(false)

  const weights = state.scoreWeights || {}
  const assumptions = state.assumptions || {}

  if (!open) return null

  const loadProfiles = async () => {
    if (!profilesLoaded) {
      const p = await listProfiles()
      setProfiles(p)
      setProfilesLoaded(true)
    }
  }

  const updateWeight = (key, value) => {
    recalc({}, { [key]: parseFloat(value) })
  }

  const updateAssumption = (key, value) => {
    recalc({ [key]: parseFloat(value) }, {})
  }

  const save = async () => {
    if (!profileName.trim()) return
    await saveProfile(profileName.trim(), { weights, assumptions })
    const p = await listProfiles()
    setProfiles(p)
    setProfileName('')
  }

  const applyProfile = async (name) => {
    const config = await loadProfile(name)
    if (config) recalc(config.assumptions || {}, config.weights || {})
  }

  const FUNDAMENTAL_WEIGHTS = [
    { key: 'revenueGrowth', label: 'Revenue Growth (5yr CAGR)', defaultW: 1.5 },
    { key: 'grossMargin',   label: 'Gross Margin',              defaultW: 1 },
    { key: 'ebitdaMargin',  label: 'EBITDA Margin',             defaultW: 1 },
    { key: 'netMargin',     label: 'Net Margin',                defaultW: 1 },
    { key: 'fcfConversion', label: 'FCF Conversion',            defaultW: 1.5 },
    { key: 'debtTrend',     label: 'Debt Management',           defaultW: 1 },
    { key: 'roe',           label: 'Return on Equity',          defaultW: 1.5 },
    { key: 'interestCoverage', label: 'Interest Coverage',      defaultW: 1 },
    { key: 'consistency',   label: 'Earnings Consistency',      defaultW: 1 }
  ]

  const VALUATION_INPUTS = [
    { key: 'wacc',       label: 'WACC',                  min: 0.05, max: 0.20, step: 0.005, pct: true },
    { key: 'termGrowth', label: 'Terminal Growth Rate',  min: 0.01, max: 0.06, step: 0.005, pct: true },
    { key: 'growthRate', label: 'FCF Growth Rate',       min: 0,    max: 0.40, step: 0.01,  pct: true },
    { key: 'sectorPe',   label: 'Sector P/E Target',     min: 5,    max: 60,   step: 1,     pct: false },
    { key: 'sectorEvEb', label: 'Sector EV/EBITDA Target',min: 4,   max: 30,   step: 0.5,   pct: false }
  ]

  const tabs = ['fundamental', 'valuation', 'profiles']

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-navy-900 border border-navy-700 rounded-2xl overflow-hidden shadow-2xl">
        {/* Title */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700">
          <h2 className="font-semibold text-white">Scoring Studio</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-navy-700">
          {tabs.map(t => (
            <button
              key={t}
              onClick={() => { setActiveTab(t); if (t === 'profiles') loadProfiles() }}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors capitalize ${
                activeTab === t ? 'text-accent border-b-2 border-accent' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-5 max-h-96 overflow-y-auto space-y-4">
          {activeTab === 'fundamental' && (
            <>
              <p className="text-xs text-slate-400">Adjust how much each predictor contributes to the quality score.</p>
              {FUNDAMENTAL_WEIGHTS.map(({ key, label, defaultW }) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="text-sm text-slate-300 flex-1">{label}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="range" min={0} max={3} step={0.5}
                      value={weights[key] ?? defaultW}
                      onChange={e => updateWeight(key, e.target.value)}
                      className="w-20 accent-accent"
                    />
                    <span className="text-xs text-white font-mono w-6 text-right">
                      {(weights[key] ?? defaultW).toFixed(1)}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}

          {activeTab === 'valuation' && (
            <>
              <p className="text-xs text-slate-400">Tune DCF assumptions — changes recalculate fair value immediately.</p>
              {VALUATION_INPUTS.map(({ key, label, min, max, step, pct }) => {
                const raw = assumptions[key]
                const val = raw ?? (pct ? (key === 'wacc' ? 0.10 : key === 'termGrowth' ? 0.03 : 0.10) : (key === 'sectorPe' ? 20 : 12))
                const display = pct ? (val * 100).toFixed(1) + '%' : val.toFixed(1) + '×'
                return (
                  <div key={key}>
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                      <span>{label}</span>
                      <span className="text-white font-mono">{display}</span>
                    </div>
                    <input
                      type="range" min={min} max={max} step={step} value={val}
                      onChange={e => updateAssumption(key, e.target.value)}
                      className="w-full accent-accent"
                    />
                  </div>
                )
              })}
            </>
          )}

          {activeTab === 'profiles' && (
            <>
              <p className="text-xs text-slate-400">Save and load named scoring configurations.</p>

              {/* Save */}
              <div className="flex gap-2">
                <input
                  className="input-field text-sm"
                  placeholder="Profile name…"
                  value={profileName}
                  onChange={e => setProfileName(e.target.value)}
                />
                <button className="btn-primary shrink-0 text-sm" onClick={save}>Save</button>
              </div>

              {/* Saved profiles */}
              {profiles.length === 0 ? (
                <p className="text-xs text-slate-500 text-center py-4">No saved profiles yet</p>
              ) : (
                <div className="space-y-2">
                  {profiles.map(p => (
                    <div key={p.name} className="flex items-center gap-2 card-sm">
                      <span className="flex-1 text-sm text-slate-300">{p.name}</span>
                      <button
                        onClick={() => applyProfile(p.name)}
                        className="text-xs text-accent hover:text-accent-light"
                      >
                        Apply
                      </button>
                      <button
                        onClick={async () => {
                          await deleteProfile(p.name)
                          setProfiles(prev => prev.filter(pr => pr.name !== p.name))
                        }}
                        className="text-xs text-slate-500 hover:text-bear"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
