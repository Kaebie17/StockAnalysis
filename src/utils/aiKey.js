// BYOK Gemini key — stored in sessionStorage (wiped when the tab closes).
// It's the user's own key; keep it out of localStorage so it doesn't linger on
// shared machines. Note: any key typed into a browser is readable by page JS, so
// users should set a usage cap on their key in Google AI Studio.
const K = 'sa_gemini_key'

export function getAiKey() {
  try { return sessionStorage.getItem(K) || '' } catch { return '' }
}
export function setAiKey(v) {
  try { v ? sessionStorage.setItem(K, v.trim()) : sessionStorage.removeItem(K) } catch {}
}
export function clearAiKey() {
  try { sessionStorage.removeItem(K) } catch {}
}
