import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, Shield } from 'lucide-react'
import type { SecretFinding } from '../services/pushFilter'
import './GitHubPushModal.css'

interface Props {
  open: boolean
  findings: SecretFinding[]
  onCancel: () => void
  onProceedWithRedaction: () => void
}

export default function SecretWarningModal({ open, findings, onCancel, onProceedWithRedaction }: Props) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="gh-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onCancel}
        >
          <motion.div
            className="gh-modal"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <button className="gh-modal-close" onClick={onCancel}>
              <X size={16} />
            </button>

            <div className="gh-modal-header">
              <div className="gh-modal-icon" style={{ background: 'rgba(239, 68, 68, 0.12)', borderColor: 'rgba(239, 68, 68, 0.3)', color: '#ef4444' }}>
                <AlertTriangle size={20} />
              </div>
              <div>
                <h2>Pronađeni tajni ključevi u kodu</h2>
                <p>U {findings.length === 1 ? 'kodu je pronađen 1 tajni ključ' : `kodu je pronađeno ${findings.length} tajnih ključeva`}. Ovo NE sme da ode javno.</p>
              </div>
            </div>

            <div className="gh-modal-body">
              <div className="gh-repo-list" style={{ maxHeight: 300 }}>
                {findings.map((f, i) => (
                  <div key={i} className="gh-repo-item" style={{ cursor: 'default' }}>
                    <div className="gh-repo-icon" style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#fca5a5' }}>
                      <AlertTriangle size={12} />
                    </div>
                    <div className="gh-repo-info">
                      <div className="gh-repo-name">{f.kind}</div>
                      <div className="gh-repo-desc" style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                        {f.path}:{f.line} — <span style={{ color: '#fca5a5' }}>{f.snippet}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{
                marginTop: 14,
                padding: 12,
                background: 'rgba(62, 207, 142, 0.06)',
                border: '1px solid rgba(62, 207, 142, 0.2)',
                borderRadius: 9,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}>
                <Shield size={16} style={{ color: '#3ecf8e', flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: '0.82rem', color: '#bbb', lineHeight: 1.5 }}>
                  <strong style={{ color: '#3ecf8e' }}>VajbAgent zaštita:</strong> kliknite <strong>Zaštiti i push-uj</strong> — tajni ključevi će biti automatski obrisani iz koda pre slanja na GitHub.
                  Preporučujemo da ih premestite u <code style={{ background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 4 }}>.env</code> fajl (koji se ionako nikad ne push-uje).
                </div>
              </div>
            </div>

            <div className="gh-modal-footer">
              <button className="gh-btn-ghost" onClick={onCancel}>
                Otkaži push
              </button>
              <button
                className="gh-btn-primary"
                onClick={onProceedWithRedaction}
                style={{ background: 'linear-gradient(135deg, #3ecf8e, #2eb37a)', boxShadow: '0 4px 14px rgba(62, 207, 142, 0.35)' }}
              >
                <Shield size={14} />
                Zaštiti i push-uj
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
