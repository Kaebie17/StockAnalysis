/**
 * src/api/orchestrator.js
 *
 * Fetches Yahoo only for Indian tickers. The automatic Screener scrape
 * (fetchScreener, api/screener.js) is gone — it was producing data with
 * fields silently shifted a year off from where they belonged (confirmed:
 * a year's revenue/operating profit/depreciation/interest, tagged
 * 'source', turning up bit-for-bit identical to the PRIOR year's actual
 * figures — four line items matching exactly, two years apart, isn't
 * something a real company's financials do). Screener data now only
 * enters through the user's own paste (AddHistoryModal/GapFillModal/
 * NormalizeModal, via pasteParser.js) — a completely separate code path
 * from this scrape, tagged 'pasted', unaffected by this removal.
 */

import { fetchYahoo, resolveTicker } from './yahoo.js'
import { fetchSec } from './secClient.js'

export async function fetchTicker(rawTicker, onProgress) {
  const log  = (msg, step) => onProgress?.({ msg, step })

  log('Fetching financial data…', 1)

  // Resolve once, use for both the routing decision below AND the Yahoo fetch
  // itself. This used to be guessed from the RAW input's suffix (isUsTicker:
  // "no .NS/.BO → must be American") — wrong for the overwhelming majority of
  // real usage, since every example ticker on the homepage (and anything else
  // typed without an explicit suffix) has none. resolveTicker() is the same
  // lookup fetchYahoo() already had to do internally to find the real Yahoo
  // symbol; using ITS answer instead of re-guessing means a bare "RELIANCE"
  // correctly routes to Screener instead of a SEC lookup that can only fail.
  const resolved  = await resolveTicker(rawTicker)
  const isIndian  = /\.(NS|BO)$/i.test(resolved)

  // ── US tickers: Yahoo (price/meta) + SEC EDGAR (deep annual history) ────────
  // SEC fills Screener's slot for US stocks — automatic, no paste. Any SEC
  // failure falls through to the Yahoo-only result, i.e. previous behaviour.
  if (!isIndian) {
    const [yRes, secRes] = await Promise.allSettled([fetchYahoo(rawTicker, resolved), fetchSec(resolved)])
    if (yRes.status !== 'fulfilled') throw new Error('Could not fetch data for this ticker from Yahoo Finance.')
    const yahooData = yRes.value
    if (secRes.status !== 'fulfilled' || !secRes.value) {
      console.info('[orchestrator] SEC unavailable:', secRes.reason?.message || 'no data')
      return { source: 'yahoo', raw: yahooData }
    }
    log('Merging SEC filing history…', 2)
    return { source: 'sec-merged', raw: { yahoo: yahooData, sec: secRes.value } }
  }

  // Indian tickers: Yahoo only. Historical depth (the years Yahoo doesn't
  // carry) comes from the user's own Screener paste (AddHistoryModal/
  // GapFillModal/NormalizeModal), not an automatic scrape.
  const yahooData = await fetchYahoo(rawTicker, resolved)
  log('Data loaded (Yahoo only — paste Screener history for deeper years)', 2)
  return { source: 'yahoo', raw: yahooData }
}
