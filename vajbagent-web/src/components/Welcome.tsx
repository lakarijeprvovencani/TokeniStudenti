import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Code2, Globe, Layout, ArrowUp, Plus, Paperclip, Loader2, LogIn, UserPlus, Key, FolderOpen, Trash2, Clock, Settings as SettingsIcon, LogOut, Sparkles } from 'lucide-react'
import { login, register, setPassword as setPasswordApi, logout, checkSession, type UserInfo } from '../services/userService'
import { listProjects, deleteProject, type SavedProject } from '../services/projectStore'
import { TEMPLATES, TEMPLATE_CATEGORIES, type Template } from '../templates'
import ModelSelector from './ModelSelector'
import Settings from './Settings'
import Onboarding, { shouldShowOnboarding } from './Onboarding'
import './Welcome.css'

const QUICK_STARTS = [
  { icon: <Globe size={16} />, label: 'Napravi sajt', prompt: 'Napravi moderan, responsivan sajt sa hero sekcijom, navigacijom i footer-om.' },
  { icon: <Layout size={16} />, label: 'Portfolio', prompt: 'Napravi portfolio sajt za developera sa projektima, about sekcijom i kontakt formom.' },
  { icon: <Code2 size={16} />, label: 'Dashboard', prompt: 'Napravi admin dashboard sa sidebar navigacijom, karticama sa statistikama i tabelom podataka.' },
]

interface WelcomeProps {
  onStart: (prompt: string) => void
  onResume: (project: SavedProject) => void
  model: string
  onModelChange: (model: string) => void
  onAuth: (user: UserInfo) => void
  user: UserInfo | null
  freeTier: boolean
}

type AuthTab = 'login' | 'register' | 'apikey'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'upravo'
  if (mins < 60) return `pre ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `pre ${hours}h`
  const days = Math.floor(hours / 24)
  return `pre ${days}d`
}

const TEXT_EXTS = /\.(ts|tsx|js|jsx|py|html|css|json|md|txt|yaml|yml|sql|sh|csv|xml|toml|env)$/i

export default function Welcome({ onStart, onResume, model, onModelChange, onAuth, user, freeTier }: WelcomeProps) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  // Handle text file attach (+ button)
  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    let added = ''
    for (const file of files) {
      if (!TEXT_EXTS.test(file.name)) continue
      const content = await file.text()
      added += `\n\n[Fajl: ${file.name}]\n\`\`\`\n${content.slice(0, 15000)}\n\`\`\``
    }
    if (added) {
      setText(prev => prev + added)
      inputRef.current?.focus()
    }
    e.target.value = ''
  }

  // Handle image attach (Paperclip button) — converts to data URL and adds note
  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    // For simplicity on welcome screen, just note that images were attached
    // The actual image data goes via session/initialPrompt but Welcome doesn't support that yet
    // So we tell the user to use the chat panel for images
    if (files.length > 0) {
      alert('Slike možeš da prikačiš direktno u chat panel kad uđeš u projekat — prevuci ih ili pejstuj.')
    }
    e.target.value = ''
  }

  // Auth state
  const [authTab, setAuthTab] = useState<AuthTab>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')
  const [checkingSession, setCheckingSession] = useState(true)

  // Projects state
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templateCategory, setTemplateCategory] = useState<'web' | 'app' | 'tool' | 'fun'>('web')
  const [showOnboarding, setShowOnboarding] = useState(false)

  // Check existing session on mount
  useEffect(() => {
    checkSession().then(info => {
      if (info) onAuth(info)
      setCheckingSession(false)
    })
  }, [])

  // Load saved projects when user is logged in
  useEffect(() => {
    if (!user) return
    setLoadingProjects(true)
    listProjects()
      .then(list => setProjects(list))
      .catch(() => {})
      .finally(() => setLoadingProjects(false))
    // Show onboarding on first login
    if (shouldShowOnboarding()) {
      setShowOnboarding(true)
    }
  }, [user])

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Obriši ovaj projekat?')) return
    await deleteProject(id)
    setProjects(prev => prev.filter(p => p.id !== id))
  }

  const handleLogin = async () => {
    if (!email.trim() || !password) return
    setAuthLoading(true)
    setAuthError('')
    const result = await login(email.trim(), password)
    setAuthLoading(false)
    if (result.ok) {
      onAuth({ name: result.name!, balance: result.balance!, freeTier: result.freeTier ?? true })
    } else {
      setAuthError(result.error || 'Greška pri prijavi.')
    }
  }

  const handleRegister = async () => {
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !password) return
    setAuthLoading(true)
    setAuthError('')
    const result = await register(firstName.trim(), lastName.trim(), email.trim(), password)
    setAuthLoading(false)
    if (result.ok) {
      onAuth({ name: result.name!, balance: result.balance!, freeTier: result.freeTier ?? true })
    } else {
      setAuthError(result.error || 'Greška pri registraciji.')
    }
  }

  const handleSetPassword = async () => {
    if (!email.trim() || !apiKey.trim() || !password) return
    setAuthLoading(true)
    setAuthError('')
    const result = await setPasswordApi(email.trim(), apiKey.trim(), password)
    setAuthLoading(false)
    if (result.ok) {
      const loginResult = await login(email.trim(), password)
      if (loginResult.ok) {
        onAuth({ name: loginResult.name!, balance: loginResult.balance!, freeTier: false })
      }
    } else {
      setAuthError(result.error || 'Pogrešan email ili API ključ.')
    }
  }

  const handleAuthSubmit = () => {
    if (authTab === 'login') handleLogin()
    else if (authTab === 'register') handleRegister()
    else handleSetPassword()
  }

  const handleAuthKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAuthSubmit()
    }
  }

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed || !user) return
    onStart(trimmed)
  }

  const handleUseTemplate = (template: Template) => {
    setTemplatesOpen(false)
    setText(template.prompt)
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const isLoggedIn = !!user

  return (
    <div className="welcome">
      <div className="welcome-glow" />
      <div className="welcome-glow-secondary" />

      {/* Top-right user controls */}
      {isLoggedIn && (
        <div className="welcome-topbar">
          <button className="welcome-icon-btn" onClick={() => setSettingsOpen(true)} title="Podešavanja">
            <SettingsIcon size={16} />
          </button>
          <div className="welcome-user-wrap">
            <button className="welcome-user-btn" onClick={() => setUserMenuOpen(!userMenuOpen)}>
              <span className="welcome-user-initials">
                {user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </span>
            </button>
            {userMenuOpen && (
              <>
                <div className="welcome-menu-backdrop" onClick={() => setUserMenuOpen(false)} />
                <div className="welcome-user-menu">
                  <div className="welcome-menu-header">
                    <span className="welcome-menu-name">{user.name}</span>
                    <span className="welcome-menu-balance">${user.balance.toFixed(2)}</span>
                  </div>
                  <div className="welcome-menu-divider" />
                  <a href="https://vajbagent.com/dashboard" target="_blank" rel="noopener" className="welcome-menu-item">
                    Dopuni kredite
                  </a>
                  <button className="welcome-menu-item logout" onClick={async () => { await logout(); window.location.reload() }}>
                    <LogOut size={14} />
                    Odjavi se
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <motion.div
        className="welcome-logo"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <img src="/logo.svg" alt="VajbAgent" className="logo-img" />
      </motion.div>

      <motion.h1
        className="welcome-title"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.15, ease: 'easeOut' }}
      >
        {isLoggedIn ? 'Šta želiš da napraviš?' : 'Prijavi se'}
      </motion.h1>

      {isLoggedIn ? (
        <>
          <motion.p
            className="welcome-subtitle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            Opiši ideju, VajbAgent će je pretvoriti u kod.
          </motion.p>

          <motion.div
            className="quick-starts"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
          >
            <button
              className="quick-pill quick-pill-templates"
              onClick={() => setTemplatesOpen(true)}
            >
              <Sparkles size={16} />
              Templejti
            </button>
            {QUICK_STARTS.map((qs) => (
              <button
                key={qs.label}
                className="quick-pill"
                onClick={() => { setText(qs.prompt); inputRef.current?.focus() }}
              >
                {qs.icon}
                {qs.label}
              </button>
            ))}
          </motion.div>

          <motion.div
            className={`input-wrap ${focused ? 'focused' : ''}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5, ease: 'easeOut' }}
          >
            <div className="input-glow-border" />
            <div className="input-inner">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={handleKeyDown}
                placeholder="Opiši šta ti treba..."
                rows={2}
              />
              <div className="input-actions">
                <div className="input-left-actions">
                  <button className="attach-btn" title="Dodaj fajl" onClick={() => fileInputRef.current?.click()}>
                    <Plus size={16} />
                  </button>
                  <button className="attach-btn" title="Prikači sliku" onClick={() => imageInputRef.current?.click()}>
                    <Paperclip size={16} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".ts,.tsx,.js,.jsx,.py,.html,.css,.json,.md,.txt,.yaml,.yml,.sql,.sh,.csv,.xml,.toml,.env"
                    style={{ display: 'none' }}
                    onChange={handleFilePick}
                  />
                  <input
                    ref={imageInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleImagePick}
                  />
                  <ModelSelector value={model} onChange={onModelChange} freeTier={freeTier} />
                </div>
                <button
                  className={`send-btn ${text.trim() ? 'active' : ''}`}
                  onClick={handleSubmit}
                  disabled={!text.trim()}
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          </motion.div>

          {/* ── Saved Projects ── */}
          <AnimatePresence>
            {projects.length > 0 && (
              <motion.div
                className="saved-projects"
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.6 }}
              >
                <div className="saved-projects-header">
                  <FolderOpen size={14} />
                  <span>Tvoji projekti</span>
                </div>
                <div className="saved-projects-list">
                  {projects.slice(0, 6).map(project => (
                    <button
                      key={project.id}
                      className="saved-project-card"
                      onClick={() => onResume(project)}
                    >
                      <div className="project-card-info">
                        <span className="project-card-name">
                          {project.name.length > 50 ? project.name.slice(0, 50) + '...' : project.name}
                        </span>
                        <span className="project-card-meta">
                          <Clock size={10} />
                          {timeAgo(project.updatedAt)}
                          {' · '}
                          {Object.keys(project.files).filter(f => !f.endsWith('/')).length} fajlova
                        </span>
                      </div>
                      <button
                        className="project-card-delete"
                        onClick={(e) => handleDeleteProject(project.id, e)}
                        title="Obriši"
                      >
                        <Trash2 size={12} />
                      </button>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {loadingProjects && projects.length === 0 && (
            <div className="saved-projects-loading">
              <Loader2 size={14} className="spin" />
            </div>
          )}
        </>
      ) : (
        /* ── Auth form ── */
        <motion.div
          className="auth-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          {checkingSession ? (
            <div className="auth-checking">
              <Loader2 size={20} className="spin" />
              <span>Provera sesije...</span>
            </div>
          ) : (
            <>
              <div className="auth-tabs">
                <button
                  className={`auth-tab ${authTab === 'login' ? 'active' : ''}`}
                  onClick={() => { setAuthTab('login'); setAuthError('') }}
                >
                  <LogIn size={14} />
                  Prijava
                </button>
                <button
                  className={`auth-tab ${authTab === 'register' ? 'active' : ''}`}
                  onClick={() => { setAuthTab('register'); setAuthError('') }}
                >
                  <UserPlus size={14} />
                  Registracija
                </button>
                <button
                  className={`auth-tab ${authTab === 'apikey' ? 'active' : ''}`}
                  onClick={() => { setAuthTab('apikey'); setAuthError('') }}
                >
                  <Key size={14} />
                  API ključ
                </button>
              </div>

              {authTab === 'apikey' && (
                <p className="auth-hint">Imaš API ključ iz Cursor ekstenzije? Postavi lozinku za web pristup.</p>
              )}

              <div className="auth-fields">
                {authTab === 'register' && (
                  <div className="auth-row">
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      onKeyDown={handleAuthKeyDown}
                      placeholder="Ime"
                      className="auth-input"
                    />
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      onKeyDown={handleAuthKeyDown}
                      placeholder="Prezime"
                      className="auth-input"
                    />
                  </div>
                )}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={handleAuthKeyDown}
                  placeholder="Email adresa"
                  className="auth-input"
                />
                {authTab === 'apikey' && (
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={handleAuthKeyDown}
                    placeholder="va-xxxx-xxxx-xxxx"
                    className="auth-input"
                    style={{ fontFamily: 'var(--mono)', letterSpacing: '0.02em' }}
                  />
                )}
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleAuthKeyDown}
                  placeholder={authTab === 'apikey' ? 'Nova lozinka' : 'Lozinka'}
                  className="auth-input"
                />
              </div>

              {authError && <p className="auth-error">{authError}</p>}

              <button
                className="auth-submit"
                onClick={handleAuthSubmit}
                disabled={authLoading}
              >
                {authLoading ? (
                  <Loader2 size={16} className="spin" />
                ) : authTab === 'login' ? (
                  'Prijavi se'
                ) : authTab === 'register' ? (
                  'Napravi nalog'
                ) : (
                  'Postavi lozinku'
                )}
              </button>
            </>
          )}
        </motion.div>
      )}

      <motion.div
        className="welcome-footer"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.7 }}
      >
        <>Powered by <span className="footer-brand">Vajb<span>Agent</span></span></>
      </motion.div>

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* First-time user onboarding */}
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}

      {/* ── Templates Modal (portaled to body) ── */}
      {createPortal(
        <AnimatePresence>
          {templatesOpen && (
            <motion.div
              className="templates-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setTemplatesOpen(false)}
            >
            <motion.div
              className="templates-modal"
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="templates-header">
                <div>
                  <h2>Templejti</h2>
                  <p>Izaberi gotov template ili napravi sopstveni</p>
                </div>
                <button className="templates-close" onClick={() => setTemplatesOpen(false)}>
                  <Trash2 size={16} style={{ display: 'none' }} />
                  ✕
                </button>
              </div>

              <div className="templates-tabs">
                {TEMPLATE_CATEGORIES.map(cat => (
                  <button
                    key={cat.id}
                    className={`templates-tab ${templateCategory === cat.id ? 'active' : ''}`}
                    onClick={() => setTemplateCategory(cat.id as 'web' | 'app' | 'tool' | 'fun')}
                  >
                    <span>{cat.icon}</span>
                    {cat.name}
                  </button>
                ))}
              </div>

              <div className="templates-grid">
                {TEMPLATES.filter(t => t.category === templateCategory).map(template => (
                  <button
                    key={template.id}
                    className="template-card"
                    onClick={() => handleUseTemplate(template)}
                  >
                    <div className="template-icon">{template.icon}</div>
                    <div className="template-info">
                      <div className="template-name">{template.name}</div>
                      <div className="template-desc">{template.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
        document.body
      )}
    </div>
  )
}
