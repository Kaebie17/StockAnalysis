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

// Sector median EV/EBITDA multiples — same sector keys as the tables above.
// Telecom/infrastructure/power sit relatively HIGH here despite modest P/E,
// because EV/EBITDA is the standard metric for capital-intensive, high-D&A
// businesses precisely where P/E is least informative; commodity/metals sit
// low, consistent with their cyclical P/E; banks/nbfc/insurance are excluded
// from this model entirely in stage.js (leveraged financials aren't valued on
// EV/EBITDA at all), so their entries here are nominal and never read.
export const SECTOR_EVEB_MAP = {
  'energy': 6, 'oil': 6, 'petroleum': 6, 'refineries': 6, 'gas': 7,
  'insurance': 12, 'life insurance': 12, 'general insurance': 12,
  'bank': 10, 'banking': 10, 'nbfc': 10, 'finance': 10, 'financial services': 10,
  'technology': 18, 'software': 18, 'information technology': 18,
  'automobile': 11, 'auto': 11, 'automotive': 11,
  'mining': 7, 'metals': 7, 'steel': 6, 'iron': 6, 'aluminium': 7,
  'fmcg': 22, 'consumer': 18, 'beverages': 20, 'food': 16,
  'pharma': 17, 'healthcare': 16, 'hospitals': 16,
  'real estate': 11, 'realty': 11,
  'power': 9, 'utilities': 9, 'infrastructure': 9,
  'chemicals': 11, 'cement': 11,
  'telecom': 8,
  'default': 10,
}

// Sector median EV/FCF multiples — same sector keys as the tables above.
// FCF is a smaller, more scrutinized base than EBITDA or earnings (net of
// capex, tax and working-capital), so quality/asset-light sectors that
// convert most of their earnings to cash (FMCG, tech, pharma) command the
// richest multiples here; capital-intensive sectors with heavy ongoing capex
// (telecom, power, energy) sit lowest, same relative ordering as EV/EBITDA
// but shifted for FCF's own conversion economics. Replaces a single flat 18x
// Market Expectation previously applied to every sector alike.
export const SECTOR_FCF_MAP = {
  'energy': 10, 'oil': 10, 'petroleum': 10, 'refineries': 10, 'gas': 11,
  'insurance': 15, 'life insurance': 15, 'general insurance': 15,
  'bank': 13, 'banking': 13, 'nbfc': 13, 'finance': 13, 'financial services': 13,
  'technology': 25, 'software': 25, 'information technology': 25,
  'automobile': 14, 'auto': 14, 'automotive': 14,
  'mining': 9, 'metals': 9, 'steel': 8, 'iron': 8, 'aluminium': 9,
  'fmcg': 28, 'consumer': 22, 'beverages': 25, 'food': 18,
  'pharma': 20, 'healthcare': 19, 'hospitals': 18,
  'real estate': 12, 'realty': 12,
  'power': 11, 'utilities': 11, 'infrastructure': 10,
  'chemicals': 13, 'cement': 13,
  'telecom': 10,
  'default': 18,
}

// P/B multiples for leveraged financials — indexed by the already-resolved
// sectorType enum (bank/nbfc/insurance from stage.js's detectSectorType),
// not text-matched like the tables above, since sectorType is reliably
// resolved by the time any P/B model needs this. Previously a single flat
// 2.0x covered all three, despite them trading in genuinely different
// ranges: banks price close to book (ROE-driven premium/discount over 1x);
// NBFCs typically carry a growth premium over banks; life insurers command
// the richest P/B of the three because embedded-value growth compounds
// faster than reported accounting book value.
export const FINANCIAL_PB_BY_SECTOR_TYPE = { bank: 2.0, nbfc: 2.5, insurance: 3.0 }

export function financialPb(sectorType) { return FINANCIAL_PB_BY_SECTOR_TYPE[sectorType] ?? 2.0 }

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

/** Sector median EV/EBITDA — fallback only, see module docblock. */
export function sectorEvEbitda(data) { return lookupSectorTable(SECTOR_EVEB_MAP, data) }

/** Sector median EV/FCF — fallback only, see module docblock. */
export function sectorEvFcf(data) { return lookupSectorTable(SECTOR_FCF_MAP, data) }
