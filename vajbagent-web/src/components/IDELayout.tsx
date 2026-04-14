import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Settings as SettingsIcon, Download, Rocket,
  Sparkles, User, Zap, ChevronLeft, ChevronRight,
  Terminal, GitBranch, Wallet, LogOut, Copy, Check, Home, Loader2, ExternalLink, X, ChevronDown, Globe, RefreshCw,
} from 'lucide-react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import * as ghInt from '../services/githubIntegration'
import * as nlInt from '../services/netlifyIntegration'
import { preboot, onServerReady, getServerUrl, writeFile as wcWriteFile, clearFilesystem } from '../services/webcontainer'
import { buildEnvFile } from '../services/secretsStore'
import { filterForPush, ensureGitignoreSafety, DEFAULT_GITIGNORE, scanForSecrets, redactSecrets, type SecretFinding } from '../services/pushFilter'
import { fetchUserInfo, logout, revealApiKey, type UserInfo } from '../services/userService'
import { saveProject, generateProjectId, type SavedProject } from '../services/projectStore'
import FileExplorer from './FileExplorer'
import Settings from './Settings'
import GitHubPushModal from './GitHubPushModal'
import NetlifyDeployModal from './NetlifyDeployModal'
import SecretWarningModal from './SecretWarningModal'
import CodeEditor from './CodeEditor'
import PreviewPanel from './PreviewPanel'
import ChatPanel from './ChatPanel'
import TerminalPanel from './Terminal'
import './IDELayout.css'

interface IDELayoutProps {
  initialPrompt: string
  model: string
  onModelChange: (model: string) => void
  freeTier?: boolean
  resumeProject?: SavedProject | null
  onBackToWelcome?: () => void
}

const panelVariants = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] } },
  exit: { opacity: 0, scale: 0.98, transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] } },
}

export default function IDELayout({ initialPrompt, model, onModelChange, freeTier, resumeProject, onBackToWelcome }: IDELayoutProps) {
  const [files, setFiles] = useState<Record<string, string>>({})
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [contextUsed, setContextUsed] = useState(0)
  const [contextLimit, setContextLimit] = useState(0)
  const [isAgentStreaming, setIsAgentStreaming] = useState(false)
  const [agentStatus, setAgentStatus] = useState('')
  const [showPreviewReady, setShowPreviewReady] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
  const selectionRef = useRef<string | null>(null)

  // ─── Project persistence ──────────────────────────────────────────────────
  const projectIdRef = useRef<string>(resumeProject?.id || generateProjectId())
  const projectNameRef = useRef<string>(resumeProject?.name || '')
  const projectPromptRef = useRef<string>(resumeProject?.prompt || initialPrompt)
  const projectCreatedAtRef = useRef<number>(resumeProject?.createdAt || Date.now())
  const chatHistoryRef = useRef<unknown[]>(resumeProject?.chatHistory || [])
  const displayMessagesRef = useRef<unknown[]>(resumeProject?.displayMessages || [])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filesRef = useRef(files)
  filesRef.current = files

  // Auto-derive project name from first user message or prompt
  const deriveProjectName = useCallback((prompt: string) => {
    if (projectNameRef.current) return // already set
    const name = prompt.slice(0, 60).replace(/\n/g, ' ').trim()
    if (name) projectNameRef.current = name
  }, [])

  // Set initial name from prompt
  useEffect(() => {
    if (initialPrompt) deriveProjectName(initialPrompt)
    if (resumeProject?.name) projectNameRef.current = resumeProject.name
  }, [])

  // Filter out build artifacts, keeping source files + small build HTML/CSS for instant preview on resume
  const SKIP_PATTERNS = /^(\.next\/|node_modules\/|\.cache\/|\.turbo\/|coverage\/)/
  const SKIP_EXTENSIONS = /\.(pack|map|d\.ts|tsbuildinfo)$/

  function filterSourceFiles(allFiles: Record<string, string>): Record<string, string> {
    const filtered: Record<string, string> = {}
    for (const [path, content] of Object.entries(allFiles)) {
      if (SKIP_PATTERNS.test(path)) continue
      if (SKIP_EXTENSIONS.test(path)) continue

      // For build output dirs (dist/, out/): keep HTML + CSS, skip large JS bundles
      const isBuildFile = /^(dist|out)\//.test(path)
      if (isBuildFile) {
        if (path.endsWith('.html') || path.endsWith('.css')) {
          // Keep HTML and CSS for preview (they're small)
          filtered[path] = content
        }
        // Skip JS bundles, images, source maps in build output
        continue
      }

      // Skip very large files (likely minified bundles)
      if (content.length > 100000) continue
      filtered[path] = content
    }
    return filtered
  }

  // Auto-save project (debounced 5s)
  const triggerAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const currentFiles = filesRef.current
      // Only save if there are files or chat messages
      if (Object.keys(currentFiles).length === 0 && chatHistoryRef.current.length === 0) return

      const sourceFiles = filterSourceFiles(currentFiles)
      saveProject({
        id: projectIdRef.current,
        name: projectNameRef.current || 'Novi projekat',
        files: sourceFiles,
        chatHistory: chatHistoryRef.current,
        displayMessages: displayMessagesRef.current,
        model,
        createdAt: projectCreatedAtRef.current,
        updatedAt: Date.now(),
        prompt: projectPromptRef.current,
      })
        .then(() => localStorage.setItem('vajb_last_active_project', projectIdRef.current))
        .catch(err => console.warn('[AutoSave] Failed:', err))
    }, 5000)
  }, [model])

  // Trigger save when files change
  useEffect(() => {
    triggerAutoSave()
  }, [files, triggerAutoSave])

  // Save on unload
  useEffect(() => {
    const handleUnload = () => {
      const currentFiles = filesRef.current
      if (Object.keys(currentFiles).length === 0 && chatHistoryRef.current.length === 0) return
      // Sync save before unload (best effort)
      const sourceFiles = filterSourceFiles(currentFiles)
      const data = JSON.stringify({
        id: projectIdRef.current,
        name: projectNameRef.current || 'Novi projekat',
        files: sourceFiles,
        chatHistory: chatHistoryRef.current,
        displayMessages: displayMessagesRef.current,
        model,
        createdAt: projectCreatedAtRef.current,
        updatedAt: Date.now(),
        prompt: projectPromptRef.current,
      })
      // Use localStorage as emergency backup (IndexedDB may not complete)
      localStorage.setItem('vajb_unsaved_project', data)
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [model])

  // Callback for ChatPanel to sync history for persistence
  const handleChatHistoryUpdate = useCallback((history: unknown[], displayMsgs: unknown[]) => {
    chatHistoryRef.current = history
    displayMessagesRef.current = displayMsgs
    triggerAutoSave()
  }, [triggerAutoSave])

  // ─── Resume project: restore files to WebContainers ───────────────────────
  const GOOD_ACTIVE_FILE = /\.(tsx?|jsx?|css|html)$/

  useEffect(() => {
    if (!resumeProject?.files) return
    const restoreFiles = async () => {
      const entries = Object.entries(resumeProject.files)
      if (entries.length === 0) return

      console.log('[Resume] Restoring', entries.length, 'files to WebContainers')
      for (const [path, content] of entries) {
        if (path.endsWith('/')) continue
        try {
          await wcWriteFile(path, content)
        } catch (err) {
          console.warn('[Resume] Failed to write:', path, err)
        }
      }
      setFiles(resumeProject.files)
      // Set active file to a real source file (prefer App.tsx, index.html, etc.)
      const preferred = ['src/App.tsx', 'src/App.jsx', 'src/main.tsx', 'index.html', 'pages/index.tsx', 'pages/index.jsx', 'app/page.tsx']
      const activeCandidate =
        preferred.find(p => resumeProject.files[p]) ||
        entries.find(([p]) => GOOD_ACTIVE_FILE.test(p) && !p.includes('node_modules') && !p.startsWith('dist/') && !p.startsWith('out/') && !p.startsWith('.next/'))?.[0]
      if (activeCandidate) setActiveFile(activeCandidate)
      console.log('[Resume] Files restored, active:', activeCandidate)
    }
    restoreFiles()
  }, [resumeProject])

  // ─── Standard hooks ───────────────────────────────────────────────────────
  // Clear filesystem for new projects (not resume)
  useEffect(() => {
    if (!resumeProject) {
      clearFilesystem().catch(() => {})
    }
  }, [])
  useEffect(() => { preboot() }, [])

  // Inject user's env secrets into WebContainers as .env file.
  // Runs on mount AND whenever secrets change (via storage event or custom event).
  // Also retries if WebContainers isn't ready yet.
  useEffect(() => {
    let cancelled = false
    const syncEnv = async () => {
      const envContent = buildEnvFile()
      if (!envContent) return
      try {
        await preboot()
        if (cancelled) return
        await wcWriteFile('.env', envContent)
        if (cancelled) return
        setFiles(prev => (prev['.env'] === envContent ? prev : { ...prev, '.env': envContent }))
      } catch (err) {
        console.warn('[Env] Failed to write .env:', err)
      }
    }
    syncEnv()
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'vajb_env_secrets') syncEnv()
    }
    const onCustom = () => syncEnv()
    window.addEventListener('storage', onStorage)
    window.addEventListener('vajb-secrets-changed', onCustom as EventListener)
    return () => {
      cancelled = true
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('vajb-secrets-changed', onCustom as EventListener)
    }
  }, [])
  useEffect(() => {
    fetchUserInfo().then(info => { if (info) setUserInfo(info) })
    ghInt.getStatus().then(s => {
      setGhConnected(s.connected)
      setGhUsername(s.info?.username || null)
    }).catch(() => {})
    nlInt.getStatus().then(s => setNlConnected(s.connected)).catch(() => {})
  }, [])

  const [hasDevServer, setHasDevServer] = useState(!!getServerUrl())

  // Listen for dev server ready — auto-switch to preview with animation
  useEffect(() => {
    if (getServerUrl()) { setHasDevServer(true); return }
    const unsub = onServerReady(() => {
      setHasDevServer(true)
      setShowPreviewReady(true)
      setTimeout(() => {
        setShowPreviewReady(false)
        setView('preview')
      }, 1800)
    })
    return unsub
  }, [])

  const [view, setView] = useState<'code' | 'preview' | 'split'>('code')
  const [deploying, setDeploying] = useState(false)
  const [deployUrl, setDeployUrl] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [ghConnected, setGhConnected] = useState(false)
  const [ghUsername, setGhUsername] = useState<string | null>(null)
  const [ghModalOpen, setGhModalOpen] = useState(false)
  const [nlConnected, setNlConnected] = useState(false)
  const [nlSiteId, setNlSiteId] = useState<string | null>(null)
  const [nlModalOpen, setNlModalOpen] = useState(false)
  const [secretFindings, setSecretFindings] = useState<SecretFinding[]>([])
  const pendingPushRef = useRef<{ repo: string; message: string; kept: Record<string, string>; skipped: string[] } | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string; url?: string } | null>(null)
  const [deployMenuOpen, setDeployMenuOpen] = useState(false)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [keyCopied, setKeyCopied] = useState(false)

  const handleContextUpdate = useCallback((used: number, limit: number) => {
    setContextUsed(used)
    setContextLimit(limit)
  }, [])

  const handleFilesChanged = useCallback((newFiles: Record<string, string>) => {
    setFiles(newFiles)
    const fileNames = Object.keys(newFiles).filter(f => !f.endsWith('/'))
    if (fileNames.length > 0) {
      setActiveFile(fileNames[fileNames.length - 1])
    }
  }, [])

  const handleFileEdit = useCallback(async (path: string, content: string) => {
    setFiles(prev => ({ ...prev, [path]: content }))
    try {
      const { writeFile } = await import('../services/webcontainer')
      await writeFile(path, content)
    } catch (err) {
      console.warn('[Editor] Failed to write:', path, err)
    }
  }, [])

  // Manual file/folder management from explorer toolbar
  const handleCreateFile = useCallback(async (path: string, content: string) => {
    const cleanPath = path.replace(/^\/+/, '')
    if (!cleanPath) return
    if (filesRef.current[cleanPath]) {
      alert(`Fajl "${cleanPath}" već postoji.`)
      return
    }
    try {
      await wcWriteFile(cleanPath, content)
      setFiles(prev => ({ ...prev, [cleanPath]: content }))
    } catch (err) {
      console.warn('[Explorer] Failed to create:', cleanPath, err)
      alert('Greška pri kreiranju fajla: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const handleDeleteFile = useCallback(async (path: string) => {
    if (!confirm(`Obriši "${path}"?`)) return
    try {
      const { getWebContainer } = await import('../services/webcontainer')
      const wc = await getWebContainer()
      await wc.fs.rm(path)
      setFiles(prev => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      if (activeFile === path) {
        const remaining = Object.keys(filesRef.current).filter(f => f !== path && !f.endsWith('/'))
        setActiveFile(remaining[0] || null)
      }
    } catch (err) {
      console.warn('[Explorer] Failed to delete:', path, err)
      alert('Greška pri brisanju: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [activeFile])

  const handleRenameFile = useCallback(async (oldPath: string, newPath: string) => {
    if (oldPath === newPath) return
    if (filesRef.current[newPath]) {
      alert(`Fajl "${newPath}" već postoji.`)
      return
    }
    try {
      const content = filesRef.current[oldPath] || ''
      const { getWebContainer } = await import('../services/webcontainer')
      const wc = await getWebContainer()
      // mkdir for parent if needed, then write new, delete old
      const dir = newPath.substring(0, newPath.lastIndexOf('/'))
      if (dir) {
        try { await wc.fs.mkdir(dir, { recursive: true }) } catch { /* exists */ }
      }
      await wc.fs.writeFile(newPath, content)
      await wc.fs.rm(oldPath)
      setFiles(prev => {
        const next = { ...prev }
        delete next[oldPath]
        next[newPath] = content
        return next
      })
      if (activeFile === oldPath) setActiveFile(newPath)
    } catch (err) {
      console.warn('[Explorer] Rename failed:', err)
      alert('Greška pri preimenovanju: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [activeFile])

  const handleExplorerRefresh = useCallback(async () => {
    try {
      const { getAllFiles } = await import('../services/webcontainer')
      const all = await getAllFiles()
      setFiles(all)
    } catch (err) {
      console.warn('[Explorer] Refresh failed:', err)
    }
  }, [])

  const handleStreamingChange = useCallback((streaming: boolean) => {
    setIsAgentStreaming(streaming)
    // Refresh balance when streaming ends
    if (!streaming) {
      fetchUserInfo().then(info => { if (info) setUserInfo(info) })
    }
  }, [])

  const handleSelectionChange = useCallback((selection: string | null) => {
    selectionRef.current = selection
  }, [])

  const handleAgentDone = useCallback(() => {
    const currentFiles = Object.keys(filesRef.current)
    const hasHtmlNow = currentFiles.some(f => f.endsWith('.html'))
    const hasBuildNow = currentFiles.some(f => f === 'dist/index.html' || f === 'out/index.html')
    const hasServer = !!getServerUrl()
    if ((hasHtmlNow || hasBuildNow) && !hasServer) {
      setShowPreviewReady(true)
      setTimeout(() => {
        setShowPreviewReady(false)
        setView('preview')
      }, 1800)
    }
    // Derive name from first prompt if not set yet
    if (!projectNameRef.current && initialPrompt) {
      deriveProjectName(initialPrompt)
    }
  }, [initialPrompt, deriveProjectName])

  const hasHtml = Object.keys(files).some(f => f.endsWith('.html'))
  const hasBuildOutput = Object.keys(files).some(f => f === 'dist/index.html' || f === 'out/index.html')
  const hasPreview = hasHtml || hasDevServer || hasBuildOutput
  const hasFiles = Object.keys(files).filter(f => !f.endsWith('/')).length > 0
  const contextPercent = contextLimit > 0 ? contextUsed / contextLimit : 0
  // Orange brand scale — lighter at low usage, richer as it fills, red when critical
  const contextColor = contextPercent > 0.9 ? '#ef4444'
                     : contextPercent > 0.7 ? '#fb923c'
                     : '#f97316'

  // Gather deployable files: prefer build output (dist/ or out/) if present, else all source.
  // Applies the same security filter as GitHub push — .env is NEVER deployed publicly.
  const collectDeployFiles = (): Record<string, string> => {
    const all = filesRef.current
    const distFiles: Record<string, string> = {}
    const outFiles: Record<string, string> = {}
    for (const [p, c] of Object.entries(all)) {
      if (p.endsWith('/')) continue
      if (p.startsWith('dist/')) distFiles[p.slice(5)] = c
      else if (p.startsWith('out/')) outFiles[p.slice(4)] = c
    }
    // dist/ and out/ are build artifacts — already bundled, no .env there normally,
    // but run through filter anyway for safety
    if (Object.keys(distFiles).length > 0) return filterForPush(distFiles).kept
    if (Object.keys(outFiles).length > 0) return filterForPush(outFiles).kept
    return filterForPush(all).kept
  }

  const slugify = (s: string) =>
    s.toLowerCase().replace(/[čć]/g, 'c').replace(/š/g, 's').replace(/ž/g, 'z').replace(/đ/g, 'dj')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

  const handleDeploy = async () => {
    if (!nlConnected) {
      const status = await nlInt.getStatus().catch(() => null)
      if (!status?.connected) {
        setToast({ type: 'error', msg: 'Prvo poveži Netlify u Podešavanjima.' })
        setSettingsOpen(true)
        return
      }
      setNlConnected(true)
    }
    setNlModalOpen(true)
  }

  const doDeploy = async (opts: { siteId?: string; siteName?: string }) => {
    setDeploying(true)
    try {
      const deployFiles = collectDeployFiles()
      if (Object.keys(deployFiles).length === 0) {
        throw new Error('Nema fajlova za deploy.')
      }
      const result = await nlInt.deploySite({
        files: deployFiles,
        siteId: opts.siteId,
        siteName: opts.siteName,
      })
      setNlSiteId(result.site_id)
      setDeployUrl(result.url)
      setToast({ type: 'success', msg: 'Sajt je objavljen!', url: result.url })
      return { url: result.url, site_id: result.site_id }
    } finally {
      setDeploying(false)
    }
  }

  const handleGitHubPush = async () => {
    if (!ghConnected) {
      const status = await ghInt.getStatus().catch(() => null)
      if (!status?.connected) {
        setToast({ type: 'error', msg: 'Prvo poveži GitHub u Podešavanjima.' })
        setSettingsOpen(true)
        return
      }
      setGhConnected(true)
      setGhUsername(status.info?.username || null)
    }
    setGhModalOpen(true)
  }

  const executePush = async (repo: string, message: string, kept: Record<string, string>, secretSkips: string[]) => {
    // Auto-create or patch .gitignore so user's repo always has safe defaults
    const existingGitignore = kept['.gitignore']
    const patched = ensureGitignoreSafety(existingGitignore)
    if (patched !== null) {
      kept['.gitignore'] = patched
      try { await wcWriteFile('.gitignore', patched) } catch { /* not critical */ }
      setFiles(prev => ({ ...prev, '.gitignore': patched }))
    } else if (!existingGitignore) {
      kept['.gitignore'] = DEFAULT_GITIGNORE
    }

    const result = await ghInt.pushFiles({ repo, files: kept, message })
    const extraMsg = secretSkips.length > 0
      ? ` · Zaštićeno: ${secretSkips.join(', ')} nije push-ovano.`
      : ''
    setToast({
      type: 'success',
      msg: `Push-ovano na ${result.owner}/${result.repo}${extraMsg}`,
      url: result.url,
    })
  }

  const doGitHubPush = async (repo: string, message: string) => {
    setPushing(true)
    try {
      const { kept, skipped } = filterForPush(filesRef.current)
      const secretSkips = skipped.filter(s => s.reason === 'secret').map(s => s.path)

      // Scan remaining file contents for hardcoded secrets
      const findings = scanForSecrets(kept)
      if (findings.length > 0) {
        // Pause push, show warning modal — user decides whether to redact and continue
        pendingPushRef.current = { repo, message, kept, skipped: secretSkips }
        setSecretFindings(findings)
        setPushing(false)
        return
      }

      await executePush(repo, message, kept, secretSkips)
    } finally {
      setPushing(false)
    }
  }

  const handleProceedWithRedaction = async () => {
    const pending = pendingPushRef.current
    if (!pending) return
    setSecretFindings([])
    setPushing(true)
    try {
      const redacted = redactSecrets(pending.kept)
      await executePush(pending.repo, pending.message, redacted, pending.skipped)
      pendingPushRef.current = null
    } catch (err) {
      setToast({ type: 'error', msg: 'Push nije uspeo: ' + (err instanceof Error ? err.message : String(err)) })
    } finally {
      setPushing(false)
    }
  }

  const handleCancelPush = () => {
    setSecretFindings([])
    pendingPushRef.current = null
  }

  const downloadZip = async () => {
    const zip = new JSZip()
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith('/')) zip.file(path, content)
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    saveAs(blob, 'vajbagent-projekat.zip')
  }

  // User initials for avatar
  const userInitials = userInfo?.name
    ? userInfo.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase()
    : ''

  return (
    <motion.div className="ide" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
      {/* ── Preview Ready Overlay ── */}
      <AnimatePresence>
        {showPreviewReady && (
          <motion.div className="preview-ready-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <motion.div
              className="preview-ready-content"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1.1, opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <Sparkles size={32} className="preview-ready-icon" />
              <h2>Sajt je spreman!</h2>
              <p>Otvaram preview...</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Topbar ── */}
      <div className="ide-topbar">
        <div className="ide-topbar-left">
          {onBackToWelcome && (
            <button className="topbar-home" onClick={onBackToWelcome} title="Početna">
              <Home size={15} />
            </button>
          )}
          <div className="topbar-brand-wrap">
            <img src="/logo.svg" alt="VajbAgent" className="ide-logo" />
            <span className="ide-brand">Vajb<span>Agent</span></span>
          </div>
        </div>

        <div className="ide-topbar-center">
          <div className="view-toggle">
            <button className={`toggle-btn ${view === 'code' ? 'active' : ''}`} onClick={() => setView('code')}>Kod</button>
            <button className={`toggle-btn ${view === 'split' ? 'active' : ''}`} onClick={() => setView('split')} disabled={!hasPreview}>Split</button>
            <button className={`toggle-btn ${view === 'preview' ? 'active' : ''}`} onClick={() => setView('preview')} disabled={!hasPreview}>Preview</button>
          </div>
        </div>

        <div className="ide-topbar-right">
          {/* Token/context usage with user info */}
          {contextLimit > 0 && (
            <div className="topbar-token-badge">
              <Zap size={11} style={{ color: contextColor }} />
              <div className="token-bar-wrap">
                <div className="token-bar" style={{ width: `${Math.min(contextPercent * 100, 100)}%`, backgroundColor: contextColor }} />
              </div>
              <span className="token-label" style={{ color: contextColor }}>{Math.round(contextPercent * 100)}%</span>
              {/* Tooltip */}
              <div className="token-tooltip">
                <div className="token-tooltip-row">
                  <span>Kontekst</span>
                  <strong>{Math.round(contextUsed / 1000)}K / {Math.round(contextLimit / 1000)}K tokena</strong>
                </div>
                <div className="token-tooltip-bar-full">
                  <div style={{ width: `${Math.min(contextPercent * 100, 100)}%`, backgroundColor: contextColor }} />
                </div>
                <p className="token-tooltip-desc">
                  {contextPercent > 0.85
                    ? 'Kontekst je skoro pun — agent će uskoro morati da skrati istoriju.'
                    : contextPercent > 0.65
                    ? 'Kontekst se puni — za složenije zadatke osveži stranicu.'
                    : 'Dovoljno prostora za kontekst.'}
                </p>
                {userInfo && (
                  <>
                    <div className="token-tooltip-divider" />
                    <div className="token-tooltip-row">
                      <span>Kredit</span>
                      <strong style={{ color: userInfo.balance < 1 ? '#ef4444' : 'var(--text)' }}>
                        ${userInfo.balance.toFixed(2)}
                      </strong>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="topbar-divider" />

          {/* Credit badge */}
          {userInfo && (
            <a
              href="https://vajbagent.com/dashboard"
              target="_blank"
              rel="noopener"
              className={`topbar-credit ${userInfo.balance < 0.5 ? 'low' : ''}`}
              title={`Kredit: $${userInfo.balance.toFixed(2)} — Klikni za dopunu`}
            >
              <Wallet size={13} />
              <span>${userInfo.balance.toFixed(2)}</span>
            </a>
          )}

          {/* User avatar with dropdown */}
          {userInfo && (
            <div className="topbar-user-wrap">
              <button className="user-avatar" onClick={() => setUserMenuOpen(!userMenuOpen)} title={userInfo.name}>
                {userInitials || <User size={12} />}
              </button>
              {userMenuOpen && (
                <div className="user-menu">
                  <div className="user-menu-header">
                    <span className="user-menu-name">{userInfo.name}</span>
                    <span className="user-menu-balance">${userInfo.balance.toFixed(2)}</span>
                  </div>
                  <div className="user-menu-key">
                    <span className="user-menu-key-label">API ključ (za Cursor)</span>
                    <button
                      className="user-menu-key-copy"
                      onClick={async () => {
                        // Fetch the key on demand — it's never in default /me responses.
                        const k = await revealApiKey()
                        if (!k) {
                          alert('Ne mogu da dohvatim ključ. Prijavi se ponovo.')
                          return
                        }
                        await navigator.clipboard.writeText(k)
                        setKeyCopied(true)
                        setTimeout(() => setKeyCopied(false), 2000)
                      }}
                    >
                      <code>Kopiraj API ključ</code>
                      {keyCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  <div className="user-menu-divider" />
                  <a href="https://vajbagent.com/dashboard" target="_blank" rel="noopener" className="user-menu-item">
                    <Wallet size={14} />
                    Dopuni kredite
                  </a>
                  <button className="user-menu-item logout" onClick={async () => { await logout(); try { localStorage.removeItem('vajb_last_active_project') } catch {}; window.location.reload() }}>
                    <LogOut size={14} />
                    Odjavi se
                  </button>
                </div>
              )}
            </div>
          )}

          <button className={`topbar-btn ${terminalOpen ? 'active' : ''}`} onClick={() => setTerminalOpen(!terminalOpen)} title="Terminal">
            <Terminal size={15} />
          </button>
          <button className="topbar-btn" onClick={() => setSettingsOpen(true)} title="Podešavanja">
            <SettingsIcon size={15} />
          </button>
          {hasFiles && (
            <>
              <button className="topbar-btn" onClick={downloadZip} title="Preuzmi kod (.zip)">
                <Download size={15} />
              </button>
              <button
                className={`topbar-btn ${ghConnected ? 'connected' : ''}`}
                onClick={handleGitHubPush}
                disabled={pushing}
                title={ghConnected
                  ? `Push na GitHub (${ghUsername ? '@' + ghUsername : 'povezan'})`
                  : 'GitHub nije povezan — klikni da podesiš'}
              >
                {pushing ? <Loader2 size={15} className="spin" /> : <GitBranch size={15} />}
                {ghConnected && <span className="topbar-btn-dot" />}
              </button>
            </>
          )}
          {/* ── Unified Deploy button: single control with a dropdown for actions ── */}
          <div className="deploy-wrap">
            <button
              className="btn-deploy"
              onClick={() => {
                if (deployUrl) {
                  // Already deployed → clicking main button re-deploys to the same site
                  handleDeploy()
                } else {
                  handleDeploy()
                }
              }}
              disabled={(!hasHtml && !hasBuildOutput) || deploying}
              title={nlConnected ? 'Objavi na Netlify' : 'Netlify nije povezan — klikni da podesiš'}
            >
              {deploying ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />}
              <span>{deploying ? 'Objavljujem...' : deployUrl ? 'Objavljeno' : 'Objavi'}</span>
              {deployUrl && !deploying && <span className="deploy-dot" />}
            </button>
            {(deployUrl || nlSiteId) && !deploying && (
              <button
                className="btn-deploy-chevron"
                onClick={() => setDeployMenuOpen(v => !v)}
                title="Više opcija"
                disabled={(!hasHtml && !hasBuildOutput)}
              >
                <ChevronDown size={13} />
              </button>
            )}
            <AnimatePresence>
              {deployMenuOpen && (
                <>
                  <div className="deploy-menu-backdrop" onClick={() => setDeployMenuOpen(false)} />
                  <motion.div
                    className="deploy-menu"
                    initial={{ opacity: 0, y: -6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.97 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  >
                    {deployUrl && (
                      <>
                        <div className="deploy-menu-header">
                          <div className="deploy-menu-label">Trenutni sajt</div>
                          <div className="deploy-menu-url" title={deployUrl}>
                            <Globe size={11} />
                            <span>{deployUrl.replace('https://', '')}</span>
                          </div>
                        </div>
                        <div className="deploy-menu-divider" />
                        <a
                          href={deployUrl}
                          target="_blank"
                          rel="noopener"
                          className="deploy-menu-item"
                          onClick={() => setDeployMenuOpen(false)}
                        >
                          <ExternalLink size={13} />
                          Otvori sajt u novom tabu
                        </a>
                        <button
                          className="deploy-menu-item"
                          onClick={() => { setDeployMenuOpen(false); handleDeploy() }}
                        >
                          <RefreshCw size={13} />
                          Ponovo objavi (isti sajt)
                        </button>
                      </>
                    )}
                    <button
                      className="deploy-menu-item"
                      onClick={() => { setDeployMenuOpen(false); setNlSiteId(null); setDeployUrl(null); handleDeploy() }}
                    >
                      <Rocket size={13} />
                      Objavi kao novi sajt
                    </button>
                    <button
                      className="deploy-menu-item"
                      onClick={() => { setDeployMenuOpen(false); setSettingsOpen(true) }}
                    >
                      <Globe size={13} />
                      Podešavanja Netlify-a
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ── Panels ── */}
      <div className="ide-panels">
        {/* Explorer — always mounted, just hidden via CSS */}
        <div className={`explorer-wrap ${explorerOpen ? 'open' : 'closed'}`}>
          <FileExplorer
            files={files}
            activeFile={activeFile}
            onSelectFile={(p) => { setActiveFile(p); if (view === 'preview') setView('code') }}
            onCreateFile={handleCreateFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRefresh={handleExplorerRefresh}
          />
        </div>

        <button
          className={`panel-toggle panel-toggle-left ${!explorerOpen ? 'collapsed' : ''}`}
          onClick={() => setExplorerOpen(!explorerOpen)}
          title={explorerOpen ? 'Sakrij explorer' : 'Prikaži explorer'}
        >
          {explorerOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className="main-content-wrap">
          <AnimatePresence mode="wait">
            {view === 'code' && (
              <motion.div key="code-only" className="panel-animate" variants={panelVariants} initial="initial" animate="animate" exit="exit">
                <CodeEditor files={files} activeFile={activeFile} onFileEdit={handleFileEdit} onSelectFile={setActiveFile} isAgentStreaming={isAgentStreaming} onSelectionChange={handleSelectionChange} streamingStatus={agentStatus} />
              </motion.div>
            )}
            {view === 'split' && (
              <motion.div key="split-view" className="panel-animate" variants={panelVariants} initial="initial" animate="animate" exit="exit">
                <CodeEditor files={files} activeFile={activeFile} onFileEdit={handleFileEdit} onSelectFile={setActiveFile} isAgentStreaming={isAgentStreaming} onSelectionChange={handleSelectionChange} streamingStatus={agentStatus} />
                <div className="ide-divider" />
                <PreviewPanel files={files} />
              </motion.div>
            )}
            {view === 'preview' && (
              <motion.div key="preview-only" className="panel-animate" variants={panelVariants} initial="initial" animate="animate" exit="exit">
                <PreviewPanel files={files} />
              </motion.div>
            )}
          </AnimatePresence>
          {terminalOpen && <TerminalPanel onClose={() => setTerminalOpen(false)} />}
        </div>

        <button
          className={`panel-toggle panel-toggle-right ${!chatOpen ? 'collapsed' : ''}`}
          onClick={() => setChatOpen(!chatOpen)}
          title={chatOpen ? 'Sakrij chat' : 'Prikaži chat'}
        >
          {chatOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>

        {/* Chat — always mounted, never unmounted! Just hidden via CSS */}
        <div className={`chat-wrap ${chatOpen ? 'open' : 'closed'}`}>
          <ChatPanel
            initialPrompt={initialPrompt}
            model={model}
            onModelChange={onModelChange}
            onFilesChanged={handleFilesChanged}
            onDone={handleAgentDone}
            onContextUpdate={handleContextUpdate}
            onStreamingChange={handleStreamingChange}
            onStatusChange={setAgentStatus}
            onChatHistoryUpdate={handleChatHistoryUpdate}
            files={files}
            activeFile={activeFile}
            selectionRef={selectionRef}
            freeTier={freeTier}
            resumeHistory={resumeProject?.chatHistory}
            resumeDisplayMessages={resumeProject?.displayMessages}
            resumeNeedsBuild={!!resumeProject?.files['package.json']}
          />
        </div>
      </div>
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <GitHubPushModal
        open={ghModalOpen}
        onClose={() => setGhModalOpen(false)}
        onPush={doGitHubPush}
        defaultName={projectNameRef.current ? slugify(projectNameRef.current) : 'vajbagent-projekat'}
        connectedUsername={ghUsername}
      />
      <NetlifyDeployModal
        open={nlModalOpen}
        onClose={() => setNlModalOpen(false)}
        onDeploy={doDeploy}
        defaultName={projectNameRef.current ? slugify(projectNameRef.current) : 'vajbagent-sajt'}
        currentSiteId={nlSiteId}
      />
      <SecretWarningModal
        open={secretFindings.length > 0}
        findings={secretFindings}
        onCancel={handleCancelPush}
        onProceedWithRedaction={handleProceedWithRedaction}
      />

      {/* ── Toast ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className={`ide-toast ${toast.type}`}
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="ide-toast-icon">
              {toast.type === 'success' ? <Check size={16} /> : <X size={16} />}
            </div>
            <div className="ide-toast-body">
              <div className="ide-toast-msg">{toast.msg}</div>
              {toast.url && (
                <a href={toast.url} target="_blank" rel="noopener" className="ide-toast-link">
                  {toast.url.replace('https://', '')} <ExternalLink size={11} />
                </a>
              )}
            </div>
            <button className="ide-toast-close" onClick={() => setToast(null)}>
              <X size={13} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
