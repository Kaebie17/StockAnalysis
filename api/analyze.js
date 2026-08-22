// api/analyze.js — serverless endpoint that sends the dashboard highlight summary
// to Gemini and returns a brief, balanced verdict. Requires GEMINI_API_KEY in the
// Vercel env as a fallback. Returns { text: null } on any failure so the client
// falls back to the built-in boilerplate.

import { checkOrigin, requireOrigin, rateLimit } from './_lib.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'   // current stable; fallback if not provided by client

const SYSTEM = `As a professional equity analyst, write a brief, balanced verdict in plain language based strictly on the figures provided. The user can see every figure you are given, so reason ACROSS them rather than restating any one.

WHAT YOU ARE GIVEN

Four price ranges, each answering a different question. Reconciling them is the main task:
- valuation.fairValueRange — what the numbers say the business is worth today, from the models most relevant to this sector.
- estimate1 — what the fundamentals justify paying: derived from growth, returns and payout, with no reference to price history.
- estimate2 — what the market has actually been paying: this stock's own historical multiple applied to projected earnings. If estimate2.reliable is false, treat it as unreliable and say so briefly.
- analystConsensus — published targets, for comparison only.

Any of these may be absent or carry an "unavailable" note; work with what is there and do not speculate about what is missing.

Also given:
- marketExpectation — the growth the CURRENT PRICE implies under several methods. Compare with recentActualGrowth to judge whether the market is assuming faster, slower or in-line growth. Ignore null methods.
- moatQuality — moat tier, quality tier, and supporting evidence. Valuation models are mathematical snapshots; moat and quality indicate whether the business can sustain the returns those models assume. A conservative model can read as "expensive" when much of a company's value lies in scale, regulatory position or optionality that cash-flow models miss. Weigh this; do not defer to the valuation signal alone. If governanceIncluded is false, pledge and related-party data were not factored, so do not over-claim on governance.

HOW TO REASON

Start with where the four ranges agree and where they diverge, and say what the divergence means. The common patterns:
- estimate2 well above estimate1 — the market is paying more than the fundamentals justify, which is sustainable only while growth or returns exceed what the formula credits.
- estimate2 well below estimate1 — the market has been paying less than the fundamentals support, a persistent discount rather than an error.
- fair value far from both — the sector's models and the multiple approach disagree about what drives value here.
- all four clustered — an unusually well-agreed valuation, worth saying plainly.

Then test that reading against market expectation and against moat and quality. A cheap reading must be checked against whether the business can sustain its returns; an expensive one against whether the moat justifies the premium.

Be even-handed: present the bull and bear sides of any genuine disagreement without a default lean.

Return only the verdict text, 4-6 sentences. No buy/sell/hold advice, no recommendations, no questions, and no caveats about needing more data.`

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ text: null }); return }
  // BYOK: prefer the user's own key (sent per request); fall back to a server key
  // only if one is configured. Never logged.
  const key = req.body?.userKey || process.env.GEMINI_API_KEY
  const summary = req.body?.summary
  const MODEL = req.body?.model || DEFAULT_MODEL

  // When falling back to the server's own GEMINI_API_KEY, require a matching
  // Origin — that path has a real per-call cost to us, and without this any
  // unauthenticated caller on the internet could drain it, key of their own
  // or not. A user-supplied key only spends the user's own quota, so the
  // softer check (never blocks a missing Origin) is enough there.
  const usingServerKey = !req.body?.userKey && !!process.env.GEMINI_API_KEY
  if (usingServerKey) { if (!requireOrigin(req, res)) return }
  else { if (!checkOrigin(req, res)) return }
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, keyPrefix: 'analyze' })) return

  if (!key || !summary) { res.status(200).json({ text: null }); return }

  // Prompt echo, for local debugging only. SYSTEM is the analyst prompt — the
  // actual product here — so it must not be returned to a browser in
  // production, where anyone can read it from the network tab.
  const debug = process.env.NODE_ENV === 'development'
    ? { model: MODEL, system: SYSTEM, userContent: JSON.stringify(summary, null, 2) }
    : undefined

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(summary) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
    })
    const data = await r.json()
    if (!r.ok) {
      // Log the full body server-side; return only the status. A Gemini error
      // body can echo the prompt back, so it shouldn't reach the client either.
      console.warn('[analyze] gemini error', r.status, JSON.stringify(data).slice(0, 800))
      res.status(200).json({ text: null, error: `gemini ${r.status}` })
      return
    }
    const cand = data?.candidates?.[0]
    const parts = cand?.content?.parts
    let text = Array.isArray(parts)
      ? parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
      : null
    if (!text) text = null
    if (!text) {
      console.warn('[analyze] empty completion', JSON.stringify(data).slice(0, 800))
      res.status(200).json({
        text: null,
        finishReason: cand?.finishReason ?? null,
        blockReason: data?.promptFeedback?.blockReason ?? null,
      })
      return
    }
    res.status(200).json({ text, debug })
  } catch (e) {
    res.status(200).json({ text: null, error: String(e?.message || e) })
  }
}
