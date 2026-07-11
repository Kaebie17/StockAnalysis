/**
 * src/pwa.js — service worker + "app updated" notice.
 *
 * Update strategy: new builds are picked up on reload (SW native + skipWaiting/
 * clientsClaim). To tell the user, we compare the build stamp baked in at build
 * time against the one saved last visit; if it changed, the app just loaded a new
 * version, so we show "Updated". This fires on every load of a newer build
 * (reload, reopen, new window) with zero polling.
 */
import { registerSW } from 'virtual:pwa-register'

const BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev'
const KEY = 'sa_build_seen'

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
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400) }, 4000)
}

function notifyIfUpdated() {
  try {
    const seen = localStorage.getItem(KEY)
    if (seen && seen !== BUILD) toast(`Updated to the latest version (${BUILD})`)
    localStorage.setItem(KEY, BUILD)
  } catch {}
}

export function setupPWA() {
  registerSW({ immediate: true })
  // Defer so the toast mounts after the app renders.
  if (typeof window !== 'undefined') setTimeout(notifyIfUpdated, 800)
}
