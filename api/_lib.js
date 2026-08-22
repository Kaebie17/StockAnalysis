// api/_lib.js — shared guards for the serverless API routes.
//
// NOT a route itself: Vercel excludes underscore-prefixed files under /api
// from routing, so this is safe to import from every handler without
// becoming an accidental endpoint.
//
// Two independent, best-effort mitigations against unauthenticated abuse —
// neither is a hard guarantee (see the caveats on each), but together they
// stop the realistic threat: casual scripted scraping of these proxies from
// other sites, and silent drain of the server-side Gemini fallback key.

const ALLOWED_ORIGINS = new Set([
  'https://stockinspector.in',
  'https://www.stockinspector.in',
])

/**
 * Blocks a request only when Origin is PRESENT and NOT allowed. Never blocks
 * a MISSING Origin — browsers don't reliably send one on every same-origin
 * request (varies by browser, method, and PWA standalone mode), so treating
 * "no Origin" as suspicious would false-positive on real users. This catches
 * browser-based cross-site abuse (another site's JS calling these endpoints)
 * without touching legitimate traffic. It does nothing against a script that
 * simply omits the header (curl, Postman) — that's not fixable from here
 * without breaking direct/native traffic too.
 */
function checkOrigin(req, res) {
  const origin = req.headers.origin
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'forbidden_origin' })
    return false
  }
  return true
}

/**
 * Stricter variant for endpoints with a real per-call cost when they fall
 * back to a server-owned key (currently just /api/analyze without a
 * userKey). Requires Origin to be present AND allowed — safe here because
 * POST fetch() calls reliably carry Origin regardless of same-origin,
 * unlike the GET proxies above.
 */
function requireOrigin(req, res) {
  const origin = req.headers.origin
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: 'forbidden_origin' })
    return false
  }
  return true
}

// Best-effort per-instance rate limiter. Vercel serverless functions run
// across many ephemeral instances with no shared memory, so this Map only
// limits requests that land on the SAME warm instance — it deters sustained
// abuse hitting one instance, but a distributed or cold-start-heavy attacker
// can partially route around it. A hard global cap needs an external store
// (Vercel KV / Upstash Redis); this is the zero-infrastructure stopgap.
const buckets = new Map()   // "prefix:ip" -> { count, resetAt }
const MAX_BUCKETS = 5000    // bound memory on a long-lived warm instance

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (fwd) return String(fwd).split(',')[0].trim()
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown'
}

/**
 * @param opts.max        requests allowed per window (default 60)
 * @param opts.windowMs    window length in ms (default 60_000)
 * @param opts.keyPrefix   namespaces the bucket per endpoint, so one busy
 *                         route doesn't eat another's budget
 */
function rateLimit(req, res, { max = 60, windowMs = 60_000, keyPrefix = '' } = {}) {
  const key = keyPrefix + ':' + clientIp(req)
  const now = Date.now()
  let b = buckets.get(key)
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b) }
  b.count++
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, v] of buckets) { if (now > v.resetAt) buckets.delete(k) }
  }
  if (b.count > max) {
    res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)))
    res.status(429).json({ error: 'rate_limited' })
    return false
  }
  return true
}

module.exports = { checkOrigin, requireOrigin, rateLimit, ALLOWED_ORIGINS }
