/**
 * src/engine/businessProfileEnums.js — fixed vocabulary for peer classification.
 *
 * Shared by the AI classification endpoint (api/classifyBusiness.js), the
 * compatibility scorer (peerCompatibility.js), and the classify/edit UI
 * (PeerSelectModal.jsx) — a fixed enum, not free text, is what makes two
 * companies' classifications actually comparable. An out-of-enum value from
 * the model is treated as unparseable, never silently accepted.
 *
 * No "assetProfile" here on purpose — an earlier draft used
 * ASSET_LIGHT_ASSEMBLY for a company like Dixon that runs real factories and
 * carries real manufacturing working capital, which is a misleading label.
 * PRODUCTION_PROFILE (what kind of production) and CAPITAL_INTENSITY (how
 * capital-heavy it is) are kept as separate axes instead.
 */

export const BUSINESS_MODELS = [
  'CONTRACT_MANUFACTURER', 'ODM', 'BRANDED_MANUFACTURER', 'COMPONENT_SUPPLIER',
  'SYSTEM_INTEGRATOR', 'DESIGN_ENGINEERING_SERVICES', 'DISTRIBUTOR_TRADER', 'PROJECT_EPC',
  'COMMODITY_PRODUCER', 'REGULATED_UTILITY_INFRA', 'FINANCIAL_INTERMEDIARY', 'OTHER',
]

export const END_MARKETS = [
  'CONSUMER_ELECTRONICS', 'MOBILE_TELECOM', 'IT_HARDWARE', 'APPLIANCES',
  'AUTOMOTIVE', 'INDUSTRIAL', 'DEFENCE_AEROSPACE', 'HEALTHCARE_PHARMA',
  'ENERGY_POWER', 'BFSI', 'FMCG_RETAIL', 'INFRASTRUCTURE_CONSTRUCTION',
  'AGRICULTURE', 'IT_SOFTWARE_SERVICES', 'OTHER',
]

export const REVENUE_MODELS = [
  'B2B_CONTRACT_MANUFACTURING', 'B2B_COMPONENT_SUPPLY', 'B2C_BRANDED_RETAIL',
  'B2B_ENTERPRISE_SALES', 'B2G_GOVERNMENT_CONTRACTS', 'PROJECT_EPC',
  'SUBSCRIPTION_RECURRING', 'COMMODITY_SALES', 'OTHER',
]

export const PRODUCTION_PROFILES = [
  'ASSEMBLY_LED', 'INTEGRATED_MANUFACTURING', 'PROCESS_MANUFACTURING',
  'DESIGN_ONLY', 'SERVICES', 'OTHER',
]

export const CAPITAL_INTENSITY = ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']

export const CLASSIFICATION_STATUS = ['classified', 'uncertain', 'unclassifiable']
export const CLASSIFICATION_CONFIDENCE = ['high', 'medium', 'low']
export const EVIDENCE_QUALITY = ['strong', 'moderate', 'weak']
// 'annual_report' and 'company_website' are schema-ready but not producible
// by api/classifyBusiness.js in v1 — it only ever sees a Yahoo business
// summary and NSE sector/industry labels.
export const EVIDENCE_SOURCES = ['business_summary', 'nse_classification', 'annual_report', 'company_website']

export function isValidClassification(fields) {
  if (!fields || typeof fields !== 'object') return false
  if (!BUSINESS_MODELS.includes(fields.businessModel)) return false
  if (fields.secondaryBusinessModels != null &&
      (!Array.isArray(fields.secondaryBusinessModels) || fields.secondaryBusinessModels.some(m => !BUSINESS_MODELS.includes(m)))) return false
  if (!Array.isArray(fields.endMarkets) || fields.endMarkets.length === 0 || fields.endMarkets.some(m => !END_MARKETS.includes(m))) return false
  if (!REVENUE_MODELS.includes(fields.revenueModel)) return false
  if (!PRODUCTION_PROFILES.includes(fields.productionProfile)) return false
  if (!CAPITAL_INTENSITY.includes(fields.capitalIntensity)) return false
  if (!CLASSIFICATION_STATUS.includes(fields.status)) return false
  if (!CLASSIFICATION_CONFIDENCE.includes(fields.confidence)) return false
  if (!EVIDENCE_QUALITY.includes(fields.evidenceQuality)) return false
  if (!Array.isArray(fields.evidence) || fields.evidence.some(e => !EVIDENCE_SOURCES.includes(e))) return false
  return true
}
