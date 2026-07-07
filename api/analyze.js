// api/analyze.js — serverless endpoint that sends the valuation + market-expectation
// summary to Gemini and returns a brief verdict. Requires GEMINI_API_KEY in the
// Vercel project env. Returns { text: null } on any failure so the client falls back
// to the built-in boilerplate.

const MODEL = 'gemini-2.5-flash'   // current stable; swap to any available Gemini model

const SYSTEM = `As a professional equity analyst, based strictly on the figures and scores provided in this prompt, write a brief verdict in plain language on valuation and market expectation.

Market expectation figures are the annual growth rates that the current share price implies under different valuation methods (reverse-DCF from free cash flow, and sales / earnings / FCF-based multiples) — i.e. the growth the market must be assuming to justify today's price. Where a method's implied growth is given, compare it with the company's recent actual growth to judge whether the market is pricing in faster growth, slower growth, a decline, or growth in line with the recent record. Some methods may be absent (null) — ignore those.

Also state what the fair-value range and the models it is based on imply about the price. If the methods disagree, note it.

Return only the verdict text (3–5 sentences). No buy/sell/hold advice, no questions, no caveats about needing more data.`

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ text: null }); return }
  // BYOK: prefer the user's own key (sent per request); fall back to a server key
  // only if one is configured. Never logged.
  const key = req.body?.userKey || process.env.GEMINI_API_KEY
  const summary = req.body?.summary
  if (!key || !summary) { res.status(200).json({ text: null }); return }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(summary) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
    })
    const data = await r.json()
    if (!r.ok) { res.status(200).json({ text: null, error: `gemini ${r.status}`, raw: data }); return }
    // Extract text defensively across possible shapes.
    const cand = data?.candidates?.[0]
    const parts = cand?.content?.parts
    let text = Array.isArray(parts)
      ? parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
      : null
    if (!text) text = null
    // If empty, surface WHY (finishReason / promptFeedback / raw) so we can diagnose.
    if (!text) {
      res.status(200).json({
        text: null,
        finishReason: cand?.finishReason ?? null,
        blockReason: data?.promptFeedback?.blockReason ?? null,
        raw: data,
      })
      return
    }
    res.status(200).json({ text })
  } catch (e) {
    res.status(200).json({ text: null, error: String(e?.message || e) })
  }
}
