/**
 * src/api/erpClient.js — the equity risk premium, cached across sessions.
 *
 * Mirrors src/api/riskFreeClient.js exactly, for the same reasons: ERP moves
 * slowly enough that every fetch costs an API call worth caching hard
 * against, and a made-up ERP would silently move every CAPM-derived required
 * return in the app.
 *
 * Never substitutes a default. Where no live ERP is available, callers fall
 * back to the static ERP_BY_MARKET constant (requiredReturn.js) — that
 * remains a legitimate, disclosed fallback, this is just the live path
 * layered on top of it.
 */

const keyFor = (market) => `sa_erp_${market}`
const REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000     // a month — ERP moves even slower than the risk-free rate
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000      // six months — say so loudly

let inflight = null
let lastError = null

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

function shouldRefetch(stored, userKey) {
  if (!stored) return true
  if (userKey && !stored.hadKey) return true
  return false
}

/**
 * @returns { erp, erpPct, asOf, ageDays, stale, note } — `erp` as a decimal
 * for the engines, `erpPct` for display. `erp` is null when nothing usable
 * exists, which is a valid state the caller must handle (falling back to
 * ERP_BY_MARKET).
 */
export async function getEquityRiskPremium({ market = 'IN', userKey = null, force = false } = {}) {
  const stored = load(market)
  const age = stored?.fetchedAt ? Date.now() - stored.fetchedAt : Infinity

  if (!force && stored?.erp > 0 && age < REFRESH_AFTER_MS && !shouldRefetch(stored, userKey)) {
    return shape(stored)
  }

  if (!userKey) {
    return stored?.erp > 0 ? shape(stored) : shape(null)
  }

  if (!force && failedAt && Date.now() - failedAt < RETRY_LOCKOUT_MS) {
    return stored?.erp > 0 ? shape(stored) : shape(null)
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const r = await fetch('/api/erp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ market, force, userKey }),
        })
        if (!r.ok) return null
        const j = await r.json().catch(() => null)
        if (j?.erp > 0) {
          const rec = { ...j, hadKey: true }
          save(market, rec); failedAt = 0; lastError = null
          return rec
        }
        lastError = j?.detail || j?.error || 'no erp returned'
        failedAt = Date.now()
        return null
      } catch (e) { lastError = e?.message || 'request failed'; failedAt = Date.now(); return null }
      finally { inflight = null }
    })()
  }

  const fresh = await inflight
  return shape(fresh || stored)
}

function shape(v) {
  if (!(v?.erp > 0)) {
    return { erp: null, erpPct: null, asOf: null, ageDays: null, stale: true,
             error: lastError,
             note: lastError
               ? `Equity risk premium unavailable: ${lastError}`
               : 'No live equity risk premium available — using the default assumption.' }
  }
  const ageDays = v.fetchedAt ? Math.round((Date.now() - v.fetchedAt) / 86400000) : null
  const stale = ageDays != null && (Date.now() - v.fetchedAt) > STALE_AFTER_MS
  return {
    erp: v.erp / 100,
    erpPct: v.erp,
    asOf: v.asOf ?? null,
    name: v.name ?? null,
    ageDays, stale,
    note: stale
      ? `Equity risk premium is ${Math.round(ageDays / 30)} months old — refresh it for a current reading.`
      : null,
  }
}

export function clearErpCache() {
  try {
    localStorage.removeItem('sa_erp_US')
    localStorage.removeItem('sa_erp_IN')
  } catch {}
  failedAt = 0
  lastError = null
}

/** Explicit user-triggered refresh — bypasses the lockout. */
export function refreshEquityRiskPremium({ market = 'IN', userKey = null } = {}) {
  failedAt = 0
  return getEquityRiskPremium({ market, userKey, force: true })
}
