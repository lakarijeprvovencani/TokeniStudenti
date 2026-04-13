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
 */
export async function startOAuthFlow(): Promise<void> {
  const { url } = await api<{ url: string }>('/auth/supabase/start')

  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'supabase-oauth', 'width=720,height=820')
    if (!popup) {
      reject(new Error('Pop-up blokiran. Dozvoli pop-up prozore i pokušaj ponovo.'))
      return
    }

    const messageHandler = (e: MessageEvent) => {
      if (e.data?.type === 'supabase-connected') {
        cleanup()
        resolve()
      }
    }

    const checkClosed = setInterval(() => {
      if (popup.closed) {
        cleanup()
        // Try to fetch status to see if it actually succeeded
        getStatus().then(s => {
          if (s.connected) resolve()
          else reject(new Error('Povezivanje otkazano'))
        }).catch(() => reject(new Error('Povezivanje otkazano')))
      }
    }, 500)

    function cleanup() {
      window.removeEventListener('message', messageHandler)
      clearInterval(checkClosed)
    }

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
