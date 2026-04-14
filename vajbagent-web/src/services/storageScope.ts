/**
 * Per-user scoping for browser-side storage (IndexedDB, localStorage).
 *
 * Without scoping, two users sharing a browser profile would see each
 * other's saved projects, env secrets, and last-active-project pointer.
 * Every storage helper (projectStore, secretsStore, App auto-resume)
 * reads the current scope through this module and prefixes its keys so
 * data is isolated per student_key_id.
 *
 * Lifecycle:
 *   - On session detect / login: call setScope(userId)
 *   - On logout: call clearScope() (data stays on disk, just hidden)
 *   - Anonymous visitors have scope=null — storage operations become
 *     no-ops so an unauthenticated page never writes anything.
 */

let currentScope: string | null = null
const listeners = new Set<(scope: string | null) => void>()

export function setScope(userId: string | null): void {
  if (currentScope === userId) return
  currentScope = userId
  listeners.forEach(fn => {
    try { fn(userId) } catch { /* ignore listener errors */ }
  })
}

export function getScope(): string | null {
  return currentScope
}

export function requireScope(): string | null {
  return currentScope
}

/** Notify when the scope changes (used by stores to flush caches). */
export function onScopeChange(fn: (scope: string | null) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Build a scoped key for localStorage. Returns null if no user yet. */
export function scopedKey(base: string): string | null {
  if (!currentScope) return null
  return `${base}::${currentScope}`
}

/** Legacy key used before per-user scoping was introduced. */
export function legacyKey(base: string): string {
  return base
}

/**
 * Drop-in localStorage wrapper that auto-scopes keys with the current user
 * id. Reads fall back to the legacy unscoped key for one-time migration
 * compatibility: if the scoped key is missing but the legacy value exists,
 * we copy it into the scoped slot and delete the legacy copy. Anonymous
 * visitors (no scope yet) get empty reads and no-op writes so an
 * unauthenticated page never stores per-user data.
 */
export const scopedStorage = {
  get(base: string): string | null {
    const scope = currentScope
    if (!scope) return null
    const scopedSlot = `${base}::${scope}`
    try {
      const scoped = localStorage.getItem(scopedSlot)
      if (scoped !== null) return scoped
      const legacy = localStorage.getItem(base)
      if (legacy !== null) {
        // Migrate once
        try {
          localStorage.setItem(scopedSlot, legacy)
          localStorage.removeItem(base)
        } catch { /* ignore */ }
        return legacy
      }
      return null
    } catch { return null }
  },
  set(base: string, value: string): void {
    const scope = currentScope
    if (!scope) return
    try { localStorage.setItem(`${base}::${scope}`, value) } catch { /* ignore */ }
  },
  remove(base: string): void {
    const scope = currentScope
    if (!scope) return
    try {
      localStorage.removeItem(`${base}::${scope}`)
      // Also wipe any legacy value so it can't leak back in a later read.
      localStorage.removeItem(base)
    } catch { /* ignore */ }
  },
}
