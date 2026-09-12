/**
 * src/engine/quality.js — reads scalar values from ratioResult
 */
import { activeValue } from './dataQuality.js'

export function scoreQuality(data, ratioResult, weights = {}) {
  const r = ratioResult
  const ratios = r?.ratios || {}
  const cagrWin = ratios.revCagrWindowYears?.value
  const growthLabel = cagrWin ? `Revenue Growth (${cagrWin}yr CAGR)` : 'Revenue Growth (CAGR)'
  const predictors = [
    { key: 'revenueGrowth', label: growthLabel,
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
      pass: checkConsistency(data?.reportedIncomeHistory, data?.basis),
      weight: weights.consistency ?? 1, tagged: null },
  ]

  const scoreable = predictors.filter(p => p.pass !== null)
  let totalW = 0, earnedW = 0
  scoreable.forEach(p => { totalW += p.weight; if (p.pass) earnedW += p.weight })

  const score = totalW > 0 ? (earnedW / totalW) * 10 : 5
  const label = score >= 7.5 ? 'EXCELLENT' : score >= 5.5 ? 'HEALTHY' : score >= 3.5 ? 'CONCERNS' : 'WEAK'

  return { score: +score.toFixed(1), label, predictors }
}

function checkConsistency(incomeHistory, basis) {
  if (!incomeHistory || incomeHistory.length < 3) return null
  // Screener's page always trails its real fiscal-year columns with one
  // more, headed "TTM" — a partial, overlapping period, not a year. Left in,
  // it would occupy one of these "last 5" slots (displacing a real year) and
  // have its trailing-12-month profit judged as if it were a full FY's. Same
  // guard as ratios.js/dataGaps.js/Header.jsx, which had the identical bug.
  const realYears = incomeHistory.filter(y => /^\d{4}$/.test(String(y?.year ?? '').trim()))
  const last5 = realYears.slice(-5)
  // A year with no reported net profit was coerced to 0 via `?? 0`, which
  // reads as a LOSS — a missing figure and a real loss are not the same
  // thing, and on a thin history one data gap could flip this predicter
  // from pass to fail on no evidence at all. Excluded, not counted against.
  const npOf = y => activeValue(y, 'netProfit', basis)?.value
  const known = last5.filter(y => npOf(y) != null)
  if (known.length < 3) return null   // not enough real data to judge consistency
  const profitable = known.filter(y => npOf(y) > 0).length
  // Same "3 of 5" bar (60%), applied to however many years actually have a
  // reported figure rather than assuming an unreported year failed it.
  return profitable / known.length >= 0.6
}
