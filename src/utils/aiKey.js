// BYOK Gemini key. Two storage modes:
//   remember = true  → localStorage  (persists after the browser closes)
//   remember = false → sessionStorage (wiped when the tab/browser closes)
// Any key typed into a browser is readable by page JS, so users should cap their
// key's usage in Google AI Studio regardless of where it's stored.
const K = 'sa_gemini_key'

export function getAiKey() {
  try { return localStorage.getItem(K) || sessionStorage.getItem(K) || '' } catch { return '' }
}

export function setAiKey(v, remember = true) {
  try {
    if (!v || !v.trim()) { localStorage.removeItem(K); sessionStorage.removeItem(K); return }
    const val = v.trim()
    if (remember) { localStorage.setItem(K, val); sessionStorage.removeItem(K) }
    else { sessionStorage.setItem(K, val); localStorage.removeItem(K) }
  } catch {}
}

export function clearAiKey() {
  try { localStorage.removeItem(K); sessionStorage.removeItem(K) } catch {}
}

export function isKeyRemembered() {
  try { return !!localStorage.getItem(K) } catch { return false }
}
