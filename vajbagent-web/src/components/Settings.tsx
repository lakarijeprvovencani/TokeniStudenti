import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Check, ExternalLink } from 'lucide-react'
import './Settings.css'

interface Integration {
  key: string
  name: string
  description: string
  fields: { key: string; label: string; placeholder: string; type?: string }[]
  docsUrl: string
}

const INTEGRATIONS: Integration[] = [
  {
    key: 'netlify',
    name: 'Netlify',
    description: 'Deploy sajta jednim klikom',
    fields: [
      { key: 'vajb_netlify_token', label: 'Personal Access Token', placeholder: 'nfp_xxxxxxxxxxxx' },
    ],
    docsUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
  },
  {
    key: 'github',
    name: 'GitHub',
    description: 'Push koda na GitHub repozitorijum',
    fields: [
      { key: 'vajb_github_token', label: 'Personal Access Token', placeholder: 'ghp_xxxxxxxxxxxx' },
      { key: 'vajb_github_repo', label: 'Repozitorijum', placeholder: 'username/repo-name' },
    ],
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    key: 'supabase',
    name: 'Supabase',
    description: 'Baza podataka i autentifikacija',
    fields: [
      { key: 'vajb_supabase_url', label: 'Project URL', placeholder: 'https://xxxxx.supabase.co' },
      { key: 'vajb_supabase_key', label: 'Anon Key', placeholder: 'eyJhbGciOiJIUzI1NiIs...' },
    ],
    docsUrl: 'https://supabase.com/dashboard/project/_/settings/api',
  },
  {
    key: 'vercel',
    name: 'Vercel',
    description: 'Deploy na Vercel platformu',
    fields: [
      { key: 'vajb_vercel_token', label: 'Access Token', placeholder: 'xxxxxxxxxxxxxxxx' },
    ],
    docsUrl: 'https://vercel.com/account/tokens',
  },
  {
    key: 'stripe',
    name: 'Stripe',
    description: 'Integracija plaćanja',
    fields: [
      { key: 'vajb_stripe_pk', label: 'Publishable Key', placeholder: 'pk_test_xxxxxxxxxxxx' },
      { key: 'vajb_stripe_sk', label: 'Secret Key', placeholder: 'sk_test_xxxxxxxxxxxx', type: 'password' },
    ],
    docsUrl: 'https://dashboard.stripe.com/apikeys',
  },
]

interface SettingsProps {
  open: boolean
  onClose: () => void
}

export default function Settings({ open, onClose }: SettingsProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    // Učitaj sve ključeve iz localStorage
    const loaded: Record<string, string> = {}
    for (const integration of INTEGRATIONS) {
      for (const field of integration.fields) {
        loaded[field.key] = localStorage.getItem(field.key) || ''
      }
    }
    setValues(loaded)
  }, [open])

  const handleSave = (integrationKey: string) => {
    const integration = INTEGRATIONS.find(i => i.key === integrationKey)
    if (!integration) return

    for (const field of integration.fields) {
      const val = values[field.key]?.trim() || ''
      if (val) {
        localStorage.setItem(field.key, val)
      } else {
        localStorage.removeItem(field.key)
      }
    }

    setSaved(integrationKey)
    setTimeout(() => setSaved(null), 2000)
  }

  const isConnected = (integration: Integration) => {
    return integration.fields.every(f => !!localStorage.getItem(f.key))
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="settings-panel"
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          >
            <div className="settings-header">
              <h2>Podešavanja</h2>
              <button className="settings-close" onClick={onClose}>
                <X size={18} />
              </button>
            </div>

            <div className="settings-body">
              <h3 className="settings-section-title">Integracije</h3>
              <p className="settings-section-desc">Poveži servise da bi agent mogao da ih koristi.</p>

              {INTEGRATIONS.map((integration) => (
                <div key={integration.key} className={`integration-card ${isConnected(integration) ? 'connected' : ''}`}>
                  <div className="integration-header">
                    <div className="integration-info">
                      <span className="integration-name">{integration.name}</span>
                      {isConnected(integration) && <span className="integration-badge">Povezano</span>}
                    </div>
                    <a href={integration.docsUrl} target="_blank" rel="noopener" className="integration-docs">
                      <ExternalLink size={12} />
                      Ključ
                    </a>
                  </div>
                  <p className="integration-desc">{integration.description}</p>

                  <div className="integration-fields">
                    {integration.fields.map((field) => (
                      <div key={field.key} className="integration-field">
                        <label>{field.label}</label>
                        <input
                          type={field.type || 'text'}
                          value={values[field.key] || ''}
                          onChange={(e) => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.placeholder}
                        />
                      </div>
                    ))}
                  </div>

                  <button
                    className="integration-save"
                    onClick={() => handleSave(integration.key)}
                  >
                    {saved === integration.key ? <><Check size={14} /> Sačuvano!</> : 'Sačuvaj'}
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
