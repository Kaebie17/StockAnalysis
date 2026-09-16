/**
 * src/engine/valuation.js
 * Stage + sector aware. All models calculated from raw scalars in ratioResult.
 *
 * KEY FIXES:
 * 1. sectorPe uses SECTOR MEDIAN not stock's own PE (using own PE is circular —
 *    EPS × own_PE always returns current price)
 * 2. sectorEvEb uses SECTOR MEDIAN EV/EBITDA (src/engine/sectorMultiples.js),
 *    not the stock's own multiple — that was the same circularity as (1), and
 *    the specific bug that triggered this file's valuation audit.
 * 3. DCF runs on real FCF only — no opCF proxy, no invented CapEx
 */
import { getApplicableModels } from './stage.js'
import { computePeg } from './peg.js'
import { capmCostOfEquity, DEFAULT_RISK_FREE_BY_MARKET, TERMINAL_GROWTH_BY_MARKET } from './requiredReturn.js'
import { sectorPe as getSectorPe, sectorEvEbitda as getSectorEvEbitda, sectorEvSales as getSectorEvSales, financialPb } from './sectorMultiples.js'
import { peerBand } from './peerBands.js'
import { TIER } from './methodologyTier.js'
import { activeValue } from './dataQuality.js'
import { latestRealRow, tableGrowthRate } from './formulas.js'
import { buildWaterfallForecast } from './estimate.js'

export function runValuation(data, r, stage, sectorType, assumptions = {}) {
  // Every call site guards on state.data being truthy, not state.ratioResult
  // specifically — the two are set together in practice, but "in practice"
  // isn't a guarantee, and every field access below already assumes r is at
  // least an object. Guarding here means a genuinely missing ratioResult
  // declines cleanly (fairValue: null, signal: 'UNKNOWN') like any other
  // missing-data case, instead of throwing.
  r = r || {}
  const modelMeta = getApplicableModels(stage, sectorType)

  // sectorPe: sector median (NOT stock's own PE — that's circular)
  const sectorPeDefault = getSectorPe(data)
  // sectorEvEb: sector median EV/EBITDA (NOT the stock's own multiple — that
  // was circular: EBITDA x its own current multiple always reproduces close
  // to today's price, clamped or not, and can never independently say the
  // stock is over/undervalued. This was the exact mechanism that made Dixon
  // Technologies' "Fair Value via EV/EBITDA" read as cheap-relative-to-nothing
  // and triggered this whole valuation audit. Peer EV/EBITDA data isn't
  // fetched (needs a per-peer quoteSummary() call the free batched quote()
  // doesn't carry — confirmed, deferred) so the sector table is the anchor.
  const sectorEvEbDefault = getSectorEvEbitda(data)
  // sectorPs: sector median EV/Sales (NOT the stock's own net margin ÷ 8 —
  // that was a heuristic with no peer/sector anchor at all, despite P/S being
  // conceptually a relative-multiple model. It also required netM > 0 to
  // compute anything, which disqualified exactly the loss-making companies
  // P/S exists to serve — PRE_REVENUE and GROWTH stages weight this model
  // specifically because their earnings aren't usable yet. Same sector table
  // (sectorMultiples.js) valuation.js's EV/EBITDA model and Market
  // Expectation's Sales variant already use.
  const sectorPsDefault = getSectorEvSales(data)

  // liveRiskFree/market: threaded from AppContext's shared fetch (Phase 8) —
  // null until that resolves, which is fine, computeWacc() always falls back
  // to a usable default rather than going blank.
  const market = assumptions.market ?? 'IN'
  // WACC default is computed per company (CAPM), not a flat rate — see computeWacc.
  const waccResult = computeWacc(r, data, {
    liveRiskFree: assumptions.liveRiskFree ?? null, erp: assumptions.liveErp ?? null, market,
    beta: assumptions.beta ?? null, betaMeta: assumptions.betaMeta ?? null,
  })
  const waccDefault = waccResult.wacc
  const waccBetaFlag = waccResult.betaFlag
  // Computed once, reused for the default below — was previously called
  // twice with identical inputs.
  const growthResult = estimateGrowth(data)

  // WACC, Terminal Growth and FCF Growth are no longer accepted as manual
  // overrides — see ValuationPanel.jsx's slider removal. Each is either a
  // real CAPM computation (WACC, off this app's own beta regression), a
  // flat disclosed market convention with no per-company discretion to
  // exercise (Terminal Growth), or already the same measured default every
  // other consumer uses and correctly DECLINES rather than substitutes a
  // flat number when unmeasurable (FCF Growth, see estimateGrowth above).
  // None of them were legitimate free-drag assumptions, so the override
  // slot itself is closed here, not just the UI that used to reach it.
  const wacc = waccDefault
  const termGrowth = TERMINAL_GROWTH_BY_MARKET[market] ?? TERMINAL_GROWTH_BY_MARKET.IN
  const growthRate = growthResult.growth

  const {
    projYears  = 10,
    sectorPe   = sectorPeDefault,
    sectorEvEb = sectorEvEbDefault,
    sectorPs   = sectorPsDefault,
    // Optional near-term (guidance) window: grow at nearTermGrowth for
    // nearTermYears, then fade toward terminal. Drives the FORWARD DCF only;
    // the reverse-DCF (market-implied) stays independent so the comparison holds.
    nearTermGrowth = null,
    nearTermYears  = 0
  } = assumptions
  const ntG = nearTermGrowth != null ? nearTermGrowth : null
  const ntY = ntG != null ? (nearTermYears || 5) : 0

  const results = {}

  // ── DCF ──────────────────────────────────────────────────────────────────────
  // FCFF (Free Cash Flow to Firm) — EBIT × (1 − effective tax rate) +
  // depreciation − capex − change in working capital, formulas.js's own
  // table row. WACC is a firm-level discount rate (it blends the cost of
  // both debt and equity); pairing it with FCFF — a cash flow that belongs
  // to debt and equity holders jointly, before either is paid — is the
  // textbook-correct match. The previous version discounted plain FCF
  // (Operating CF − CapEx, already net of interest paid) at WACC and then
  // subtracted debt again on top of that, a mismatch: a cash flow already
  // partway to "equity's share" was being treated as if it were the whole
  // enterprise's. FCFF has no partial/estimated form the way the old FCF
  // ladder did (see formulas.js's 'weighted' mode: every term must resolve
  // — EBIT, effective tax rate, depreciation, capex, working-capital change
  // — or the row simply doesn't compute) — so a skipped DCF here means the
  // company's statements genuinely don't carry everything FCFF needs, not
  // a silently degraded estimate.
  const latestIncDcf = latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic))
  const fcffValue = activeValue(latestIncDcf, 'fcff', data?.basis)?.value
  const cfBaseDcf = fcffValue > 0 ? fcffValue : null
  if (isApplicable('dcf', modelMeta) && r.shares) {
    // Preferred: the multi-year waterfall DCF — each projection year's FCFF
    // comes from re-running the earnings waterfall's own output (constant
    // historically-normalized margins/ratios, growth fading from year 1's
    // measured rate to terminal by year 5), not one starting FCFF figure
    // compounded by a single flat rate. Falls back to the older single-FCFF
    // DCF when there's no margin history to build a waterfall from at all —
    // same graceful decline as everywhere else, not a silently weaker number.
    const waterfallEV = waterfallDcfEV(data, wacc, termGrowth, projYears, ntG, ntY)
    const ev = waterfallEV ?? (cfBaseDcf ? dcfEV(cfBaseDcf, growthRate, wacc, termGrowth, projYears, ntG, ntY) : null)
    const perShare = ev != null ? (ev + r.cash - r.totalDebt) / r.shares : null
    if (perShare != null && perShare > 0) {
      // growthRate is always the measured default now (see above — the
      // manual override is gone), so these caveats — computed from that
      // same measured CAGR — always describe what's actually being used.
      const caveats = [
        r.cashEstimated && 'Cash not reported — assumed nil, fair value understated',
        r.debtEstimated && 'Debt estimated from Equity × D/E',
        waccBetaFlag,
        growthResult.unusual &&
          `Growth rate (${(growthRate * 100).toFixed(0)}%) is well outside a typical range — likely a recovery from a collapsed base or a one-off`,
        growthResult.aboveSustainable &&
          `Growth rate (${(growthRate * 100).toFixed(0)}%) exceeds what ${(growthResult.sustainable * 100).toFixed(0)}% ROE-funded growth alone can sustain — implies raising capital or more leverage`,
      ].filter(Boolean)
      results.dcf = {
        value: perShare,
        note: caveats.length ? caveats.join('; ') : (waterfallEV != null ? 'FCFF-based (waterfall)' : 'FCFF-based'),
        estimated: caveats.length > 0,
        // DERIVED — after this session's fixes (WACC clamp removed, beta
        // used as-reported, terminal growth anchored to RBI/Fed targets),
        // every component in this chain is either REPORTED (FCFF's own
        // inputs, cash, debt) or DERIVED (CAPM WACC, anchored terminal
        // growth) — no ASSUMED component remains.
        tier: TIER.DERIVED,
      }
    }
  }

  // ── P/E ── real peer data preferred, sector table as fallback ────────────────
  // Before real peer data existed, "sector median" here meant a static,
  // hand-set table — a genuine peer group's ACTUAL current multiple is a
  // strictly better anchor when there are enough peers to trust (see
  // peerBands.js). Forward P/E tried first (a market-implied peer band
  // already prices in near-term earnings changes the same way this model
  // is trying to); trailing P/E as a second peer-based attempt; the sector
  // table only when peer data isn't available at all.
  const peers = assumptions.peers || []
  if (isApplicable('pe', modelMeta) && r.eps > 0) {
    const peBand = peerBand(peers, 'forwardPe') || peerBand(peers, 'pe')
    const targetPe = peBand?.median ?? sectorPe
    const note = peBand
      ? `EPS × peer median ${targetPe}× P/E (${peBand.count} peers)`
      : `EPS × sector median ${targetPe}× P/E`
    // DERIVED when a real peer band anchors it (real data + a percentile
    // formula); ASSUMED when it falls to the static sector table, which has
    // no anchor beyond this app's own directional judgment.
    results.pe = { value: r.eps * targetPe, note, tier: peBand ? TIER.DERIVED : TIER.ASSUMED }
  }

  // ── EV/EBITDA ── real peer median first, sector-median table otherwise —
  // same two-tier shape as the P/B block below. Peer EV/EBITDA used to be
  // unfetchable at all (Yahoo's batched quote() call doesn't carry it), but
  // peersClient.js's enrichFromCache() now supplies it for free whenever a
  // peer ticker has already been analyzed in this app (its full financials
  // are already in this browser's IndexedDB from that analysis) ───────────
  if (isApplicable('evEbitda', modelMeta) && r.ebitda > 0 && r.shares && r.totalDebt != null) {
    const evEbBand = peerBand(peers, 'evEbitda')
    const targetEvEb = evEbBand?.median ?? sectorEvEb
    const impliedEV = r.ebitda * targetEvEb
    const impliedEq = impliedEV + r.cash - r.totalDebt
    const perShare  = impliedEq / r.shares
    if (perShare > 0) {
      const note = evEbBand
        ? `EBITDA × peer median ${targetEvEb.toFixed(1)}× EV/EBITDA (${evEbBand.count} peers)`
        : `EBITDA × ${targetEvEb.toFixed(1)}× sector median EV/EBITDA`
      results.evEbitda = { value: perShare, note, tier: evEbBand ? TIER.DERIVED : TIER.ASSUMED }
    }
  }

  // ── P/B ── ROE-derived target multiple ────────────────────────────────────────
  const actualPb = r.ratios?.pb?.value
  const pbDistorted = detectBookValueDistortion(data, actualPb)
  const isFinancialSector = ['insurance', 'bank', 'nbfc'].includes(sectorType)
  const roe = activeValue(
    latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic)),
    'roe', data?.basis
  )?.value
  // No fabricated 12%-ROE stand-in: a target multiple built on a number
  // nobody measured isn't "conservative," it's a guess wearing this
  // company's row. Financials use a sector-median multiple (not circular,
  // since it isn't derived from the stock's own price); everyone else needs
  // a REAL measured ROE or the row simply doesn't exist.
  if (isApplicable('pb', modelMeta) && r.bookPerShare > 0 && !pbDistorted &&
      (isFinancialSector || roe > 0)) {
    const pbBand = peerBand(peers, 'pb')
    let targetPb = null, pbNote = null
    let pbTier = TIER.DERIVED
    if (pbBand) {
      targetPb = pbBand.median
      pbNote = `Book x ${targetPb.toFixed(1)}x (peer median PB, ${pbBand.count} peers)`
    } else if (isFinancialSector) {
      targetPb = financialPb(sectorType)
      pbNote = `Book x ${targetPb.toFixed(1)}x (sector median PB)`
      // financialPb() is a flat asserted number per sector type (bank/nbfc/
      // insurance) — same category as the sector tables, no external anchor.
      pbTier = TIER.ASSUMED
    }
    // No peer data and not a financial sector: P/B simply doesn't compute
    // here, same as any other model whose real inputs aren't available. This
    // used to fall back to justifiedMultiple.js's CAPM/ROE-derived form —
    // but that number is a genuinely different (intrinsic, fundamentals-
    // derived) method than what EXTRINSIC_MODELS below is supposed to mean:
    // relative valuation against real peers or a sector benchmark. Folding
    // it in here let a non-relative number quietly win "Fair Value (relative)"
    // and duplicated a figure already shown correctly, under its own label,
    // in the Justified Multiples panel.
    if (targetPb != null) {
      results.pb = { value: r.bookPerShare * targetPb, note: pbNote, tier: pbTier }
    }
  }

  // ── P/S ── real peer median EV/Revenue first, sector-median EV/Sales
  // table otherwise — same fix as EV/EBITDA above, same peersClient.js
  // cache-derived source (enrichFromCache's evRevenue field). ─────────────
  // No netMargin gate: P/S is weighted specifically for PRE_REVENUE/GROWTH
  // stages (stage.js) precisely because those companies' earnings aren't
  // usable yet — gating this model on positive margin would disqualify the
  // exact companies it exists to serve.
  if (isApplicable('ps', modelMeta) && r.revenue > 0 && r.shares && r.totalDebt != null) {
    const psBand = peerBand(peers, 'evRevenue')
    const targetPs = psBand?.median ?? sectorPs
    const impliedEV = r.revenue * targetPs
    const impliedEq = impliedEV + r.cash - r.totalDebt
    const perShare  = impliedEq / r.shares
    if (perShare > 0) {
      const note = psBand
        ? `Revenue × peer median ${targetPs.toFixed(1)}× EV/Sales (${psBand.count} peers)`
        : `Revenue × ${targetPs.toFixed(1)}× sector median EV/Sales`
      results.ps = { value: perShare, note, tier: psBand ? TIER.DERIVED : TIER.ASSUMED }
    }
  }

  // ── Graham Number ─────────────────────────────────────────────────────────────
  // Skip Graham for asset-light/high-PB companies — distorted book value breaks it
  if (isApplicable('graham', modelMeta) && r.grahamNumber > 0 && !pbDistorted) {
    // DERIVED — 22.5 is Graham's own published constant, not this app's
    // guess, applied to real EPS/book value.
    results.graham = { value: r.grahamNumber, note: 'sqrt(22.5 x EPS x Book Value per Share)', tier: TIER.DERIVED }
  }

  // ── PEG (growth-stage only; gated by stage.js applicable list) ──────────────
  if (isApplicable('peg', modelMeta) && r.eps > 0) {
    const peg = computePeg(r, data, {
      forwardGrowthPct: assumptions.forwardGrowthPct ?? null,
      mode: assumptions.pegMode || 'blend',
    })
    if (peg.applicable && peg.fairValue > 0) {
      // DERIVED — Lynch's "fair P/E ≈ growth rate" is a named, universal
      // heuristic, not an app-invented number, applied to real EPS/growth.
      results.peg = { value: peg.fairValue, note: peg.note, meta: peg, tier: TIER.DERIVED }
    }
  }

    // ── Applicable models & primary selection ─────────────────────────────────────
  // Fair Value now means one specific thing: relative valuation against peers/
  // sector — P/E, P/B, EV/EBITDA, P/S. DCF and Graham are genuinely different
  // methods (cash-flow discounting; a fixed heuristic ceiling) that used to
  // compete in the SAME weighted race and could silently win it — for an
  // ESTABLISHED company DCF (weight 3) usually beat every peer/sector model,
  // so "Fair Value" was frequently just DCF wearing a different label, and the
  // two were impossible to tell apart from the headline number alone. They're
  // surfaced as their own separate headline figures instead (intrinsicValue,
  // secondaryChecks below) — never blended into this number or its range.
  const EXTRINSIC_MODELS = ['pe', 'pb', 'evEbitda', 'ps']
  // No weighted blend even within the extrinsic group: averaging models that
  // disagree by era (a turnaround's EV/EBITDA vs its pre-turnaround revenue
  // multiples) produces a number no model supports. Fair value is the
  // PRIMARY model — the highest-weighted extrinsic one for this stage/sector
  // among those with valid inputs (see byWeightDesc below) — with the others
  // shown as a range for context. A reliability gate drops models whose
  // inputs are meaningless for this stock.
  const netMargin = activeValue(
    latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic)),
    'netMargin', data?.basis
  )?.value
  const inputValid = (m) => {
    if ((m === 'pe' || m === 'graham' || m === 'peg') && !(netMargin > 0)) return false
    // Financial-sector P/B uses a fixed sector-median multiple, not an
    // ROE-derived one (see the P/B block above), so it isn't gated on ROE.
    if (m === 'pb' && !isFinancialSector && !(roe > 0)) return false
    return true
  }
  const validKeys = modelMeta.applicable.filter(m =>
    EXTRINSIC_MODELS.includes(m) && results[m]?.value > 0 && inputValid(m))

  const MODEL_NAMES = {
    dcf: 'DCF', pe: 'P/E', evEbitda: 'EV/EBITDA', pb: 'P/B',
    ps: 'P/S', graham: 'Graham', peg: 'PEG',
  }

  // Primary = the highest-WEIGHTED extrinsic model among the ones that
  // actually have valid inputs for this ticker — modelMeta.weights is the
  // stage/sector domain judgement of which model to trust most; ranking by
  // it, rather than by array position in `applicable`, is what makes this
  // "the most appropriate PEER/SECTOR model for the ticker" rather than an
  // accident of how the list happened to be typed. That accident was real:
  // GROWTH and TRANSITION both list `ps` (weight 1) before `peg` (weight 1.5)
  // in `applicable`, so array-order selection once picked the LOWER-weighted
  // model whenever both were valid — weighting fixed that, and restricting
  // the pool to EXTRINSIC_MODELS here is the separate, later fix that stops
  // an intrinsic model (peg, or previously dcf) from winning this race at all.
  // Filtering to validKeys first, then ranking, is also the cascade for a
  // missing result: if the top-weighted model's inputs aren't there, it's
  // simply not in validKeys, and the next-highest-weighted valid one wins —
  // never a hole where the highest-weighted model failed to compute.
  const byWeightDesc = (a, b) => (modelMeta.weights?.[b] ?? 0) - (modelMeta.weights?.[a] ?? 0)
  const rankedKeys   = [...validKeys].sort(byWeightDesc)
  const primaryKey   = rankedKeys[0] || null
  const primaryModel = primaryKey
    ? { key: primaryKey, name: MODEL_NAMES[primaryKey] || primaryKey, value: results[primaryKey].value }
    : null
  const fairValue = primaryModel?.value ?? null

  // Range across valid EXTRINSIC models only — context only, shown in
  // details. Was previously across every applicable model including DCF/
  // Graham, which meant "Fair Value's range" silently mixed a cash-flow
  // model and a heuristic ceiling into what was supposed to be a peer/sector
  // comparison range.
  const modelValues = validKeys.map(m => results[m].value)
  const rangeLow    = modelValues.length > 1 ? Math.min(...modelValues) : fairValue
  const rangeHigh   = modelValues.length > 1 ? Math.max(...modelValues) : fairValue

  // ── Intrinsic Value (DCF) & secondary heuristic checks (Graham, PEG) ──────────
  // Own headline figures, never folded into Fair Value's primary/range above.
  // DCF is the rigorous cash-flow-discounting method; Graham/PEG are simple,
  // no-required-return heuristic formulas (a fixed sanity ceiling; "fair P/E
  // = growth rate") — shown as supporting checks, not peers of DCF's rigor.
  const intrinsicValue = results.dcf
    ? { key: 'dcf', name: 'DCF', value: results.dcf.value, note: results.dcf.note, tier: results.dcf.tier }
    : null
  const secondaryChecks = {
    graham: results.graham ? { value: results.graham.value, note: results.graham.note, tier: results.graham.tier } : null,
    peg:    results.peg    ? { value: results.peg.value,    note: results.peg.note,    tier: results.peg.tier }    : null,
  }

  // Signal from the primary model's value vs CMP. Deadband scaled to how much
  // the valid extrinsic models actually disagree for THIS stock (rangeHigh vs
  // rangeLow) rather than a flat percentage assumed to fit every company
  // alike — a ±2% band sat inside the ordinary noise of any relative-
  // valuation estimate (WACC, multiple selection and model choice each
  // individually carry more uncertainty than that), so the label was
  // flipping on routine price moves, not on anything the model was actually
  // confident about. Floored at 10% — a disclosed, conservative minimum,
  // not a measurement — for the single-model case (rangeLow == rangeHigh),
  // where there's nothing of this company's own to derive a wider band from;
  // never goes narrower than that even when models happen to agree tightly.
  const modelSpreadPct = (fairValue > 0 && rangeHigh != null && rangeLow != null)
    ? ((rangeHigh - rangeLow) / fairValue) / 2 : null
  const deadband = Math.max(0.10, modelSpreadPct ?? 0)
  const upside = fairValue != null && r.price > 0 ? ((fairValue - r.price) / r.price) * 100 : null
  const signal = (fairValue == null || r.price <= 0) ? 'UNKNOWN'
    : r.price < fairValue * (1 - deadband) ? 'UNDERVALUED'
    : r.price > fairValue * (1 + deadband) ? 'OVERVALUED'
    : 'FAIRLY_VALUED'

  // ── Reverse DCF ───────────────────────────────────────────────────────────────
  const impliedGrowth = reverseDcfGrowth(r, data, { wacc, termGrowth, projYears })

    return {
    models: results,
    modelMeta,
    fairValue,
    primaryModel,
    rangeLow,
    rangeHigh,
    upside,
    signal,
    intrinsicValue,
    secondaryChecks,
    impliedGrowth,
    assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb, sectorPs },
    defaults: { wacc: waccDefault, termGrowth: TERMINAL_GROWTH_BY_MARKET[market] ?? TERMINAL_GROWTH_BY_MARKET.IN, projYears: 10, growthRate: growthResult.growth, sectorPe: sectorPeDefault, sectorEvEb: sectorEvEbDefault, sectorPs: sectorPsDefault }
  }
}

function isApplicable(m, meta) { return meta.applicable.includes(m) || meta.caution.includes(m) }

// Book value going "meaningless" (the reason P/B and Graham get skipped) is a
// real, specific mechanism — heavy buybacks or dividends returning more to
// shareholders than the business retains, so book shrinks even while the
// business earns well. This tests that mechanism directly: has the company
// been profitable in every year of available history while book-per-share
// still failed to grow? A snapshot "P/B > 10" (the previous check) can't
// tell a stock the market richly (but legitimately) prices from one whose
// book value has actually been hollowed out by capital returns — it would
// exclude a genuine high-ROE, high-growth compounder for the same reason it
// correctly excludes an Apple-style buyback story, just because both trade
// above 10x book.
//
// Falls back to the old snapshot threshold only when there isn't enough
// balance-sheet history (fewer than 3 usable years) to measure the real
// trend — a weaker signal, but better than skipping the check outright.
function detectBookValueDistortion(data, actualPb) {
  const yearOf = row => {
    const m = String(row?.year ?? '').match(/(?:19|20)\d{2}/)
    return m ? Number(m[0]) : null
  }
  const bal = (data?.balanceHistory || []).filter(row => !row?.synthetic)
  const inc = (data?.reportedIncomeHistory || []).filter(row => !row?.synthetic)

  const points = []
  for (const bRow of bal) {
    const y = yearOf(bRow)
    const eq = activeValue(bRow, 'totalEquity', data?.basis)?.value
    if (y == null || !(eq > 0)) continue
    const iRow = inc.find(row => yearOf(row) === y)
    const np  = activeValue(iRow, 'netProfit', data?.basis)?.value
    const eps = activeValue(iRow, 'eps', data?.basis)?.value
    const shares = (np > 0 && eps > 0) ? np / eps : null
    if (!(shares > 0)) continue
    points.push({ year: y, bps: eq / shares, netProfit: np })
  }
  points.sort((a, b) => a.year - b.year)

  const FALLBACK_PB_THRESHOLD = 10
  if (points.length < 3) return actualPb != null && actualPb > FALLBACK_PB_THRESHOLD

  const allProfitable = points.every(p => p.netProfit > 0)
  const bookShrank = points[points.length - 1].bps < points[0].bps
  return allProfitable && bookShrank
}

// Company-specific WACC via CAPM, the professional standard (vs a flat rate):
//   Cost of equity  Ke = riskFree + beta × equityRiskPremium   (see requiredReturn.js)
//   Cost of debt    Kd = interest / totalDebt  (after-tax: × (1 − taxRate))
//   WACC = E/(E+D)·Ke + D/(E+D)·Kd·(1−tax)      with E = market cap, D = total debt
//
// riskFree resolves through THREE tiers, always landing on a usable number —
// Fair Value is a core, always-on feature and must never go blank for lack of
// a configured AI key: liveRiskFree (shared with justifiedMultiple.js, when
// Phase 8's plumbing supplies it) → DEFAULT_RISK_FREE_BY_MARKET → 0.07. ERP
// comes from the same shared ERP_BY_MARKET justifiedMultiple.js now uses —
// this used to be a second, independently-hardcoded 5.5% here vs 6.5% there,
// silently disagreeing for no stated reason.
//
// taxRate: statutory corporate rate by market, not a flat guess applied to
// both alike. India: 22% base + 10% surcharge + 4% cess = 25.17% effective
// under Section 115BAA, the regime most large listed companies have adopted.
// US: 21% flat federal rate (Tax Cuts and Jobs Act, 2017) — state tax varies
// 0-11% and isn't modelled, a documented simplification rather than a silent
// one.
const TAX_RATE_BY_MARKET = { IN: 0.2517, US: 0.21 }

// No output clamp. WACC/Ke is shown exactly as CAPM computes it from real
// inputs (risk-free, beta, ERP, measured cost of debt) — a clamp here would
// silently overwrite a real, formula-derived number with a boundary value
// whenever a genuinely high-beta stock (or an unusual rate environment)
// pushed it past a band this app asserted. Checked against this app's own
// live sanity bounds on Rf/ERP (api/riskfree.js, api/erp.js): a high-beta
// Indian stock in an elevated-rate environment can legitimately compute
// Ke above 50%; a low-beta US stock in a near-zero-rate environment can
// legitimately fall under 2%. Both are real CAPM outputs from in-bounds
// inputs, not broken data — clamping either would replace a real number
// with a guess. The one thing that CAN make this number worth a second
// look — an unusual beta reading — is surfaced via betaFlag (see
// requiredReturn.js) without altering the computed value.
export function computeWacc(r, data, { liveRiskFree = null, market = 'IN', erp = null, taxRate = null, beta = null, betaMeta = null } = {}) {
  const riskFree = liveRiskFree ?? DEFAULT_RISK_FREE_BY_MARKET[market] ?? DEFAULT_RISK_FREE_BY_MARKET.IN
  const tax = taxRate ?? TAX_RATE_BY_MARKET[market] ?? TAX_RATE_BY_MARKET.IN
  // `beta` here is this app's own regression (AppContext's SET_LIVE_BETA,
  // threaded via assumptions.beta) — Yahoo's reported figure is the
  // fallback ONLY, used when the regression hasn't resolved or declined
  // for lack of overlapping history. See requiredReturn.js.
  const resolvedBeta = (beta != null && beta > 0) ? beta
    : (r?.ratios?.beta?.value != null && r.ratios.beta.value > 0) ? r.ratios.beta.value : 1.0
  // E (market cap) has no table-native home — it's live-price-dependent,
  // stays sourced from the snapshot. D/interest are both table-native
  // (formulas.js/reported income), read directly off the latest real row.
  const E = r?.marketCap > 0 ? r.marketCap : null
  const incRow = latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic))
  const balRow = latestRealRow((data?.balanceHistory || []).filter(x => !x.synthetic))
  const totalDebt = activeValue(balRow, 'totalDebt', data?.basis)?.value
  const interest = activeValue(incRow, 'interest', data?.basis)?.value
  const D = totalDebt > 0 ? totalDebt : 0
  const capm = capmCostOfEquity({ riskFreeRate: riskFree, beta: resolvedBeta, erp, market, betaMeta })
  const ke = capm.r
  const betaFlag = capm.betaFlag
  if (E == null) return { wacc: ke, betaFlag }          // no market cap → all-equity proxy
  // Cost of debt has to be MEASURED (interest / debt) — a flat 9% dressed up
  // as this company's WACC was the same "invented figure feeding a fair
  // value" problem the DCF section below already refuses for FCF/CapEx.
  // D == 0 means debt carries no weight in WACC at all, so kd is moot there.
  // No clamp here either, same reasoning as the WACC output above — real
  // distressed or subsidised debt legitimately sits outside any flat band.
  let kd = 0
  if (D > 0) {
    if (!(interest > 0)) return { wacc: null, betaFlag }      // real debt, no way to measure its cost
    kd = interest / D
  }
  const V = E + D
  const wacc = (E / V) * ke + (D / V) * kd * (1 - tax)
  return { wacc, betaFlag }
}


// Build the "market implies X% vs your view Y%" insight for the combined verdict.
// Prefers the real reverse-DCF (valuation.impliedGrowth). If that can't resolve
// (e.g. no positive cash flow), falls back to the stage-appropriate Market
// Expectation variant (earnings-based, else sales-based) and LABELS the basis.
// "Your view" = user guidance if given, else the growth the DCF is currently
// using (scenario/model). Returns null when nothing resolves → caller hides it.
// Shared "which market-expectation variant is primary" — used by BOTH the pillar
// and the boilerplate insight so they always show the SAME number. Stage-ordered:
// growth/pre-revenue → sales first; else earnings first.
export function primaryExpectation(marketExpectation, stage) {
  const V = marketExpectation?.variants
  if (!V) return null
  const order = (stage === 'GROWTH' || stage === 'PRE_REVENUE')
    ? ['sales', 'fcf', 'earnings'] : ['earnings', 'fcf', 'sales']
  const key = order.find(k => V[k]?.applicable && V[k].impliedGrowth != null)
  return key ? { key, ...V[key] } : null
}

export function expectationInsight(valuation, marketExpectation, ratioResult = null, stage = null, guidedGrowthPct = null) {
  if (!valuation) return null
  const rdcf   = valuation.impliedGrowth
  const price  = ratioResult?.price
  const g      = ratioResult?.ratios || {}

  // Headline number = the SAME variant the Market Expectation pillar shows.
  const prim = primaryExpectation(marketExpectation, stage)
  let implied = null, basis = null
  if (prim) { implied = prim.impliedGrowth; basis = prim.key }        // 'sales' | 'earnings' | 'fcf'
  else if (rdcf != null) { implied = rdcf; basis = 'reverse-DCF' }
  if (implied == null) return null

  // Recent actual growth to compare against (basis-appropriate). npCagr, not
  // npGrowthYoY — the latter is a single year's change and was rendering as
  // "Historical earnings CAGR" even though it wasn't a CAGR and didn't move
  // when the growth-window slider did.
  const recent = (basis === 'earnings') ? g.npCagr?.value
                                        : (g.revCagr?.value)
  const recentLabel = (basis === 'earnings') ? 'earnings' : 'sales'
  const basisLabel  = basis === 'reverse-DCF' ? ' (reverse-DCF)' : ` (${basis}-based)`

  let story = ''
  if (implied < 0) {
    story = ` — the price implies the business will shrink about ${Math.abs(implied).toFixed(0)}% a year, so the market is pricing in decline`
      + (recent != null ? `, far more pessimistic than its recent ~${recent.toFixed(0)}% ${recentLabel} growth` : '')
  } else if (recent != null) {
    const d = implied - recent
    story = d >= 3
      ? ` — well above the company's recent ~${recent.toFixed(0)}% ${recentLabel} growth, so the market expects growth to accelerate`
      : d <= -3
      ? ` — below the company's recent ~${recent.toFixed(0)}% ${recentLabel} growth, so the market expects growth to slow from the recent pace`
      : ` — roughly in line with its recent ~${recent.toFixed(0)}% ${recentLabel} growth, so growth expectations look fairly priced`
  }
  let text = `The market is pricing in ~${implied.toFixed(1)}% growth${basisLabel}${story}.`

  const gap = (guidedGrowthPct != null ? guidedGrowthPct : recent) != null
    ? (guidedGrowthPct != null ? guidedGrowthPct : recent) - implied : null
  if (guidedGrowthPct != null) {
    const gd = guidedGrowthPct - implied
    const rel = Math.abs(gd) < 1 ? 'in line with' : gd > 0 ? `${gd.toFixed(0)} pts above` : `${Math.abs(gd).toFixed(0)} pts below`
    text += ` Your guided view of ~${guidedGrowthPct.toFixed(0)}% is ${rel} that.`
  }
  const yourView = guidedGrowthPct != null ? guidedGrowthPct : recent
  const viewLabel = guidedGrowthPct != null ? 'your view' : `recent ${recentLabel} growth`

  // Secondary: note the cash-flow (reverse-DCF) reading when it differs and is
  // available — neutral, no interpretation. Omitted if it didn't resolve.
  let bases = null
  if (basis !== 'reverse-DCF' && rdcf != null && Math.abs(rdcf - implied) >= 10) {
    bases = `On a cash-flow (reverse-DCF) basis the implied figure is ~${rdcf.toFixed(0)}%, versus ~${implied.toFixed(0)}% on ${basis === 'earnings' ? 'earnings' : 'sales'} — the two methods differ.`
  }

  return { implied, basis, yourView, viewLabel, gap, text, bases }
}

function estimateGrowth(data) {
  const incRow = latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic))
  // The table's own toggle-conscious growth reading — full-period CAGR
  // (reported) or the selected method (normalized), same figure every
  // consumer uses. No revCagr means no growth rate, not a flat 8% dressed
  // up as one. Callers (DCF, reverse-DCF) decline rather than substitute
  // when this comes back null.
  const cagr = tableGrowthRate(data, 'revenueGrowth', data?.basis).value
  if (cagr == null) return { growth: null, unusual: false, sustainable: null, aboveSustainable: false }
  const g = cagr / 100

  // A rate outside this range is unusual — likely a recovery from a
  // collapsed base or a one-off — but it's real, measured data, not a
  // reason to hide it. Used as-is and flagged (see the DCF caveats this
  // feeds), not discarded: this used to decline outright here, which meant
  // a company with a genuine severe decline (or a genuine outsized
  // recovery) got no DCF at all rather than a real number with a caveat
  // attached. Before that, it was clamp(g, 0.02, 0.20) — a FLOOR that
  // substituted +2% for any decline, including a real, measured one. Both
  // were the same mistake in different directions: swapping a real number
  // for one this function preferred instead of showing what was measured.
  const unusual = g < -0.3 || g > 0.6

  // Sustainable growth — ROE x retention, the standard corporate-finance
  // measure of how fast a company can grow funding itself without raising
  // fresh capital — is surfaced as a flagged comparison, not used to cap
  // the returned growth rate. A company genuinely growing faster than this
  // is really growing that fast; whether it can keep funding that by
  // raising capital or leverage is a separate question from what the
  // measured rate is. Silently substituting the lower, "sustainable"
  // figure whenever it undercut the real one was the same fabricated-
  // number problem as the +2% floor above — just conservative instead of
  // optimistic, which doesn't make it not a substitution.
  //
  // No reported payout -> treated as retaining everything, the same
  // convention justifiedMultiple.js's sustainableGrowth() already uses.
  // When ROE isn't positive (missing data, or a currently loss-making
  // company) there's no earnings-funded capacity to compare against, so no
  // comparison is made — never a fabricated substitute for "we don't know."
  const roe = activeValue(incRow, 'roe', data?.basis)?.value
  const payoutPct = activeValue(incRow, 'dividendPayout', data?.basis)?.value
  const retention = (payoutPct != null && payoutPct >= 0 && payoutPct <= 100)
    ? 1 - payoutPct / 100 : 1
  const sustainable = (roe > 0) ? (roe / 100) * retention : null
  const aboveSustainable = sustainable != null && g > sustainable

  return { growth: g, unusual, sustainable, aboveSustainable }
}

/**
 * The multi-year DCF, built by re-running the earnings waterfall's own
 * OUTPUT for every projection year, instead of compounding one starting
 * FCFF figure by a single growth rate. The driver PERCENTAGES (EBITDA
 * margin, D&A/revenue, net-interest/revenue, other income, tax rate,
 * capex/revenue, NWC/revenue) come from the waterfall's own historical
 * normalization ONCE and are held constant across every year — only
 * revenue growth changes year to year, fading linearly from year 1's
 * measured rate toward mature/terminal growth by year 5, then flat — same
 * "forecast the driver, not the derived output" discipline the one-year
 * waterfall already uses.
 *
 * Returns null when there's no margin history to build a waterfall from at
 * all — the caller falls back to the older single-FCFF-compounded-by-one-
 * rate DCF unchanged, exactly as if this function didn't exist.
 */
function waterfallDcfEV(data, wacc, tg, yrs, ntGrowth = null, ntYears = 0, matureFadeYears = 5) {
  const w0 = buildWaterfallForecast(data, {})
  if (!w0) return null

  const basis = data?.basis
  const latestInc = latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic))
  const revenue0 = activeValue(latestInc, 'revenue', basis)?.value
  const latestBal = latestRealRow((data?.balanceHistory || []).filter(x => !x.synthetic))
  const nwc0 = activeValue(latestBal, 'nwc', basis)?.value ?? 0
  if (!(revenue0 > 0)) return null

  const d = w0.drivers
  const ebitdaMargin = d.ebitdaMarginPct / 100
  const daRatio      = d.daToRevenuePct != null ? d.daToRevenuePct / 100 : 0
  const interestRatio = d.netInterestToRevenuePct != null ? d.netInterestToRevenuePct / 100 : 0
  const otherIncomeRatio = (d.otherIncomeToRevenuePct || 0) / 100
  const taxRate = d.taxRatePct / 100
  const capexRatio = d.capexToRevenuePct != null ? d.capexToRevenuePct / 100 : 0
  const nwcRatio = d.nwcToRevenuePct != null ? d.nwcToRevenuePct / 100 : null
  // Year 1's own measured growth — the same figure the one-year waterfall
  // used, unless an explicit near-term (guidance) rate overrides it.
  const g1 = ntYears > 0 ? ntGrowth : (w0.drivers.growthPct / 100)

  let revenue = revenue0, nwc = nwc0
  let pv = 0, lastFcff = null
  for (let t = 1; t <= yrs; t++) {
    let gt
    if (ntYears > 0 && t <= ntYears) {
      gt = ntGrowth
    } else {
      const fadeStart = ntYears > 0 ? ntGrowth : g1
      const step = ntYears > 0 ? (t - ntYears) : (t - 1)
      const totalFadeYears = Math.max(1, Math.min(matureFadeYears, yrs) - ntYears)
      gt = totalFadeYears > 1
        ? fadeStart - (fadeStart - tg) * Math.min(1, step / (totalFadeYears - 1))
        : tg
    }
    revenue = revenue * (1 + gt)
    const ebitda = revenue * ebitdaMargin
    const da = revenue * daRatio
    const ebit = ebitda - da
    const netInterest = revenue * interestRatio
    const otherIncome = revenue * otherIncomeRatio
    const pbt = ebit - netInterest + otherIncome
    const tax = pbt > 0 ? pbt * taxRate : 0
    const capex = revenue * capexRatio
    const nwcNow = nwcRatio != null ? revenue * nwcRatio : nwc
    const deltaNwc = nwcNow - nwc
    nwc = nwcNow
    const fcff = ebit * (1 - taxRate) + da - capex - deltaNwc
    lastFcff = fcff
    pv += fcff / Math.pow(1 + wacc, t)
  }
  if (lastFcff == null) return null
  const terminalValue = (lastFcff * (1 + tg)) / (wacc - tg) / Math.pow(1 + wacc, yrs)
  return pv + terminalValue
}

// Enterprise PV → equity value per share, with a growth fade toward terminal.
function dcfPerShare(cfBase, g, wacc, tg, yrs, cash, debt, shares, ntGrowth = null, ntYears = 0) {
  // cash/debt are never null now — ratios.js assumes nil cash and flags it, so the
  // bridge always runs. The flag rides along on r.bsEstimated and the note below.
  if (!(cfBase > 0) || !(shares > 0)) return null
  if (wacc == null || wacc <= tg) return null
  if (cash == null || debt == null) return null
  // No measured base growth rate AND no user-set near-term (guidance) window
  // to fade from instead — there's nothing real to project the cash flow on.
  if (ntYears === 0 && g == null) return null
  const ev = dcfEV(cfBase, g, wacc, tg, yrs, ntGrowth, ntYears)
  const ps = (ev + cash - debt) / shares
  return ps > 0 ? ps : null
}

/**
 * What growth rate would the DCF need to assume for its output to land
 * exactly on today's market price? Exported so marketExpectation.js can
 * present this as its own fourth variant (the DCF fade-to-terminal-growth
 * convention, alongside its other three variants' flat-growth-then-exit-
 * multiple convention) — runValuation()'s own impliedGrowth is just a call
 * to this, same output as before.
 */
export function reverseDcfGrowth(r, data, { wacc, termGrowth, projYears = 10 } = {}) {
  // Same FCFF rule as the forward DCF above.
  const latestIncRev = latestRealRow((data?.reportedIncomeHistory || []).filter(x => !x.synthetic))
  const fcffRevValue = activeValue(latestIncRev, 'fcff', data?.basis)?.value
  const cfForRev = fcffRevValue > 0 ? fcffRevValue : null
  // wacc discounts every cash flow in the solve below — a null wacc silently
  // coerces to 0 in arithmetic (no discounting at all), which would return a
  // confidently wrong implied growth rather than none. Requires a real WACC.
  if (!(cfForRev && r.price > 0 && r.shares && r.totalDebt != null && wacc != null)) return null
  const targetEV = r.price * r.shares + r.totalDebt - r.cash
  return solveGrowth(cfForRev, targetEV, wacc, termGrowth, projYears)
}

function solveGrowth(fcf0, tEV, wacc, tg, yrs) {
  const LO = -0.9, HI = 3.0        // wide bounds: let the maths return the real rate
  let lo = LO, hi = HI
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const ev  = dcfEV(fcf0, mid, wacc, tg, yrs)
    if (Math.abs(ev - tEV) < 1e5) break
    ev > tEV ? (hi = mid) : (lo = mid)
  }
  const g = (lo + hi) / 2
  // If it pins to a bound it didn't really converge — inputs are degenerate
  // (e.g. FCF too thin to justify the price at any sane rate). Return null so the
  // packager simply omits it rather than reporting a floored/absurd number.
  if (g <= LO + 0.01 || g >= HI - 0.01) return null
  return g * 100
}

// H-model linear fade (Fuller & Hsia, 1984, Financial Analysts Journal —
// standard CFA-curriculum practice): growth declines by a constant AMOUNT
// each year from the starting rate to the terminal rate, reaching it exactly
// by the last projection year — not an arbitrary geometric decay. This
// replaces a bare `Math.pow(0.85, step)` (15%/yr compounding decay) that had
// no stated derivation anywhere and, being geometric rather than linear,
// asymptotically approached the terminal rate rather than reaching it
// smoothly by design, relying on a floor (Math.max(..., tg)) to force the
// last mile rather than arriving there on its own.
function dcfEV(f, g, w, tg, yrs, ntGrowth = null, ntYears = 0) {
  let pv = 0, cf = f
  for (let i = 1; i <= yrs; i++) {
    let gi
    if (ntYears > 0 && i <= ntYears) {
      gi = ntGrowth                                   // explicit near-term (guidance) window
    } else {
      const fadeStart     = ntYears > 0 ? ntGrowth : g    // fade from the near-term rate, else base
      const step          = ntYears > 0 ? (i - ntYears) : (i - 1)
      const totalFadeYears = yrs - ntYears
      // step runs 0..totalFadeYears-1; linearly interpolate so the LAST
      // projection year lands exactly on tg, matching the terminal-value
      // formula's own assumption that growth is tg from year yrs+1 onward —
      // a smooth handoff instead of a floor forcing a late, sudden jump.
      gi = totalFadeYears > 1
        ? fadeStart - (fadeStart - tg) * (step / (totalFadeYears - 1))
        : tg
    }
    cf *= (1 + gi)
    pv += cf / Math.pow(1 + w, i)
  }
  return pv + (cf * (1 + tg)) / (w - tg) / Math.pow(1 + w, yrs)
}
