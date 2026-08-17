/**
 * src/engine/parseExcerpt.js — decipher a pasted report excerpt into a proposed
 * normalization: which P&L line, which year, and the new value (or amount to
 * remove, or a % change).
 *
 * This NEVER applies anything blindly. It returns a best-guess PROPOSAL with the
 * raw matches it found, so the modal can show it and let the user confirm or
 * correct before reconstruction. Financial prose is too varied to trust a parse
 * silently — the human verifies.
 *
 * Reuses extractMoney (absolute base units) from factExtract.
 */
import { extractMoney } from './factExtract.js'

// P&L lines the user may restate, with the words that name them in a report.
const LINE_KEYWORDS = [
  ['otherIncome',  /\bother\s+income\b/i],
  ['tax',          /\b(tax|taxation|income tax|tax expense)\b/i],
  ['interest',     /\b(interest|finance cost|finance charges)\b/i],
  ['depreciation', /\b(depreciation|amortis|amortiz|d&a|depreciation and amortis)/i],
  ['expenses',     /\b(expenses|total expenses|operating expenses|opex)\b/i],
  ['revenue',      /\b(revenue|sales|turnover|total income)\b/i],  // proposed only; user warned
]

const YEAR_RE = /\b(?:FY\s?)?((?:19|20)\d{2})(?:\s?[-–/]\s?\d{2,4})?\b/gi

// Words that signal what the number MEANS.
const REMOVE_HINT = /\b(one-?off|exceptional|extraordinary|non-?recurring|removed?|excluding|stripping|adjust(?:ed|ment)? out|deducted?)\b/i
const SET_HINT    = /\b(restated?|adjusted (?:to|figure|value)?|revised (?:to)?|corrected (?:to)?|should be|actually|grew to|rose to|stood at|reported as)\b/i

/**
 * @returns {{
 *   ok: boolean,
 *   line: string|null,          // proposed field key
 *   year: string|null,          // 4-digit
 *   mode: 'set'|'remove'|'percent'|null,
 *   value: number|null,         // absolute base units (for set/remove)
 *   percent: number|null,       // for mode 'percent'
 *   candidates: { money: [], percents: [], years: [], lines: [] },  // for the UI
 *   note: string
 * }}
 */
export function parseExcerpt(text) {
  const t = String(text || '').trim()
  const empty = {
    ok: false, line: null, year: null, mode: null, value: null, percent: null,
    candidates: { money: [], percents: [], years: [], lines: [] }, note: '',
  }
  if (!t) return { ...empty, note: 'Paste an excerpt from the report.' }

  // ── candidates ──
  const money = extractMoney(t)                              // [{value, raw, index}] absolute
  const percents = extractPercentsLocal(t)                   // [{value, raw, index}]
  const years = []
  let ym
  const yre = new RegExp(YEAR_RE)
  while ((ym = yre.exec(t)) !== null) years.push({ year: ym[1], raw: ym[0], index: ym.index })
  const lines = LINE_KEYWORDS.filter(([, re]) => re.test(t)).map(([key]) => key)

  // ── propose line ──
  const line = lines[0] ?? null

  // ── propose year (the latest 4-digit found; report excerpts usually name the FY) ──
  const year = years.length
    ? years.map(y => y.year).sort().reverse()[0]
    : null

  // ── propose mode + value ──
  let mode = null, value = null, percent = null
  if (money.length > 0) {
    // set vs remove by hint words. Default: if wording says one-off/exceptional
    // → remove that amount; if it says restated/adjusted-to/grew-to → set to it.
    if (REMOVE_HINT.test(t) && !SET_HINT.test(t)) {
      mode = 'remove'
      // the one-off is usually the SMALLER figure (a component of the line)
      value = money.reduce((a, b) => (b.value < a.value ? b : a)).value
    } else if (SET_HINT.test(t)) {
      mode = 'set'
      // "X grew to Y" → the NEW value is the larger/later figure
      value = money.reduce((a, b) => (b.value > a.value ? b : a)).value
    } else {
      // no clear hint — propose 'set' to the single figure, flag for confirmation
      mode = money.length === 1 ? 'set' : null
      value = money.length === 1 ? money[0].value : null
    }
  } else if (percents.length > 0) {
    // "an x% change attributed to restatement" — resolvable against the reported
    // base at apply time, so carry the percent through for the modal to compute.
    mode = 'percent'
    percent = percents[0].value
  }

  const enough = !!line && !!year && (mode != null)
  const note = enough
    ? 'Best interpretation below — confirm or correct before applying.'
    : buildMissingNote(line, year, mode, money, percents)

  return { ok: enough, line, year, mode, value, percent,
           candidates: { money, percents, years, lines }, note }
}

// Local percent extractor (factExtract's extractPercents shape may vary; keep this
// self-contained so the parser has no hidden dependency on its exact return).
function extractPercentsLocal(text) {
  const out = []
  const re = /([\d,]+(?:\.\d+)?)\s*%/g
  let m
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''))
    if (isFinite(n)) out.push({ value: n, raw: m[0].trim(), index: m.index })
  }
  return out
}

function buildMissingNote(line, year, mode, money, percents) {
  const miss = []
  if (!line) miss.push('which line (e.g. other income, tax)')
  if (!year) miss.push('the year')
  if (mode == null && money.length !== 1 && percents.length === 0)
    miss.push(money.length > 1 ? 'which figure is the restatement' : 'a value')
  return miss.length
    ? `Couldn't read ${miss.join(', ')}. Correct it below.`
    : 'Confirm the reading below.'
}

/**
 * Turn a confirmed proposal into the edit reconstructRow expects.
 * reportedValue = the current value of that line (absolute base units), needed
 * for 'remove' (subtract) and 'percent' (apply to base).
 */
export function proposalToEdit(proposal, reportedValue) {
  const { line, mode, value, percent } = proposal
  if (mode === 'set')    return { line, newValue: value }
  if (mode === 'remove') return { line, newValue: (reportedValue ?? 0) - (value ?? 0) }
  if (mode === 'percent' && reportedValue != null) {
    return { line, newValue: reportedValue * (1 + percent / 100) }
  }
  return null
}
