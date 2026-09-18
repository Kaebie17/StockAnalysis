// api/suggestPeers.js — ask Gemini directly for real peer companies, rather
// than only matching against whatever this browser has already classified.
//
// This is the actual discovery step. The earlier version of this feature
// (api/classifyBusiness.js) only ever labelled ONE company at a time and
// matched it against others already labelled — which meant nothing new could
// surface until a human had independently classified every candidate first.
// This endpoint instead asks the model to name real, listed peer companies
// directly, using its own knowledge plus live search — the app then screens
// and validates what comes back (peersClient.js's suggestPeers /
// PeerSelectModal.jsx), it doesn't have to already know the answer.
//
// Input is deliberately just the company's name and its real business
// description (Yahoo's longBusinessSummary — there's no NSE equivalent) —
// NO sector/industry classification label of any kind, NSE's or Yahoo's.
// An earlier version sent NSE's own per-company Industry label alongside
// the description, on the theory that real NSE data must be better than
// Yahoo's. It's still too coarse for this to be safe: NSE labels Dixon
// "Consumer Electronics", the same bucket as branded companies with a
// completely different business model, and the risk that the model anchors
// on a supplied label — despite an explicit instruction not to — isn't
// worth it when the description text alone already carries the real signal
// ("provision of electronic manufacturing services" is IN Dixon's own
// Yahoo summary). Nothing here needs a classification label to work.
//
// Always grounded (google_search on) — unlike classifyBusiness.js's
// summary-length-dependent toggle, naming real tickers accurately benefits
// from live search regardless of how much description text is available;
// getting a real, small-cap Indian ticker symbol right matters more here
// than in a single-company classification.

import { checkOrigin, requireOrigin, rateLimit } from './_lib.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const MAX_PEERS = 20

const SYSTEM_INSTRUCTION =
  'You identify real, listed peer companies for the target company given below. Search for and use your own ' +
  'knowledge of the actual market. Reply with ONLY a JSON object, no prose, no markdown fences:\n' +
  '{"peers": [{"symbol": "<the real, currently-tradeable NSE or BSE ticker, with .NS or .BO suffix>", ' +
  '"name": "<company name>", "relationship": "<short phrase, e.g. \\"EMS/contract manufacturing\\" or \\"branded consumer electronics\\">", ' +
  '"overlap": ["<1-4 short tags describing what actually overlaps, e.g. business line, end market, customer type>"], ' +
  '"rationale": "<one sentence, specific, citing why this is or is not a close match>", ' +
  '"confidence": "high"|"medium"|"low"}]}\n' +
  `Include up to ${MAX_PEERS} candidates: direct competitors, companies with a substantially similar operating model, ` +
  'and other relevant listed Indian companies. For each one, state the real relationship and any important caveats or ' +
  'business-line differences in the rationale; do not include a company merely because it sits in the same broad sector ' +
  'if its actual business model differs materially (say so in the rationale instead, with lower confidence, or leave it ' +
  'out entirely). ONLY include a company you are confident is currently listed on NSE or BSE with a real, tradeable ' +
  'ticker symbol — if it is privately held, an unlisted subsidiary, delisted, listed on a different exchange only, or ' +
  'you are not reasonably sure of its exact ticker, LEAVE IT OUT OF THE LIST ENTIRELY. Do not include an entry with a ' +
  'null, guessed, or placeholder symbol under any circumstance.'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const body = req.body || {}
  const { symbol, name, businessSummary } = body
  if (!symbol || !name) return res.status(200).json({ peers: null, error: 'missing_input', detail: 'symbol and name are required' })

  const key = body.userKey || process.env.GEMINI_API_KEY
  const usingServerKey = !body.userKey && !!process.env.GEMINI_API_KEY
  if (usingServerKey) { if (!requireOrigin(req, res)) return }
  else { if (!checkOrigin(req, res)) return }
  if (!rateLimit(req, res, { max: 10, windowMs: 60_000, keyPrefix: 'suggestPeers' })) return

  if (!key) return res.status(200).json({ peers: null, error: 'no_key', detail: 'No API key configured.' })

  const MODEL = body.model || DEFAULT_MODEL
  // Deliberately no NSE (or Yahoo) sector/industry label in the input — NSE's
  // own label is too coarse for this exact company (Dixon: "Consumer
  // Electronics" vs. its real EMS/ODM/contract-manufacturing model) and
  // risked anchoring the model toward it despite instructions not to. Name +
  // the real business description is what actually carries the signal.
  const userText = JSON.stringify({ symbol, name, businessSummary: businessSummary || null })

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: `Find peer companies for:\n${userText}` }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
          // responseMimeType omitted — incompatible with tools (grounding),
          // same as api/erp.js and api/classifyBusiness.js's grounded path.
        }),
      })

    const data = await r.json().catch(() => null)
    if (!r.ok) {
      const detail = data?.error?.message || `HTTP ${r.status}`
      console.warn('[suggestPeers] gemini error', r.status, detail)
      return res.status(200).json({ peers: null, error: 'fetch_failed', detail })
    }

    const cand = data?.candidates?.[0]
    const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? ''
    const parsed = parsePeers(text)

    if (parsed == null && cand?.finishReason && cand.finishReason !== 'STOP') {
      console.warn('[suggestPeers] incomplete completion:', cand.finishReason)
      return res.status(200).json({ peers: null, error: 'fetch_failed',
        detail: cand.finishReason === 'MAX_TOKENS' ? 'the model ran out of output tokens before answering' : `the model stopped early (${cand.finishReason})` })
    }
    if (parsed == null) {
      console.warn('[suggestPeers] could not parse:', String(text).slice(0, 500))
      return res.status(200).json({ peers: null, error: 'unparseable', detail: 'the model did not return a usable peer list', raw: String(text).slice(0, 800) })
    }

    return res.status(200).json({ peers: parsed })
  } catch (e) {
    console.warn('[suggestPeers] failed:', e?.message)
    return res.status(200).json({ peers: null, error: 'fetch_failed', detail: e?.message || 'unknown' })
  }
}

const TICKER_RE = /\.(NS|BO)$/i
const RELEVANCE_VALUES = ['high', 'medium', 'low']

function parsePeers(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()
  let j
  try {
    j = JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { j = JSON.parse(m[0]) } catch { return null }
  }
  if (!Array.isArray(j?.peers)) return null

  // Validate/normalize each entry rather than discarding the whole response
  // over one bad row — a partial list of real candidates is useful, a hard
  // all-or-nothing failure over one malformed symbol is not. A candidate
  // with no real, exchange-suffixed symbol is DROPPED here, not kept as an
  // "unresolved" row — an unlisted/private/unconfident-ticker company isn't
  // a usable peer candidate in this app no matter how good its rationale
  // reads, so it doesn't belong in the output at all.
  const out = []
  for (const p of j.peers.slice(0, MAX_PEERS)) {
    if (!p || typeof p !== 'object') continue
    if (typeof p.symbol !== 'string' || !TICKER_RE.test(p.symbol.trim())) continue
    const symbol = p.symbol.trim().toUpperCase()
    const name = typeof p.name === 'string' ? p.name.trim() : null
    if (!name) continue   // need at least a name to be useful at all
    out.push({
      symbol,
      name,
      relationship: typeof p.relationship === 'string' ? p.relationship.slice(0, 200) : '',
      overlap: Array.isArray(p.overlap) ? p.overlap.filter(o => typeof o === 'string').slice(0, 4) : [],
      rationale: typeof p.rationale === 'string' ? p.rationale.slice(0, 500) : '',
      confidence: RELEVANCE_VALUES.includes(p.confidence) ? p.confidence : 'low',
    })
  }
  return out
}
