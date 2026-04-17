import { useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Lock, CheckCircle2, AlertCircle, Sparkles } from 'lucide-react'
import { resetPassword, type UserInfo } from '../services/userService'
import './ResetPassword.css'

interface ResetPasswordProps {
  token: string
  /** Called after successful reset — SPA is already logged in via the fresh
   *  session cookie returned by /auth/reset-password, so the parent should
   *  just swap to the welcome/IDE state. */
  onComplete: (user: UserInfo) => void
  /** User hit "cancel" — go to welcome without resetting. */
  onCancel: () => void
}

export default function ResetPassword({ token, onComplete, onCancel }: ResetPasswordProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async () => {
    setError('')
    if (password.length < 8) { setError('Lozinka mora imati najmanje 8 karaktera.'); return }
    if (password !== confirm) { setError('Lozinke se ne poklapaju.'); return }
    setLoading(true)
    const result = await resetPassword(token, password)
    setLoading(false)
    if (!result.ok || !result.user) {
      setError(result.error || 'Greška pri resetovanju lozinke.')
      return
    }
    setDone(true)
    // Brief success animation, then hand control back to the parent.
    setTimeout(() => onComplete(result.user!), 900)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  }

  return (
    <div className="reset-root">
      <div className="reset-glow" />
      <div className="reset-glow-secondary" />

      <motion.div
        className="reset-card"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="reset-badge">
          <Sparkles size={14} />
          <span>Reset lozinke</span>
        </div>

        {done ? (
          <>
            <div className="reset-icon reset-icon-success">
              <CheckCircle2 size={32} />
            </div>
            <h1>Lozinka je promenjena</h1>
            <p>Prijavljujem te automatski…</p>
          </>
        ) : (
          <>
            <div className="reset-icon">
              <Lock size={26} />
            </div>
            <h1>Postavi novu lozinku</h1>
            <p>Izaberi novu lozinku. Posle submita, automatski ćeš biti prijavljen.</p>

            <div className="reset-fields">
              <input
                type="password"
                className="reset-input"
                placeholder="Nova lozinka (min. 8 karaktera)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKey}
                autoFocus
                autoComplete="new-password"
              />
              <input
                type="password"
                className="reset-input"
                placeholder="Potvrdi novu lozinku"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={handleKey}
                autoComplete="new-password"
              />
            </div>

            {error && (
              <div className="reset-error">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}

            <button className="reset-submit" onClick={submit} disabled={loading}>
              {loading ? <Loader2 size={16} className="spin" /> : 'Sačuvaj novu lozinku'}
            </button>

            <button type="button" className="reset-cancel" onClick={onCancel}>
              Otkaži i nazad na početnu
            </button>
          </>
        )}
      </motion.div>
    </div>
  )
}
