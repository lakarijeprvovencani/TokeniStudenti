/**
 * Supabase OAuth integration — talks to vajbagent.com backend
 * which proxies all Supabase Management API calls.
 */

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

interface ApiOpts {
  signal?: AbortSignal
}

async function api<T = unknown>(path: string, init: RequestInit & ApiOpts = {}): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    let msg = `HTTP ${resp.status}`
    try {
      const parsed = JSON.parse(text)
      msg = parsed.error || parsed.message || msg
    } catch {
      if (text) msg = text
    }
    throw new Error(msg)
  }
  return resp.json()
}

export interface SupabaseStatus {
  connected: boolean
  configured: boolean
}

export interface SupabaseOrg {
  id: string
  name: string
  slug?: string
}

export interface SupabaseProject {
  id: string
  ref: string
  name: string
  region: string
  organization_id: string
  status?: string
  created_at?: string
}

export interface SupabaseCredentials {
  url: string
  anon_key: string
}

export async function getStatus(): Promise<SupabaseStatus> {
  return api('/api/supabase/status')
}

/**
 * Open OAuth popup. Resolves when the popup notifies success via postMessage.
 * Uses polling on connection status as fallback in case postMessage fails
 * (cross-origin, cookie issues, etc.).
 */
export async function startOAuthFlow(): Promise<void> {
  const { url } = await api<{ url: string }>('/auth/supabase/start')

  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'supabase-oauth', 'width=720,height=820')
    if (!popup) {
      reject(new Error('Pop-up blokiran. Dozvoli pop-up prozore i pokušaj ponovo.'))
      return
    }
    // TypeScript narrowing: capture non-null reference
    const popupWin: Window = popup

    let settled = false
    const startTime = Date.now()
    // Give user at least 90s to complete the flow before giving up
    const MAX_WAIT = 180_000
    // Don't trust popupWin.closed in the first 3s (cross-origin nav can briefly show closed=true)
    const MIN_WAIT_BEFORE_CLOSED_CHECK = 3000

    function done(success: boolean, errMsg?: string) {
      if (settled) return
      settled = true
      window.removeEventListener('message', messageHandler)
      clearInterval(pollInterval)
      try { if (!popupWin.closed) popupWin.close() } catch { /* ignore */ }
      if (success) resolve()
      else reject(new Error(errMsg || 'Povezivanje otkazano'))
    }

    const messageHandler = (e: MessageEvent) => {
      if (e.data?.type === 'supabase-connected') {
        done(true)
      }
    }

    // Poll backend status every 2s — this catches success even if postMessage fails
    const pollInterval = setInterval(async () => {
      if (settled) return
      const elapsed = Date.now() - startTime

      // Check backend first (source of truth)
      try {
        const s = await getStatus()
        if (s.connected) {
          done(true)
          return
        }
      } catch { /* ignore */ }

      // Then check if popup closed (only after grace period)
      if (elapsed > MIN_WAIT_BEFORE_CLOSED_CHECK) {
        try {
          if (popupWin.closed) {
            // Wait one more poll cycle for backend to catch up
            setTimeout(async () => {
              if (settled) return
              try {
                const finalStatus = await getStatus()
                if (finalStatus.connected) done(true)
                else done(false)
              } catch {
                done(false)
              }
            }, 1500)
            return
          }
        } catch { /* cross-origin, popup still alive */ }
      }

      // Hard timeout
      if (elapsed > MAX_WAIT) {
        done(false, 'Isteklo vreme za povezivanje. Pokušaj ponovo.')
      }
    }, 2000)

    window.addEventListener('message', messageHandler)
  })
}

export async function disconnect(): Promise<void> {
  await api('/api/supabase/disconnect', { method: 'POST' })
}

export async function listOrganizations(): Promise<SupabaseOrg[]> {
  const data = await api<{ organizations: SupabaseOrg[] }>('/api/supabase/organizations')
  return data.organizations || []
}

export async function listProjects(): Promise<SupabaseProject[]> {
  const data = await api<{ projects: SupabaseProject[] }>('/api/supabase/projects')
  return data.projects || []
}

export async function createProject(orgId: string, name: string, region = 'us-east-1'): Promise<SupabaseProject> {
  const data = await api<{ project: SupabaseProject }>('/api/supabase/create-project', {
    method: 'POST',
    body: JSON.stringify({ orgId, name, region }),
  })
  return data.project
}

export async function getCredentials(projectRef: string): Promise<SupabaseCredentials> {
  return api(`/api/supabase/credentials/${projectRef}`)
}
