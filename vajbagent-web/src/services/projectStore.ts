/**
 * Project persistence using IndexedDB — scoped per user.
 *
 * Each authenticated user gets their own database, named
 * `vajbagent-projects::<userId>`, so two people sharing the same
 * browser profile cannot see each other's projects. The legacy
 * unscoped `vajbagent-projects` database is migrated once into the
 * current user's scoped DB on first access, so existing users don't
 * lose anything when this change ships.
 *
 * Anonymous visitors (no userId set) have no DB access at all — all
 * operations resolve to empty / no-op so the UI never writes project
 * data before we know who it belongs to.
 */

import { getScope, onScopeChange } from './storageScope'

const LEGACY_DB_NAME = 'vajbagent-projects'
const DB_VERSION = 1
const STORE_NAME = 'projects'

function scopedDbName(): string | null {
  const scope = getScope()
  if (!scope) return null
  return `${LEGACY_DB_NAME}::${scope}`
}

// Cached open handle per scope so we don't reopen on every call.
let cachedDb: { name: string; db: IDBDatabase } | null = null

// Remember which scopes we have already tried to migrate so we don't
// re-copy legacy rows every time.
const migratedScopes = new Set<string>()

// On scope change, drop the cached handle so the next call opens the new DB.
onScopeChange(() => {
  if (cachedDb) {
    try { cachedDb.db.close() } catch { /* ignore */ }
    cachedDb = null
  }
})

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

function openDbByName(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION)
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

/**
 * One-shot migration from the legacy unscoped DB into the current user's
 * scoped DB. Runs at most once per (scope, session) combination. We only
 * copy rows when the scoped DB is empty so re-running the app on a
 * secondary user never pulls in the first user's projects.
 */
async function migrateLegacyIfNeeded(scopedName: string, db: IDBDatabase): Promise<void> {
  const scope = getScope()
  if (!scope) return
  if (migratedScopes.has(scope)) return
  migratedScopes.add(scope)

  // Check: is the scoped DB empty? If not, skip migration.
  const scopedCount = await new Promise<number>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).count()
      req.onsuccess = () => resolve(req.result || 0)
      req.onerror = () => resolve(0)
    } catch { resolve(0) }
  })
  if (scopedCount > 0) return

  // Try to open the legacy DB. If it doesn't exist, nothing to migrate.
  let legacyDb: IDBDatabase
  try {
    legacyDb = await openDbByName(LEGACY_DB_NAME)
  } catch { return }

  try {
    const rows = await new Promise<SavedProject[]>((resolve) => {
      try {
        const tx = legacyDb.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).getAll()
        req.onsuccess = () => resolve(req.result || [])
        req.onerror = () => resolve([])
      } catch { resolve([]) }
    })
    if (rows.length === 0) return

    // Copy all legacy rows into the scoped DB under a single write tx.
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        for (const row of rows) store.put(row)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      } catch { resolve() }
    })
    console.log(`[projectStore] Migrated ${rows.length} legacy project(s) → ${scopedName}`)
  } finally {
    try { legacyDb.close() } catch { /* ignore */ }
  }
}

async function openDB(): Promise<IDBDatabase | null> {
  const name = scopedDbName()
  if (!name) return null
  if (cachedDb && cachedDb.name === name) return cachedDb.db
  const db = await openDbByName(name)
  cachedDb = { name, db }
  await migrateLegacyIfNeeded(name, db)
  return db
}

/** Save (create or update) a project */
export async function saveProject(project: SavedProject): Promise<void> {
  const db = await openDB()
  if (!db) return
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
  if (!db) return null
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
  if (!db) return []
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
  if (!db) return
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
