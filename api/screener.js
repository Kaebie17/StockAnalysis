// api/screener.js
// Vercel Serverless Function — Screener.in CORS proxy
// Deployed automatically by Vercel when placed in /api folder
// URL: https://your-app.vercel.app/api/screener?ticker=RELIANCE

export default async function handler(req, res) {
  // CORS headers for browser requests
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(200).end()
    return
  }

  const { ticker } = req.query

  if (!ticker) {
    return res.status(400).json({ error: 'ticker parameter required' })
  }

  try {
    const url = `https://www.screener.in/company/${ticker.toUpperCase()}/consolidated/`

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StockVal/1.0)',
        'Accept':     'text/html,application/xhtml+xml',
      }
    })

    if (!response.ok) {
      throw new Error(`Screener returned ${response.status}`)
    }

    const html = await response.text()

    // Return raw HTML — parsing happens client-side in screener.js
    res.status(200).send(html)

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
