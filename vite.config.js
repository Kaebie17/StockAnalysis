import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  
  define: { __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0,16).replace('T',' ')) },
plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      manifest: {
        name: 'StockAnalyzr',
        short_name: 'StockAnalyzr',
        description: 'Stock Valuation PWA',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }

        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/query1\.finance\.yahoo\.com\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'yahoo-cache', expiration: { maxAgeSeconds: 3600 } }
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/api/screener': {
        target: 'https://www.screener.in',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/screener/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://www.screener.in/'
        }
      }
    }
  },
  build: { sourcemap: true  },
})
