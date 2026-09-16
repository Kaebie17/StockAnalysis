/**
 * src/engine/quality.js — reads table-native fields directly off the
 * latest real row (margins/returns/leverage are all formulas.js
 * STANDARD_FORMULA_ROWS entries; growth via tableGrowthRate, the one
 * toggle-conscious reader every consumer shares). fcfConversion is the one
 * exception still sourced from ratioResult, since it isn't itself a
 * materialized table row (it's fcf÷netProfit computed ad hoc in
 * currentSnapshot.js).
 */
import { activeValue } from './dataQuality.js'
import { latestRealRow, tableGrowthRate } from './formulas.js'

export function scoreQuality(data, ratioResult, weights = {}) {
  const incRow = latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic))
  const balRow = latestRealRow((data?.balanceHistory || []).filter(x => !x.synthetic))
  const basis = data?.basis
  const at = (row, key) => activeValue(row, key, basis)

  const revGrowth = tableGrowthRate(data, 'revenueGrowth', basis)
  const revCagrTagged = {
    value: revGrowth.value ?? null,
    status: revGrowth.value != null ? 'calculated' : 'unavailable',
    formula: revGrowth.windowYears ? `Revenue CAGR over the last ${revGrowth.windowYears} years` : 'Revenue CAGR',
  }
  const cagrWin = revGrowth.windowYears
  const growthLabel = cagrWin ? `Revenue Growth (${cagrWin}yr CAGR)` : 'Revenue Growth (CAGR)'

  const ebitdaMargin = at(incRow, 'ebitdaMargin') ?? at(incRow, 'operatingMargin')
  const netMargin = at(incRow, 'netMargin')
  const de = at(balRow, 'de')
  const roe = at(incRow, 'roe')
  const roce = at(incRow, 'roce')
  const icr = at(incRow, 'icr')
  const fcfConversion = ratioResult?.ratios?.fcfConversion

  const predictors = [
    { key: 'revenueGrowth', label: growthLabel,
      value: revCagrTagged.value, threshold: 10,
      pass: revCagrTagged.value != null ? revCagrTagged.value >= 10 : null,
      weight: weights.revenueGrowth ?? 1.5, tagged: revCagrTagged },

    { key: 'ebitdaMargin', label: 'EBITDA / Operating Margin',
      value: ebitdaMargin?.value,
      threshold: 12,
      pass: ebitdaMargin?.value != null ? ebitdaMargin.value >= 12 : null,
      weight: weights.ebitdaMargin ?? 1, tagged: ebitdaMargin },

    { key: 'netMargin', label: 'Net Profit Margin',
      value: netMargin?.value, threshold: 8,
      pass: netMargin?.value != null ? netMargin.value >= 8 : null,
      weight: weights.netMargin ?? 1, tagged: netMargin },

    { key: 'fcfConversion', label: 'FCF Conversion (FCF/Net Profit)',
      value: fcfConversion?.value, threshold: 60,
      pass: fcfConversion?.value != null ? fcfConversion.value >= 60 : null,
      weight: weights.fcfConversion ?? 1.5, tagged: fcfConversion },

    { key: 'de', label: 'Debt / Equity (lower is better)',
      value: de?.value, threshold: 1,
      pass: de?.value != null ? de.value < 1.0 : null,
      weight: weights.de ?? 1, tagged: de },

    { key: 'roe', label: 'Return on Equity',
      value: roe?.value, threshold: 12,
      pass: roe?.value != null ? roe.value >= 12 : null,
      weight: weights.roe ?? 1.5, tagged: roe },

    { key: 'roce', label: 'Return on Capital Employed',
      value: roce?.value, threshold: 12,
      pass: roce?.value != null ? roce.value >= 12 : null,
      weight: weights.roce ?? 1, tagged: roce },

    { key: 'icr', label: 'Interest Coverage (EBITDA/Interest)',
      value: icr?.value, threshold: 3,
      pass: icr?.value != null ? icr.value >= 3 : null,
      weight: weights.icr ?? 1, tagged: icr },

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
