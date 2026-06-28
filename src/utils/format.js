/**
 * src/utils/format.js
 */

export function fmtNum(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—'
  if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(decimals) + 'T'
  if (Math.abs(v) >= 1e9)  return (v / 1e9).toFixed(decimals) + 'B'
  if (Math.abs(v) >= 1e6)  return (v / 1e6).toFixed(decimals) + 'M'
  if (Math.abs(v) >= 1e3)  return (v / 1e3).toFixed(decimals) + 'K'
  return v.toFixed(decimals)
}

export function fmtINR(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—'
  if (Math.abs(v) >= 1e12) return '₹' + (v / 1e12).toFixed(decimals) + 'L Cr'
  if (Math.abs(v) >= 1e7)  return '₹' + (v / 1e7).toFixed(decimals) + 'Cr'
  if (Math.abs(v) >= 1e5)  return '₹' + (v / 1e5).toFixed(decimals) + 'L'
  return '₹' + v.toFixed(0)
}

export function fmtCurrency(v, currency = 'USD', decimals = 1) {
  if (v == null || isNaN(v)) return '—'
  if (currency === 'INR') return fmtINR(v, decimals)
  const sym = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency + ' '
  return sym + fmtNum(v, decimals)
}

export function fmtPct(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%'
}

export function fmtPctPlain(v, decimals = 1) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(decimals) + '%'
}

export function fmtMultiple(v, suffix = 'x', decimals = 1) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(decimals) + suffix
}

export function fmtPrice(v, currency = 'USD') {
  if (v == null || isNaN(v)) return '—'
  if (currency === 'INR') return '₹' + v.toFixed(2)
  const sym = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : ''
  return sym + v.toFixed(2)
}

export function signalColor(signal) {
  if (!signal) return 'text-slate-400'
  const s = signal.toUpperCase()
  if (s.includes('UNDER') || s === 'BULLISH' || s === 'EXCELLENT' || s === 'HEALTHY') return 'text-bull'
  if (s.includes('OVER')  || s === 'BEARISH' || s === 'WEAK')                         return 'text-bear'
  return 'text-neutral'
}

export function signalBadgeClass(signal) {
  if (!signal) return 'badge-neutral'
  const s = signal.toUpperCase()
  if (s.includes('UNDER') || s === 'BULLISH' || s === 'EXCELLENT' || s === 'HEALTHY') return 'badge-bull'
  if (s.includes('OVER')  || s === 'BEARISH' || s === 'WEAK')                         return 'badge-bear'
  return 'badge-neutral'
}
