/**
 * src/engine/formulaBuilder.js — structured, controlled formula builder.
 *
 * A formula is a FLAT token sequence the user assembles from constrained choices:
 *   operand, operator, operand, operator, …   (odd length, ≥1 operand)
 * where operand = { type:'metric', key } | { type:'const', value }
 *       operator = '+' | '-' | '*' | '/'
 *
 * No free text, so nothing to parse unsafely — no eval, no mathjs. Precedence is
 * resolved by ENUMERATING every full parenthesization and letting the user pick
 * the grouping (result) they meant. Evaluation walks the chosen binary tree.
 *
 * Operands come straight off the ratioResult object (base metrics are exposed at
 * its top level), so evaluation scope = ratioResult.
 */

// Base metrics available as operands (exposed on ratioResult). label → key.
export const BASE_METRICS = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'opProfit', label: 'Operating Profit' },
  { key: 'ebitda', label: 'EBITDA' },
  { key: 'netProfit', label: 'Net Profit' },
  { key: 'interest', label: 'Interest' },
  { key: 'depreciation', label: 'Depreciation' },
  { key: 'totalEquity', label: 'Total Equity' },
  { key: 'totalDebt', label: 'Total Debt' },
  { key: 'cash', label: 'Cash' },
  { key: 'netDebt', label: 'Net Debt' },
  { key: 'capitalEmployed', label: 'Capital Employed' },
  { key: 'totalAssets', label: 'Total Assets' },
  { key: 'opCF', label: 'Operating Cash Flow' },
  { key: 'fcf', label: 'Free Cash Flow' },
  { key: 'eps', label: 'EPS' },
  { key: 'bookPerShare', label: 'Book Value / Share' },
  { key: 'price', label: 'Price' },
  { key: 'marketCap', label: 'Market Cap' },
  { key: 'ev', label: 'Enterprise Value' },
  { key: 'shares', label: 'Shares Outstanding' },
]
const LABEL = Object.fromEntries(BASE_METRICS.map(m => [m.key, m.label]))
export const OPERATORS = ['+', '-', '*', '/']
const SYM = { '+': '+', '-': '−', '*': '×', '/': '÷' }

// tokens = [operand, operator, operand, ...] → validate shape
export function validTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length % 2 === 0) return false
  return tokens.every((t, i) =>
    i % 2 === 0 ? (t?.type === 'metric' || t?.type === 'const') : OPERATORS.includes(t))
}

// Split a flat token list into operands[] and operators[]
function split(tokens) {
  const operands = [], operators = []
  tokens.forEach((t, i) => (i % 2 === 0 ? operands.push(t) : operators.push(t)))
  return { operands, operators }
}

// All full parenthesizations of the flat sequence (Catalan(n-1) trees).
export function enumerateGroupings(tokens) {
  if (!validTokens(tokens)) return []
  const { operands, operators } = split(tokens)
  const trees = build(operands, operators)
  // De-dupe by expression string (each tree is a distinct grouping)
  const seen = new Set(), out = []
  for (const tree of trees) {
    const expr = exprString(tree)
    if (seen.has(expr)) continue
    seen.add(expr)
    out.push({ tree, expr })
  }
  return out
}

function build(operands, operators) {
  if (operands.length === 1) return [operands[0]]
  const trees = []
  for (let i = 0; i < operators.length; i++) {
    const L = build(operands.slice(0, i + 1), operators.slice(0, i))
    const R = build(operands.slice(i + 1), operators.slice(i + 1))
    for (const l of L) for (const r of R) trees.push({ op: operators[i], left: l, right: r })
  }
  return trees
}

// Human-readable expression with parentheses.
export function exprString(node) {
  if (node.type === 'metric') return LABEL[node.key] || node.key
  if (node.type === 'const') return String(node.value)
  return `(${exprString(node.left)} ${SYM[node.op]} ${exprString(node.right)})`
}

// Evaluate a chosen tree against a scope (ratioResult). Returns number | null.
export function evalTree(node, scope) {
  if (!node) return null
  if (node.type === 'metric') { const v = scope?.[node.key]; return typeof v === 'number' && isFinite(v) ? v : null }
  if (node.type === 'const') return typeof node.value === 'number' ? node.value : null
  const l = evalTree(node.left, scope), r = evalTree(node.right, scope)
  if (l == null || r == null) return null
  switch (node.op) {
    case '+': return l + r
    case '-': return l - r
    case '*': return l * r
    case '/': return r === 0 ? null : l / r
    default: return null
  }
}
