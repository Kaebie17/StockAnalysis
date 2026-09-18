// api/classifyBusiness.js — classify one company's business model from its
// own description, for peer-discovery purposes (see src/engine/
// peerCompatibility.js and src/api/peersClient.js's fetchBusinessModelMatches).
//
// Per-COMPANY, not per-market like api/erp.js — there's no useful server-side
// cache here (thousands of possible tickers, one-shot serverless instances);
// the real cache is the client's central `classifications` IndexedDB store
// (src/utils/db.js), keyed by symbol and reused across every ticker's peer
// review. This handler is stateless.
//
// Same BYOK posture as api/analyze.js/api/erp.js: the caller's own Gemini key
// is used when supplied; the server's own key is a fallback, gated by the
// stricter requireOrigin() since that path has a real cost.
//
// Enum arrays below are duplicated from src/engine/businessProfileEnums.js
// rather than imported — Vercel's function bundler resolving a cross-
// directory import from api/ into src/engine/ was flagged as an unverified
// risk, and this is a small, static list, so duplication is the safer
// choice over an unverified production import. KEEP IN SYNC WITH
// src/engine/businessProfileEnums.js IF EITHER CHANGES.

import { checkOrigin, requireOrigin, rateLimit } from './_lib.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const MIN_SUMMARY_WORDS = 40   // below this, fall back to grounded search instead of classifying thin/absent text

const BUSINESS_MODELS = ['CONTRACT_MANUFACTURER', 'ODM', 'BRANDED_MANUFACTURER', 'COMPONENT_SUPPLIER',
  'SYSTEM_INTEGRATOR', 'DESIGN_ENGINEERING_SERVICES', 'DISTRIBUTOR_TRADER', 'PROJECT_EPC',
  'COMMODITY_PRODUCER', 'REGULATED_UTILITY_INFRA', 'FINANCIAL_INTERMEDIARY', 'OTHER']
const END_MARKETS = ['CONSUMER_ELECTRONICS', 'MOBILE_TELECOM', 'IT_HARDWARE', 'APPLIANCES',
  'AUTOMOTIVE', 'INDUSTRIAL', 'DEFENCE_AEROSPACE', 'HEALTHCARE_PHARMA', 'ENERGY_POWER', 'BFSI',
  'FMCG_RETAIL', 'INFRASTRUCTURE_CONSTRUCTION', 'AGRICULTURE', 'IT_SOFTWARE_SERVICES', 'OTHER']
const REVENUE_MODELS = ['B2B_CONTRACT_MANUFACTURING', 'B2B_COMPONENT_SUPPLY', 'B2C_BRANDED_RETAIL',
  'B2B_ENTERPRISE_SALES', 'B2G_GOVERNMENT_CONTRACTS', 'PROJECT_EPC', 'SUBSCRIPTION_RECURRING',
  'COMMODITY_SALES', 'OTHER']
const PRODUCTION_PROFILES = ['ASSEMBLY_LED', 'INTEGRATED_MANUFACTURING', 'PROCESS_MANUFACTURING',
  'DESIGN_ONLY', 'SERVICES', 'OTHER']
const CAPITAL_INTENSITY = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']
const STATUS_VALUES = ['classified', 'uncertain', 'unclassifiable']
const CONFIDENCE_VALUES = ['high', 'medium', 'low']
const EVIDENCE_QUALITY_VALUES = ['strong', 'moderate', 'weak']
const EVIDENCE_SOURCES = ['business_summary', 'nse_classification', 'annual_report', 'company_website']

const SYSTEM_INSTRUCTION =
  'You classify a company\'s business model from the description given. Reply with ONLY a JSON object, ' +
  'no prose, no markdown fences, using EXACTLY these enum values and no others:\n' +
  `{"businessModel": <one of ${JSON.stringify(BUSINESS_MODELS)}>, ` +
  `"secondaryBusinessModels": <array, 0-2 of the same list, only when the business genuinely spans two categories (e.g. contract manufacturing AND own-design/ODM work) — do not force a single bucket when the evidence supports two>, ` +
  `"endMarkets": <array, 1-4 of ${JSON.stringify(END_MARKETS)}>, ` +
  `"revenueModel": <one of ${JSON.stringify(REVENUE_MODELS)}>, ` +
  `"productionProfile": <one of ${JSON.stringify(PRODUCTION_PROFILES)}>, ` +
  `"capitalIntensity": <one of ${JSON.stringify(CAPITAL_INTENSITY)}>, ` +
  '"rationale": <one sentence citing what in the INPUT specifically supports this classification — e.g. "reports EMS/Mobile segment revenue" — never a generic restatement of the enum like "it is a contract manufacturer because it manufactures electronics">, ' +
  `"evidence": <array, which of ${JSON.stringify(EVIDENCE_SOURCES)} actually informed this answer>, ` +
  `"status": <one of ${JSON.stringify(STATUS_VALUES)}>, ` +
  `"confidence": <one of ${JSON.stringify(CONFIDENCE_VALUES)} — YOUR certainty in this answer>, ` +
  `"evidenceQuality": <one of ${JSON.stringify(EVIDENCE_QUALITY_VALUES)} — how strong the INPUT material itself was, judged independently of your own confidence: a short, generic description is weak evidence even if you feel confident about the answer it points to>}\n` +
  'If the evidence is thin or ambiguous, do not invent false precision: use "businessModel": "OTHER", ' +
  '"status": "uncertain", and say in the rationale what is missing (e.g. "insufficient evidence to distinguish contract manufacturing from ODM").'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const body = req.body || {}
  const { symbol, name, sector, industry, businessSummary } = body

  if (!symbol || !name) return res.status(200).json({ businessModel: null, error: 'missing_input', detail: 'symbol and name are required' })

  const key = body.userKey || process.env.GEMINI_API_KEY
  const usingServerKey = !body.userKey && !!process.env.GEMINI_API_KEY
  if (usingServerKey) { if (!requireOrigin(req, res)) return }
  else { if (!checkOrigin(req, res)) return }
  if (!rateLimit(req, res, { max: 20, windowMs: 60_000, keyPrefix: 'classifyBusiness' })) return

  if (!key) {
    return res.status(200).json({ businessModel: null, error: 'no_key', detail: 'No API key configured.' })
  }

  const MODEL = body.model || DEFAULT_MODEL
  const summaryWords = String(businessSummary || '').trim().split(/\s+/).filter(Boolean).length
  const useGrounding = summaryWords < MIN_SUMMARY_WORDS

  const userText = JSON.stringify({ name, sector: sector || null, industry: industry || null, businessSummary: businessSummary || null })

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: useGrounding
      ? `The business description below is thin or missing. Search for what ${name} (NSE: ${symbol}) actually does, then classify it.\n${userText}`
      : userText }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
      // responseMimeType is dropped in the grounded path — Gemini does not
      // support structured-output mode together with tools (grounding), see
      // api/erp.js's identical note; the grounded response is parsed as
      // JSON-in-prose by parseClassification() below instead.
      ...(useGrounding ? {} : { responseMimeType: 'application/json' }),
    },
    ...(useGrounding ? { tools: [{ google_search: {} }] } : {}),
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) })

    const data = await r.json().catch(() => null)
    if (!r.ok) {
      const detail = data?.error?.message || `HTTP ${r.status}`
      console.warn('[classifyBusiness] gemini error', r.status, detail)
      return res.status(200).json({ businessModel: null, error: 'fetch_failed', detail })
    }

    const cand = data?.candidates?.[0]
    const text = cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? ''
    const parsed = parseClassification(text)

    if (parsed == null && cand?.finishReason && cand.finishReason !== 'STOP') {
      console.warn('[classifyBusiness] incomplete completion:', cand.finishReason)
      return res.status(200).json({ businessModel: null, error: 'fetch_failed',
        detail: cand.finishReason === 'MAX_TOKENS' ? 'the model ran out of output tokens before answering' : `the model stopped early (${cand.finishReason})` })
    }
    if (parsed == null) {
      console.warn('[classifyBusiness] could not parse:', String(text).slice(0, 300))
      return res.status(200).json({ businessModel: null, error: 'unparseable', detail: 'the model did not return a usable classification' })
    }
    if (parsed.businessModel === 'unclassifiable') {
      return res.status(200).json({ businessModel: null, error: 'unclassifiable', detail: 'the model could not classify this company' })
    }

    return res.status(200).json(parsed)
  } catch (e) {
    console.warn('[classifyBusiness] failed:', e?.message)
    return res.status(200).json({ businessModel: null, error: 'fetch_failed', detail: e?.message || 'unknown' })
  }
}

function parseClassification(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim()
  let j
  try {
    j = JSON.parse(cleaned)
  } catch {
    // Grounded responses can wrap JSON in prose — pull out the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { j = JSON.parse(m[0]) } catch { return null }
  }
  if (j?.businessModel == null) return null   // model explicitly declined
  if (!validate(j)) return null
  return {
    businessModel: j.businessModel,
    secondaryBusinessModels: Array.isArray(j.secondaryBusinessModels) ? j.secondaryBusinessModels : [],
    endMarkets: j.endMarkets,
    revenueModel: j.revenueModel,
    productionProfile: j.productionProfile,
    capitalIntensity: j.capitalIntensity,
    rationale: typeof j.rationale === 'string' ? j.rationale.slice(0, 500) : '',
    evidence: Array.isArray(j.evidence) ? j.evidence.filter(e => EVIDENCE_SOURCES.includes(e)) : [],
    status: j.status,
    confidence: j.confidence,
    evidenceQuality: j.evidenceQuality,
  }
}

function validate(j) {
  if (!BUSINESS_MODELS.includes(j.businessModel)) return false
  if (j.secondaryBusinessModels != null && (!Array.isArray(j.secondaryBusinessModels) || j.secondaryBusinessModels.some(m => !BUSINESS_MODELS.includes(m)))) return false
  if (!Array.isArray(j.endMarkets) || j.endMarkets.length === 0 || j.endMarkets.some(m => !END_MARKETS.includes(m))) return false
  if (!REVENUE_MODELS.includes(j.revenueModel)) return false
  if (!PRODUCTION_PROFILES.includes(j.productionProfile)) return false
  if (!CAPITAL_INTENSITY.includes(j.capitalIntensity)) return false
  if (!STATUS_VALUES.includes(j.status)) return false
  if (!CONFIDENCE_VALUES.includes(j.confidence)) return false
  if (!EVIDENCE_QUALITY_VALUES.includes(j.evidenceQuality)) return false
  return true
}
