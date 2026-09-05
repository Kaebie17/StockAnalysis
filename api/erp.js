// api/erp.js — the current total equity risk premium, used alongside the
// risk-free rate in every CAPM-based required-return calculation.
//
// Fetched rather than hardcoded for the same reason the risk-free rate is:
// it moves (more slowly, but not never — Damodaran's own published ERP
// series has ranged roughly 4-6% for mature markets and higher for
// emerging ones like India as macro/market conditions shift), and every
// required-return figure downstream is sensitive to it.
//
// Unlike the risk-free rate, ERP is not a single directly-observable market
// quantity — different methodologies (historical, implied, survey-based)
// can legitimately disagree by a point or more at the same moment, so
// asking a model to "estimate the ERP" has no natural sanity band the way
// asking for a bond yield does. What IS a well-defined retrieval task is
// asking for a SPECIFIC, NAMED, periodically-published figure: Aswath
// Damodaran's own total equity risk premium estimate by market (mature
// market ERP plus country risk premium where applicable), the exact source
// this app's own ERP_BY_MARKET constant already cites in its comments. This
// mirrors api/riskfree.js's approach exactly — factual retrieval of a named
// published figure, not model-generated estimation.
//
// Same two safeguards as the risk-free endpoint:
//   1. The answer is bounded to the realistic range Damodaran's own
//      published series has actually moved in for that market. A value
//      outside it is a model error, not a market event.
//   2. Failure returns the LAST GOOD value with its date, never a default.

import { checkOrigin, requireOrigin, rateLimit } from './_lib.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'

// Plausible bands by market, from the realistic historical range Damodaran's
// own published total-ERP-by-country figures have moved in — generously
// wide so this only catches a genuine model error, not real market movement.
const BOUNDS = {
  IN: { min: 5, max: 11, name: "Damodaran's total equity risk premium for India (mature market ERP + country risk premium)" },
  US: { min: 3, max: 8,  name: "Damodaran's implied equity risk premium for the US (mature market)" },
}

let cached = null      // { erp, asOf, market, fetchedAt }
const TTL_MS = 30 * 24 * 60 * 60 * 1000   // a month; ERP moves even more slowly than the risk-free rate

export default async function handler(req, res) {
  const q = req.method === 'POST' ? (req.body || {}) : (req.query || {})
  const market = String(q.market || 'IN').toUpperCase()
  const bounds = BOUNDS[market] || BOUNDS.IN
  const force = q.force === '1' || q.force === true

  if (!force && cached?.market === market && Date.now() - cached.fetchedAt < TTL_MS) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ...cached, source: 'cache' })
  }

  const key = q.userKey || process.env.GEMINI_API_KEY

  const usingServerKey = !q.userKey && !!process.env.GEMINI_API_KEY
  if (usingServerKey) { if (!requireOrigin(req, res)) return }
  else { if (!checkOrigin(req, res)) return }
  if (!rateLimit(req, res, { max: 10, windowMs: 60_000, keyPrefix: 'erp' })) return

  if (!key) {
    return res.status(200).json(cached
      ? { ...cached, source: 'stale', note: 'No API key — showing the last value fetched.' }
      : { erp: null, error: 'no_key',
          note: 'No API key configured, so the equity risk premium cannot be fetched.' })
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
            `You report a single published financial figure. Reply with ONLY a JSON object, no ` +
            `prose and no markdown fences: {"erp": <number>, "asOf": "<YYYY-MM>"} where erp is the ` +
            `premium as a percentage (for example 7.2 for 7.2%). If you are not reasonably ` +
            `confident of Damodaran's current published figure, reply {"erp": null}.` }] },
          contents: [{ role: 'user', parts: [{ text: market === 'IN'
            ? `What is Aswath Damodaran's most recently published TOTAL equity risk premium for India ` +
              `— his mature market (US) implied ERP plus his India country risk premium, added together?`
            : `What is Aswath Damodaran's most recently published implied equity risk premium for the ` +
              `US (mature market)?` }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 512,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: 'application/json',
          },
        }),
      })

    const data = await r.json().catch(() => null)
    if (!r.ok) {
      const detail = data?.error?.message || `HTTP ${r.status}`
      console.warn('[erp] gemini error', r.status, detail)
      return res.status(200).json({ ...fallback(cached, 'fetch_failed'), detail })
    }

    const cand = data?.candidates?.[0]
    const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? ''
    const parsed = parseErp(text)

    if (parsed == null && cand?.finishReason && cand.finishReason !== 'STOP') {
      console.warn('[erp] incomplete completion:', cand.finishReason)
      return res.status(200).json({ ...fallback(cached, 'incomplete'),
        detail: cand.finishReason === 'MAX_TOKENS'
          ? 'the model ran out of output tokens before answering'
          : `the model stopped early (${cand.finishReason})` })
    }

    if (parsed == null) {
      console.warn('[erp] could not parse:', String(text).slice(0, 300))
      return res.status(200).json({ ...fallback(cached, 'unparseable'),
        detail: 'the model did not return a usable figure' })
    }

    if (parsed.erp < bounds.min || parsed.erp > bounds.max) {
      console.warn(`[erp] ${market} erp ${parsed.erp}% outside ${bounds.min}-${bounds.max}% — rejected`)
      return res.status(200).json({ ...fallback(cached, 'out_of_range'),
        detail: `Returned ${parsed.erp}%, outside the ${bounds.min}-${bounds.max}% range for ${bounds.name}` })
    }

    cached = {
      erp: parsed.erp,
      asOf: parsed.asOf || new Date().toISOString().slice(0, 7),
      market,
      fetchedAt: Date.now(),
      name: bounds.name,
    }
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ ...cached, source: 'fetched' })
  } catch (e) {
    console.warn('[erp] failed:', e?.message)
    return res.status(200).json({ ...fallback(cached, 'exception'), detail: e?.message || 'unknown' })
  }
}

function parseErp(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()
  try {
    const j = JSON.parse(cleaned)
    if (j?.erp == null) return null
    const erp = Number(j.erp)
    if (!isFinite(erp)) return null
    return { erp, asOf: typeof j.asOf === 'string' ? j.asOf : null }
  } catch {
    const m = cleaned.match(/(\d+\.?\d*)\s*%/)
    if (m) {
      const erp = parseFloat(m[1])
      return isFinite(erp) ? { erp, asOf: null } : null
    }
    return null
  }
}

function fallback(prev, reason) {
  return prev
    ? { ...prev, source: 'stale', error: reason,
        note: `Could not refresh the equity risk premium (${reason}) — using the value from ${prev.asOf}.` }
    : { erp: null, error: reason,
        note: 'The equity risk premium could not be fetched, so the default assumption is used instead.' }
}
