import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      // Proxy /api/screener to Screener.in in local dev
      // (same as what the Vercel serverless function does in production)
      '/api/screener': {
        target: 'https://www.screener.in',
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL(path, 'http://localhost')
          const ticker = url.searchParams.get('ticker') ?? ''
          return `/company/${ticker}/consolidated/`
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept':     'text/html,application/xhtml+xml',
          'Referer':    'https://www.screener.in',
        }
      }
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Stock Valuation Analyzer',
        short_name: 'StockVal',
        description: 'Multi-model stock valuation with technicals and fundamentals',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/financialmodelingprep\.com\/api/,
            handler: 'NetworkFirst',
            options: { cacheName: 'fmp-api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 3600 } }
          },
          {
            urlPattern: /^https:\/\/query1\.finance\.yahoo\.com/,
            handler: 'NetworkFirst',
            options: { cacheName: 'yahoo-api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 3600 } }
          }
        ]
      }
    })
  ]
})
