import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { X, Loader2, Sparkles, LogIn, UserPlus } from 'lucide-react'
import { register, login, fetchUserInfo, type UserInfo } from '../services/userService'
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
}

type Mode = 'register' | 'login'

export default function AuthModal({ open, onClose, onAuthed, pendingPrompt }: AuthModalProps) {
  const [mode, setMode] = useState<Mode>('register')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    setError('')
    let isNewRegistration = false
    if (mode === 'register') {
      if (!firstName.trim() || !lastName.trim() || !email.trim() || !password) {
        setError('Popuni sva polja.')
        return
      }
      setLoading(true)
      const result = await register(firstName.trim(), lastName.trim(), email.trim(), password)
      if (!result.ok) { setLoading(false); setError(result.error || 'Greška pri registraciji.'); return }
      isNewRegistration = true
    } else {
      if (!email.trim() || !password) { setError('Unesi email i lozinku.'); return }
      setLoading(true)
      const result = await login(email.trim(), password)
      if (!result.ok) { setLoading(false); setError(result.error || 'Greška pri prijavi.'); return }
    }
    // Fetch the full UserInfo via /auth/me — this is the only place that
    // returns the stable user_id we need for per-user storage scoping, and
    // it also calls setScope() internally.
    const info = await fetchUserInfo()
    setLoading(false)
    if (!info) { setError('Nalog je napravljen, ali provera sesije nije uspela. Osveži stranicu.'); return }
    onAuthed(info, isNewRegistration)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  }

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
                <span>{mode === 'register' ? 'Napravi nalog' : 'Prijava'}</span>
              </div>
              <h2>{mode === 'register' ? 'Još samo jedan korak' : 'Dobrodošao nazad'}</h2>
              <p>
                {mode === 'register'
                  ? 'Napravi nalog za 10 sekundi i dobij besplatne kredite na poklon.'
                  : 'Prijavi se da nastaviš tamo gde si stao.'}
              </p>
            </div>

            {pendingPrompt && (
              <div className="auth-pending-prompt">
                <span className="pending-label">Tvoj prompt</span>
                <div className="pending-text">{pendingPrompt}</div>
              </div>
            )}

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

            <div className="auth-fields-modal">
              {mode === 'register' && (
                <div className="auth-name-row">
                  <input
                    className="auth-input-modal"
                    placeholder="Ime"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <input
                    className="auth-input-modal"
                    placeholder="Prezime"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    onKeyDown={handleKeyDown}
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
              />
              <input
                className="auth-input-modal"
                type="password"
                placeholder="Lozinka"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>

            {error && <div className="paywall-error">{error}</div>}

            <button className="btn-primary auth-submit-big" onClick={submit} disabled={loading}>
              {loading ? <Loader2 size={16} className="spin" /> : mode === 'register' ? 'Napravi nalog i kreni' : 'Prijavi se'}
            </button>

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
