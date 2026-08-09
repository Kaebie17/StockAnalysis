import React, { useMemo, useState } from 'react'
import { applicableFacts, computeFact, factType } from '../../engine/factImpact.js'
import { extractFacts } from '../../engine/factExtract.js'

const symOf = c => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[c]) || '₹'

/**
 * FactInputModal — record what was announced; the app works out what it means.
 *
 * The design point: you are never asked to type a growth rate or a multiple. You
 * describe the event in its own terms ("₹500 Cr order over 3 years") and the app
 * converts it, showing every step. Asking for the conclusion instead would
 * quietly require the user to have done this arithmetic already, and most would
 * enter a round number that felt about right — leaving the one number the app
 * builds to be accountable resting on a guess.
 *
 * Re-rating is the exception, and it's handled the other way round: the app
 * PROPOSES a multiple from sustained market behaviour and you accept or override
 * it, because no announcement computes what people are willing to pay.
 */
export default function FactInputModal({ open, onClose, ctx, rerating, onCommit, sourceItem }) {
  const [text, setText] = useState(sourceItem?.title || '')
  const [typeId, setTypeId] = useState(null)
  const [fields, setFields] = useState({})
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)

  // Read the announcement as it's typed or pasted. What it yields drives
  // everything below: enough facts and the impact computes; not enough and the
  // app names exactly which one is missing rather than filling it in.
  const parsed = useMemo(() => extractFacts(text, ctx), [text, ctx])

  // Extraction proposes; the user can correct. Any field they touch wins, so a
  // wrong guess is one edit away from right rather than something to fight.
  const activeType = manual ? typeId : (typeId || parsed.typeId)
  const activeFields = useMemo(
    () => ({ ...(parsed.typeId === activeType ? parsed.fields : {}), ...fields }),
    [parsed, activeType, fields])

  const types = useMemo(() => applicableFacts(ctx?.sectorType), [ctx?.sectorType])
  const t = activeType ? factType(activeType) : null
  const result = t ? computeFact(activeType, activeFields, ctx) : null

  // Required inputs the text didn't supply, recomputed against what the user has
  // since filled in.
  const stillMissing = (parsed.typeId === activeType ? parsed.missing : [])
    .filter(m => activeFields[m.key] == null || activeFields[m.key] === '')

  if (!open) return null

  const pick = id => {
    setTypeId(id); setManual(true)
    const defs = {}
    for (const f of factType(id)?.fields || []) if (f.default !== undefined) defs[f.key] = f.default
    setFields(defs)
  }

  const commitFact = async () => {
    if (!result || result.error || result.note) return
    setBusy(true)
    try {
      const entries = [result, result.second].filter(Boolean)
      for (const r of entries) {
        await onCommit({
          lever: r.lever,
          oldValue: r.from ?? null,
          newValue: r.to,
          disposition: 'revised',
          trigger: sourceItem ? 'news' : 'manual',
          factType: activeType,
          factFields: activeFields,
          sourceText: text || null,
          steps: r.steps,
          reason: reason || t.label,
          sourceItem: sourceItem || null,
          toGuidance: !!t.toGuidance,
        })
      }
      onClose()
    } finally { setBusy(false) }
  }

  const acceptRerating = async () => {
    setBusy(true)
    try {
      await onCommit({
        lever: 'multiple',
        oldValue: rerating.band?.median ?? null,
        newValue: rerating.proposal.multiple,
        disposition: 'revised',
        trigger: 'rerating',
        reason: rerating.summary,
        steps: [rerating.summary, rerating.peerContext?.label].filter(Boolean),
      })
      onClose()
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center
                    p-0 sm:p-4 bg-black/60 backdrop-blur-sm"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full sm:max-w-lg bg-navy-900 border border-navy-700
                      rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-700 shrink-0">
          <h2 className="font-semibold text-white">📌 What happened?</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4
                        pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {sourceItem && (
            <p className="text-xs text-slate-400 bg-navy-800/50 rounded-lg px-3 py-2">
              {sourceItem.title}
            </p>
          )}

          {/* Re-rating proposal sits above the fact list because it's the one
              thing the app worked out on its own — the user is accepting a
              measurement, not supplying one. */}
          {!typeId && rerating?.detected && (
            <div className="border border-neutral/40 rounded-lg p-3 space-y-2">
              <div className="text-xs text-neutral font-medium">
                ⚑ The market may have {rerating.direction}
              </div>
              <p className="text-[11px] text-slate-400">{rerating.summary}</p>
              {rerating.peerContext && (
                <p className="text-[11px] text-slate-500">{rerating.peerContext.label}</p>
              )}
              <button onClick={acceptRerating} disabled={busy}
                className="btn-primary text-xs w-full py-1.5">
                {rerating.proposal.label}
              </button>
              <p className="text-[10px] text-slate-600">
                Keeps the same spread — only the centre of the range moves.
              </p>
            </div>
          )}

          {/* Open input. What a release actually tells you varies enormously —
              one states a contract value and a period, another says a licence is
              suspended and nothing else. A fixed form would make the user work
              out the answer before they could enter it; this reads whatever is
              there and is explicit about what it still needs. */}
          <div>
            <span className="text-xs text-slate-400 block mb-1">
              Paste the announcement, or describe what happened
            </span>
            <textarea rows={3} value={text} onChange={e => setText(e.target.value)}
              placeholder="e.g. Company bags ₹500 crore order to be executed over 3 years"
              className="input-field text-xs w-full resize-none" />
          </div>

          {text.trim() && parsed.typeId && !manual && (
            <div className="text-[11px] text-slate-500">
              Read as: <span className="text-slate-300">{factType(parsed.typeId)?.label}</span>
              {parsed.found.length > 0 && <> · {parsed.found.join(' · ')}</>}
              <button onClick={() => { setTypeId(parsed.typeId); setManual(true); setFields(parsed.fields) }}
                className="text-accent hover:text-accent-light ml-1.5">change</button>
            </div>
          )}

          {text.trim() && !parsed.typeId && !activeType && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-neutral">{parsed.note}</p>
              {types.map(ft => (
                <button key={ft.id} onClick={() => pick(ft.id)}
                  className="w-full text-left px-3 py-1.5 rounded-lg border border-navy-700
                             hover:border-accent/50 transition-colors">
                  <div className="text-xs text-slate-200">{ft.label}</div>
                </button>
              ))}
            </div>
          )}

          {/* The honest half: name the fact that would let this compute, rather
              than assuming a value for it. Until it's supplied the flag stands. */}
          {stillMissing.length > 0 && (
            <div className="bg-navy-800/50 rounded-lg px-3 py-2.5 space-y-2">
              <p className="text-[11px] text-neutral">
                Not enough to work out the impact yet. Still needed:
              </p>
              {stillMissing.map(m => {
                const f = t?.fields.find(x => x.key === m.key)
                return (
                  <div key={m.key}>
                    <span className="text-[11px] text-slate-400 block mb-1">{m.ask}</span>
                    {f && <FactField field={f} ctx={ctx} value={activeFields[m.key] ?? ''}
                                     onChange={v => setFields(s => ({ ...s, [m.key]: v }))} />}
                  </div>
                )
              })}
              <p className="text-[10px] text-slate-600">
                Leave it blank if you don't know — the estimate stays flagged rather than moving
                on a guess.
              </p>
            </div>
          )}

          {/* Full field set only when the user asked to edit by hand. */}
          {manual && t && (
            <div className="space-y-3">
              <div className="text-sm text-slate-200">{t.label}</div>
              {t.fields.map(f => (
                <FactField key={f.key} field={f} ctx={ctx}
                  value={activeFields[f.key] ?? ''}
                  onChange={v => setFields(s => ({ ...s, [f.key]: v }))} />
              ))}
            </div>
          )}

          {result?.error && stillMissing.length === 0 && (
            <p className="text-xs text-slate-500">{result.error}</p>
          )}
          {result?.note && <p className="text-xs text-neutral">{result.note}</p>}
          {result?.lever && (
            <div className="bg-navy-800/50 rounded-lg px-3 py-2.5 space-y-1.5">
              {result.steps.map((s, i) => (
                <div key={i} className="text-[11px] text-slate-400">{s}</div>
              ))}
              <LeverChange r={result} />
              {result.second && (
                <>
                  <div className="border-t border-navy-700 pt-1.5 mt-1.5" />
                  {result.second.steps.map((s, i) => (
                    <div key={i} className="text-[11px] text-slate-400">{s}</div>
                  ))}
                  <LeverChange r={result.second} />
                </>
              )}
            </div>
          )}

          <input value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Note (optional) — what you'll want to remember"
            className="input-field text-xs w-full" />
        </div>

        {(result?.lever || activeType) && (
          <div className="flex gap-2 px-5 py-4 border-t border-navy-700 shrink-0
                          pb-[max(1rem,env(safe-area-inset-bottom))]">
            <button onClick={onClose} className="flex-1 text-sm text-slate-400 hover:text-white py-2">
              Cancel
            </button>
            <button onClick={commitFact} disabled={busy || !result?.lever}
              className="flex-1 btn-primary text-sm py-2">
              {busy ? 'Applying…' : 'Apply to estimate'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function LeverChange({ r }) {
  const isPct = r.lever === 'growth' || r.lever === 'margin'
  const fmt = v => (v == null ? '—' : isPct ? `${(v * 100).toFixed(1)}%` : `${(+v).toFixed(1)}×`)
  const up = r.to > r.from
  return (
    <div className="text-xs text-slate-300 pt-0.5">
      <span className="text-slate-500 capitalize">{r.lever}</span>{' '}
      <span className="font-mono">{fmt(r.from)}</span>
      <span className="text-slate-600"> → </span>
      <span className={`font-mono ${up ? 'text-bull' : 'text-bear'}`}>{fmt(r.to)}</span>
    </div>
  )
}

function FactField({ field, value, onChange, ctx }) {
  const unit = field.unit
  const cur = symOf(ctx?.currency)
  const unitLabel = unit === 'money' ? `${cur} (${ctx?.currency === 'INR' ? 'Cr' : 'M'})`
    : unit === 'percent' ? '%' : unit === 'years' ? 'yr' : unit === 'bps' ? 'bps' : ''

  if (unit === 'choice') {
    return (
      <div>
        <span className="text-xs text-slate-400 block mb-1">{field.label}</span>
        <div className="flex gap-2">
          {field.options.map(([v, lbl]) => (
            <button key={v} type="button" onClick={() => onChange(v)}
              className={`flex-1 py-1.5 rounded-lg text-xs border transition-colors ${
                value === v ? 'border-accent bg-navy-800 text-white' : 'border-navy-700 text-slate-400'}`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <span className="text-xs text-slate-400 block mb-1">
        {field.label}{field.hint && <span className="text-slate-600"> — {field.hint}</span>}
      </span>
      <div className="flex items-center gap-2">
        <input
          type={unit === 'text' ? 'text' : 'number'}
          inputMode={unit === 'text' ? 'text' : 'decimal'}
          // Money is HELD in absolute units (so the maths is unit-free) but
          // ENTERED and SHOWN in Cr / M, because nobody types 5000000000.
          // Scaling only at this boundary keeps the conversion in one place.
          value={unit === 'money' && value !== '' && value != null
            ? value / (ctx?.currency === 'INR' ? 1e7 : 1e6)
            : value}
          placeholder={field.placeholder || ''}
          onChange={e => {
            const raw = e.target.value
            if (raw === '') return onChange('')
            if (unit === 'money') {
              const div = ctx?.currency === 'INR' ? 1e7 : 1e6
              return onChange(+raw * div)
            }
            onChange(unit === 'text' ? raw : +raw)
          }}
          className="input-field text-sm flex-1" />
        {unitLabel && <span className="text-xs text-slate-500 shrink-0 w-14">{unitLabel}</span>}
      </div>
    </div>
  )
}
