/**
 * Netlify OAuth integration — talks to vajbagent.com backend.
 */

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
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
    try { const p = JSON.parse(text); msg = p.error || p.message || msg } catch { if (text) msg = text }
    throw new Error(msg)
  }
  return resp.json()
}

export interface NetlifyConnectionInfo {
  email: string | null
  full_name: string | null
}

export interface NetlifyStatus {
  connected: boolean
  configured: boolean
  info: NetlifyConnectionInfo | null
}

export interface NetlifySite {
  id: string
  name: string
  url: string
  ssl_url?: string
  admin_url?: string
  updated_at?: string
}

export interface NetlifyDeployResult {
  site_id: string
  deploy_id: string
  url: string
  deploy_url: string
  state: string
}

export async function getStatus(): Promise<NetlifyStatus> {
  return api('/api/netlify/status')
}

export async function startOAuthFlow(): Promise<{ connected: boolean }> {
  const { url } = await api<{ url: string }>('/auth/netlify/start')

  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'netlify-oauth', 'width=760,height=860,menubar=no,toolbar=no')
    if (!popup) {
      reject(new Error('Pop-up blokiran. Dozvoli pop-up prozore.'))
      return
    }

    let settled = false
    const startTime = Date.now()
    const MAX_WAIT = 300_000

    function finish(connected: boolean) {
      if (settled) return
      settled = true
      window.removeEventListener('message', messageHandler)
      clearInterval(pollInterval)
      resolve({ connected })
    }

    const messageHandler = (e: MessageEvent) => {
      if (e.data?.type === 'netlify-connected') {
        getStatus().then(s => { if (s.connected) finish(true) }).catch(() => {})
      }
    }
    window.addEventListener('message', messageHandler)

    const pollInterval = setInterval(async () => {
      if (settled) return
      try {
        const s = await getStatus()
        if (s.connected) { finish(true); return }
      } catch { /* keep polling */ }

      if (Date.now() - startTime > MAX_WAIT) {
        try {
          const final = await getStatus()
          finish(final.connected)
        } catch { finish(false) }
      }
    }, 2000)
  })
}

export async function disconnect(): Promise<void> {
  await api('/api/netlify/disconnect', { method: 'POST' })
}

export async function listSites(): Promise<NetlifySite[]> {
  const data = await api<{ sites: NetlifySite[] }>('/api/netlify/sites')
  return data.sites || []
}

export async function deploySite(opts: {
  files: Record<string, string>
  siteId?: string
  siteName?: string
}): Promise<NetlifyDeployResult> {
  const data = await api<{ result: NetlifyDeployResult }>('/api/netlify/deploy', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
  return data.result
}
