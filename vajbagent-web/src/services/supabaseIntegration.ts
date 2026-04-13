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
 * Open OAuth popup and wait for connection to complete.
 *
 * Design: no false errors, no auto-close. Backend status is the source of truth,
 * polled every 2s. Returns once connected=true or the generous 5-min timeout hits.
 * Popup stays open — user sees success page and closes it manually.
 */
export async function startOAuthFlow(): Promise<{ connected: boolean }> {
  const { url } = await api<{ url: string }>('/auth/supabase/start')

  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'supabase-oauth', 'width=760,height=860,menubar=no,toolbar=no')
    if (!popup) {
      reject(new Error('Pop-up blokiran. Dozvoli pop-up prozore u browser-u i pokušaj ponovo.'))
      return
    }

    let settled = false
    const startTime = Date.now()
    const MAX_WAIT = 300_000 // 5 minutes — generous for scope selection, etc.

    function finish(connected: boolean) {
      if (settled) return
      settled = true
      window.removeEventListener('message', messageHandler)
      clearInterval(pollInterval)
      resolve({ connected })
    }

    const messageHandler = (e: MessageEvent) => {
      if (e.data?.type === 'supabase-connected') {
        // Verify with backend (avoid false positives from spoofed messages)
        getStatus()
          .then(s => { if (s.connected) finish(true) })
          .catch(() => { /* keep polling */ })
      }
    }
    window.addEventListener('message', messageHandler)

    // Poll backend status every 2s — ONLY source of truth.
    // Do NOT check popup.closed — that can false-positive during cross-origin nav,
    // AND the popup stays open intentionally (user closes when ready).
    const pollInterval = setInterval(async () => {
      if (settled) return

      try {
        const s = await getStatus()
        if (s.connected) {
          finish(true)
          return
        }
      } catch { /* network blip, keep polling */ }

      // Hard timeout
      if (Date.now() - startTime > MAX_WAIT) {
        try {
          const final = await getStatus()
          finish(final.connected)
        } catch {
          finish(false)
        }
      }
    }, 2000)
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
