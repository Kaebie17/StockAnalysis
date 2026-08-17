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

const keyFor = (market) => `sa_riskfree_${market}`
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000     // a month
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000      // six months — say so loudly

let inflight = null
let lastError = null

// Failures are not retried on a timer. useEstimate is mounted by five separate
// components, each of which ran its own fetch — so a single page produced five
// calls a minute against a rate that changes a few basis points a month. After a
// failure the rate is simply absent until the user asks for it again.
let failedAt = 0
const RETRY_LOCKOUT_MS = 60 * 60 * 1000

function load(market) {
  try {
    const raw = localStorage.getItem(keyFor(market))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function save(market, v) {
  try { localStorage.setItem(keyFor(market), JSON.stringify(v)) } catch {}
}

/**
 * Has a key appeared since the stored rate was fetched?
 *
 * The stored value carries no record of whether a key was used, so a rate
 * fetched keylessly (which always fails) looked identical to a real one and was
 * reused for a month. Recording it means entering a key later triggers a refetch
 * immediately, which is what a user expects after adding one.
 */
function shouldRefetch(stored, userKey) {
  if (!stored) return true
  if (userKey && !stored.hadKey) return true
  return false
}

/**
 * @returns { rate, ratePct, asOf, ageDays, stale, note } — `rate` as a decimal
 * for the engines, `ratePct` for display. `rate` is null when nothing usable
 * exists, which is a valid state the caller must handle.
 */
export async function getRiskFreeRate({ market = 'IN', userKey = null, force = false } = {}) {
  const stored = load(market)
  const age = stored?.fetchedAt ? Date.now() - stored.fetchedAt : Infinity

  // A stored rate is only reused if it was fetched WITH a key. The first load
  // after install has no key, stores nothing, and the earlier version then kept
  // returning that empty result — so entering a key later changed nothing until
  // storage was cleared by hand.
  if (!force && stored?.rate > 0 && age < REFRESH_AFTER_MS && !shouldRefetch(stored, userKey)) {
    return shape(stored)
  }

  // No key means the request cannot succeed, so it isn't made. Returning
  // immediately also avoids poisoning the CDN with a keyless response that a
  // later keyed request would then be served from.
  if (!userKey) {
    return stored?.rate > 0 ? shape(stored) : shape(null)
  }

  // A recent failure blocks further attempts until the user explicitly refreshes.
  // Without this, every component mount retried a call that had just failed —
  // hammering the API for a value that is monthly by nature.
  if (!force && failedAt && Date.now() - failedAt < RETRY_LOCKOUT_MS) {
    return stored?.rate > 0 ? shape(stored) : shape(null)
  }

  // One fetch at a time — several components ask for this on the same render.
  if (!inflight) {
    inflight = (async () => {
      try {
        // POST, not GET. The key was a query parameter on a cacheable GET, so
        // it travelled in the URL and Vercel cached the response against it —
        // an earlier keyless answer could be replayed for a keyed request.
        const r = await fetch('/api/riskfree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ market, force, userKey }),
        })
        if (!r.ok) return null
        const j = await r.json().catch(() => null)
        if (j?.rate > 0) {
          const rec = { ...j, hadKey: true }
          save(market, rec); failedAt = 0; lastError = null
          return rec
        }
        // Carry the reason forward so the UI can say WHY rather than only that
        // no rate is available — a wrong model name and a restricted key look
        // identical otherwise.
        lastError = j?.detail || j?.error || 'no rate returned'
        failedAt = Date.now()
        return null
      } catch (e) { lastError = e?.message || 'request failed'; failedAt = Date.now(); return null }
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
             error: lastError,
             note: lastError
               ? `Risk-free rate unavailable: ${lastError}`
               : 'No risk-free rate available — fundamentals-based estimates need one.' }
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
  try {
    localStorage.removeItem('sa_riskfree_US')
    localStorage.removeItem('sa_riskfree_IN')
    localStorage.removeItem('sa_riskfree')   // legacy market-blind key
  } catch {}
  failedAt = 0
  lastError = null
}

/** Explicit user-triggered refresh — bypasses the lockout. */
export function refreshRiskFreeRate({ market = 'IN', userKey = null } = {}) {
  failedAt = 0
  return getRiskFreeRate({ market, userKey, force: true })
}
