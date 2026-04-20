import { setScope } from './storageScope'
import { setApiKey, clearApiKey } from './authToken'

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

export interface UserInfo {
  name: string
  /** Stable non-secret user identifier — hash of student key. Used to scope
   *  per-user browser storage so two users on the same browser profile
   *  never see each other's projects or secrets. */
  userId: string
  freeTier: boolean
  balance: number
  apiKey?: string
  /** False only for self-registered web users who haven't clicked the
   *  verification link yet. Undefined for legacy accounts (grandfathered). */
  emailVerified?: boolean
}

export interface AuthResult {
  ok: boolean
  /** Full user info constructed from the register/login response body. Populated
   *  on success so the caller can avoid a follow-up `/auth/me` roundtrip — that
   *  second call used to break registration on browsers that block third-party
   *  cookies (Safari ITP, Firefox strict, Brave default), causing "provera
   *  sesije nije uspela" right after a successful signup. */
  user?: UserInfo
  email?: string
  error?: string
}

/**
 * Build a UserInfo from an auth response body. Both /auth/register and
 * /auth/login return the same shape and include `user_id`, so we can skip
 * the extra /auth/me call that would otherwise require a valid cross-site
 * session cookie.
 */
function userFromAuthResponse(data: any): UserInfo {
  const info: UserInfo = {
    name: data.name || '',
    userId: data.user_id || '',
    freeTier: data.free_tier ?? true,
    balance: typeof data.balance_usd === 'number' ? data.balance_usd : 0,
    emailVerified: typeof data.email_verified === 'boolean' ? data.email_verified : undefined,
  }
  if (info.userId) setScope(info.userId)
  // Persist the Bearer-fallback key for browsers that refuse to store our
  // cross-site session cookie. See services/authToken.ts for the full
  // reasoning — the key is attached by the global fetch interceptor to
  // every subsequent API call so the app works on Safari/Brave too.
  if (typeof data.api_key === 'string' && data.api_key.length > 8) {
    setApiKey(data.api_key)
  }
  return info
}

/** Login with email + password. Sets httpOnly session cookie. */
export async function login(email: string, password: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Greška pri prijavi.' }
    return { ok: true, user: userFromAuthResponse(data), email: data.email }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Register new account with password. Sets httpOnly session cookie. */
export async function register(firstName: string, lastName: string, email: string, password: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${API_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email, password }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Greška pri registraciji.' }
    return { ok: true, user: userFromAuthResponse(data), email: data.email }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Start a password-reset flow — emails the user a link with a one-time token. */
export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Greška.' }
    return { ok: true, message: data.message }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Complete a password reset using the token from the email link. Sets the session cookie on success. */
export async function resetPassword(token: string, newPassword: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${API_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token, new_password: newPassword }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Greška pri resetovanju lozinke.' }
    return { ok: true, user: userFromAuthResponse(data), email: data.email }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Set password for existing account (using API key). Sets httpOnly session cookie. */
export async function setPassword(email: string, currentKey: string, newPassword: string): Promise<AuthResult> {
  try {
    const res = await fetch(`${API_URL}/auth/set-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, current_key: currentKey, new_password: newPassword }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error || 'Greška.' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Logout — clears session cookie and the per-user storage scope */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch { /* ignore */ }
  setScope(null)
  // Drop the Bearer-fallback key too so a subsequent anonymous visit can't
  // impersonate the previous user via leftover localStorage.
  clearApiKey()
}

/**
 * Check if user is logged in (session cookie valid).
 * By default does NOT include the raw API key — use `revealKey: true` only
 * when the user explicitly clicks "Show API key", to minimise how often
 * the secret moves over the wire and into memory.
 */
export async function checkSession(opts: { revealKey?: boolean } = {}): Promise<UserInfo | null> {
  try {
    const qs = opts.revealKey ? '?include_key=1' : ''
    const res = await fetch(`${API_URL}/auth/me${qs}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      setScope(null)
      // Any 401/403 on /auth/me means our stored key is no longer valid —
      // wipe it so we don't keep retrying with a dead credential.
      if (res.status === 401 || res.status === 403) clearApiKey()
      return null
    }
    const data = await res.json()
    const info: UserInfo = {
      name: data.name || '',
      userId: data.user_id || '',
      freeTier: data.free_tier ?? true,
      balance: data.balance_usd ?? 0,
      apiKey: data.api_key || undefined,
      emailVerified: typeof data.email_verified === 'boolean' ? data.email_verified : undefined,
    }
    if (info.userId) setScope(info.userId)
    return info
  } catch {
    return null
  }
}

/** Fetch user info — uses session cookie (no api_key in response) */
export async function fetchUserInfo(): Promise<UserInfo | null> {
  return checkSession()
}

/**
 * Confirm the user's email address using the one-time token from the
 * verification link (?verify_token=...). Backend flips email_verified=true
 * and releases the welcome bonus ($0.90 by default). Safe to call without
 * a session — the token itself is the credential.
 */
export async function verifyEmail(token: string): Promise<{ ok: boolean; alreadyVerified?: boolean; balanceUsd?: number; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data?.error || 'Verifikacija nije uspela.' }
    return {
      ok: true,
      alreadyVerified: !!data.already_verified,
      balanceUsd: typeof data.balance_usd === 'number' ? data.balance_usd : undefined,
    }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Ask the backend to re-send the verification email to the logged-in user. */
export async function resendVerificationEmail(): Promise<{ ok: boolean; alreadyVerified?: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/auth/resend-verification`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data?.error || 'Greška pri slanju emaila.' }
    return { ok: true, alreadyVerified: !!data.already_verified }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Reveal the API key — only call from an explicit user action (e.g. "Copy key" button) */
export async function revealApiKey(): Promise<string | null> {
  const info = await checkSession({ revealKey: true })
  return info?.apiKey || null
}

/** Refresh just the balance */
export async function fetchBalance(): Promise<number | null> {
  const info = await checkSession()
  return info?.balance ?? null
}

/**
 * Start a Stripe Checkout session for a USD top-up and return the hosted URL.
 * Session cookie auth — no API key needed from the web app.
 */
export async function createCheckout(amountUsd: number): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/create-checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ amount_usd: amountUsd, return_url: window.location.origin + '/' }),
    })
    const data = await res.json()
    if (!res.ok || !data.url) return { ok: false, error: data.error || 'Greška pri kreiranju sesije plaćanja.' }
    return { ok: true, url: data.url }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}
