import { useState, useCallback, useEffect, Component, type ReactNode, type ErrorInfo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Welcome from './components/Welcome'
import LoadingTransition from './components/LoadingTransition'
import IDELayout from './components/IDELayout'
import { DEFAULT_MODEL } from './models'
import { type UserInfo, fetchUserInfo } from './services/userService'
import { type SavedProject, loadProject } from './services/projectStore'
import { getScope } from './services/storageScope'
import './App.css'

type AppState = 'welcome' | 'loading' | 'ide'

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
  const [state, setState] = useState<AppState>('welcome')
  const [prompt, setPrompt] = useState('')
  const [pendingImages, setPendingImages] = useState<AttachedImage[]>([])
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [resumeProject, setResumeProject] = useState<SavedProject | null>(null)

  // On mount: check if the backend still recognises our session. If yes and
  // there's a last-active project, auto-resume into IDE. If not (logged out,
  // or stale cookie from before a Redis restart), stay on welcome and clear
  // the auto-resume pointer so stale projects can't boot us into a broken IDE.
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      // First: verify session
      const userInfo = await fetchUserInfo().catch(() => null)
      if (cancelled) return
      if (!userInfo) {
        // Not authenticated — drop any stale auto-resume pointer and stay on welcome
        clearLastProjectId()
        return
      }
      setUser(userInfo)

      // Authenticated: try to resume last project (scoped to this user)
      const lastId = readLastProjectId()
      if (!lastId) return
      try {
        const project = await loadProject(lastId)
        if (cancelled) return
        if (project && (Object.keys(project.files || {}).length > 0 || (project.chatHistory && project.chatHistory.length > 0))) {
          setResumeProject(project)
          setModel(project.model)
          setState('ide')
        } else {
          // Empty / missing project — clean up pointer
          clearLastProjectId()
        }
      } catch (err) {
        console.warn('[App] Resume load failed:', err)
        clearLastProjectId()
      }
    }
    boot()
    return () => { cancelled = true }
  }, [])

  // Auto-select Lite for free tier users
  useEffect(() => {
    if (user?.freeTier && model !== 'vajb-agent-lite') {
      setModel('vajb-agent-lite')
    }
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

  const handleResume = (project: SavedProject) => {
    setResumeProject(project)
    setPrompt('')
    setPendingImages([])
    setModel(project.model)
    writeLastProjectId(project.id)
    // Skip loading animation for resume — go straight to IDE
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
    <AnimatePresence mode="wait">
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
  )
}

export default function App() {
  return (
    <RootErrorBoundary>
      <AppInner />
    </RootErrorBoundary>
  )
}
