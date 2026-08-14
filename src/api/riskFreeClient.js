/**
 * src/api/riskFreeClient.js — the risk-free rate, cached across sessions.
 *
 * Persisted in localStorage rather than refetched, because the rate moves by a
 * few basis points a month and every fetch costs an API call the user is paying
 * for. A month-old figure is accurate enough for a valuation input; a
 * two-year-old one is not, which is what the age check is for.
 *
 * Never substitutes a default. Where no rate is available the fundamentals-based
 * estimate simply doesn't render and says why — a made-up risk-free rate would
 * silently move every justified multiple in the app.
 */

const KEY = 'sa_riskfree'
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000     // a month
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000      // six months — say so loudly

let inflight = null

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function save(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* private mode */ }
}

/**
 * @returns { rate, ratePct, asOf, ageDays, stale, note } — `rate` as a decimal
 * for the engines, `ratePct` for display. `rate` is null when nothing usable
 * exists, which is a valid state the caller must handle.
 */
export async function getRiskFreeRate({ market = 'IN', userKey = null, force = false } = {}) {
  const stored = load()
  const age = stored?.fetchedAt ? Date.now() - stored.fetchedAt : Infinity

  if (!force && stored?.rate > 0 && age < REFRESH_AFTER_MS) return shape(stored)

  // One fetch at a time — several components ask for this on the same render.
  if (!inflight) {
    inflight = (async () => {
      try {
        const qs = new URLSearchParams({ market })
        if (force) qs.set('force', '1')
        if (userKey) qs.set('userKey', userKey)
        const r = await fetch(`/api/riskfree?${qs}`)
        if (!r.ok) return null
        const j = await r.json().catch(() => null)
        if (j?.rate > 0) { save(j); return j }
        return null
      } catch { return null }
      finally { inflight = null }
    })()
  }

  const fresh = await inflight
  // A failed refresh falls back to whatever is stored, however old — a real
  // rate from six months ago beats no estimate at all, and the age is shown.
  return shape(fresh || stored)
}

function shape(v) {
  if (!(v?.rate > 0)) {
    return { rate: null, ratePct: null, asOf: null, ageDays: null, stale: true,
             note: 'No risk-free rate available — fundamentals-based estimates need one.' }
  }
  const ageDays = v.fetchedAt ? Math.round((Date.now() - v.fetchedAt) / 86400000) : null
  const stale = ageDays != null && (Date.now() - v.fetchedAt) > STALE_AFTER_MS
  return {
    rate: v.rate / 100,
    ratePct: v.rate,
    asOf: v.asOf ?? null,
    name: v.name ?? null,
    ageDays, stale,
    note: stale
      ? `Risk-free rate is ${Math.round(ageDays / 30)} months old — refresh it for a current reading.`
      : null,
  }
}

export function clearRiskFreeCache() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}
