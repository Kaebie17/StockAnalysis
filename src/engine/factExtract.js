/**
 * src/engine/factExtract.js — read an announcement, pull out the numbers.
 *
 * The point is that the user shouldn't have to translate. A form with fixed
 * fields ("that segment as % of revenue") asks someone to work out the answer
 * before they can enter it — and what a given announcement actually tells you
 * varies enormously. One press release states a contract value and a delivery
 * period; another says a licence is suspended and nothing more.
 *
 * So the input is open: paste the headline, the snippet, the concall line,
 * whatever exists. This module extracts what's there, decides which lever it
 * touches, and reports what's still MISSING rather than guessing it. If enough
 * is present, the impact computes. If not, the flag stays and the app says
 * precisely which fact would resolve it.
 *
 * Nothing here infers a magnitude that wasn't stated. An extractor that filled
 * gaps with plausible defaults would be worse than no extractor: the estimate
 * would move on numbers nobody wrote down.
 */

const CR = 1e7          // Indian crore
const LAKH_CR = 1e12
const MN = 1e6
const BN = 1e9

/** Money in absolute units. Handles crore / lakh crore / million / billion. */
export function extractMoney(text) {
  const out = []
  const re = /(?:₹|rs\.?|inr|\$|usd)?\s*([\d,]+(?:\.\d+)?)\s*(lakh\s*crore|lakh\s*cr|crore|cr\b|million|mn\b|billion|bn\b)/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''))
    if (!isFinite(n)) continue
    const u = m[2].toLowerCase().replace(/\s+/g, ' ')
    const mult = /lakh/.test(u) ? LAKH_CR
      : /^(crore|cr)/.test(u) ? CR
      : /^(million|mn)/.test(u) ? MN
      : /^(billion|bn)/.test(u) ? BN : null
    if (mult) out.push({ value: n * mult, raw: m[0].trim(), index: m.index })
  }
  return out
}

/** Percentages, with the words around them so "of revenue" can be told from "capacity". */
export function extractPercents(text) {
  const out = []
  const re = /([\d.]+)\s*(?:%|per\s*cent|percent)/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1])
    if (!isFinite(n)) continue
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase()
    const before = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase()
    out.push({ value: n, raw: m[0], index: m.index, before, after })
  }
  return out
}

export function extractBps(text) {
  const m = /(-?[\d.]+)\s*(?:bps|basis\s*points?)/i.exec(text)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!isFinite(n)) return null
  // Direction lives in the wording, not the sign: nobody writes "-20 bps".
  //
  // Words BEFORE the figure win over words after it, because the phrase leading
  // into a number qualifies the number, while what follows usually explains the
  // cause. "NIM compression of 20 bps due to higher cost of funds" contains both
  // "compression" and "higher"; only the first is describing the NIM.
  const DOWN = /(compress|contract|declin|shrink|reduc|lower|cut|fall|fell|squeez|erod|pressur|drop|narrow|down)/
  const UP   = /(expan|improv|widen|increas|ris(?:e|ing)|rose|gain|accret|higher|up\b)/
  const before = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase()
  const after  = text.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase()

  if (DOWN.test(before)) return n > 0 ? -n : n
  if (UP.test(before))   return Math.abs(n)
  if (DOWN.test(after) && !UP.test(after)) return n > 0 ? -n : n
  if (UP.test(after) && !DOWN.test(after)) return Math.abs(n)
  return n
}

/** "over 3 years", "in FY27", "by FY28", "next 5 years". */
export function extractDuration(text) {
  const yrs = /(?:over|across|in|within|during|next|spread\s+over)\s+(?:the\s+)?(\d+)\s*(?:-|\s)?\s*(?:year|yr|fiscal)/i.exec(text)
  if (yrs) return { years: parseInt(yrs[1], 10) }
  const fy = /\bFY\s?(\d{2,4})\b/i.exec(text)
  if (fy) {
    const y = fy[1].length === 2 ? 2000 + parseInt(fy[1], 10) : parseInt(fy[1], 10)
    const nowFy = new Date().getFullYear() + (new Date().getMonth() >= 3 ? 1 : 0)
    return { fiscalYear: `FY${String(y).slice(-2)}`, years: Math.max(1, y - nowFy + 1) }
  }
  return {}
}

/**
 * Which kind of event this is. Ordered by specificity — a capex announcement
 * often also contains the word "expansion", so the more specific patterns win.
 */
const CLASSIFIERS = [
  { id: 'nim_change',      lendersOnly: true,
    re: /\b(nim|net interest margin|repo|rate hike|rate cut|cost of funds|lending rate)\b/i },
  { id: 'margin_guidance',
    re: /\b(margin)\b[^.]{0,60}\b(guid|target|expect|maintain|improve to|of\s*\d)/i },
  { id: 'growth_guidance',
    re: /\b(guid\w*|targets?|expects?|aims?|projects?|sees)\b[^.]{0,80}?\b(revenue|growth|topline|aum|loan book|sales)\b|\b(revenue|growth|topline|aum)\b[^.]{0,40}?\bguid\w*/i },
  { id: 'segment_loss',
    re: /\b(bans?|banned|bars?|barred|prohibit|restrict|suspend|revoke|licence cancel|license cancel|halt|discontinu|embargo|exit(?:ed|ing)?|stop(?:ped)? (?:from|onboarding))\b/i },
  { id: 'capex',
    re: /\b(capex|capital expenditure|invest(?:ment|ing)? of|to invest|outlay)\b/i },
  { id: 'subsidy',
    re: /\b(subsid|incentive|pli\b|production linked|tax (?:break|holiday|benefit)|grant)\b/i },
  { id: 'input_cost',
    re: /\b(raw material|input cost|commodity price|coal|crude|steel price|feedstock)\b/i },
  { id: 'capacity',
    re: /\b(capacity|new plant|commission(?:ed|ing)?|expansion|debottleneck|new (?:branches|stores|units))\b/i },
  { id: 'contract',
    re: /\b(order|contract|deal|bagged|wins?|won|secured|awarded|letter of intent|loi\b|mandate|tie-?up|partnership)\b/i },
]

export function classify(text, sectorType) {
  const lender = sectorType === 'bank' || sectorType === 'nbfc'
  for (const c of CLASSIFIERS) {
    if (c.lendersOnly && !lender) continue
    if (c.re.test(text)) return c.id
  }
  return null
}

/** Required inputs per type, and the question to ask when one is absent. */
const REQUIRED = {
  contract:        [['value', 'the contract value'], ['years', 'the delivery period']],
  capacity:        [['addedPct', 'how much capacity is being added, as a %'],
                    ['utilisation', 'how much of it you expect to be used (a new plant rarely runs full)']],
  segment_loss:    [['segmentPct', "that segment's share of revenue"]],
  capex:           [['amount', 'the capex amount']],
  subsidy:         [['amount', 'the annual benefit']],
  input_cost:      [['changePct', 'the cost change %'], ['shareOfCost', 'that input as a % of total costs']],
  nim_change:      [['bps', 'the expected NIM impact in bps']],
  margin_guidance: [['targetPct', 'the guided margin %']],
  growth_guidance: [['growthPct', 'the guided growth %, or a revenue target']],
}

/**
 * Pull whatever the text supports into the fields a fact type needs.
 *
 * @returns { typeId, fields, missing: [{key, ask}], found: [...], enough }
 */
export function extractFacts(text, ctx = {}) {
  const t = String(text || '').trim()
  if (!t) return { typeId: null, fields: {}, missing: [], found: [], enough: false }

  const typeId = classify(t, ctx.sectorType)
  if (!typeId) {
    return { typeId: null, fields: {}, missing: [], found: [], enough: false,
             note: "Couldn't tell what kind of event this is. Pick one below and fill in what you know." }
  }

  const money = extractMoney(t)
  const pcts = extractPercents(t)
  const dur = extractDuration(t)
  const bps = extractBps(t)
  const lower = t.toLowerCase()

  const fields = {}
  const found = []

  const takeMoney = (key, label) => {
    if (money.length === 0) return
    // The largest figure is almost always the headline one; secondary numbers in
    // these releases tend to be sub-components.
    const pick = money.reduce((a, b) => (b.value > a.value ? b : a))
    fields[key] = pick.value
    found.push(`${label}: ${pick.raw}`)
  }

  // Percentages already claimed by another field. Without this a single "30%"
  // in the text would be read as BOTH the capacity added and its utilisation —
  // the same number silently doing two jobs and inflating the result.
  const usedPct = new Set()
  const takePct = (key, label, matcher, { fallback = false } = {}) => {
    let hit = pcts.find(p => !usedPct.has(p.index) && matcher(p))
    if (!hit && fallback) {
      const free = pcts.filter(p => !usedPct.has(p.index))
      if (free.length === 1) hit = free[0]
    }
    if (!hit) return
    usedPct.add(hit.index)
    fields[key] = hit.value
    found.push(`${label}: ${hit.raw}`)
  }

  switch (typeId) {
    case 'contract': {
      takeMoney('value', 'Contract value')
      if (dur.years) { fields.years = dur.years; found.push(`Period: ${dur.years} years`) }
      fields.direction = /\b(lost|lose|cancel|terminat|withdraw)\b/.test(lower) ? 'lost' : 'won'
      // Only set when the text actually says so — an unstated assumption here
      // would silently double-count revenue the company already had.
      if (/\b(replac|renew|existing contract|re-?award)\b/.test(lower)) fields.incremental = 'replacing'
      else if (/\b(new|fresh|maiden|first)\b/.test(lower)) fields.incremental = 'new'
      break
    }
    case 'capacity': {
      takePct('addedPct', 'Capacity added',
        p => /capacit|expan|increas|add/.test(p.before + p.after), { fallback: true })
      takePct('utilisation', 'Utilisation', p => /utilis|utiliz|occupan/.test(p.before + p.after))
      if (dur.years) fields.years = dur.years
      break
    }
    case 'segment_loss': {
      takePct('segmentPct', 'Segment share of revenue',
        p => /revenue|sales|topline|book|business|contribut/.test(p.after + p.before), { fallback: true })
      break
    }
    case 'capex': {
      takeMoney('amount', 'Capex')
      if (dur.years) fields.yearsToLive = dur.years
      break
    }
    case 'subsidy': {
      takeMoney('amount', 'Benefit')
      if (dur.years) fields.years = dur.years
      break
    }
    case 'input_cost': {
      takePct('shareOfCost', 'Share of costs',
        p => /^\s*(?:of|as)?\s*(?:the\s*)?(?:total\s*)?(?:cost|expens|raw material)/.test(p.after))
      takePct('changePct', 'Cost change',
        p => /(cost|price|rate)s?\s*(up|down|rise|rose|fell|increase|decrease)?\s*$/.test(p.before) ||
             /(up|down|higher|lower|increase|decrease)/.test(p.before))
      break
    }
    case 'nim_change': {
      if (bps != null) { fields.bps = bps; found.push(`NIM impact: ${bps} bps`) }
      break
    }
    case 'margin_guidance': {
      takePct('targetPct', 'Guided margin', p => /margin/.test(p.before + p.after))
      if (dur.fiscalYear) fields.fiscalYear = dur.fiscalYear
      break
    }
    case 'growth_guidance': {
      fields.mode = 'growth'
      takePct('growthPct', 'Guided growth',
        p => /(growth|grow|revenue|increase|topline)/.test(p.before + p.after), { fallback: true })
      if (fields.growthPct == null && money.length) {
        fields.mode = 'target'
        takeMoney('targetRevenue', 'Revenue target')
        if (dur.years) fields.years = dur.years
      }
      if (dur.fiscalYear) fields.fiscalYear = dur.fiscalYear
      break
    }
    default: break
  }

  // What's still absent. This is the honest half of the job: the app names the
  // one fact that would let it compute, rather than assuming a value.
  let required = REQUIRED[typeId] || []
  // Revenue guidance can arrive either as a growth rate or as a target figure —
  // whichever is present satisfies it.
  if (typeId === 'growth_guidance' && fields.mode === 'target') {
    required = [['targetRevenue', 'the revenue target'], ['years', 'the period it covers']]
  }
  const missing = required
    .filter(([k]) => fields[k] == null || fields[k] === '')
    .map(([key, ask]) => ({ key, ask }))

  return { typeId, fields, missing, found, enough: missing.length === 0 }
}
