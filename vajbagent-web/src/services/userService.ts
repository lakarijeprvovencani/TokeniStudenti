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

/** Check if user is logged in (session cookie valid). Returns user info or null. */
export async function checkSession(): Promise<UserInfo | null> {
  try {
    const res = await fetch(`${API_URL}/auth/me`, {
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

/** Fetch user info — uses session cookie */
export async function fetchUserInfo(): Promise<UserInfo | null> {
  return checkSession()
}

/** Refresh just the balance */
export async function fetchBalance(): Promise<number | null> {
  const info = await checkSession()
  return info?.balance ?? null
}
