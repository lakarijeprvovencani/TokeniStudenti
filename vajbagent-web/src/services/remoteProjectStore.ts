/**
 * Remote project persistence — talks to vajbagent.com backend.
 * Type-compatible with the IndexedDB projectStore so callers can swap freely.
 */

import type { SavedProject } from './projectStore'

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    let msg = `HTTP ${resp.status}`
    try { const p = JSON.parse(text); msg = p.error || p.message || msg } catch { if (text) msg = text }
    throw new Error(msg)
  }
  return resp.json()
}

export interface ProjectSummary {
  id: string
  name: string
  model: string
  prompt?: string
  createdAt: number
  updatedAt: number
  fileCount: number
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await api<{ projects: ProjectSummary[] }>('/api/projects')
  return data.projects || []
}

export async function loadProject(id: string): Promise<SavedProject | null> {
  try {
    const data = await api<{ project: SavedProject }>(`/api/projects/${encodeURIComponent(id)}`)
    return data.project || null
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null
    throw err
  }
}

export async function saveProject(project: SavedProject): Promise<void> {
  await api(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    body: JSON.stringify(project),
  })
}

export async function createProject(project: SavedProject): Promise<void> {
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify(project),
  })
}

export async function deleteProject(id: string): Promise<void> {
  await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export interface UploadSignResult {
  uploadUrl: string
  publicUrl: string
  r2Key: string
}

export async function signUpload(projectId: string, filePath: string, contentType: string, sizeBytes: number): Promise<UploadSignResult> {
  return api<UploadSignResult>(`/api/projects/${encodeURIComponent(projectId)}/uploads/sign`, {
    method: 'POST',
    body: JSON.stringify({ path: filePath, contentType, sizeBytes }),
  })
}

export async function commitUpload(projectId: string, r2Key: string, filePath: string): Promise<{ url: string }> {
  return api<{ url: string }>(`/api/projects/${encodeURIComponent(projectId)}/uploads/commit`, {
    method: 'POST',
    body: JSON.stringify({ r2Key, filePath }),
  })
}

export { generateProjectId } from './projectStore'
