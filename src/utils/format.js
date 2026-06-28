// format.js — display formatting helpers

export function fmt(value, decimals = 2) {
  if (value == null || isNaN(value)) return '—'
  return value.toFixed(decimals)
}

export function fmtPct(value, decimals = 1) {
  if (value == null || isNaN(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`
}

export function fmtPctAbs(value, decimals = 1) {
  if (value == null || isNaN(value)) return '—'
  return `${value.toFixed(decimals)}%`
}

export function fmtCurrency(value, currency = 'USD', compact = false) {
  if (value == null || isNaN(value)) return '—'
  if (compact) return fmtCompact(value, currency)
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function fmtPrice(value, currency = 'USD') {
  if (value == null || isNaN(value)) return '—'
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency + ' '
  return `${symbol}${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtCompact(value, currency = 'USD') {
  if (value == null || isNaN(value)) return '—'
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency + ' '
  const abs    = Math.abs(value)
  const sign   = value < 0 ? '-' : ''
  if (abs >= 1e12) return `${sign}${symbol}${(abs / 1e12).toFixed(2)}T`
  if (abs >= 1e9)  return `${sign}${symbol}${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6)  return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3)  return `${sign}${symbol}${(abs / 1e3).toFixed(2)}K`
  return `${sign}${symbol}${abs.toFixed(2)}`
}

export function fmtMultiple(value, decimals = 1) {
  if (value == null || isNaN(value)) return '—'
  return `${value.toFixed(decimals)}x`
}

export function fmtVolume(value) {
  if (value == null || isNaN(value)) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return value.toLocaleString()
}

export function fmtDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function signalColor(signal) {
  switch (signal) {
    case 'UNDERVALUED':
    case 'BULLISH':
    case 'EXCELLENT':
    case 'HEALTHY':
    case 'ACCUMULATION':
      return 'text-accent-green'
    case 'OVERVALUED':
    case 'BEARISH':
    case 'WEAK':
    case 'DISTRIBUTION':
    case 'OVERBOUGHT':
      return 'text-accent-red'
    case 'FAIRLY_VALUED':
    case 'NEUTRAL':
    case 'CONCERNS':
    case 'OVERSOLD':
      return 'text-accent-amber'
    default:
      return 'text-slate-400'
  }
}

export function signalChip(signal) {
  switch (signal) {
    case 'UNDERVALUED':
    case 'BULLISH':
    case 'EXCELLENT':
    case 'HEALTHY':
      return 'chip-green'
    case 'OVERVALUED':
    case 'BEARISH':
    case 'WEAK':
      return 'chip-red'
    case 'FAIRLY_VALUED':
    case 'NEUTRAL':
    case 'CONCERNS':
      return 'chip-amber'
    default:
      return 'chip-slate'
  }
}

export function signalEmoji(signal) {
  switch (signal) {
    case 'UNDERVALUED':  return '💎'
    case 'FAIRLY_VALUED':return '⚖️'
    case 'OVERVALUED':   return '⚠️'
    case 'BULLISH':      return '📈'
    case 'NEUTRAL':      return '➡️'
    case 'BEARISH':      return '📉'
    case 'EXCELLENT':    return '🌟'
    case 'HEALTHY':      return '✅'
    case 'CONCERNS':     return '⚠️'
    case 'WEAK':         return '🚨'
    default:             return '—'
  }
}

export function upsideColor(upside) {
  if (upside == null) return 'text-slate-400'
  if (upside >  15) return 'text-accent-green'
  if (upside < -10) return 'text-accent-red'
  return 'text-accent-amber'
}

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£',
  INR: '₹', JPY: '¥', CNY: '¥',
  AUD: 'A$', CAD: 'C$', SGD: 'S$',
}
