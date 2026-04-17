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

// Safari Private Mode / Brave Strict Incognito occasionally throw on
// localStorage.setItem with a QuotaExceededError (or return a window.local
// Storage that silently drops writes). We fall through to sessionStorage —
// which those browsers keep functional — so the Bearer fallback still
// survives a page refresh within the same tab. Without this rescue, users
// get logged out on every refresh in private windows.
function readFromStorage(store: Storage | undefined | null): string | null {
  if (!store) return null
  try {
    const v = store.getItem(STORAGE_KEY)
    return v && typeof v === 'string' && v.length > 8 ? v : null
  } catch {
    return null
  }
}

function writeToStorage(store: Storage | undefined | null, key: string): boolean {
  if (!store) return false
  try {
    store.setItem(STORAGE_KEY, key)
    // Round-trip verification — some private modes accept setItem but then
    // drop the value, so we can't trust a clean throw.
    return store.getItem(STORAGE_KEY) === key
  } catch {
    return false
  }
}

function removeFromStorage(store: Storage | undefined | null): void {
  if (!store) return
  try { store.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

function readStored(): string | null {
  // localStorage first (survives new tabs + full shutdown in normal mode);
  // sessionStorage second (survives refreshes even in strict private mode).
  return readFromStorage(typeof localStorage !== 'undefined' ? localStorage : null)
    || readFromStorage(typeof sessionStorage !== 'undefined' ? sessionStorage : null)
}

export function getApiKey(): string | null {
  if (cached !== null) return cached
  cached = readStored()
  return cached
}

export function setApiKey(key: string | null | undefined): void {
  if (!key) {
    cached = null
    removeFromStorage(typeof localStorage !== 'undefined' ? localStorage : null)
    removeFromStorage(typeof sessionStorage !== 'undefined' ? sessionStorage : null)
    return
  }
  cached = key
  const wroteLocal = writeToStorage(typeof localStorage !== 'undefined' ? localStorage : null, key)
  // Always mirror to sessionStorage too — cheap and rescues us when
  // localStorage silently drops the write.
  const wroteSession = writeToStorage(typeof sessionStorage !== 'undefined' ? sessionStorage : null, key)
  if (!wroteLocal && !wroteSession) {
    console.warn('[authToken] Neither localStorage nor sessionStorage is writable — user will be logged out on refresh.')
  } else if (!wroteLocal) {
    console.warn('[authToken] localStorage unavailable (likely private mode). Falling back to sessionStorage — user will be logged out when this tab is closed.')
  }
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
