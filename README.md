# StockVal — Multi-Model Stock Valuation PWA

A Progressive Web App for stock valuation analysis combining fundamental valuation models, business quality scoring, and technical analysis signals.

---

## Features

- **Multi-model valuation** — DCF, P/E, EV/EBITDA, P/B, P/S, Graham Number, Reverse DCF
- **Fundamental quality scoring** — configurable predictors with editable weights and thresholds
- **Technical analysis** — RSI, MACD, SMA/EMA, volume, OBV, candlestick patterns, divergence detection
- **Progressive disclosure** — crisp summary view, drill down on demand
- **Fully configurable** — Scoring Studio to edit every weight, threshold, and formula
- **Named profiles** — save configurations for different investment styles or sectors
- **Offline capable** — cached data works without internet (PWA)
- **Data fallback** — FMP API → Screener.in (Indian stocks) → file upload (Phase 3)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get a free FMP API key

Visit [financialmodelingprep.com](https://financialmodelingprep.com) and sign up for a free account.
Free tier: 250 API calls/day.

### 3. Run locally

```bash
npm run dev
```

Open http://localhost:5173 in your browser.

### 4. Enter your API key

Click **API Key** in the top right and paste your FMP key. It's saved locally in your browser.

---

## Build & Deploy

### Build for production

```bash
npm run build
```

### Deploy to Vercel

1. Push this repo to GitHub
2. Import the repo in [vercel.com](https://vercel.com)
3. Vercel auto-detects Vite — no config needed
4. Deploy

The `/api/screener.js` file is automatically deployed as a Vercel Serverless Function (Screener.in proxy for Indian stocks).

---

## Project Structure

```
src/
  api/
    fmp.js          — FMP API fetcher (all raw data)
    screener.js     — Screener.in HTML parser (fallback)
  engine/
    normalize.js    — Raw API → clean standard object
    ratios.js       — All derived ratio calculations
    stage.js        — Company stage auto-detection
    valuation.js    — DCF, P/E, EV/EBITDA etc.
    technicals.js   — RSI, MACD, SMA, patterns, volume
    quality.js      — Configurable scoring engine + verdict
  store/
    AppContext.jsx  — Global state (React Context)
  utils/
    db.js           — Raw IndexedDB (no module)
    format.js       — Number/currency formatters
  components/
    dashboard/      — Header, SummaryStrip, panels
    studio/         — ScoringStudio configuration UI
api/
  screener.js       — Vercel Serverless Function (CORS proxy)
```

---

## Data Philosophy

- **Raw data** is fetched from APIs exactly as returned — never derived
- **All ratios and metrics** are calculated in the app from raw data
- **Formulas are transparent** — visible and editable in Scoring Studio
- **Sources are independent** — switching source doesn't change how ratios are calculated

---

## Phase Roadmap

- ✅ Phase 1 — FMP API + Valuation engine + Dashboard
- ✅ Phase 2 — Screener.in fallback (Vercel proxy included)
- 🔲 Phase 3 — File upload (CSV/Excel/image)
- 🔲 Phase 4 — Sector presets (Banking, Tech, FMCG etc.)
- 🔲 Phase 5 — Peer comparison strip
- 🔲 Phase 6 — Historical valuation band (P/E range chart)
- 🔲 Phase 7 — PWA polish, icons, offline UX

---

## Disclaimer

StockVal is for research and educational purposes only. All signals are model outputs based on available data and configurable assumptions. This is not financial advice. Always conduct your own due diligence.
