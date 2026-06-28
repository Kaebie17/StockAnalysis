/**
 * src/engine/quality.js
 */

export function scoreQuality(data, ratios, weights = DEFAULT_WEIGHTS) {
  const predictors = [
    {
      key: 'revenueGrowth',
      label: 'Revenue Growth (5yr CAGR)',
      value: ratios.revCagr,
      threshold: 10,
      pass: ratios.revCagr >= 10,
      weight: weights.revenueGrowth ?? 1.5
    },
    {
      key: 'grossMargin',
      label: 'Gross Margin',
      value: ratios.grossMargin,
      threshold: 30,
      pass: ratios.grossMargin >= 30,
      weight: weights.grossMargin ?? 1
    },
    {
      key: 'ebitdaMargin',
      label: 'EBITDA Margin',
      value: ratios.ebitdaMargin,
      threshold: 15,
      pass: ratios.ebitdaMargin >= 15,
      weight: weights.ebitdaMargin ?? 1
    },
    {
      key: 'netMargin',
      label: 'Net Margin',
      value: ratios.netMargin,
      threshold: 8,
      pass: ratios.netMargin >= 8,
      weight: weights.netMargin ?? 1
    },
    {
      key: 'fcfConversion',
      label: 'FCF Conversion',
      value: ratios.fcfConversion,
      threshold: 60,
      pass: ratios.fcfConversion >= 60,
      weight: weights.fcfConversion ?? 1.5
    },
    {
      key: 'debtTrend',
      label: 'Debt Management',
      value: ratios.de,
      threshold: 1,
      pass: ratios.de != null ? ratios.de < 1.0 : null,
      weight: weights.debtTrend ?? 1
    },
    {
      key: 'roe',
      label: 'Return on Equity',
      value: ratios.roe,
      threshold: 12,
      pass: ratios.roe >= 12,
      weight: weights.roe ?? 1.5
    },
    {
      key: 'interestCoverage',
      label: 'Interest Coverage',
      value: ratios.interestCoverage,
      threshold: 3,
      pass: ratios.interestCoverage >= 3 || ratios.interestCoverage == null,
      weight: weights.interestCoverage ?? 1
    },
    {
      key: 'consistency',
      label: 'Earnings Consistency',
      value: null,
      threshold: null,
      pass: checkConsistency(data.incomeHistory),
      weight: weights.consistency ?? 1
    }
  ]

  // Only score predictors where we have data
  const scoreable = predictors.filter(p => p.pass !== null && p.value !== null || p.key === 'consistency')

  let totalWeight = 0, earnedWeight = 0
  scoreable.forEach(p => {
    totalWeight += p.weight
    if (p.pass) earnedWeight += p.weight
  })

  const score = totalWeight > 0 ? (earnedWeight / totalWeight) * 10 : 5
  const label = score >= 7.5 ? 'EXCELLENT' : score >= 5.5 ? 'HEALTHY' : score >= 3.5 ? 'CONCERNS' : 'WEAK'

  return { score: +score.toFixed(1), label, predictors }
}

function checkConsistency(incomeHistory) {
  if (!incomeHistory || incomeHistory.length < 3) return null
  const last5 = incomeHistory.slice(-5)
  const profitable = last5.filter(y => y.netIncome > 0).length
  return profitable >= 3
}

const DEFAULT_WEIGHTS = {
  revenueGrowth: 1.5, grossMargin: 1, ebitdaMargin: 1, netMargin: 1,
  fcfConversion: 1.5, debtTrend: 1, roe: 1.5, interestCoverage: 1, consistency: 1
}
