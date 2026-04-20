import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, CheckCircle2, AlertCircle, MailCheck, Sparkles } from 'lucide-react'
import { verifyEmail } from '../services/userService'
import './ResetPassword.css'

interface VerifyEmailProps {
  token: string
  /** Fired once the animation finishes so the parent can swap to the
   *  welcome/IDE state. `success=true` means the account is now verified
   *  and the welcome bonus was released. */
  onDone: (success: boolean) => void
}

type Phase = 'verifying' | 'success' | 'error'

export default function VerifyEmail({ token, onDone }: VerifyEmailProps) {
  const [phase, setPhase] = useState<Phase>('verifying')
  const [error, setError] = useState('')
  const [alreadyVerified, setAlreadyVerified] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await verifyEmail(token)
      if (cancelled) return
      if (!result.ok) {
        setError(result.error || 'Verifikacija nije uspela.')
        setPhase('error')
        return
      }
      setAlreadyVerified(!!result.alreadyVerified)
      if (typeof result.balanceUsd === 'number') setBalance(result.balanceUsd)
      setPhase('success')
      // Give the success animation a beat, then hand control back.
      setTimeout(() => { if (!cancelled) onDone(true) }, 2200)
    })()
    return () => { cancelled = true }
  }, [token, onDone])

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
          <span>Potvrda emaila</span>
        </div>

        {phase === 'verifying' && (
          <>
            <div className="reset-icon">
              <Loader2 size={26} className="spin" />
            </div>
            <h1>Potvrđujem tvoj email…</h1>
            <p>Sekund, samo proveravam link.</p>
          </>
        )}

        {phase === 'success' && (
          <>
            <motion.div
              className="reset-icon reset-icon-success"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <CheckCircle2 size={32} />
            </motion.div>
            <h1>{alreadyVerified ? 'Email je već potvrđen' : 'Email uspešno potvrđen!'}</h1>
            {!alreadyVerified && typeof balance === 'number' && balance > 0 ? (
              <p>
                Nalog je aktiviran. Dobio si <strong>${balance.toFixed(2)}</strong> kredita dobrodošlice — možeš odmah da pokreneš prvi prompt.
              </p>
            ) : (
              <p>Nalog je aktivan — prebacujem te na aplikaciju.</p>
            )}
            <div className="reset-done-hint" style={{ opacity: 0.7, fontSize: 13, marginTop: 10 }}>
              <MailCheck size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              Hvala što si potvrdio adresu.
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <div className="reset-icon" style={{ color: '#ef4444' }}>
              <AlertCircle size={28} />
            </div>
            <h1>Link nije važeći</h1>
            <p>{error || 'Link za verifikaciju je istekao ili je pogrešan.'}</p>
            <p style={{ fontSize: 13, opacity: 0.75 }}>
              Uloguj se i zatraži novi email iz dashboarda, ili se ponovo registruj ako još nemaš nalog.
            </p>
            <button
              type="button"
              className="reset-submit"
              onClick={() => onDone(false)}
              style={{ marginTop: 18 }}
            >
              Nazad na početnu
            </button>
          </>
        )}
      </motion.div>
    </div>
  )
}
