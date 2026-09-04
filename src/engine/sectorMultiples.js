/**
 * src/engine/sectorMultiples.js — the shared, static sector-multiple tables.
 *
 * FALLBACK OF LAST RESORT. Real data always wins when it's available: a
 * peer-median multiple (src/engine/peerBands.js) or the company's own actual
 * multiple is preferred everywhere these are used. This table only fires when
 * neither exists — a static, hand-set, necessarily-approximate table, same
 * epistemic status as any textbook "typical sector multiple" reference.
 *
 * Before this existed, valuation.js and marketExpectation.js each had their
 * own, independently-hardcoded version of "what's normal for this sector" —
 * valuation.js's SECTOR_PE_MAP had ~15 granular buckets; marketExpectation.js
 * had three sector-specific numbers (insurance/bank/nbfc) and ONE flat
 * default (20 for P/E, 3.0 for sales) covering every other sector — tech,
 * FMCG, steel, auto, everything. Same underlying question, very different
 * fidelity, for no stated reason. One table now, both files import it.
 */

// Sector median P/E multiples.
export const SECTOR_PE_MAP = {
  'energy': 15, 'oil': 15, 'petroleum': 15, 'refineries': 15, 'gas': 15,
  'insurance': 18, 'life insurance': 18, 'general insurance': 18,
  'bank': 16, 'banking': 16, 'nbfc': 16, 'finance': 16, 'financial services': 16,
  'technology': 25, 'software': 25, 'information technology': 25,
  'automobile': 20, 'auto': 20, 'automotive': 20,
  'mining': 12, 'metals': 12, 'steel': 10, 'iron': 10, 'aluminium': 12,
  'fmcg': 45, 'consumer': 35, 'beverages': 40, 'food': 35,
  'pharma': 28, 'healthcare': 28, 'hospitals': 30,
  'real estate': 30, 'realty': 30,
  'power': 18, 'utilities': 18, 'infrastructure': 20,
  'chemicals': 22, 'cement': 20,
  'telecom': 20,
  'default': 20,
}

// Sector median EV/Sales multiples — same sector keys as SECTOR_PE_MAP so both
// tables stay in sync, values set by the same broad convention P/E used
// (higher-margin/higher-growth sectors command a higher revenue multiple).
export const SECTOR_SALES_MAP = {
  'energy': 1.0, 'oil': 1.0, 'petroleum': 1.0, 'refineries': 1.0, 'gas': 1.2,
  'insurance': 1.5, 'life insurance': 1.5, 'general insurance': 1.5,
  'bank': 2.0, 'banking': 2.0, 'nbfc': 2.5, 'finance': 2.0, 'financial services': 2.0,
  'technology': 7.0, 'software': 7.0, 'information technology': 7.0,
  'automobile': 1.5, 'auto': 1.5, 'automotive': 1.5,
  'mining': 1.2, 'metals': 1.0, 'steel': 1.0, 'iron': 1.0, 'aluminium': 1.2,
  'fmcg': 6.0, 'consumer': 4.5, 'beverages': 5.0, 'food': 3.5,
  'pharma': 4.5, 'healthcare': 4.0, 'hospitals': 4.0,
  'real estate': 3.5, 'realty': 3.5,
  'power': 2.5, 'utilities': 2.5, 'infrastructure': 2.0,
  'chemicals': 2.5, 'cement': 2.5,
  'telecom': 2.5,
  'default': 3.0,
}

function lookupSectorTable(table, data) {
  const combined = [data?.meta?.sector, data?.meta?.industry, data?.name]
    .filter(Boolean).join(' ').toLowerCase()
  for (const [key, value] of Object.entries(table)) {
    if (key !== 'default' && combined.includes(key)) return value
  }
  return table.default
}

/** Sector median P/E — fallback only, see module docblock. */
export function sectorPe(data) { return lookupSectorTable(SECTOR_PE_MAP, data) }

/** Sector median EV/Sales — fallback only, see module docblock. */
export function sectorEvSales(data) { return lookupSectorTable(SECTOR_SALES_MAP, data) }
