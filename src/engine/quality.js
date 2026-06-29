/**
 * src/engine/quality.js — reads scalar values from ratioResult
 */
export function scoreQuality(data, ratioResult, weights = {}) {
  const r = ratioResult
  const ratios = r?.ratios || {}

  const predictors = [
    { key: 'revenueGrowth', label: 'Revenue Growth (5yr CAGR)',
      value: ratios.revCagr?.value, threshold: 10,
      pass: ratios.revCagr?.value != null ? ratios.revCagr.value >= 10 : null,
      weight: weights.revenueGrowth ?? 1.5, tagged: ratios.revCagr },

    { key: 'ebitdaMargin', label: 'EBITDA / Operating Margin',
      value: ratios.ebitdaMargin?.value ?? ratios.operatingMargin?.value,
      threshold: 12,
      pass: (ratios.ebitdaMargin?.value ?? ratios.operatingMargin?.value) != null
        ? (ratios.ebitdaMargin?.value ?? ratios.operatingMargin?.value) >= 12 : null,
      weight: weights.ebitdaMargin ?? 1, tagged: ratios.ebitdaMargin ?? ratios.operatingMargin },

    { key: 'netMargin', label: 'Net Profit Margin',
      value: ratios.netMargin?.value, threshold: 8,
      pass: ratios.netMargin?.value != null ? ratios.netMargin.value >= 8 : null,
      weight: weights.netMargin ?? 1, tagged: ratios.netMargin },

    { key: 'fcfConversion', label: 'FCF Conversion (FCF/Net Profit)',
      value: ratios.fcfConversion?.value, threshold: 60,
      pass: ratios.fcfConversion?.value != null ? ratios.fcfConversion.value >= 60 : null,
      weight: weights.fcfConversion ?? 1.5, tagged: ratios.fcfConversion },

    { key: 'de', label: 'Debt / Equity (lower is better)',
      value: ratios.de?.value, threshold: 1,
      pass: ratios.de?.value != null ? ratios.de.value < 1.0 : null,
      weight: weights.de ?? 1, tagged: ratios.de },

    { key: 'roe', label: 'Return on Equity',
      value: ratios.roe?.value, threshold: 12,
      pass: ratios.roe?.value != null ? ratios.roe.value >= 12 : null,
      weight: weights.roe ?? 1.5, tagged: ratios.roe },

    { key: 'roce', label: 'Return on Capital Employed',
      value: ratios.roce?.value, threshold: 12,
      pass: ratios.roce?.value != null ? ratios.roce.value >= 12 : null,
      weight: weights.roce ?? 1, tagged: ratios.roce },

    { key: 'icr', label: 'Interest Coverage (EBITDA/Interest)',
      value: ratios.icr?.value, threshold: 3,
      pass: ratios.icr?.value != null ? ratios.icr.value >= 3 : null,
      weight: weights.icr ?? 1, tagged: ratios.icr },

    { key: 'consistency', label: 'Earnings Consistency (profitable 3+/5yr)',
      value: null, threshold: null,
      pass: checkConsistency(data?.incomeHistory),
      weight: weights.consistency ?? 1, tagged: null },
  ]

  const scoreable = predictors.filter(p => p.pass !== null)
  let totalW = 0, earnedW = 0
  scoreable.forEach(p => { totalW += p.weight; if (p.pass) earnedW += p.weight })

  const score = totalW > 0 ? (earnedW / totalW) * 10 : 5
  const label = score >= 7.5 ? 'EXCELLENT' : score >= 5.5 ? 'HEALTHY' : score >= 3.5 ? 'CONCERNS' : 'WEAK'

  return { score: +score.toFixed(1), label, predictors }
}

function checkConsistency(incomeHistory) {
  if (!incomeHistory || incomeHistory.length < 3) return null
  const last5 = incomeHistory.slice(-5)
  const profitable = last5.filter(y => (y.netProfit?.value ?? 0) > 0).length
  return profitable >= 3
}
