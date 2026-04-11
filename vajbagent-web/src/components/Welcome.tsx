import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Code2, Globe, Layout, ArrowUp, Plus, Paperclip, Loader2, LogIn, UserPlus, Key } from 'lucide-react'
import { login, register, setPassword as setPasswordApi, logout, checkSession, type UserInfo } from '../services/userService'
import ModelSelector from './ModelSelector'
import './Welcome.css'

const QUICK_STARTS = [
  { icon: <Globe size={16} />, label: 'Napravi sajt', prompt: 'Napravi moderan, responsivan sajt sa hero sekcijom, navigacijom i footer-om.' },
  { icon: <Layout size={16} />, label: 'Portfolio', prompt: 'Napravi portfolio sajt za developera sa projektima, about sekcijom i kontakt formom.' },
  { icon: <Code2 size={16} />, label: 'Dashboard', prompt: 'Napravi admin dashboard sa sidebar navigacijom, karticama sa statistikama i tabelom podataka.' },
]

interface WelcomeProps {
  onStart: (prompt: string) => void
  model: string
  onModelChange: (model: string) => void
  onAuth: (user: UserInfo) => void
  user: UserInfo | null
  freeTier: boolean
}

type AuthTab = 'login' | 'register' | 'apikey'

export default function Welcome({ onStart, model, onModelChange, onAuth, user, freeTier }: WelcomeProps) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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

  // Check existing session on mount
  useEffect(() => {
    checkSession().then(info => {
      if (info) onAuth(info)
      setCheckingSession(false)
    })
  }, [])

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
      // Now login with the new password
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
                  <button className="attach-btn" title="Dodaj fajl">
                    <Plus size={16} />
                  </button>
                  <button className="attach-btn" title="Prikači sliku">
                    <Paperclip size={16} />
                  </button>
                  <ModelSelector value={model} onChange={onModelChange} freeTier={freeTier} />
                  <a href="https://vajbagent.com/dashboard" target="_blank" rel="noopener" className="user-badge">
                    <span className="user-badge-name">{user.name.split(' ')[0]}</span>
                    <span className={`user-badge-balance ${user.balance < 0.5 ? 'low' : ''}`}>${user.balance.toFixed(2)}</span>
                  </a>
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
        {isLoggedIn ? (
          <span>
            Ulogovan kao <span className="footer-brand">{user.name.split(' ')[0]}</span>
            {' · '}
            <button className="footer-logout" onClick={async () => { await logout(); window.location.reload() }}>
              Odjavi se
            </button>
          </span>
        ) : (
          <>Powered by <span className="footer-brand">Vajb<span>Agent</span></span></>
        )}
      </motion.div>
    </div>
  )
}
