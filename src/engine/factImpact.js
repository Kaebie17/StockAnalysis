/**
 * src/engine/factImpact.js — turn an announcement into a lever change.
 *
 * The alternative design was a box asking "revise growth to what?", which quietly
 * requires the user to have already done this arithmetic in their head. Most
 * people would type a round number that felt about right, and the estimate — the
 * one figure in the app built to be accountable — would end up resting on a
 * guess indistinguishable from a calculation.
 *
 * So the app asks for FACTS ("₹500 Cr order over 3 years") and does the maths,
 * showing every step. The user supplies what was announced; they never type a
 * growth rate or a multiple.
 *
 * Each fact type declares its inputs and a compute() that returns the lever it
 * moves, the before/after, and the working. Anything it can't compute returns a
 * reason instead of a number — a fact type that silently guesses would defeat
 * the point of asking for facts at all.
 */

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const pct = (v, d = 1) => (v == null || !isFinite(v) ? null : +(v * 100).toFixed(d))

/**
 * @param ctx {
 *   revenue, netProfit, totalAssets, cogs,   // absolute, current
 *   growth, margin,                          // decimals, currently in force
 *   nim,                                     // % — lenders only
 *   currency, sectorType
 * }
 */
export const FACT_TYPES = [
  {
    id: 'contract',
    label: 'Order / contract',
    lever: 'growth',
    hint: 'A won or lost order with a stated value.',
    fields: [
      { key: 'value', label: 'Contract value', unit: 'money', required: true },
      { key: 'years', label: 'Delivered over', unit: 'years', required: true, default: 1 },
      { key: 'direction', label: 'Won or lost', unit: 'choice',
        options: [['won', 'Won'], ['lost', 'Lost']], default: 'won' },
      { key: 'incremental', label: 'New business, or replacing existing?', unit: 'choice',
        options: [['new', 'New'], ['replacing', 'Replacing']], default: 'new' },
    ],
    compute(f, ctx) {
      if (!(ctx.revenue > 0)) return fail('No revenue figure to size this against.')
      if (!(f.value > 0)) return fail('Enter the contract value.')
      // Replacing existing business adds nothing to the top line — the common
      // way a headline number overstates its own impact.
      if (f.incremental === 'replacing') {
        return note('Replaces existing business — no change to the revenue path.')
      }
      const years = Math.max(1, +f.years || 1)
      const annual = (+f.value) / years
      const sign = f.direction === 'lost' ? -1 : 1
      const delta = (sign * annual) / ctx.revenue
      return apply('growth', ctx.growth, ctx.growth + delta, [
        `${money(f.value, ctx)} over ${years} yr → ${money(annual, ctx)}/yr`,
        `on revenue of ${money(ctx.revenue, ctx)} → ${sign > 0 ? '+' : ''}${pct(delta)}% to growth`,
      ])
    },
  },

  {
    id: 'capacity',
    label: 'Capacity expansion',
    lever: 'growth',
    hint: 'New plant, branches or lines coming online.',
    fields: [
      { key: 'addedPct', label: 'Capacity added', unit: 'percent', required: true },
      { key: 'utilisation', label: 'Expected utilisation of it', unit: 'percent', default: 75 },
      { key: 'years', label: 'Ramped over', unit: 'years', default: 2 },
    ],
    compute(f, ctx) {
      if (!(f.addedPct > 0)) return fail('Enter the capacity added.')
      const years = Math.max(1, +f.years || 1)
      const util = (+f.utilisation || 100) / 100
      // Capacity is not revenue: a plant at 75% utilisation delivers 75% of its
      // nameplate, and it arrives spread over the ramp rather than all at once.
      const totalLift = (+f.addedPct / 100) * util
      const perYear = totalLift / years
      return apply('growth', ctx.growth, ctx.growth + perYear, [
        `+${f.addedPct}% capacity at ${f.utilisation || 100}% utilisation → +${pct(totalLift)}% revenue`,
        `spread over ${years} yr → +${pct(perYear)}%/yr to growth`,
      ])
    },
  },

  {
    id: 'segment_loss',
    label: 'Segment banned / exited',
    lever: 'growth',
    hint: 'A business line stopping — regulatory ban, exit, licence loss.',
    fields: [
      { key: 'segmentPct', label: 'That segment as % of revenue', unit: 'percent', required: true },
      { key: 'retained', label: 'Portion you expect to keep', unit: 'percent', default: 0 },
    ],
    compute(f, ctx) {
      if (!(f.segmentPct > 0)) return fail("Enter the segment's share of revenue.")
      const lost = (+f.segmentPct / 100) * (1 - (+f.retained || 0) / 100)
      // A one-off level drop, not a permanent change to the growth RATE — but it
      // lands inside the projection year, so it nets against growth there.
      return apply('growth', ctx.growth, ctx.growth - lost, [
        `${f.segmentPct}% of revenue${f.retained ? `, keeping ${f.retained}% of it` : ''} → −${pct(lost)}% revenue`,
        'Applied as a one-off level drop within the projection year',
      ])
    },
  },

  {
    id: 'capex',
    label: 'Capex announced',
    lever: 'both',
    hint: 'Spend now, revenue later — this hits margin before it helps growth.',
    fields: [
      { key: 'amount', label: 'Capex amount', unit: 'money', required: true },
      { key: 'life', label: 'Asset life', unit: 'years', default: 15 },
      { key: 'revenueWhenLive', label: 'Extra revenue once live (optional)', unit: 'money' },
      { key: 'yearsToLive', label: 'Live in', unit: 'years', default: 2 },
    ],
    compute(f, ctx) {
      if (!(f.amount > 0)) return fail('Enter the capex amount.')
      if (!(ctx.revenue > 0)) return fail('No revenue figure to size this against.')
      const life = Math.max(1, +f.life || 15)
      const dep = (+f.amount) / life
      const marginHit = dep / ctx.revenue
      const steps = [
        `${money(f.amount, ctx)} over ${life} yr life → ${money(dep, ctx)}/yr depreciation`,
        `on revenue of ${money(ctx.revenue, ctx)} → −${pct(marginHit)} pts of margin`,
      ]
      const out = { lever: 'margin', from: ctx.margin, to: ctx.margin - marginHit, steps }

      // Growth only if the revenue is expected inside the projection horizon —
      // otherwise this is all cost and no benefit for now, which is exactly the
      // point most capex announcements gloss over.
      if (f.revenueWhenLive > 0 && (+f.yearsToLive || 0) <= 1) {
        const g = (+f.revenueWhenLive) / ctx.revenue
        out.second = { lever: 'growth', from: ctx.growth, to: ctx.growth + g,
          steps: [`+${money(f.revenueWhenLive, ctx)} revenue once live → +${pct(g)}% growth`] }
      } else if (f.revenueWhenLive > 0) {
        steps.push(`Revenue of ${money(f.revenueWhenLive, ctx)} arrives in ~${f.yearsToLive} yr — beyond this projection, so not counted yet`)
      }
      return out
    },
  },

  {
    id: 'subsidy',
    label: 'Subsidy / incentive',
    lever: 'margin',
    hint: 'PLI, tax break, or any recurring benefit.',
    fields: [
      { key: 'amount', label: 'Benefit per year', unit: 'money', required: true },
      { key: 'years', label: 'For how many years', unit: 'years', default: 5 },
    ],
    compute(f, ctx) {
      if (!(f.amount > 0)) return fail('Enter the annual benefit.')
      if (!(ctx.revenue > 0)) return fail('No revenue figure to size this against.')
      const delta = (+f.amount) / ctx.revenue
      return apply('margin', ctx.margin, ctx.margin + delta, [
        `${money(f.amount, ctx)}/yr on revenue of ${money(ctx.revenue, ctx)}`,
        `→ +${pct(delta)} pts of margin${f.years ? ` for ${f.years} yr` : ''}`,
      ])
    },
  },

  {
    id: 'input_cost',
    label: 'Input cost change',
    lever: 'margin',
    hint: 'A raw material or key cost moving.',
    fields: [
      { key: 'changePct', label: 'Cost change', unit: 'percent', required: true,
        hint: 'negative if cheaper' },
      { key: 'shareOfCost', label: 'That input as % of total costs', unit: 'percent', required: true },
      { key: 'passThrough', label: 'Portion you can pass to customers', unit: 'percent', default: 0 },
    ],
    compute(f, ctx) {
      if (!(ctx.revenue > 0)) return fail('No revenue figure to size this against.')
      if (f.changePct == null || f.changePct === '') return fail('Enter the cost change.')
      if (!(f.shareOfCost > 0)) return fail("Enter that input's share of costs.")
      // Costs = revenue × (1 − margin). Using the actual cost base rather than
      // revenue matters: a 10% move in an input that's 30% of costs is not a 10%
      // move in anything the margin sees.
      const costBase = ctx.revenue * (1 - (ctx.margin ?? 0))
      const affected = costBase * (+f.shareOfCost / 100)
      const raw = affected * (+f.changePct / 100)
      const net = raw * (1 - (+f.passThrough || 0) / 100)
      const delta = -net / ctx.revenue
      return apply('margin', ctx.margin, ctx.margin + delta, [
        `Costs ≈ ${money(costBase, ctx)}; this input ${f.shareOfCost}% → ${money(affected, ctx)}`,
        `${f.changePct > 0 ? '+' : ''}${f.changePct}% on that = ${money(raw, ctx)}` +
          (f.passThrough ? `, ${f.passThrough}% passed on → ${money(net, ctx)}` : ''),
        `→ ${delta >= 0 ? '+' : ''}${pct(delta)} pts of margin`,
      ])
    },
  },

  {
    id: 'nim_change',
    label: 'Rate change (NIM impact)',
    lever: 'margin',
    lendersOnly: true,
    hint: 'A repo move helps or hurts depending on your funding mix — enter the NIM effect, not the repo change.',
    fields: [
      { key: 'bps', label: 'Expected NIM impact', unit: 'bps', required: true,
        hint: 'negative if margins compress' },
    ],
    compute(f, ctx) {
      if (f.bps == null || f.bps === '') return fail('Enter the expected NIM impact.')
      if (!(ctx.totalAssets > 0) || !(ctx.revenue > 0)) {
        return fail('Need total assets and revenue to convert a NIM change into margin.')
      }
      // NIM is earned on ASSETS; margin is measured on revenue. Converting via
      // the asset base is what makes a bps figure comparable to a margin figure —
      // a repo change can't be applied to margin directly.
      const profitDelta = ctx.totalAssets * ((+f.bps) / 10000)
      const delta = profitDelta / ctx.revenue
      return apply('margin', ctx.margin, ctx.margin + delta, [
        `${f.bps} bps on assets of ${money(ctx.totalAssets, ctx)} → ${money(profitDelta, ctx)}`,
        `on revenue of ${money(ctx.revenue, ctx)} → ${delta >= 0 ? '+' : ''}${pct(delta)} pts of margin`,
      ])
    },
  },

  {
    id: 'margin_guidance',
    label: 'Margin guidance',
    lever: 'margin',
    toGuidance: true,      // a statement about the future — belongs in guidance
    hint: "Management's own margin target.",
    fields: [
      { key: 'targetPct', label: 'Guided margin', unit: 'percent', required: true },
      { key: 'fiscalYear', label: 'For which year', unit: 'text', placeholder: 'FY27' },
    ],
    compute(f, ctx) {
      if (!(f.targetPct > 0)) return fail('Enter the guided margin.')
      const to = (+f.targetPct) / 100
      return apply('margin', ctx.margin, to, [
        `Management guides ${f.targetPct}%${f.fiscalYear ? ` for ${f.fiscalYear}` : ''}`,
        ctx.margin != null
          ? `vs ${pct(ctx.margin)}% currently → ${to > ctx.margin ? '+' : ''}${pct(to - ctx.margin)} pts`
          : 'no current margin to compare',
      ])
    },
  },

  {
    id: 'growth_guidance',
    label: 'Revenue guidance',
    lever: 'growth',
    toGuidance: true,
    hint: "Management's own revenue or growth target.",
    fields: [
      { key: 'mode', label: 'Given as', unit: 'choice',
        options: [['growth', 'Growth %'], ['target', 'Revenue target']], default: 'growth' },
      { key: 'growthPct', label: 'Guided growth', unit: 'percent' },
      { key: 'targetRevenue', label: 'Revenue target', unit: 'money' },
      { key: 'years', label: 'Over', unit: 'years', default: 1 },
      { key: 'fiscalYear', label: 'For which year', unit: 'text', placeholder: 'FY27' },
    ],
    compute(f, ctx) {
      let to
      if (f.mode === 'target') {
        if (!(f.targetRevenue > 0) || !(ctx.revenue > 0)) return fail('Enter the revenue target.')
        const yrs = Math.max(1, +f.years || 1)
        to = Math.pow((+f.targetRevenue) / ctx.revenue, 1 / yrs) - 1
        return apply('growth', ctx.growth, to, [
          `${money(ctx.revenue, ctx)} → ${money(f.targetRevenue, ctx)} over ${yrs} yr`,
          `implies ${pct(to)}% a year`,
        ])
      }
      if (!(f.growthPct !== '' && isFinite(+f.growthPct))) return fail('Enter the guided growth.')
      to = (+f.growthPct) / 100
      return apply('growth', ctx.growth, to, [
        `Management guides ${f.growthPct}%${f.fiscalYear ? ` for ${f.fiscalYear}` : ''}`,
      ])
    },
  },
]

export const factType = id => FACT_TYPES.find(t => t.id === id) || null

/** Fact types applicable to this company — NIM only means something for lenders. */
export function applicableFacts(sectorType) {
  const lender = sectorType === 'bank' || sectorType === 'nbfc'
  return FACT_TYPES.filter(t => !t.lendersOnly || lender)
}

/**
 * Run a fact type against its inputs. Returns { lever, from, to, steps } — or
 * { error } / { note } when there's nothing to apply, never a guessed number.
 */
export function computeFact(typeId, fields, ctx) {
  const t = factType(typeId)
  if (!t) return { error: 'Unknown fact type' }
  try { return t.compute(fields, ctx || {}) }
  catch (e) { return { error: String(e?.message || e) } }
}

function apply(lever, from, to, steps) { return { lever, from, to, steps } }
function fail(error) { return { error } }
function note(msg) { return { note: msg } }

function money(v, ctx) {
  if (v == null || !isFinite(v)) return '—'
  const inr = ctx?.currency === 'INR'
  const div = inr ? 1e7 : 1e6
  const unit = inr ? 'Cr' : 'M'
  const sym = inr ? '₹' : '$'
  // Values under one unit are entered as absolutes; show them plainly.
  if (Math.abs(v) < div) return `${sym}${Math.round(v).toLocaleString('en-IN')}`
  return `${sym}${Math.round(v / div).toLocaleString('en-IN')} ${unit}`
}
