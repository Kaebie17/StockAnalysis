
/**
 * src/utils/format.js — number/currency/percent formatters and signal colors.
 */

export function fmtNum(v, dec = 1, currency = null) {
  if (v == null || isNaN(v)) return '—'
  // Indian numbering: use Crore / Lakh for INR so it matches the rest of the app
  // (never Billions/Trillions).
  if (currency === 'INR') {
    if (Math.abs(v) >= 1e7) return (v/1e7).toFixed(dec)+'Cr'
    if (Math.abs(v) >= 1e5) return (v/1e5).toFixed(dec)+'L'
    if (Math.abs(v) >= 1e3) return (v/1e3).toFixed(dec)+'K'
    return v.toFixed(dec)
  }
  if (Math.abs(v) >= 1e12) return (v/1e12).toFixed(dec)+'T'
  if (Math.abs(v) >= 1e9)  return (v/1e9).toFixed(dec)+'B'
  if (Math.abs(v) >= 1e7)  return (v/1e7).toFixed(dec)+'Cr'
  if (Math.abs(v) >= 1e6)  return (v/1e6).toFixed(dec)+'M'
  if (Math.abs(v) >= 1e3)  return (v/1e3).toFixed(dec)+'K'
  return v.toFixed(dec)
}

export function fmtCurrency(v, currency = 'USD', dec = 1) {
  if (v == null || isNaN(v)) return '—'
  const sym = currency === 'INR' ? '₹' : currency === 'GBP' ? '£' : '$'
  return sym + fmtNum(v, dec, currency)
}

export function fmtPct(v, dec = 1) {
  if (v == null || isNaN(v)) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(dec) + '%'
}

export function fmtPctPlain(v, dec = 1) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(dec) + '%'
}

export function fmtMultiple(v, dec = 1) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(dec) + '×'
}

export function fmtPrice(v, currency = 'USD') {
  if (v == null || isNaN(v)) return '—'
  const sym = currency === 'INR' ? '₹' : '$'
  return sym + v.toFixed(2)
}

export function signalColor(s) {
  if (!s) return 'text-slate-400'
  const u = s.toUpperCase()
  if (['UNDERVALUED','BULLISH','EXCELLENT','HEALTHY'].some(k => u.includes(k))) return 'text-bull'
  if (['OVERVALUED','BEARISH','WEAK'].some(k => u.includes(k)))                 return 'text-bear'
  return 'text-neutral'
}

export function signalBadgeClass(s) {
  if (!s) return 'badge-neutral'
  const u = s.toUpperCase()
  if (['UNDERVALUED','BULLISH','EXCELLENT','HEALTHY'].some(k => u.includes(k))) return 'badge-bull'
  if (['OVERVALUED','BEARISH','WEAK'].some(k => u.includes(k)))                 return 'badge-bear'
  return 'badge-neutral'
}

// Resolution badge / fmtTagged removed — superseded by
// src/engine/methodologyTier.js's tierFromStatus() + <ProvenanceTag>, the
// one provenance system now used everywhere (see that file's docblock).