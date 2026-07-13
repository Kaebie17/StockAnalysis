/**
 * src/engine/provenance.js — three-tier data provenance.
 *
 *   real       — directly from a source (Yahoo / Screener / a document's actual figure)
 *   calculated — derived from real inputs via a formula (ratios, gross margin from COGS+revenue)
 *   estimated  — reconstructed/inferred (trend-filled, quarterly-summed, provisional)
 *
 * A tagged value is { value, tier, method?, note? }. Keep the tag with the number
 * wherever it flows so the UI can label it honestly.
 */

export const TIER = { REAL: 'real', CALCULATED: 'calculated', ESTIMATED: 'estimated' }

export const real       = (value, meta = {}) => ({ value, tier: TIER.REAL, ...meta })
export const calculated = (value, meta = {}) => ({ value, tier: TIER.CALCULATED, ...meta })
export const estimated  = (value, meta = {}) => ({ value, tier: TIER.ESTIMATED, ...meta })

export const isReal       = t => t?.tier === TIER.REAL
export const isCalculated = t => t?.tier === TIER.CALCULATED
export const isEstimated  = t => t?.tier === TIER.ESTIMATED

export const valueOf = t => (t && typeof t === 'object' && 'tier' in t ? t.value : t)

export function tierMeta(tier) {
  switch (tier) {
    case TIER.REAL:       return { label: 'Real',       short: 'R', color: 'bull',    hint: 'Directly from source data' }
    case TIER.CALCULATED: return { label: 'Calculated', short: 'C', color: 'accent',  hint: 'Derived from real inputs via a formula' }
    case TIER.ESTIMATED:  return { label: 'Estimated',  short: 'E', color: 'neutral', hint: 'Reconstructed/inferred — treat as approximate' }
    default:              return { label: '',           short: '',  color: 'slate',   hint: '' }
  }
}
