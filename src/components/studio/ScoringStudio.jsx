// ScoringStudio.jsx
import React, { useState, useEffect } from 'react'
import { useApp } from '../../store/AppContext.jsx'
import { DEFAULT_FUNDAMENTAL_PREDICTORS, DEFAULT_TECHNICAL_PREDICTORS } from '../../engine/quality.js'
import { DEFAULT_ASSUMPTIONS } from '../../engine/valuation.js'

export default function ScoringStudio({ onClose }) {
  const { state, actions } = useApp()
  const [tab, setTab]           = useState('fundamental')
  const [profileName, setProfileName] = useState('')
  const [showSaveForm, setShowSaveForm] = useState(false)

  // Load profiles on mount
  useEffect(() => { actions.loadProfiles() }, [])

  const fundPredictors = state.fundPredictors
  const techPredictors = state.techPredictors
  const pillarWeights  = state.pillarWeights
  const profiles       = state.profiles

  // ── Weight normalization helpers ─────────────────────────

  function updateFundWeight(id, newWeight) {
    const updated = fundPredictors.map(p => p.id === id ? { ...p, weight: newWeight } : p)
    actions.updateFundPredictors(updated)
  }

  function updateTechWeight(id, newWeight) {
    const updated = techPredictors.map(p => p.id === id ? { ...p, weight: newWeight } : p)
    actions.updateTechPredictors(updated)
  }

  function updateFundThreshold(id, newThreshold) {
    const updated = fundPredictors.map(p => {
      if (p.id !== id) return p
      // Return a new predictor with updated threshold baked into evaluate
      return { ...p, threshold: newThreshold,
        evaluate: buildThresholdEvaluator(p, newThreshold) }
    })
    actions.updateFundPredictors(updated)
  }

  function buildThresholdEvaluator(predictor, threshold) {
    // Rebuild a simple threshold evaluator for editable predictors
    return (data, ratios, hist) => {
      const original = DEFAULT_FUNDAMENTAL_PREDICTORS.find(d => d.id === predictor.id)
      if (!original) return { value: null, unit: '', pass: false }
      const result = original.evaluate(data, ratios, hist)
      if (threshold == null) return result
      return { ...result, pass: result.value != null && (predictor.direction === 'lower'
        ? result.value <= threshold
        : result.value >= threshold) }
    }
  }

  function removeFundPredictor(id) {
    actions.updateFundPredictors(fundPredictors.filter(p => p.id !== id))
  }

  function removeTechPredictor(id) {
    actions.updateTechPredictors(techPredictors.filter(p => p.id !== id))
  }

  function addFundPredictor(predictor) {
    if (fundPredictors.find(p => p.id === predictor.id)) return
    actions.updateFundPredictors([...fundPredictors, { ...predictor, weight: 10 }])
  }

  function resetFundDefaults() {
    actions.updateFundPredictors(DEFAULT_FUNDAMENTAL_PREDICTORS)
  }

  function resetTechDefaults() {
    actions.updateTechPredictors(DEFAULT_TECHNICAL_PREDICTORS)
  }

  function updatePillar(key, val) {
    // Keep total = 100 by adjusting others proportionally
    const others = Object.keys(pillarWeights).filter(k => k !== key)
    const remaining = 100 - val
    const currentOthersTotal = others.reduce((s, k) => s + pillarWeights[k], 0)
    const updated = { ...pillarWeights, [key]: val }
    if (currentOthersTotal > 0) {
      others.forEach(k => {
        updated[k] = Math.round((pillarWeights[k] / currentOthersTotal) * remaining)
      })
    }
    actions.updatePillarWeights(updated)
  }

  function handleSaveProfile(e) {
    e.preventDefault()
    if (!profileName.trim()) return
    actions.saveCurrentProfile(profileName.trim())
    setProfileName('')
    setShowSaveForm(false)
  }

  const fundTotal = fundPredictors.reduce((s, p) => s + p.weight, 0)
  const techTotal = techPredictors.reduce((s, p) => s + p.weight, 0)

  return (
    <div className="fixed inset-0 bg-surface-900/80 backdrop-blur z-50 flex items-start justify-end p-4 overflow-auto">
      <div className="w-full max-w-xl bg-surface-800 border border-slate-600 rounded-2xl shadow-2xl">

        {/* Studio header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <div>
            <h2 className="font-display font-bold text-slate-100">⚙️ Scoring Studio</h2>
            <p className="text-xs text-slate-500 mt-0.5">Configure how signals are scored and weighted</p>
          </div>
          <button onClick={onClose} className="btn-ghost text-lg leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {['fundamental', 'technical', 'pillars', 'profiles'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-xs font-medium capitalize transition-colors border-b-2
                ${tab === t
                  ? 'border-accent-cyan text-accent-cyan'
                  : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">

          {/* ── Fundamental tab ── */}
          {tab === 'fundamental' && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">
                  Total weight: <span className={fundTotal === 100 ? 'text-accent-green' : 'text-accent-red'}>{fundTotal}%</span>
                  {fundTotal !== 100 && <span className="text-slate-500"> (adjust to reach 100%)</span>}
                </p>
                <button onClick={resetFundDefaults} className="btn-ghost text-xs">↺ Reset defaults</button>
              </div>

              <div className="space-y-3">
                {fundPredictors.map(p => (
                  <PredictorCard
                    key={p.id}
                    predictor={p}
                    onWeightChange={w => updateFundWeight(p.id, w)}
                    onThresholdChange={p.threshold != null ? t => updateFundThreshold(p.id, t) : null}
                    onRemove={() => removeFundPredictor(p.id)}
                  />
                ))}
              </div>

              {/* Add from defaults not already included */}
              {DEFAULT_FUNDAMENTAL_PREDICTORS.filter(d => !fundPredictors.find(p => p.id === d.id)).length > 0 && (
                <div>
                  <p className="label mb-2">Add Predictor</p>
                  <div className="flex flex-wrap gap-2">
                    {DEFAULT_FUNDAMENTAL_PREDICTORS
                      .filter(d => !fundPredictors.find(p => p.id === d.id))
                      .map(d => (
                        <button key={d.id} onClick={() => addFundPredictor(d)} className="btn-outline text-xs">
                          + {d.label}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Technical tab ── */}
          {tab === 'technical' && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">
                  Total weight: <span className={techTotal === 100 ? 'text-accent-green' : 'text-accent-red'}>{techTotal}%</span>
                </p>
                <button onClick={resetTechDefaults} className="btn-ghost text-xs">↺ Reset defaults</button>
              </div>
              <div className="space-y-3">
                {techPredictors.map(p => (
                  <PredictorCard
                    key={p.id}
                    predictor={p}
                    onWeightChange={w => updateTechWeight(p.id, w)}
                    onRemove={() => removeTechPredictor(p.id)}
                  />
                ))}
              </div>
            </>
          )}

          {/* ── Pillars tab ── */}
          {tab === 'pillars' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-400">
                Set how much each pillar contributes to the Combined Verdict.
                Total must equal 100%.
              </p>
              {Object.entries(pillarWeights).map(([key, val]) => (
                <div key={key} className="space-y-1">
                  <div className="flex justify-between">
                    <label className="text-sm text-slate-300 capitalize">{key}</label>
                    <span className="font-mono text-sm text-slate-200">{val}%</span>
                  </div>
                  <input
                    type="range" min={0} max={100} step={5}
                    value={val}
                    onChange={e => updatePillar(key, parseInt(e.target.value))}
                    className="w-full h-1 bg-surface-700 rounded appearance-none accent-cyan-400"
                  />
                </div>
              ))}
              <div className="card-inner px-4 py-3 flex justify-between">
                <span className="text-xs text-slate-400">Total</span>
                <span className={`font-mono text-xs ${
                  Object.values(pillarWeights).reduce((s,v) => s+v, 0) === 100
                  ? 'text-accent-green' : 'text-accent-red'}`}>
                  {Object.values(pillarWeights).reduce((s,v) => s+v, 0)}%
                </span>
              </div>
            </div>
          )}

          {/* ── Profiles tab ── */}
          {tab === 'profiles' && (
            <div className="space-y-4">
              <p className="text-xs text-slate-400">
                Save the current configuration as a named profile.
                Switch between profiles for different investment styles or sectors.
              </p>

              {/* Saved profiles */}
              {profiles.length > 0 && (
                <div className="space-y-2">
                  {profiles.map(p => (
                    <div key={p.id} className="card-inner px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-200">{p.name}</p>
                        <p className="text-xs text-slate-500">
                          Saved {new Date(p.savedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <button onClick={() => actions.applyProfile(p.id)} className="btn-outline text-xs">Apply</button>
                      <button onClick={() => actions.removeProfile(p.id)} className="btn-ghost text-xs text-accent-red">✕</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Save current */}
              {showSaveForm ? (
                <form onSubmit={handleSaveProfile} className="flex gap-2">
                  <input
                    type="text"
                    value={profileName}
                    onChange={e => setProfileName(e.target.value)}
                    placeholder="Profile name (e.g. Value Investing)"
                    className="flex-1 bg-surface-700 border border-slate-600 rounded-xl px-3 py-2 text-sm
                               text-slate-100 placeholder-slate-500 focus:outline-none focus:border-accent-cyan"
                    autoFocus
                  />
                  <button type="submit" className="btn-primary">Save</button>
                  <button type="button" onClick={() => setShowSaveForm(false)} className="btn-ghost">Cancel</button>
                </form>
              ) : (
                <button onClick={() => setShowSaveForm(true)} className="btn-outline w-full text-sm">
                  + Save Current Config as Profile
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PredictorCard({ predictor, onWeightChange, onThresholdChange, onRemove }) {
  return (
    <div className="bg-surface-700 rounded-xl px-4 py-3 space-y-2 border border-slate-600/40">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm text-slate-200 font-medium">{predictor.label}</p>
          <p className="text-xs text-slate-500">{predictor.desc}</p>
        </div>
        <button onClick={onRemove} className="text-slate-600 hover:text-accent-red transition-colors text-xs flex-shrink-0 mt-0.5">✕</button>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-xs text-slate-400">Weight</label>
          <span className="font-mono text-xs text-slate-300">{predictor.weight}%</span>
        </div>
        <input
          type="range" min={0} max={50} step={5}
          value={predictor.weight}
          onChange={e => onWeightChange(parseInt(e.target.value))}
          className="w-full h-1 bg-surface-900 rounded appearance-none accent-cyan-400"
        />
      </div>

      {onThresholdChange && predictor.threshold != null && (
        <div className="space-y-1">
          <div className="flex justify-between">
            <label className="text-xs text-slate-400">Threshold</label>
            <span className="font-mono text-xs text-slate-300">
              {predictor.direction === 'lower' ? '< ' : '> '}
              {predictor.threshold}
              {predictor.id.includes('margin') || predictor.id.includes('growth') || predictor.id.includes('roce') ? '%' : ''}
            </span>
          </div>
          <input
            type="range"
            min={predictor.direction === 'lower' ? 0 : 0}
            max={predictor.id.includes('growth') ? 50 : predictor.id.includes('margin') ? 80 : 30}
            step={predictor.id.includes('growth') || predictor.id.includes('margin') ? 5 : 1}
            value={predictor.threshold}
            onChange={e => onThresholdChange(parseFloat(e.target.value))}
            className="w-full h-1 bg-surface-900 rounded appearance-none accent-cyan-400"
          />
        </div>
      )}
    </div>
  )
}
