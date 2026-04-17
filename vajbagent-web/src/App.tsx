import { useState, useCallback, useEffect, Component, type ReactNode, type ErrorInfo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Welcome from './components/Welcome'
import LoadingTransition from './components/LoadingTransition'
import IDELayout from './components/IDELayout'
import { DEFAULT_MODEL } from './models'
import { type UserInfo, fetchUserInfo } from './services/userService'
import { type SavedProject, loadProject as loadProjectLocal, listProjects as listProjectsLocal } from './services/projectStore'
import { loadProject as loadProjectRemote, listProjects as listProjectsRemote, saveProject as saveProjectRemote } from './services/remoteProjectStore'
import { uploadAllImagesToR2 } from './services/userAssets'
import { getScope } from './services/storageScope'
import { preboot as prebootWebContainer } from './services/webcontainer'
import './App.css'

type AppState = 'booting' | 'welcome' | 'loading' | 'ide'

const LAST_PROJECT_KEY_BASE = 'vajb_last_active_project'
const LEGACY_LAST_PROJECT_KEY = 'vajb_last_active_project'

/**
 * Scoped last-project pointer. Before per-user scoping, this was a single
 * global key in localStorage — two users sharing a browser could auto-resume
 * into each other's IDE. We now prefix it with the authenticated user id so
 * every user has their own pointer. Returns null for anonymous visitors.
 */
function lastProjectKey(): string | null {
  const scope = getScope()
  if (!scope) return null
  return `${LAST_PROJECT_KEY_BASE}::${scope}`
}
function readLastProjectId(): string | null {
  const k = lastProjectKey()
  if (!k) return null
  try {
    const scoped = localStorage.getItem(k)
    if (scoped) return scoped
    // Migrate: legacy unscoped pointer → scoped (once)
    const legacy = localStorage.getItem(LEGACY_LAST_PROJECT_KEY)
    if (legacy) {
      localStorage.setItem(k, legacy)
      localStorage.removeItem(LEGACY_LAST_PROJECT_KEY)
      return legacy
    }
    return null
  } catch { return null }
}
function writeLastProjectId(id: string): void {
  const k = lastProjectKey()
  if (!k) return
  try { localStorage.setItem(k, id) } catch { /* ignore */ }
}
function clearLastProjectId(): void {
  const k = lastProjectKey()
  try {
    if (k) localStorage.removeItem(k)
    // Always also wipe the legacy key so it can't sneak back in.
    localStorage.removeItem(LEGACY_LAST_PROJECT_KEY)
  } catch { /* ignore */ }
}

// Error boundary — last line of defence against the whole tree dying to a
// runtime exception and leaving the user staring at a black screen.
class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[VajbAgent] Render crashed:', error, info)
    // Clear potentially-corrupt auto-resume pointer so next reload starts
    // clean. We don't know the user id here so clear both the legacy
    // unscoped key and any scoped variants we can find.
    try {
      localStorage.removeItem(LEGACY_LAST_PROJECT_KEY)
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith(LAST_PROJECT_KEY_BASE + '::')) localStorage.removeItem(k)
      }
    } catch { /* ignore */ }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'radial-gradient(circle at top, #1a1a1f, #0a0a0d)', color: '#fff',
          fontFamily: 'Inter, system-ui, sans-serif', padding: 24, textAlign: 'center',
        }}>
          <div style={{ maxWidth: 460 }}>
            <div style={{
              width: 64, height: 64, borderRadius: 18, margin: '0 auto 18px',
              background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28, color: '#ef4444',
            }}>⚠</div>
            <h1 style={{ fontSize: '1.25rem', marginBottom: 10 }}>Nešto je puklo</h1>
            <p style={{ fontSize: '0.9rem', color: '#aaa', lineHeight: 1.55, marginBottom: 22 }}>
              Osvežavanje stranice obično pomaže. Ako se ponovo desi, pošalji poruku podršci.
            </p>
            <button
              onClick={() => {
                try {
                  localStorage.removeItem(LEGACY_LAST_PROJECT_KEY)
                  for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i)
                    if (k && k.startsWith(LAST_PROJECT_KEY_BASE + '::')) localStorage.removeItem(k)
                  }
                } catch { /* ignore */ }
                window.location.reload()
              }}
              style={{
                padding: '11px 22px', background: 'linear-gradient(135deg, #f97316, #ea580c)',
                color: '#fff', border: 'none', borderRadius: 10, fontSize: '0.9rem',
                fontWeight: 600, cursor: 'pointer',
              }}
            >
              Osveži i počni iznova
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

interface AttachedImage { name: string; dataUrl: string }

function AppInner() {
  const [state, setState] = useState<AppState>('booting')
  const [prompt, setPrompt] = useState('')
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [resumeProject, setResumeProject] = useState<SavedProject | null>(null)
  const [migrationBanner, setMigrationBanner] = useState<{ count: number; running: boolean } | null>(null)

  // Warm the WebContainer as soon as the app mounts — this runs in parallel
  // with user auth, project list fetch, and the user typing their first prompt.
  // By the time they hit Send, WC is usually already booted, shaving 3-8s off
  // first-run preview time. preboot() is idempotent so re-calling it from
  // IDELayout is cheap.
  useEffect(() => {
    prebootWebContainer()
  }, [])

  const migrateLocalProjects = useCallback(async () => {
    setMigrationBanner(prev => prev ? { ...prev, running: true } : null)
    try {
      const locals = await listProjectsLocal()
      let migrated = 0
      for (const proj of locals) {
        try {
          const cloudFiles = await uploadAllImagesToR2(proj.id, proj.files)
          await saveProjectRemote({ ...proj, files: cloudFiles })
          migrated++
        } catch (err) {
          console.warn('[Migration] Failed for', proj.id, err)
        }
      }
      console.log(`[Migration] Done: ${migrated}/${locals.length}`)
    } finally {
      setMigrationBanner(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      const userInfo = await fetchUserInfo().catch(() => null)
      if (cancelled) return
      if (!userInfo) {
        clearLastProjectId()
        setState('welcome')
        return
      }
      setUser(userInfo)

      // Check for local projects that aren't in the cloud yet
      try {
        const [locals, remotes] = await Promise.all([
          listProjectsLocal().catch(() => [] as SavedProject[]),
          listProjectsRemote().catch(() => []),
        ])
        if (locals.length > 0 && remotes.length === 0) {
          setMigrationBanner({ count: locals.length, running: false })
        }
      } catch { /* ignore */ }

      const lastId = readLastProjectId()
      if (!lastId) {
        setState('welcome')
        return
      }
      try {
        let project: SavedProject | null = null
        try {
          project = await loadProjectRemote(lastId)
        } catch {
          project = await loadProjectLocal(lastId)
        }
        if (cancelled) return
        if (project && (Object.keys(project.files || {}).length > 0 || (project.chatHistory && project.chatHistory.length > 0))) {
          setResumeProject(project)
          setModel(project.model)
          setState('ide')
        } else {
          clearLastProjectId()
          setState('welcome')
        }
      } catch (err) {
        console.warn('[App] Resume load failed:', err)
        clearLastProjectId()
        setState('welcome')
      }
    }
    boot()
    return () => { cancelled = true }
  }, [])

  // Free tier users keep the default Max model so their first build
  // experience is the "wow" Lovable/Bolt-style demo — they have $2 of
  // signup credit which comfortably covers 4-6 full Max builds. If they
  // had previously picked a locked tier (Power/Ultra/Architect) before
  // going free, we drop them back to Max instead of Lite. See backend
  // FREE_TIER_ALLOWED set in src/index.js for the authoritative gate.
  useEffect(() => {
    if (!user?.freeTier) return
    const FREE_OK = new Set(['vajb-agent-lite', 'vajb-agent-turbo', 'vajb-agent-pro', 'vajb-agent-max'])
    if (!FREE_OK.has(model)) setModel('vajb-agent-max')
  }, [user?.freeTier])

  const handleAuth = useCallback((userInfo: UserInfo) => {
    setUser(userInfo)
  }, [])

  const handleStart = (text: string, images: AttachedImage[] = []) => {
    setResumeProject(null)
    setPrompt(text)
    setPendingImages(images)
    setState('loading')
    // Clear until IDELayout creates its new project; it will save under a new id
    clearLastProjectId()
  }

  const handleResume = async (projectOrSummary: SavedProject) => {
    writeLastProjectId(projectOrSummary.id)
    let full: SavedProject | null = null
    try {
      full = await loadProjectRemote(projectOrSummary.id)
    } catch { /* fallback */ }
    if (!full) {
      try { full = await loadProjectLocal(projectOrSummary.id) } catch { /* ignore */ }
    }
    if (!full) full = projectOrSummary
    setResumeProject(full)
    setPrompt('')
    setPendingImages([])
    setModel(full.model || projectOrSummary.model)
    setState('ide')
  }

  const handleLoadingComplete = useCallback(() => {
    setState('ide')
  }, [])

  const handleBackToWelcome = useCallback(() => {
    setResumeProject(null)
    setPrompt('')
    clearLastProjectId()
    setState('welcome')
  }, [])

  const freeTier = user?.freeTier ?? true

  return (
    <>
    {migrationBanner && state === 'welcome' && (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
        background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
        color: '#fff', padding: '10px 20px', display: 'flex', alignItems: 'center',
        justifyContent: 'center', gap: 12, fontSize: '0.85rem', fontWeight: 500,
      }}>
        <span>
          {migrationBanner.running
            ? 'Prebacujem projekte u cloud...'
            : `Pronađeno ${migrationBanner.count} lokalni${migrationBanner.count === 1 ? '' : 'h'} projek${migrationBanner.count === 1 ? 'at' : 'ata'}. Prebaci u cloud?`}
        </span>
        {!migrationBanner.running && (
          <>
            <button onClick={migrateLocalProjects} style={{
              padding: '4px 14px', background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
            }}>Da, prebaci</button>
            <button onClick={() => setMigrationBanner(null)} style={{
              padding: '4px 14px', background: 'transparent', border: '1px solid rgba(255,255,255,0.3)',
              borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: '0.8rem',
            }}>Ne sad</button>
          </>
        )}
      </div>
    )}
    <AnimatePresence mode="wait">
      {state === 'booting' && (
        <motion.div
          key="booting"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          style={{
            position: 'fixed', inset: 0,
            background: '#0a0a0f',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            width: 28, height: 28,
            border: '2.5px solid rgba(255,255,255,0.1)',
            borderTopColor: '#FA7315',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
        </motion.div>
      )}

      {state === 'welcome' && (
        <motion.div
          key="welcome"
          exit={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <Welcome
            onStart={handleStart}
            onResume={handleResume}
            model={model}
            onModelChange={setModel}
            onAuth={handleAuth}
            user={user}
            freeTier={freeTier}
          />
        </motion.div>
      )}

      {state === 'loading' && (
        <motion.div
          key="loading"
          exit={{ opacity: 0, scale: 1.05, filter: 'blur(10px)' }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ position: 'fixed', inset: 0 }}
        >
          <LoadingTransition onComplete={handleLoadingComplete} />
        </motion.div>
      )}

      {state === 'ide' && (
        <motion.div
          key="ide"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          style={{ height: '100vh' }}
        >
          <IDELayout
            initialPrompt={prompt}
            initialImages={pendingImages}
            model={model}
            onModelChange={setModel}
            freeTier={freeTier}
            resumeProject={resumeProject}
            onBackToWelcome={handleBackToWelcome}
          />
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}

export default function App() {
  return (
    <RootErrorBoundary>
      <AppInner />
    </RootErrorBoundary>
  )
}
