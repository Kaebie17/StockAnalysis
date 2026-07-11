/**
 * src/pwa.js — service-worker registration with an "update available" toast that
 * auto-reloads to the new build. Combined with skipWaiting/clientsClaim in
 * vite.config, a fresh deploy takes effect promptly on the stable domain.
 */
import { registerSW } from 'virtual:pwa-register'

function toast(msg) {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
    'background:#1e293b', 'color:#e2e8f0', 'padding:10px 16px', 'border-radius:10px',
    'font:500 13px system-ui,sans-serif', 'box-shadow:0 6px 24px rgba(0,0,0,.4)',
    'z-index:2147483647', 'border:1px solid #334155',
  ].join(';')
  document.body.appendChild(el)
  return el
}

export function setupPWA() {
  const updateSW = registerSW({
    onNeedRefresh() {
      toast('New version available — updating…')
      // Activate the new service worker and reload to the latest build.
      setTimeout(() => updateSW(true), 1200)
    },
    onOfflineReady() {
      const el = toast('Ready to work offline')
      setTimeout(() => el.remove(), 2500)
    },
  })
}
