/**
 * src/api/businessProfileClient.js — classify a company's business model, or
 * reuse the answer already sitting in the central classifications store.
 *
 * This module never writes to db.js's `classifications` store itself — it
 * only ever returns a candidate result. The caller (PeerSelectModal.jsx)
 * decides whether/how it actually gets saved, via a diff-review step for any
 * re-run over an existing record, so a re-classify never silently overwrites
 * a prior answer — AI-sourced or user-edited.
 */

import { getClassification } from '../utils/db.js'

// Same djb2-style hash AIVerdict.jsx already uses inline for its own
// fingerprint — duplicated rather than shared, matching this codebase's
// existing pattern of small local duplicates over a shared util for a
// one-line function.
function hashStr(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return h.toString(36)
}

export function classificationFingerprint({ name, sector, industry, businessSummary }) {
  return hashStr(`${name || ''}|${sector || ''}|${industry || ''}|${businessSummary || ''}`)
}

// One in-flight request per symbol — de-dupes a double click or a re-render
// firing two paid calls for the same company at once.
const inflight = new Map()

/**
 * @returns one of:
 *   { skipped: 'user-owned', existing }   — a human correction, never auto-refreshed without force
 *   { skipped: 'unchanged', existing }    — already classified by AI from the same input, nothing changed
 *   { result: {...classification fields...} }  — a fresh AI result, NOT yet saved
 *   { error: 'no_key' | 'fetch_failed' | 'unparseable' | 'unclassifiable' | 'missing_input', detail }
 */
export async function classifyCompany({ symbol, name, meta, userKey, model, force = false }) {
  const sym = String(symbol || '').trim().toUpperCase()
  if (!sym || !name) return { error: 'missing_input', detail: 'symbol and name are required' }

  const fp = classificationFingerprint({ name, sector: meta?.sector, industry: meta?.industry, businessSummary: meta?.businessSummary })

  if (!force) {
    const existing = await getClassification(sym)
    if (existing?.userEdited) return { skipped: 'user-owned', existing }
    if (existing?.source === 'ai' && existing.fingerprint === fp) return { skipped: 'unchanged', existing }
  }

  if (inflight.has(sym)) return inflight.get(sym)

  const promise = (async () => {
    try {
      const r = await fetch('/api/classifyBusiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: sym, name,
          sector: meta?.sector || null, industry: meta?.industry || null,
          businessSummary: meta?.businessSummary || null,
          userKey, model,
        }),
      })
      const data = await r.json().catch(() => null)
      if (!data || data.businessModel == null) {
        return { error: data?.error || 'fetch_failed', detail: data?.detail }
      }
      return { result: { ...data, fingerprint: fp, classifiedAt: Date.now(), model: model || 'gemini-2.5-flash' } }
    } catch (e) {
      return { error: 'fetch_failed', detail: e?.message }
    } finally {
      inflight.delete(sym)
    }
  })()

  inflight.set(sym, promise)
  return promise
}
