/**
 * src/engine/spread.js — shared "measure it from the data itself" primitives.
 *
 * This exact logic (sort a real historical series, take a percentile band,
 * gate on a minimum sample size; or exclude a value that's relatively far
 * from the sample's own median) was independently reimplemented five
 * different times across this codebase (forwardPeBand, pbBand,
 * priceDispersion, multipleSpread, growthScenarioSpread), each slightly
 * differently. That's exactly the shape of risk that caused a real bug this
 * session: a fix applied to one copy (forwardPeBand's outlier filter) did
 * not automatically reach its sibling (pbBand still had the old flat
 * ceiling) until asked about directly. One shared implementation, used
 * everywhere this pattern appears, so a future fix can't miss a copy that
 * doesn't exist anymore.
 */

/**
 * Percentile band from a raw numeric series — the shared shape behind
 * "median plus a low/high band" wherever this codebase needs one.
 *
 * minSamples is a genuine structural floor: a percentile BAND (low/high)
 * from fewer points than this isn't a noisy estimate, it's degenerate — at
 * n=2 the formula below picks nothing but the two raw endpoints (see
 * targetMultiple.js's cited Trent failure). Below it, decline (null), the
 * same standing as any other structural requirement in this codebase, not
 * a plausibility judgment.
 *
 * preferredSamples is different: below it the result is still computed and
 * returned, tagged `thin: true` — real data, disclosed as a smaller sample
 * than ideal, not hidden.
 *
 * @returns { low, median, high, count, thin } or null if fewer than
 *          minSamples usable values exist.
 */
export function percentileSpread(values, { lowP = 0.15, highP = 0.85, minSamples = 3, preferredSamples = minSamples } = {}) {
  const clean = (values || []).filter(v => v != null && isFinite(v))
  if (clean.length < minSamples) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { low: q(lowP), median: q(0.5), high: q(highP), count: sorted.length,
           thin: sorted.length < preferredSamples }
}

/**
 * Exclude values that sit far from the sample's OWN median — a data
 * artifact (a mid-year restatement, a stub year, a quote glitch), not a
 * price/multiple anyone actually traded at. Measured from the sample's own
 * distribution rather than a fixed absolute band, which is what let a real
 * observation (Trent's own ~117x P/E; a genuine >12x-book compounder) get
 * silently discarded before this existed.
 *
 * Falls back to the unfiltered set if filtering would remove more than half
 * the data (or drop below minKeep) — a sign the "outlier" cluster is the
 * dominant regime, not a genuine artifact, and a thin, aggressively-filtered
 * remainder would itself be less reliable than the full sample.
 */
export function filterRelativeOutliers(values, { multiple = 4, minKeep = 20 } = {}) {
  const clean = (values || []).filter(v => v != null && isFinite(v) && v > 0)
  if (clean.length === 0) return clean
  const sorted = [...clean].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!(median > 0)) return clean
  const filtered = clean.filter(v => v >= median / multiple && v <= median * multiple)
  return filtered.length >= Math.max(minKeep, clean.length * 0.5) ? filtered : clean
}
