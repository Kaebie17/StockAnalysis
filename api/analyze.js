// api/analyze.js — serverless endpoint that sends the valuation + market-expectation
// summary to Gemini and returns a brief verdict. Requires GEMINI_API_KEY in the
// Vercel project env. Returns { text: null } on any failure so the client falls back
// to the built-in boilerplate.

const MODEL = 'gemini-2.0-flash'   // swap to any current Gemini model string

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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(summary) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
      }),
    })
    if (!r.ok) { res.status(200).json({ text: null, error: `gemini ${r.status}` }); return }
    const data = await r.json()
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || null
    res.status(200).json({ text })
  } catch (e) {
    res.status(200).json({ text: null, error: String(e?.message || e) })
  }
}
