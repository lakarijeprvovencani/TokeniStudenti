const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

export interface UserInfo {
  name: string
  freeTier: boolean
  balance: number
  apiKey?: string
}

export interface AuthResult {
  ok: boolean
  name?: string
  email?: string
  balance?: number
  freeTier?: boolean
  error?: string
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
    return { ok: true, name: data.name, email: data.email, balance: data.balance_usd, freeTier: data.free_tier ?? true }
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
    return { ok: true, name: data.name, email: data.email, balance: data.balance_usd, freeTier: data.free_tier ?? true }
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
    return { ok: true, name: data.name }
  } catch {
    return { ok: false, error: 'Ne mogu da se povežem sa serverom.' }
  }
}

/** Logout — clears session cookie */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch { /* ignore */ }
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
    if (!res.ok) return null
    const data = await res.json()
    return {
      name: data.name || '',
      freeTier: data.free_tier ?? true,
      balance: data.balance_usd ?? 0,
      apiKey: data.api_key || undefined,
    }
  } catch {
    return null
  }
}

/** Fetch user info — uses session cookie (no api_key in response) */
export async function fetchUserInfo(): Promise<UserInfo | null> {
  return checkSession()
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
