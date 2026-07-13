import React, { useState } from 'react'
import { BASE_METRICS, OPERATORS, enumerateGroupings, evalTree, exprString } from '../engine/formulaBuilder.js'

/**
 * FormulaBuilder — assemble a formula from constrained choices (metric/constant +
 * operator), then pick the parenthesization you meant from the generated options.
 * No free text. onSave receives { tokens, tree } to store as an override.
 *
 * Props: scope (ratioResult, for live preview values), initial ({tokens}), onSave, onCancel
 */
const SYM = { '+': '+', '-': '−', '*': '×', '/': '÷' }

export default function FormulaBuilder({ scope = {}, initial, onSave, onCancel }) {
  const [tokens, setTokens] = useState(initial?.tokens || [{ type: 'metric', key: 'revenue' }])
  const [options, setOptions] = useState(null)   // grouping alternatives

  const isOperandSlot = i => i % 2 === 0
  const setToken = (i, tok) => setTokens(ts => ts.map((t, j) => (j === i ? tok : t)))
  const addOperator = op => setTokens(ts => [...ts, op, { type: 'metric', key: 'revenue' }])
  const removeLast = () => setTokens(ts => (ts.length >= 3 ? ts.slice(0, -2) : ts))

  const compute = () => setOptions(enumerateGroupings(tokens))

  return (
    <div className="space-y-3">
      {/* token row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {tokens.map((t, i) => isOperandSlot(i) ? (
          <OperandSlot key={i} token={t} onChange={tok => { setToken(i, tok); setOptions(null) }} />
        ) : (
          <select key={i} value={t} onChange={e => { setToken(i, e.target.value); setOptions(null) }}
            className="input-field text-xs py-1 w-12 text-center">
            {OPERATORS.map(op => <option key={op} value={op}>{SYM[op]}</option>)}
          </select>
        ))}
      </div>

      {/* add operator+operand */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-slate-500">Add:</span>
        {OPERATORS.map(op => (
          <button key={op} onClick={() => { addOperator(op); setOptions(null) }}
            className="badge bg-navy-700 text-slate-200 w-7">{SYM[op]}</button>
        ))}
        {tokens.length >= 3 && <button onClick={() => { removeLast(); setOptions(null) }} className="badge bg-navy-700 text-slate-400 hover:text-bear">✕ last</button>}
        <button onClick={compute} className="btn-primary text-xs ml-auto">Show groupings</button>
      </div>

      {/* grouping alternatives */}
      {options && (
        <div className="space-y-1.5">
          {options.length === 0 && <p className="text-xs text-bear">Incomplete formula.</p>}
          {options.length > 1 && <p className="text-[11px] text-slate-500">Pick the grouping you mean:</p>}
          {options.map((o, k) => {
            const v = evalTree(o.tree, scope)
            return (
              <button key={k} onClick={() => onSave?.({ tokens, tree: o.tree })}
                className="w-full text-left rounded-lg border border-navy-700 hover:border-accent bg-navy-900/50 px-3 py-2">
                <span className="font-mono text-xs text-slate-200">{o.expr}</span>
                <span className="text-[11px] text-slate-500 ml-2">= {v == null ? '—' : round(v)}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onCancel} className="btn-ghost text-xs">Cancel</button>
      </div>
    </div>
  )
}

function OperandSlot({ token, onChange }) {
  const isConst = token.type === 'const'
  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={isConst ? '__const__' : token.key}
        onChange={e => onChange(e.target.value === '__const__' ? { type: 'const', value: 1 } : { type: 'metric', key: e.target.value })}
        className="input-field text-xs py-1">
        {BASE_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        <option value="__const__">— number —</option>
      </select>
      {isConst && (
        <input type="number" step="any" value={token.value}
          onChange={e => onChange({ type: 'const', value: parseFloat(e.target.value) || 0 })}
          className="input-field text-xs py-1 w-20" />
      )}
    </span>
  )
}

const round = v => Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100
