# StockVal PWA

Stock valuation PWA with Yahoo Finance + Screener.in fallback.

## Setup

```bash
npm install
```

### Development (requires Vercel CLI for the /api routes)
```bash
npm install -g vercel
vercel dev
```
> `vercel dev` runs both the Vite frontend AND the /api serverless functions locally.
> Plain `npm run dev` works for UI only — Yahoo data won't load because the /api/yahoo proxy won't exist.

### Production (deploy to Vercel)
```bash
vercel deploy
```
Or connect your GitHub repo in the Vercel dashboard — it auto-deploys on push.

## How it works

**Data flow:**
1. You enter a ticker (e.g. `AAPL`, `RELIANCE.NS`, `TCS.NS`)
2. App calls `/api/yahoo` (Vercel serverless) which:
   - Visits finance.yahoo.com to get a session cookie
   - Fetches a crumb token from Yahoo's getCrumb endpoint
   - Uses both to make authenticated calls to Yahoo's data APIs
3. If Yahoo fails, falls back to `/api/screener` which proxies Screener.in
4. If both fail, prompts CSV upload

**Why a proxy is required:** Yahoo Finance blocks direct browser requests via CORS. The crumb + cookie flow must happen server-side. This is the fix for the 401/Unauthorized errors.

## Indian stocks
- Add `.NS` for NSE: `RELIANCE.NS`, `TCS.NS`, `INFY.NS`
- Add `.BO` for BSE: `500325.BO`
- Or just enter `RELIANCE` — the app will try to auto-resolve to the NSE symbol via Yahoo search

## Features
- 7 valuation models (DCF, P/E, EV/EBITDA, P/B, P/S, Graham, EV/GP)
- Reverse DCF (implied growth rate)
- RSI, MACD, Bollinger Bands, SMA 50/200, patterns
- Quality score across 9 fundamental predictors
- Scoring Studio (⚙ button) — adjust weights and DCF assumptions live
- PWA — installable, works offline for recently fetched tickers
- 1-hour IndexedDB cache
- CSV upload fallback

## Project structure
```
api/
  yahoo.js         ← Vercel serverless: Yahoo proxy with crumb/cookie
  screener.js      ← Vercel serverless: Screener.in HTML parser
src/
  api/             ← Client-side fetchers (call the proxy, not Yahoo directly)
  engine/          ← Pure calculations: normalize, ratios, valuation, technicals, quality
  store/           ← React Context global state
  utils/           ← IndexedDB, number formatters
  components/      ← UI panels
```
