import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import { Sparkles, Zap, Crown, X, Loader2, Gift } from 'lucide-react'
import { createCheckout } from '../services/userService'
import { formatCredits } from '../services/credits'
import './PaywallModal.css'

interface PaywallModalProps {
  open: boolean
  onClose: () => void
  /** Headline shown at top — differs between "first use" and "out of credits" */
  variant?: 'welcome' | 'out-of-credits'
  /** Called if user chooses to keep the free tier and skip payment (only on welcome variant) */
  onSkip?: () => void
  /** Current balance in USD — shown in out-of-credits variant */
  currentBalanceUsd?: number
}

interface Pack {
  id: string
  usd: number
  label: string
  sub: string
  icon: typeof Sparkles
  highlight?: boolean
}

const PACKS: Pack[] = [
  { id: 'small', usd: 5, label: 'Starter', sub: 'Isprobaj jače modele', icon: Sparkles },
  { id: 'mid', usd: 15, label: 'Kreator', sub: 'Najbolji odnos cene', icon: Zap, highlight: true },
  { id: 'big', usd: 20, label: 'Pro', sub: 'Za ozbiljne projekte', icon: Crown },
  { id: 'huge', usd: 50, label: 'Ultra', sub: 'Mesec dana vajbovanja', icon: Crown },
]

export default function PaywallModal({ open, onClose, variant = 'welcome', onSkip, currentBalanceUsd }: PaywallModalProps) {
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [customMode, setCustomMode] = useState(false)
  const [customAmount, setCustomAmount] = useState('10')

  // Esc-to-close, regardless of variant. Attach only while open so we
  // don't leak listeners when the modal is closed.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const startCheckout = async (usd: number) => {
    if (usd < 1 || usd > 1000) {
      setError('Iznos mora biti između $1 i $1000.')
      return
    }
    setError('')
    setLoading(String(usd))
    const result = await createCheckout(usd)
    setLoading(null)
    if (!result.ok || !result.url) {
      setError(result.error || 'Greška pri pokretanju plaćanja.')
      return
    }
    // Same-tab redirect to Stripe Checkout
    window.location.href = result.url
  }

  const handleCustom = () => {
    const n = Number(customAmount)
    if (!Number.isFinite(n) || n < 1) {
      setError('Unesi iznos u dolarima (min. $1).')
      return
    }
    startCheckout(Math.round(n))
  }

  const isOut = variant === 'out-of-credits'

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
            className="paywall-modal"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button is always available — even when out of credits
                the user must be able to dismiss the modal (to go check
                projects, copy code, etc.). We show the paywall again the
                next time they try to send a chat message. */}
            <button className="paywall-close" onClick={onClose} aria-label="Zatvori">
              <X size={18} />
            </button>

            <div className="paywall-header">
              <div className="paywall-badge">
                <Sparkles size={14} />
                <span>Krediti</span>
              </div>
              <h2>
                {isOut
                  ? 'Ponestalo ti je kredita'
                  : 'Pokreni sa pravom snagom'}
              </h2>
              <p>
                {isOut
                  ? `Imaš još ${formatCredits(currentBalanceUsd ?? 0)} kredita. Dopuni nalog da nastaviš da gradiš bez prekida.`
                  : 'Dobio si besplatne kredite na poklon. Za duže sesije, jače modele i složenije projekte dopuni nalog.'}
              </p>
            </div>

            {!customMode ? (
              <>
                <div className="paywall-packs">
                  {PACKS.map(p => {
                    const Icon = p.icon
                    const isLoading = loading === String(p.usd)
                    return (
                      <button
                        key={p.id}
                        className={`paywall-pack ${p.highlight ? 'highlight' : ''}`}
                        onClick={() => startCheckout(p.usd)}
                        disabled={!!loading}
                      >
                        {p.highlight && <span className="pack-ribbon">Preporučeno</span>}
                        <div className="pack-icon"><Icon size={18} /></div>
                        <div className="pack-name">{p.label}</div>
                        <div className="pack-credits">{formatCredits(p.usd)}</div>
                        <div className="pack-credits-label">kredita</div>
                        <div className="pack-price">
                          {isLoading ? <Loader2 size={14} className="spin" /> : `$${p.usd}`}
                        </div>
                      </button>
                    )
                  })}
                </div>

                <button className="paywall-custom-btn" onClick={() => { setCustomMode(true); setError('') }}>
                  Ili unesi svoj iznos →
                </button>
              </>
            ) : (
              <div className="paywall-custom">
                <label>Koliko hoćeš da uplatiš?</label>
                <div className="paywall-custom-row">
                  <div className="custom-input-wrap">
                    <span className="custom-prefix">$</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      value={customAmount}
                      onChange={(e) => setCustomAmount(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="custom-credits">
                    = <strong>{formatCredits(Number(customAmount) || 0)}</strong> kredita
                  </div>
                </div>
                <div className="paywall-custom-actions">
                  <button className="btn-ghost" onClick={() => setCustomMode(false)}>← Nazad</button>
                  <button
                    className="btn-primary"
                    onClick={handleCustom}
                    disabled={!!loading}
                  >
                    {loading ? <Loader2 size={14} className="spin" /> : 'Nastavi ka plaćanju'}
                  </button>
                </div>
              </div>
            )}

            {error && <div className="paywall-error">{error}</div>}

            {!isOut && onSkip && (
              <button className="paywall-skip" onClick={onSkip}>
                <Gift size={13} />
                Nastavi sa besplatnim kreditima
              </button>
            )}

            <p className="paywall-secure">
              🔒 Plaćanje obavlja Stripe. Podatke kartice ne čuvamo.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
