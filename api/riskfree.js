// api/riskfree.js — the current 10-year government bond yield, used as the
// risk-free rate in the justified-multiple calculation.
//
// Fetched rather than hardcoded because it moves, and every justified multiple
// is sensitive to it: a point on the risk-free rate moves a P/E by several
// turns. Asked of Gemini because no free market-data API carries the Indian
// 10-year G-Sec reliably, and the number is public, single-valued and easy to
// state — the kind of lookup a language model does well.
//
// Two safeguards, because a hallucinated rate would silently distort every
// estimate downstream:
//   1. The answer is bounded. Anything outside 4-12% for India is rejected —
//      the 10-year has not left that band in decades, so a value beyond it is a
//      model error rather than a market event.
//   2. Failure returns the LAST GOOD value with its date, never a default. A
//      stale-but-real rate is better than an invented one, and the client shows
//      how old it is.

import { checkOrigin, requireOrigin, rateLimit } from './_lib.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'

// Plausible bands by market. A rate outside these is rejected regardless of how
// confidently it is stated.
const BOUNDS = {
  IN: { min: 4, max: 12, name: 'India 10-year G-Sec' },
  US: { min: 0.5, max: 10, name: 'US 10-year Treasury' },
}

// Cached in module memory. Serverless instances recycle, so this is a warm-start
// optimisation rather than storage — the client caches properly.
let cached = null      // { rate, asOf, market, fetchedAt }

const TTL_MS = 30 * 24 * 60 * 60 * 1000   // a month; the rate moves slowly

export default async function handler(req, res) {
  // Accepts POST (key in the body) or GET (server-key only). The key must never
  // travel in a query string on a cacheable GET — the URL is logged upstream and
  // the response gets cached against it.
  const q = req.method === 'POST' ? (req.body || {}) : (req.query || {})
  const market = String(q.market || 'IN').toUpperCase()
  const bounds = BOUNDS[market] || BOUNDS.IN
  const force = q.force === '1' || q.force === true

  if (!force && cached?.market === market && Date.now() - cached.fetchedAt < TTL_MS) {
    // Never cached at the CDN: the response depends on whether a key was sent,
    // so a shared cache would serve one caller's outcome to another.
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ...cached, source: 'cache' })
  }

  const key = q.userKey || process.env.GEMINI_API_KEY

  // Same reasoning as /api/analyze: a request relying on the server's own
  // GEMINI_API_KEY has a real cost, and `force=1` bypasses this endpoint's
  // month-long cache entirely — without this check, anyone could repeatedly
  // force a fresh (billed) lookup with no key of their own. A user-supplied
  // key only spends the user's own quota.
  const usingServerKey = !q.userKey && !!process.env.GEMINI_API_KEY
  if (usingServerKey) { if (!requireOrigin(req, res)) return }
  else { if (!checkOrigin(req, res)) return }
  if (!rateLimit(req, res, { max: 10, windowMs: 60_000, keyPrefix: 'riskfree' })) return

  if (!key) {
    return res.status(200).json(cached
      ? { ...cached, source: 'stale', note: 'No API key — showing the last value fetched.' }
      : { rate: null, error: 'no_key',
          note: 'No API key configured, so the risk-free rate cannot be fetched.' })
  }

  const MODEL = q.model || DEFAULT_MODEL

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text:
            `You report a single financial figure. Reply with ONLY a JSON object, no prose ` +
            `and no markdown fences: {"rate": <number>, "asOf": "<YYYY-MM>"} where rate is the ` +
            `yield as a percentage (for example 6.85 for 6.85%). If you are not reasonably ` +
            `confident of a current figure, reply {"rate": null}.` }] },
          contents: [{ role: 'user', parts: [{ text:
            `What is the current yield on the ${bounds.name}?` }] }],
          generationConfig: {
            temperature: 0,
            // 2.5-flash is a thinking model: it spends output tokens reasoning
            // before answering, so a 100-token cap was consumed before the JSON
            // closed and the response arrived truncated at `{"rate":`. Thinking
            // is disabled outright — this is a lookup, not a problem to reason
            // about — and the ceiling raised so the answer can't be clipped.
            maxOutputTokens: 512,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: 'application/json',
          },
        }),
      })

    const data = await r.json().catch(() => null)
    if (!r.ok) {
      // The status and message, not just "failed" — a 400 from a bad model name
      // and a 403 from a restricted key need completely different fixes, and the
      // client was showing the same nothing for both.
      const detail = data?.error?.message || `HTTP ${r.status}`
      console.warn('[riskfree] gemini error', r.status, detail)
      return res.status(200).json({ ...fallback(cached, 'fetch_failed'), detail })
    }

    const cand = data?.candidates?.[0]
    const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? ''
    const parsed = parseRate(text)

    // A truncated or empty completion has a distinct finishReason, and saying
    // which one it was turns "unparseable" into something actionable.
    if (parsed == null && cand?.finishReason && cand.finishReason !== 'STOP') {
      console.warn('[riskfree] incomplete completion:', cand.finishReason)
      return res.status(200).json({ ...fallback(cached, 'incomplete'),
        detail: cand.finishReason === 'MAX_TOKENS'
          ? 'the model ran out of output tokens before answering'
          : `the model stopped early (${cand.finishReason})` })
    }

    if (parsed == null) {
      // Include what came back, so an unexpected shape is diagnosable rather
      // than silent. Truncated — this reaches the browser.
      // Raw text is logged, not returned — a truncated JSON fragment shown as
      // an error message ("Risk-free rate unavailable: {\"rate\":") tells the
      // user nothing they can act on.
      console.warn('[riskfree] could not parse:', String(text).slice(0, 300))
      return res.status(200).json({ ...fallback(cached, 'unparseable'),
        detail: 'the model did not return a usable figure' })
    }

    // The bound check. This is the safeguard that matters — a confidently
    // stated but wrong rate is the failure mode worth defending against, and
    // an out-of-band figure is the only signature of it available here.
    if (parsed.rate < bounds.min || parsed.rate > bounds.max) {
      console.warn(`[riskfree] ${market} rate ${parsed.rate}% outside ${bounds.min}-${bounds.max}% — rejected`)
      return res.status(200).json({ ...fallback(cached, 'out_of_range'),
        detail: `Returned ${parsed.rate}%, outside the ${bounds.min}-${bounds.max}% range for ${bounds.name}` })
    }

    cached = {
      rate: parsed.rate,
      asOf: parsed.asOf || new Date().toISOString().slice(0, 7),
      market,
      fetchedAt: Date.now(),
      name: bounds.name,
    }
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ...cached, source: 'fetched' })
  } catch (e) {
    console.warn('[riskfree] failed:', e?.message)
    return res.status(200).json({ ...fallback(cached, 'exception'), detail: e?.message || 'unknown' })
  }
}

function parseRate(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()
  try {
    const j = JSON.parse(cleaned)
    if (j?.rate == null) return null
    const rate = Number(j.rate)
    if (!isFinite(rate)) return null
    return { rate, asOf: typeof j.asOf === 'string' ? j.asOf : null }
  } catch {
    // A bare number in prose, as a last resort.
    const m = cleaned.match(/(\d+\.?\d*)\s*%/)
    if (m) {
      const rate = parseFloat(m[1])
      return isFinite(rate) ? { rate, asOf: null } : null
    }
    return null
  }
}

/** Last good value, marked stale — never a substituted default. */
function fallback(prev, reason) {
  return prev
    ? { ...prev, source: 'stale', error: reason,
        note: `Could not refresh the rate (${reason}) — using the value from ${prev.asOf}.` }
    : { rate: null, error: reason,
        note: 'The risk-free rate could not be fetched, so fundamentals-based estimates are unavailable.' }
}
