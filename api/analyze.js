// api/analyze.js — serverless endpoint that sends the dashboard highlight summary
// to Gemini and returns a brief, balanced verdict. Requires GEMINI_API_KEY in the
// Vercel env as a fallback. Returns { text: null } on any failure so the client
// falls back to the built-in boilerplate.

const MODEL = 'gemini-2.5-flash'   // current stable; swap to any available Gemini model

const SYSTEM = `As a professional equity analyst, based strictly on the figures, scores, and qualitative points provided in this prompt, write a brief, balanced verdict in plain language that weighs ALL of the signals against one another. The user can see every figure you are given, so reason across them — do not lean on any single one.

The signals provided:
- valuation: a fair-value RANGE from the two most relevant models, a signal (under/over/fairly valued), P/E, EV/EBITDA, and current price (CMP). State what the range and its models imply about the price; if models disagree, note it.
- fundamentals: a quality score/label with ROE, net margin, and free-cash-flow sign.
- technicals: a score/label with RSI, moving-average crosses, and volume.
- marketExpectation: the annual growth rates the CURRENT PRICE implies under different methods (reverse-DCF from free cash flow, and sales / earnings / FCF multiples) — i.e. the growth the market must assume to justify today's price. Compare each with recentActualGrowth to judge whether the market is pricing in faster, slower, declining, or in-line growth. Ignore methods that are null.
- moatQuality: the qualitative judgement layer — a moat tier (None/Narrow/Wide/Very Wide), a quality tier (Low/Medium/High), an implicationForValuation, supporting evidence, key metrics, and any captured document context (outlook, schemes, pledge, related-party, initiatives). Valuation models are mathematical snapshots; moat and quality indicate whether the business can actually sustain the returns those models assume. A conservative model can read as "expensive" when much of a company's value lies in scale, regulatory position, or optionality that cash-flow models do not capture — weigh this, do not defer to the valuation signal alone. If governanceIncluded is false, pledge/related-party were not factored, so do not over-claim on governance.

Your task: explicitly identify where these signals AGREE and where they DISAGREE, and reconcile them into one coherent view. A cheap or expensive model reading must be tested against fundamentals, market expectation, and moat/quality rather than restated. Be even-handed — present the bull and bear sides of any genuine disagreement fairly, without a default lean.

Return only the verdict text (4–6 sentences). No buy/sell/hold advice, no questions, no caveats about needing more data.`

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ text: null }); return }
  // BYOK: prefer the user's own key (sent per request); fall back to a server key
  // only if one is configured. Never logged.
  const key = req.body?.userKey || process.env.GEMINI_API_KEY
  const summary = req.body?.summary
  if (!key || !summary) { res.status(200).json({ text: null }); return }

  // DEBUG (temporary): echo the exact prompt pieces so the client can log them.
  const debug = { model: MODEL, system: SYSTEM, userContent: JSON.stringify(summary, null, 2) }

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
    if (!r.ok) { res.status(200).json({ text: null, error: `gemini ${r.status}`, raw: data }); return }
    const cand = data?.candidates?.[0]
    const parts = cand?.content?.parts
    let text = Array.isArray(parts)
      ? parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
      : null
    if (!text) text = null
    if (!text) {
      res.status(200).json({
        text: null,
        finishReason: cand?.finishReason ?? null,
        blockReason: data?.promptFeedback?.blockReason ?? null,
        raw: data,
      })
      return
    }
    res.status(200).json({ text, debug })
  } catch (e) {
    res.status(200).json({ text: null, error: String(e?.message || e) })
  }
}
