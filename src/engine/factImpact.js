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
      { key: 'marginKind', label: 'Which margin', unit: 'choice',
        options: [['net', 'Net'], ['operating', 'Operating / EBITDA'], ['gross', 'Gross']] },
      { key: 'fiscalYear', label: 'For which year', unit: 'text', placeholder: 'FY27' },
    ],
    compute(f, ctx) {
      if (!(f.targetPct > 0)) return fail('Enter the guided margin.')
      const guided = (+f.targetPct) / 100

      // Convert to the NET margin this model runs on, instead of assuming the
      // quoted figure already is one. "Operating margin of 26%" on an insurer
      // earning 4.7% net is not a 5.5x profit uplift — it's a different line of
      // the same P&L, and the ratio between them is observable in this company's
      // own numbers. Reading the qualifier and doing the conversion is the app's
      // job; asking the user which margin they meant was pushing our mistake
      // onto them.
      const kind = f.marginKind || null
      if (!kind) {
        return fail('The text doesn\'t say which margin this is. Pick Net, Operating or Gross — ' +
                    'they sit on different lines and are not interchangeable.')
      }

      let to = guided
      const steps = []
      if (kind === 'net') {
        steps.push(`Management guides ${f.targetPct}% net margin${f.fiscalYear ? ` for ${f.fiscalYear}` : ''}`)
      } else {
        // How much of this company's operating (or gross) profit survives to the
        // bottom line, measured from what it actually reports. A guided margin
        // at the higher line scales by that same ratio.
        const conv = ctx.netMargin > 0 && ctx.opMargin > 0 ? ctx.netMargin / ctx.opMargin : null
        if (!(conv > 0)) {
          return fail(`Can't convert a ${kind} margin to a net margin for this company — ` +
                      `its operating and net margins aren't both available.`)
        }
        to = guided * conv
        steps.push(
          `Management guides ${f.targetPct}% ${kind} margin${f.fiscalYear ? ` for ${f.fiscalYear}` : ''}`,
          `This company converts ${pct(ctx.opMargin)}% operating → ${pct(ctx.netMargin)}% net ` +
            `(${(conv * 100).toFixed(0)}% carries through)`,
          `→ ${f.targetPct}% ${kind} ≈ ${pct(to)}% net`)
      }

      // Last-resort guard. With the conversion above this should rarely fire; if
      // it does, something in the reading is wrong and the number shouldn't land.
      if (ctx.margin > 0) {
        const ratio = to / ctx.margin
        if (ratio > 3 || ratio < 0.33) {
          return fail(`That works out to ${pct(to)}% net margin, ${ratio > 1 ? 'far above' : 'far below'} ` +
                      `this company's current ${pct(ctx.margin)}%. Check the figure before applying it.`)
        }
      }

      steps.push(ctx.margin != null
        ? `vs ${pct(ctx.margin)}% currently → ${to > ctx.margin ? '+' : ''}${pct(to - ctx.margin)} pts`
        : 'no current margin to compare')
      return apply('margin', ctx.margin, to, steps)
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
      { key: 'segmentShare', label: "That segment's share of revenue", unit: 'percent',
        hint: 'only when the rate is for one part of the business' },
      { key: 'targetRevenue', label: 'Revenue target', unit: 'money' },
      { key: 'years', label: 'Over', unit: 'years', default: 1 },
      { key: 'fiscalYear', label: 'For which year', unit: 'text', placeholder: 'FY27' },
    ],
    compute(f, ctx) {
      // A macro forecast is not company guidance. GDP growth has some
      // relationship to a bank's book, but no computable one — applying it as a
      // revenue growth rate is a category error, not an approximation.
      if (f.scope === 'macro') {
        return fail('This is a macro forecast (GDP, inflation or similar), not company guidance. ' +
                    'It may inform your own view, but there is no defensible way to turn it into ' +
                    "this company's revenue growth.")
      }

      // A segment rate applied to the whole company overstates it by whatever
      // the rest of the business weighs. With the segment's share of revenue the
      // blend is arithmetic; without it, that share is the one fact to ask for.
      if (f.scope === 'segment') {
        const share = (+f.segmentShare) / 100
        if (!(share > 0)) {
          return fail(`This is growth for one part of the business (loans, AUM, a division), not the ` +
                      `whole company. Give that segment's share of revenue and the overall rate follows.`,
                      { needs: 'segmentShare' })
        }
        const segRate = f.mode === 'growth' ? (+f.growthPct) / 100 : null
        if (segRate == null) return fail('Enter the segment growth rate.')
        const rest = ctx.growth ?? 0
        const blended = segRate * share + rest * (1 - share)
        const speakerNote = f.speaker === 'third-party'
          ? ' (a third-party forecast, not company guidance)' : ''
        return apply('growth', ctx.growth, blended, [
          `${round(segRate * 100, 1)}% on the ${round(share * 100, 0)}% of revenue that segment represents${speakerNote}`,
          `rest of the business assumed to continue at ${round(rest * 100, 1)}%`,
          `→ blended ${round(blended * 100, 1)}% overall`,
        ])
      }

      // A company-level forecast from someone other than management competes
      // directly with the standing assumption: both claim to describe the same
      // thing. Neither wins on principle — the assumption is measured history
      // and therefore stale by construction; the forecast is forward-looking but
      // from a party with no accountability for it. So the conflict is surfaced
      // with both provenances and the choice is one tap, rather than the app
      // silently ranking a broker above the record.
      if (f.speaker === 'third-party' && f.scope === 'company' && ctx.growth != null
          && f.mode === 'growth' && isFinite(+f.growthPct)) {
        const proposed = (+f.growthPct) / 100
        if (Math.abs(proposed - ctx.growth) >= 0.03) {
          return {
            lever: 'growth', from: ctx.growth, to: proposed,
            conflict: {
              currentPct: round(ctx.growth * 100, 1),
              currentLabel: ctx.growthLabel || 'your current assumption',
              proposedPct: round(proposed * 100, 1),
              proposedLabel: 'third-party forecast',
            },
            steps: [
              `Your assumption: ${round(ctx.growth * 100, 1)}% (${ctx.growthLabel || 'measured history'})`,
              `This forecast: ${f.growthPct}%${f.fiscalYear ? ` for ${f.fiscalYear}` : ''}, from a third party`,
              'Measured history against a forward view — neither settles it, so this is your call.',
            ],
          }
        }
      }

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
      const who = f.speaker === 'third-party' ? 'A broker forecast of'
        : f.speaker === 'management' ? 'Management guides'
        : 'Guidance of'
      return apply('growth', ctx.growth, to, [
        `${who} ${f.growthPct}%${f.fiscalYear ? ` for ${f.fiscalYear}` : ''}`,
        ...(f.speaker === 'third-party'
          ? ['Third-party estimate — weaker than the company committing to a number itself.'] : []),
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
