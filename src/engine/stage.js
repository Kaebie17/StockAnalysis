// stage.js
// Auto-detects company stage from normalized data
// User can override. Stage drives which valuation models and predictors are active.

export const STAGES = {
  PRE_REVENUE:  { id: 'pre_revenue',  label: 'Pre-Revenue / Early Stage', emoji: '🌱' },
  GROWTH:       { id: 'growth',       label: 'Growth / Scaling',           emoji: '🚀' },
  TRANSITION:   { id: 'transition',   label: 'Transition / Inflection',    emoji: '📈' },
  ESTABLISHED:  { id: 'established',  label: 'Established / Mature',       emoji: '🏛️' },
}

export function detectStage(data, historicalRatios) {
  const { latest, incomeHistory } = data
  const { revenue, netIncome, fcf, ebitda } = latest

  // No revenue at all
  if (!revenue || revenue <= 0) return STAGES.PRE_REVENUE.id

  // Check profitability consistency
  const profitableYears = incomeHistory.filter(y => y.netIncome > 0).length
  const fcfPositiveYears = data.cashflowHistory?.filter(y => y.fcf > 0).length ?? 0

  // Revenue growth
  const revenueGrowth = calcRevenueGrowth(incomeHistory)

  // Stage 4: Established
  if (profitableYears >= 3 && fcfPositiveYears >= 2 && (revenueGrowth == null || revenueGrowth < 25)) {
    return STAGES.ESTABLISHED.id
  }

  // Stage 3: Transition — approaching profitability
  if (revenueGrowth != null && revenueGrowth > 15 && netIncome != null) {
    const recentlyProfitable = incomeHistory.slice(0, 2).some(y => y.netIncome > 0)
    if (recentlyProfitable) return STAGES.TRANSITION.id
  }

  // Stage 2: Growth — revenue exists, still loss-making
  if (revenue > 0 && (netIncome == null || netIncome <= 0)) {
    return STAGES.GROWTH.id
  }

  // Stage 3 catch-all for profitable but fast-growing
  if (revenueGrowth != null && revenueGrowth >= 25 && netIncome > 0) {
    return STAGES.TRANSITION.id
  }

  return STAGES.ESTABLISHED.id
}

function calcRevenueGrowth(incomeHistory) {
  const sorted = [...incomeHistory].sort((a, b) => new Date(b.date) - new Date(a.date))
  if (sorted.length < 2) return null
  const latest = sorted[0].revenue
  const prior  = sorted[1].revenue
  if (!latest || !prior || prior <= 0) return null
  return ((latest - prior) / prior) * 100
}

export function getStageConfig(stageId) {
  return Object.values(STAGES).find(s => s.id === stageId) ?? STAGES.ESTABLISHED
}
