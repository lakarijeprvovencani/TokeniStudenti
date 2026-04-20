import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { X, Loader2, Sparkles, LogIn, UserPlus, ArrowLeft, CheckCircle2, Mail } from 'lucide-react'
import { register, login, requestPasswordReset, fetchRegisterToken, type UserInfo } from '../services/userService'
import './PaywallModal.css'
import './AuthModal.css'

interface AuthModalProps {
  open: boolean
  onClose: () => void
  /** isNewRegistration=true only when the user just went through the register
   *  tab; login and API-key flows set it to false so the caller can decide
   *  whether to show the post-signup paywall/onboarding. */
  onAuthed: (user: UserInfo, isNewRegistration: boolean) => void
  /** Optional prompt the user was trying to send — shown as a preview so they remember */
  pendingPrompt?: string
  /** Which tab to open on first mount. Defaults to 'register' so the primary
   *  "Napravi nalog i kreni" CTA is the default action, but any "Prijavi se"
   *  entry point (top-right button on Welcome) can override to 'login' so the
   *  user lands on the right form. */
  initialMode?: 'register' | 'login'
}

type Mode = 'register' | 'login' | 'forgot'

export default function AuthModal({ open, onClose, onAuthed, pendingPrompt, initialMode = 'register' }: AuthModalProps) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [forgotSent, setForgotSent] = useState('')
  // Captured user after a successful but *unverified* registration. While
  // set, the modal renders a "check your email" success state instead of
  // the register form, and only calls onAuthed when the user acknowledges
  // it — so the parent goes straight to welcome with the right context.
  const [pendingVerifyUser, setPendingVerifyUser] = useState<UserInfo | null>(null)
  const [pendingVerifyEmail, setPendingVerifyEmail] = useState('')

  // ─── Anti-bot: signed token + countdown + honeypot + Turnstile ─────────
  // Mirrors the protection the VS Code dashboard has been using. The token
  // comes from the server and is bound to a timestamp — any submit younger
  // than 2s or without a valid signature is rejected server-side.
  const [regToken, setRegToken] = useState('')
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [verifyCountdown, setVerifyCountdown] = useState(0)
  const honeypotRef = useRef<HTMLInputElement>(null)
  const turnstileContainerRef = useRef<HTMLDivElement>(null)
  const turnstileWidgetIdRef = useRef<string | null>(null)

  // When the modal is (re)opened, honour the requested initialMode so the
  // top-right "Prijavi se" entry point lands on login rather than register.
  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setError('')
      setForgotSent('')
      setPendingVerifyUser(null)
      setPendingVerifyEmail('')
      setTurnstileToken('')
    }
  }, [open, initialMode])

  // Fetch signed register-token + turnstile site key whenever the user
  // lands on the register tab. Re-fetch after a failed submit too so the
  // 30-min expiry window never surprises anyone.
  useEffect(() => {
    if (!open || mode !== 'register') return
    let cancelled = false
    ;(async () => {
      const r = await fetchRegisterToken()
      if (cancelled) return
      setRegToken(r.token)
      setTurnstileSiteKey(r.turnstileSiteKey)
      // 3-second countdown before submit becomes active — matches the
      // dashboard's anti-autosubmit delay. Bots that fire forms in <300ms
      // flat-out can't beat this without holding for 3s first, and even
      // then the server rejects tokens younger than 2s.
      setVerifyCountdown(3)
    })()
    return () => { cancelled = true }
  }, [open, mode])

  useEffect(() => {
    if (verifyCountdown <= 0) return
    const t = setTimeout(() => setVerifyCountdown(n => n - 1), 1000)
    return () => clearTimeout(t)
  }, [verifyCountdown])

  // Lazy-load Turnstile script + render the widget once we have a site
  // key. Cleanup on unmount so re-opening the modal doesn't stack widgets.
  useEffect(() => {
    if (!open || mode !== 'register' || !turnstileSiteKey) return
    const container = turnstileContainerRef.current
    if (!container) return

    const SCRIPT_ID = 'cf-turnstile-script'
    const render = () => {
      const cf = (window as any).turnstile
      if (!cf || !container) return
      if (turnstileWidgetIdRef.current) {
        try { cf.reset(turnstileWidgetIdRef.current) } catch { /* ignore */ }
        return
      }
      turnstileWidgetIdRef.current = cf.render(container, {
        sitekey: turnstileSiteKey,
        theme: 'dark',
        callback: (tok: string) => setTurnstileToken(tok),
        'error-callback': () => setTurnstileToken(''),
        'expired-callback': () => setTurnstileToken(''),
      })
    }

    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script')
      s.id = SCRIPT_ID
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      s.async = true
      s.defer = true
      s.onload = render
      document.head.appendChild(s)
    } else {
      render()
    }

    return () => {
      const cf = (window as any).turnstile
      if (cf && turnstileWidgetIdRef.current) {
        try { cf.remove(turnstileWidgetIdRef.current) } catch { /* ignore */ }
        turnstileWidgetIdRef.current = null
      }
    }
  }, [open, mode, turnstileSiteKey])

  const submit = async () => {
    setError('')
    if (mode === 'forgot') {
      if (!email.trim()) { setError('Unesi svoju email adresu.'); return }
      setLoading(true)
      const result = await requestPasswordReset(email.trim())
      setLoading(false)
      if (!result.ok) { setError(result.error || 'Greška.'); return }
      setForgotSent(result.message || 'Poslali smo ti email sa linkom za resetovanje lozinke. Proveri inbox i spam folder.')
      return
    }
    if (mode === 'register') {
      if (!firstName.trim() || !lastName.trim() || !email.trim() || !password) {
        setError('Popuni sva polja.')
        return
      }
      if (password.length < 8) {
        setError('Lozinka mora imati najmanje 8 karaktera.')
        return
      }
      if (verifyCountdown > 0) { setError(`Sačekaj još ${verifyCountdown}s pre slanja forme.`); return }
      if (turnstileSiteKey && !turnstileToken) {
        setError('Molimo završi CAPTCHA verifikaciju iznad.')
        return
      }
      setLoading(true)
      const result = await register(
        firstName.trim(),
        lastName.trim(),
        email.trim(),
        password,
        {
          token: regToken,
          honeypot: honeypotRef.current?.value || '',
          turnstileToken,
        },
      )
      setLoading(false)
      if (!result.ok || !result.user) {
        setError(result.error || 'Greška pri registraciji.')
        // Fetch a fresh token so the user can retry — old one may have
        // been burned or expired.
        fetchRegisterToken().then(r => {
          setRegToken(r.token)
          setVerifyCountdown(3)
          setTurnstileToken('')
          const cf = (window as any).turnstile
          if (cf && turnstileWidgetIdRef.current) { try { cf.reset(turnstileWidgetIdRef.current) } catch { /* ignore */ } }
        })
        return
      }
      // If the backend issued the account but needs email verification
      // first, show the "check your email" success state inside the modal
      // so the user immediately knows why they can't chat yet. We only
      // forward to the parent (onAuthed) once the user acknowledges this.
      if (result.user.emailVerified === false) {
        setPendingVerifyUser(result.user)
        setPendingVerifyEmail(email.trim())
        return
      }
      onAuthed(result.user, true)
      return
    }
    // login
    if (!email.trim() || !password) { setError('Unesi email i lozinku.'); return }
    setLoading(true)
    const result = await login(email.trim(), password)
    setLoading(false)
    if (!result.ok || !result.user) { setError(result.error || 'Greška pri prijavi.'); return }
    onAuthed(result.user, false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  }

  const headerTitle = mode === 'register'
    ? 'Još samo jedan korak'
    : mode === 'login'
      ? 'Dobrodošao nazad'
      : 'Resetuj lozinku'

  const headerSubtitle = mode === 'register'
    ? 'Napravi nalog za 10 sekundi i dobij besplatne kredite na poklon.'
    : mode === 'login'
      ? 'Prijavi se da nastaviš tamo gde si stao.'
      : 'Unesi email na koji si se registrovao — poslaćemo ti link za postavljanje nove lozinke.'

  const headerBadge = mode === 'register'
    ? 'Napravi nalog'
    : mode === 'login'
      ? 'Prijava'
      : 'Reset lozinke'

  const submitLabel = mode === 'register'
    ? 'Napravi nalog i kreni'
    : mode === 'login'
      ? 'Prijavi se'
      : 'Pošalji link za reset'

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="paywall-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="paywall-modal auth-modal"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="paywall-close" onClick={onClose}><X size={18} /></button>

            <div className="paywall-header">
              <div className="paywall-badge">
                <Sparkles size={14} />
                <span>{headerBadge}</span>
              </div>
              <h2>{headerTitle}</h2>
              <p>{headerSubtitle}</p>
            </div>

            {pendingPrompt && mode !== 'forgot' && (
              <div className="auth-pending-prompt">
                <span className="pending-label">Tvoj prompt</span>
                <div className="pending-text">{pendingPrompt}</div>
              </div>
            )}

            {mode !== 'forgot' && !pendingVerifyUser && (
              <div className="auth-mode-tabs">
                <button
                  className={`auth-mode-tab ${mode === 'register' ? 'active' : ''}`}
                  onClick={() => { setMode('register'); setError('') }}
                >
                  <UserPlus size={14} />
                  Registracija
                </button>
                <button
                  className={`auth-mode-tab ${mode === 'login' ? 'active' : ''}`}
                  onClick={() => { setMode('login'); setError('') }}
                >
                  <LogIn size={14} />
                  Prijava
                </button>
              </div>
            )}

            {pendingVerifyUser ? (
              <>
                <div className="auth-success-box">
                  <Mail size={20} />
                  <div>
                    <div className="auth-success-title">Proveri email</div>
                    <div className="auth-success-text">
                      Poslali smo ti link za potvrdu na <strong>{pendingVerifyEmail}</strong>. Klikni na link da aktiviraš nalog i dobiješ kredit dobrodošlice.
                    </div>
                    <div
                      style={{
                        marginTop: 12,
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: 'rgba(250, 115, 21, 0.08)',
                        border: '1px solid rgba(250, 115, 21, 0.25)',
                        fontSize: 12.5,
                        lineHeight: 1.55,
                        color: '#ffb27a',
                        display: 'flex',
                        gap: 8,
                        alignItems: 'flex-start',
                      }}
                    >
                      <span style={{ fontSize: 14, lineHeight: 1 }}>⚠</span>
                      <span>
                        <strong style={{ color: '#ffd19a' }}>Bitno:</strong> prvi email najčešće odleti u <strong>Spam / Junk</strong> folder. Ako ga ne vidiš u Inbox-u u sledećih 30 sekundi, proveri tamo.
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  className="btn-primary auth-submit-big"
                  onClick={() => {
                    const u = pendingVerifyUser
                    setPendingVerifyUser(null)
                    setPendingVerifyEmail('')
                    if (u) onAuthed(u, true)
                  }}
                >
                  U redu, proveriću email
                </button>
              </>
            ) : forgotSent ? (
              <div className="auth-success-box">
                <CheckCircle2 size={20} />
                <div>
                  <div className="auth-success-title">Email je poslat</div>
                  <div className="auth-success-text">{forgotSent}</div>
                </div>
              </div>
            ) : (
              <div className="auth-fields-modal">
                {mode === 'register' && (
                  <div className="auth-name-row">
                    <input
                      className="auth-input-modal"
                      placeholder="Ime"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoComplete="given-name"
                    />
                    <input
                      className="auth-input-modal"
                      placeholder="Prezime"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoComplete="family-name"
                    />
                  </div>
                )}
                <input
                  className="auth-input-modal"
                  type="email"
                  placeholder="Email adresa"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={handleKeyDown}
                  autoComplete="email"
                />
                {mode !== 'forgot' && (
                  <input
                    className="auth-input-modal"
                    type="password"
                    placeholder="Lozinka"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  />
                )}
                {mode === 'register' && (
                  <>
                    {/* Honeypot: invisible to humans (positioned off-screen with tabIndex=-1
                        and autoComplete=off) but bot autofillers populate `website`/`name`
                        fields eagerly. Any non-empty value is a guaranteed bot → server 400. */}
                    <input
                      ref={honeypotRef}
                      type="text"
                      name="website"
                      tabIndex={-1}
                      autoComplete="off"
                      aria-hidden="true"
                      style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}
                    />
                    {turnstileSiteKey && (
                      <div ref={turnstileContainerRef} className="auth-turnstile" style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }} />
                    )}
                  </>
                )}
              </div>
            )}

            {error && !pendingVerifyUser && <div className="paywall-error">{error}</div>}

            {!forgotSent && !pendingVerifyUser && (() => {
              const showCountdown = mode === 'register' && verifyCountdown > 0
              const disabled = loading || showCountdown
              const label = showCountdown
                ? `Verifikacija… ${verifyCountdown}`
                : submitLabel
              return (
                <button className="btn-primary auth-submit-big" onClick={submit} disabled={disabled}>
                  {loading ? <Loader2 size={16} className="spin" /> : label}
                </button>
              )
            })()}

            {mode === 'login' && !forgotSent && (
              <div className="auth-link-row">
                <button
                  type="button"
                  className="auth-text-link"
                  onClick={() => { setMode('forgot'); setError(''); setPassword('') }}
                >
                  Zaboravio si lozinku?
                </button>
              </div>
            )}

            {mode === 'forgot' && (
              <div className="auth-link-row">
                <button
                  type="button"
                  className="auth-text-link"
                  onClick={() => { setMode('login'); setError(''); setForgotSent('') }}
                >
                  <ArrowLeft size={13} />
                  Nazad na prijavu
                </button>
              </div>
            )}

            <p className="paywall-secure">
              Nalog se čuva sigurno. Lozinku ne vidi niko osim tebe.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
