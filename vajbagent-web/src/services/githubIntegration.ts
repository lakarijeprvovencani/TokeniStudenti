/**
 * GitHub OAuth integration — talks to vajbagent.com backend.
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

export interface GitHubConnectionInfo {
  username: string | null
  name: string | null
  avatar_url: string | null
}

export interface GitHubStatus {
  connected: boolean
  configured: boolean
  info: GitHubConnectionInfo | null
}

export interface GitHubRepo {
  id: number
  name: string
  full_name: string
  private: boolean
  html_url: string
  description: string | null
  default_branch: string
  updated_at: string
}

export interface GitHubPushResult {
  owner: string
  repo: string
  branch: string
  commit_sha: string
  url: string
  files_count: number
}

export async function getStatus(): Promise<GitHubStatus> {
  return api('/api/github/status')
}

export async function startOAuthFlow(): Promise<{ connected: boolean }> {
  const { url } = await api<{ url: string }>('/auth/github/start')

  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'github-oauth', 'width=760,height=860,menubar=no,toolbar=no')
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
      if (e.data?.type === 'github-connected') {
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
  await api('/api/github/disconnect', { method: 'POST' })
}

export async function listRepos(): Promise<GitHubRepo[]> {
  const data = await api<{ repos: GitHubRepo[] }>('/api/github/repos')
  return data.repos || []
}

export async function pushFiles(opts: {
  repo: string
  files: Record<string, string>
  message?: string
  branch?: string
  createIfMissing?: boolean
}): Promise<GitHubPushResult> {
  const data = await api<{ result: GitHubPushResult }>('/api/github/push', {
    method: 'POST',
    body: JSON.stringify(opts),
  })
  return data.result
}
