/**
 * Project persistence using IndexedDB.
 * Stores files, chat history, and metadata for each project.
 * Survives page refresh, browser restart, etc.
 */

const DB_NAME = 'vajbagent-projects'
const DB_VERSION = 1
const STORE_NAME = 'projects'

export interface SavedProject {
  id: string
  name: string
  files: Record<string, string>
  chatHistory: unknown[]       // Message[] from ChatPanel
  displayMessages: unknown[]   // DisplayMessage[] from ChatPanel
  model: string
  createdAt: number
  updatedAt: number
  /** First line of initial prompt — used as subtitle */
  prompt?: string
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Save (create or update) a project */
export async function saveProject(project: SavedProject): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(project)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Load a project by ID */
export async function loadProject(id: string): Promise<SavedProject | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(id)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

/** List all projects, sorted by updatedAt descending (newest first) */
export async function listProjects(): Promise<SavedProject[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).index('updatedAt').openCursor(null, 'prev')
    const results: SavedProject[] = []
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        results.push(cursor.value)
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Delete a project by ID */
export async function deleteProject(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Generate a unique project ID */
export function generateProjectId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
