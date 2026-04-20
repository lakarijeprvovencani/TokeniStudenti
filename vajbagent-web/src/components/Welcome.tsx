import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Code2, Globe, Layout, ArrowUp, Plus, Paperclip, Loader2, FolderOpen, Trash2, Clock, Settings as SettingsIcon, LogOut, Sparkles, MailWarning } from 'lucide-react'
import { logout, checkSession, resendVerificationEmail, type UserInfo } from '../services/userService'
import AuthModal from './AuthModal'
import PaywallModal from './PaywallModal'
import { listProjects as listProjectsLocal, deleteProject as deleteProjectLocal, type SavedProject } from '../services/projectStore'
import * as remoteStore from '../services/remoteProjectStore'
import { formatCredits, openPaywall } from '../services/credits'
import { resizeImageFile } from '../services/imageResize'
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

interface AttachedImage { name: string; dataUrl: string }

interface WelcomeProps {
  onStart: (prompt: string, images?: AttachedImage[]) => void
  onResume: (project: SavedProject) => void
  model: string
  onModelChange: (model: string) => void
  onAuth: (user: UserInfo) => void
  user: UserInfo | null
  freeTier: boolean
}

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
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [focused, setFocused] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [enhancing, setEnhancing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [resendError, setResendError] = useState('')
  const dragDepth = useRef(0)
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

  const MAX_IMAGES = 4

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const accepted: AttachedImage[] = []
    for (const file of files) {
      if (attachedImages.length + accepted.length >= MAX_IMAGES) break
      const resized = await resizeImageFile(file)
      if (resized) accepted.push({ name: resized.name, dataUrl: resized.dataUrl })
    }
    if (accepted.length > 0) {
      setAttachedImages(prev => [...prev, ...accepted].slice(0, MAX_IMAGES))
      inputRef.current?.focus()
    }
    e.target.value = ''
  }

  const removeAttachedImage = (index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index))
  }

  const handleWelcomeDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file')) return
    e.preventDefault()
    dragDepth.current++
    setDragging(true)
  }
  const handleWelcomeDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const handleWelcomeDragOver = (e: React.DragEvent) => { e.preventDefault() }
  const handleWelcomeDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    const accepted: AttachedImage[] = []
    for (const file of files) {
      if (attachedImages.length + accepted.length >= MAX_IMAGES) break
      const resized = await resizeImageFile(file)
      if (resized) accepted.push({ name: resized.name, dataUrl: resized.dataUrl })
    }
    if (accepted.length > 0) {
      setAttachedImages(prev => [...prev, ...accepted].slice(0, MAX_IMAGES))
      inputRef.current?.focus()
    }
  }

  // New-flow modals (Bolt/Lovable style)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authModalMode, setAuthModalMode] = useState<'register' | 'login'>('register')
  const [paywallOpen, setPaywallOpen] = useState(false)
  const [pendingPrompt, setPendingPrompt] = useState('')
  const [paySuccessToast, setPaySuccessToast] = useState('')

  // Any "Dopuni kredite" button anywhere in the tree fires a global event
  // so we don't have to thread callbacks through every component.
  useEffect(() => {
    const handler = () => setPaywallOpen(true)
    window.addEventListener('vajb:open-paywall', handler)
    return () => window.removeEventListener('vajb:open-paywall', handler)
  }, [])

  // Handle Stripe return (?pay=ok|cancel) — webhook has already credited the
  // account server-side, we just need to refresh balance + show feedback.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const pay = params.get('pay')
    if (!pay) return
    if (pay === 'ok') {
      const amt = params.get('amount') || ''
      setPaySuccessToast(`Uplata uspešna! ${amt ? `+${amt}$ kredita` : 'Krediti dodati na nalog.'}`)
      // Reload user info to pick up new balance
      checkSession().then(info => { if (info) onAuth(info) })
    } else if (pay === 'cancel') {
      setPaySuccessToast('Plaćanje je otkazano.')
    }
    // Clean the URL so refresh doesn't re-show the toast
    window.history.replaceState({}, '', window.location.pathname)
    setTimeout(() => setPaySuccessToast(''), 5000)
  }, [])

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
    })
  }, [])

  // Load saved projects when user is logged in. Onboarding is NOT triggered
  // here anymore — it only fires from handleAuthModalSuccess for genuine
  // new registrations, so returning users (login or auto-resumed session)
  // never see the onboarding overlay again.
  useEffect(() => {
    if (!user) return
    setLoadingProjects(true)
    remoteStore.listProjects()
      .then(summaries => {
        const asSaved: SavedProject[] = summaries.map(s => ({
          id: s.id, name: s.name, model: s.model, prompt: s.prompt,
          createdAt: s.createdAt, updatedAt: s.updatedAt,
          files: {}, chatHistory: [], displayMessages: [],
          _fileCount: s.fileCount,
        }))
        setProjects(asSaved)
      })
      .catch(() => {
        listProjectsLocal()
          .then(list => setProjects(list))
          .catch(() => {})
      })
      .finally(() => setLoadingProjects(false))
  }, [user])

  const handleDeleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Obriši ovaj projekat?')) return
    try { await remoteStore.deleteProject(id) } catch { /* fallback below */ }
    try { await deleteProjectLocal(id) } catch { /* ignore */ }
    setProjects(prev => prev.filter(p => p.id !== id))
  }

  const enhancePrompt = async () => {
    const raw = text.trim()
    if (!raw || enhancing) return
    setEnhancing(true)
    try {
      const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'
      const res = await fetch(`${API_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          model: 'vajb-agent-lite',
          stream: false,
          max_tokens: 4096,
          messages: [
            {
              role: 'system',
              content: `Ti si prompt enhancer za AI web builder. Korisnik ukuca kratak opis sajta, a ti ga pretvoriš u detaljan, jasan brief na SRPSKOM jeziku.

Pravila:
- Zadrži korisnikovu originalnu nameru 100% — ne menjaj temu
- Imenuj KONKRETNE sekcije sajta (npr. hero sa CTA dugmetom, galerija usluga sa karticama, testimonial karusel, FAQ akordion, kontakt forma sa mapom, footer sa socijalnim mrežama)
- Predloži paletu boja opisno (npr. "tamna elegantna paleta sa zlatnim akcentom" ili "svetla čista paleta sa plavim akcentima") — nemoj hex kodove
- Predloži stil tipografije (npr. "moderan sans-serif font, veliki naslovi, čist razmak")
- Ako je biznis tip (restoran, salon, klinika, agencija) — dodaj specifične sekcije za tu industriju (radno vreme, meni/cenovnik, galerija radova, recenzije, lokacija)
- Naglasi da sajt treba biti responsivan, modernog dizajna, sa animacijama pri skrolovanju
- Ako korisnik ne pomene temu — predloži jednu koja ima smisla
- NE dodaj objašnjenja, napomene ni komentare — SAMO poboljšan prompt, ništa drugo
- Piši kao senior UI dizajner koji daje brief developeru
- Odgovor: 4-8 rečenica, dovoljno detaljan ali ne predugačak`
            },
            { role: 'user', content: raw }
          ]
        }),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        console.warn('[Enhance] API error:', res.status, errText)
        return
      }
      const data = await res.json()
      console.log('[Enhance] Response:', JSON.stringify(data).slice(0, 500))
      const enhanced = data.choices?.[0]?.message?.content?.trim()
      if (enhanced) {
        setText(enhanced)
        setTimeout(() => inputRef.current?.focus(), 50)
      } else {
        console.warn('[Enhance] No content in response:', data)
      }
    } catch (err) {
      console.warn('[Enhance] Failed:', err)
    } finally {
      setEnhancing(false)
    }
  }

  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed && attachedImages.length === 0) return
    if (!user) {
      // Stash the prompt (and any attached images) and pop the auth modal.
      // After register → paywall; after login → onStart fires with the
      // full stashed payload.
      setPendingPrompt(trimmed)
      setAuthModalMode('register')
      setAuthModalOpen(true)
      return
    }
    // Unverified users have $0 balance by design — the backend withholds
    // the welcome bonus until they click the verification link. Showing
    // the paywall here would be misleading; they need to check their
    // inbox, not pay. Scroll to the banner we rendered at the top so the
    // CTA is unmistakable.
    if (user.emailVerified === false) {
      try {
        document.querySelector('.verify-banner')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch { /* ignore */ }
      return
    }
    // Pre-flight balance check: a logged-in user with effectively 0 credit
    // can never succeed on the first send — back-end will 402 — so open
    // the paywall immediately instead of letting them watch the spinner.
    const MIN_USD_TO_START = 0.01
    if (user.balance < MIN_USD_TO_START) {
      setPendingPrompt(trimmed)
      openPaywall()
      return
    }
    onStart(trimmed, attachedImages)
    setAttachedImages([])
  }

  const handleAuthModalSuccess = (info: UserInfo, isNewRegistration: boolean) => {
    onAuth(info)
    setAuthModalOpen(false)
    if (!isNewRegistration) {
      // Returning user (login) — never show paywall or onboarding on sign-in,
      // just continue with whatever they were doing.
      const p = pendingPrompt
      const imgs = attachedImages
      setPendingPrompt('')
      setAttachedImages([])
      if (p || imgs.length > 0) onStart(p, imgs)
      return
    }
    // Fresh registration: show onboarding first (if they haven't dismissed
    // it), then the paywall upsell. shouldShowOnboarding() is already
    // scoped per user so each account only ever sees the overlay once.
    //
    // Unverified users skip the paywall — they can't use anything yet, so
    // pushing a top-up dialog in their face would be obnoxious. The
    // verify-email banner already tells them exactly what to do.
    if (info.emailVerified === false) {
      return
    }
    if (shouldShowOnboarding()) {
      setShowOnboarding(true)
    }
    setPaywallOpen(true)
  }

  const handlePaywallSkip = () => {
    setPaywallOpen(false)
    // User chose to continue with free credits — start generation with stashed prompt + images
    const p = pendingPrompt
    const imgs = attachedImages
    setPendingPrompt('')
    setAttachedImages([])
    if (p || imgs.length > 0) onStart(p, imgs)
  }

  const handlePaywallClose = () => {
    // Close via X button — same as skip (they still have free credits)
    handlePaywallSkip()
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
      {!isLoggedIn && (
        <div className="welcome-topbar welcome-topbar-auth">
          <button
            type="button"
            className="welcome-auth-link welcome-auth-link-secondary"
            onClick={() => { setAuthModalMode('login'); setAuthModalOpen(true) }}
          >
            Prijavi se
          </button>
          <button
            type="button"
            className="welcome-auth-link welcome-auth-link-primary"
            onClick={() => { setAuthModalMode('register'); setAuthModalOpen(true) }}
          >
            Registruj se
          </button>
        </div>
      )}
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
                    <span className="welcome-menu-balance">{formatCredits(user.balance)} kredita</span>
                  </div>
                  <div className="welcome-menu-divider" />
                  <button
                    type="button"
                    className="welcome-menu-item"
                    onClick={() => { setUserMenuOpen(false); openPaywall() }}
                  >
                    Dopuni kredite
                  </button>
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

      {isLoggedIn && user?.emailVerified === false && (
        <motion.div
          className="verify-banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <MailWarning size={16} />
          <div className="verify-banner-text">
            <strong>Potvrdi email adresu</strong>
            <span>
              {resendState === 'sent'
                ? 'Link je ponovo poslat — proveri inbox i spam.'
                : 'Klikni link koji smo ti poslali na email da aktiviraš nalog i dobiješ kredit dobrodošlice.'}
              {resendState === 'error' && resendError && ` (${resendError})`}
            </span>
          </div>
          <button
            type="button"
            className="verify-banner-btn"
            disabled={resendState === 'sending' || resendState === 'sent'}
            onClick={async () => {
              setResendState('sending')
              setResendError('')
              const r = await resendVerificationEmail()
              if (r.ok) {
                setResendState('sent')
                setTimeout(() => setResendState('idle'), 15000)
              } else {
                setResendError(r.error || 'Greška.')
                setResendState('error')
              }
            }}
          >
            {resendState === 'sending' ? <Loader2 size={13} className="spin" /> : resendState === 'sent' ? 'Poslato' : 'Pošalji ponovo'}
          </button>
        </motion.div>
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
        Šta želiš da napraviš?
      </motion.h1>

      {true ? (
        <>
          <motion.p
            className="welcome-subtitle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            Opiši ideju, VajbAgent će je pretvoriti u kod.
          </motion.p>
          <motion.p
            className="welcome-capabilities"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.38 }}
          >
            Landing strane · sajtovi · React aplikacije · dashbordi · PWA za mobilne · Supabase baza i auth · GitHub &amp; Netlify deploy jednim klikom
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
            className={`input-wrap ${focused ? 'focused' : ''} ${dragging ? 'drag-over' : ''}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5, ease: 'easeOut' }}
            onDragEnter={handleWelcomeDragEnter}
            onDragLeave={handleWelcomeDragLeave}
            onDragOver={handleWelcomeDragOver}
            onDrop={handleWelcomeDrop}
          >
            <div className="input-glow-border" />
            {dragging && (
              <div className="welcome-drop-overlay">
                <Paperclip size={22} />
                <span>Pusti sliku ovde</span>
              </div>
            )}
            <div className="input-inner">
              {attachedImages.length > 0 && (
                <div className="welcome-attached-images">
                  {attachedImages.map((img, i) => (
                    <div key={i} className="welcome-attached-image" title={img.name}>
                      <img src={img.dataUrl} alt={img.name} />
                      <button
                        type="button"
                        className="welcome-attached-remove"
                        onClick={() => removeAttachedImage(i)}
                        title="Ukloni sliku"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={handleKeyDown}
                placeholder={attachedImages.length > 0 ? 'Opiši šta hoćeš sa slikom...' : 'Opiši šta ti treba...'}
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
                <div className="send-group">
                  {text.trim().length > 0 && (
                    <button
                      className={`enhance-btn ${enhancing ? 'enhancing' : ''}`}
                      onClick={enhancePrompt}
                      disabled={enhancing || !text.trim()}
                      title="Poboljšaj prompt"
                    >
                      {enhancing ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                    </button>
                  )}
                  <button
                    className={`send-btn ${text.trim() || attachedImages.length > 0 ? 'active' : ''}`}
                    onClick={handleSubmit}
                    disabled={!text.trim() && attachedImages.length === 0}
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
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
                          {project._fileCount ?? Object.keys(project.files || {}).filter(f => !f.endsWith('/')).length} fajlova
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
      ) : null}

      <motion.div
        className="welcome-footer"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.7 }}
      >
        <span>Powered by <span className="footer-brand">Vajb<span>Agent</span></span></span>
        <span className="footer-sep">·</span>
        <a href="/extenzija" className="footer-ext-link">
          Koristiš Cursor / VS Code? Preuzmi ekstenziju →
        </a>
      </motion.div>

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* First-time user onboarding */}
      {showOnboarding && <Onboarding onComplete={() => setShowOnboarding(false)} />}

      {/* New bolt-style auth + paywall flow */}
      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        onAuthed={handleAuthModalSuccess}
        pendingPrompt={pendingPrompt}
        initialMode={authModalMode}
      />
      <PaywallModal
        open={paywallOpen}
        onClose={handlePaywallClose}
        variant="welcome"
        onSkip={handlePaywallSkip}
      />

      {/* Stripe return toast */}
      <AnimatePresence>
        {paySuccessToast && (
          <motion.div
            className="pay-toast"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
          >
            {paySuccessToast}
          </motion.div>
        )}
      </AnimatePresence>

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
