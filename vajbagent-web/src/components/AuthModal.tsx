import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { X, Loader2, Sparkles, LogIn, UserPlus, ArrowLeft, CheckCircle2, Mail } from 'lucide-react'
import { register, login, requestPasswordReset, type UserInfo } from '../services/userService'
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

  // When the modal is (re)opened, honour the requested initialMode so the
  // top-right "Prijavi se" entry point lands on login rather than register.
  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setError('')
      setForgotSent('')
      setPendingVerifyUser(null)
      setPendingVerifyEmail('')
    }
  }, [open, initialMode])

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
      setLoading(true)
      const result = await register(firstName.trim(), lastName.trim(), email.trim(), password)
      setLoading(false)
      if (!result.ok || !result.user) { setError(result.error || 'Greška pri registraciji.'); return }
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
                    <div className="auth-success-text" style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                      Ne vidiš email? Proveri spam folder — stiže za par sekundi.
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
              </div>
            )}

            {error && !pendingVerifyUser && <div className="paywall-error">{error}</div>}

            {!forgotSent && !pendingVerifyUser && (
              <button className="btn-primary auth-submit-big" onClick={submit} disabled={loading}>
                {loading ? <Loader2 size={16} className="spin" /> : submitLabel}
              </button>
            )}

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
