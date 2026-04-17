/**
 * Cross-site-cookie-proof auth bridge.
 *
 * The backend sets a `Set-Cookie: vajb_session=...; SameSite=None; Secure`
 * on every successful register / login / reset, but Safari ITP, Brave and
 * Firefox-with-strict-mode refuse to STORE it because the SPA
 * (vajbagent.netlify.app) and the API (vajbagent.com) are a cross-site pair
 * from the browser's point of view. Without the cookie every subsequent
 * call to the API returns 401 and the user sees "Prijava je istekla" right
 * after registration.
 *
 * Workaround: the backend now also returns the raw `api_key` in the JSON
 * response body of /auth/register, /auth/login and /auth/reset-password.
 * We stash it in localStorage and this module's `installAuthFetch()` hook
 * attaches it as `Authorization: Bearer <key>` to every `window.fetch` call
 * targeting the API host that doesn't already carry an `Authorization`
 * header. The session cookie is still the PRIMARY credential when the
 * browser will accept it — the Bearer header is the fallback that keeps the
 * app working everywhere else.
 *
 * Security notes:
 * - This gives up one layer of XSS protection (httpOnly cookie) on browsers
 *   that can store the cookie anyway. We accept this because the
 *   alternative is "app doesn't work for ~30% of users". Mitigations:
 *   - Key is per-user, rotated by the "Regenerate key" flow on the dashboard
 *     and invalidated by any password reset (destroyAllSessionsForKey).
 *   - No other localStorage key shares the same prefix, so a CSP / lockdown
 *     audit can flag this one location.
 * - Cleared on explicit logout and on any 401 response.
 */

const STORAGE_KEY = 'vajb_api_key'

// Resolve the API origin once at boot. Same default as userService.ts.
const API_URL = (import.meta as any).env?.VITE_API_URL || 'https://vajbagent.com'
let API_HOST = ''
try { API_HOST = new URL(API_URL).host } catch { /* ignore */ }

let cached: string | null = null
let installed = false

function readStored(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v && typeof v === 'string' && v.length > 8 ? v : null
  } catch {
    return null
  }
}

export function getApiKey(): string | null {
  if (cached !== null) return cached
  cached = readStored()
  return cached
}

export function setApiKey(key: string | null | undefined): void {
  if (!key) {
    cached = null
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    return
  }
  cached = key
  try { localStorage.setItem(STORAGE_KEY, key) } catch { /* ignore */ }
}

export function clearApiKey(): void {
  setApiKey(null)
}

/**
 * Decide if `input` points at our API host. Works for absolute URLs,
 * `Request` instances and relative URLs (treated as same-origin as the SPA,
 * which is never the API so they're left untouched).
 */
function isApiRequest(input: RequestInfo | URL): boolean {
  if (!API_HOST) return false
  try {
    if (typeof input === 'string') {
      if (!input.startsWith('http')) return false
      return new URL(input).host === API_HOST
    }
    if (input instanceof URL) return input.host === API_HOST
    if (input && typeof (input as Request).url === 'string') {
      return new URL((input as Request).url).host === API_HOST
    }
  } catch { /* ignore */ }
  return false
}

/**
 * Patch `window.fetch` so every outbound request to the API automatically
 * carries our Bearer header when localStorage has a key. Idempotent — safe
 * to call multiple times (we only install once).
 */
export function installAuthFetch(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const original = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = getApiKey()
    if (!key || !isApiRequest(input)) {
      return original(input, init)
    }

    // Don't overwrite an explicit Authorization header — some VSCode-style
    // callers pass their own Bearer and we must respect it.
    const existing = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    if (existing.has('Authorization') || existing.has('authorization')) {
      return original(input, init)
    }
    existing.set('Authorization', `Bearer ${key}`)

    const mergedInit: RequestInit = { ...(init || {}), headers: existing }
    return original(input, mergedInit)
  }
}
