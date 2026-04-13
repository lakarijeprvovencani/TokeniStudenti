import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Check, ExternalLink, Key, Plus, Trash2, Eye, EyeOff, Database, Loader2, Zap } from 'lucide-react'
import { loadSecrets, addSecret, removeSecret, type Secret } from '../services/secretsStore'
import * as supa from '../services/supabaseIntegration'
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
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [newSecretKey, setNewSecretKey] = useState('')
  const [newSecretValue, setNewSecretValue] = useState('')
  const [showSecretValue, setShowSecretValue] = useState<Record<string, boolean>>({})

  // Supabase OAuth state
  const [supaStatus, setSupaStatus] = useState<{ connected: boolean; configured: boolean } | null>(null)
  const [supaLoading, setSupaLoading] = useState(false)
  const [supaError, setSupaError] = useState<string | null>(null)
  const [supaProjects, setSupaProjects] = useState<supa.SupabaseProject[]>([])
  const [supaOrgs, setSupaOrgs] = useState<supa.SupabaseOrg[]>([])
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [showCreateProject, setShowCreateProject] = useState(false)

  useEffect(() => {
    // Učitaj sve ključeve iz localStorage
    const loaded: Record<string, string> = {}
    for (const integration of INTEGRATIONS) {
      for (const field of integration.fields) {
        loaded[field.key] = localStorage.getItem(field.key) || ''
      }
    }
    setValues(loaded)
    setSecrets(loadSecrets())
    // Load Supabase status
    if (open) {
      supa.getStatus().then(s => {
        setSupaStatus(s)
        if (s.connected) loadSupaData()
      }).catch(() => setSupaStatus({ connected: false, configured: false }))
    }
  }, [open])

  const loadSupaData = async () => {
    try {
      const [projects, orgs] = await Promise.all([
        supa.listProjects(),
        supa.listOrganizations(),
      ])
      setSupaProjects(projects)
      setSupaOrgs(orgs)
    } catch (err) {
      console.warn('[Supabase] Load failed:', err)
    }
  }

  const handleSupaConnect = async () => {
    setSupaError(null)
    setSupaLoading(true)
    try {
      await supa.startOAuthFlow()
      const status = await supa.getStatus()
      setSupaStatus(status)
      if (status.connected) await loadSupaData()
    } catch (err) {
      setSupaError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setSupaLoading(false)
    }
  }

  const handleSupaDisconnect = async () => {
    if (!confirm('Prekini Supabase vezu?')) return
    await supa.disconnect()
    setSupaStatus({ connected: false, configured: supaStatus?.configured || false })
    setSupaProjects([])
    setSupaOrgs([])
  }

  const handleUseProject = async (project: supa.SupabaseProject) => {
    setSupaLoading(true)
    setSupaError(null)
    try {
      const creds = await supa.getCredentials(project.ref)
      // Store as legacy fields so existing code uses them
      localStorage.setItem('vajb_supabase_url', creds.url)
      localStorage.setItem('vajb_supabase_key', creds.anon_key)
      // Also add as env secrets so they're auto-injected
      addSecret('SUPABASE_URL', creds.url)
      addSecret('SUPABASE_ANON_KEY', creds.anon_key)
      addSecret('VITE_SUPABASE_URL', creds.url)
      addSecret('VITE_SUPABASE_ANON_KEY', creds.anon_key)
      setSecrets(loadSecrets())
      setSaved('supabase-oauth')
      setTimeout(() => setSaved(null), 2500)
    } catch (err) {
      setSupaError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setSupaLoading(false)
    }
  }

  const handleCreateProject = async () => {
    if (!newProjectName.trim() || supaOrgs.length === 0) return
    setCreatingProject(true)
    setSupaError(null)
    try {
      const project = await supa.createProject(supaOrgs[0].id, newProjectName.trim())
      setSupaProjects(prev => [...prev, project])
      setNewProjectName('')
      setShowCreateProject(false)
      // Wait a moment then auto-use it
      setTimeout(() => handleUseProject(project), 1000)
    } catch (err) {
      setSupaError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setCreatingProject(false)
    }
  }

  const handleAddSecret = () => {
    if (!newSecretKey.trim() || !newSecretValue.trim()) return
    const updated = addSecret(newSecretKey, newSecretValue)
    setSecrets(updated)
    setNewSecretKey('')
    setNewSecretValue('')
  }

  const handleRemoveSecret = (key: string) => {
    if (!confirm(`Obrisati ${key}?`)) return
    setSecrets(removeSecret(key))
  }

  const toggleShowSecret = (key: string) => {
    setShowSecretValue(prev => ({ ...prev, [key]: !prev[key] }))
  }

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
              {/* ── Supabase OAuth Hero Section ── */}
              {supaStatus?.configured && (
                <div className={`supa-hero ${supaStatus.connected ? 'connected' : ''}`}>
                  <div className="supa-hero-bg" />
                  <div className="supa-hero-content">
                    <div className="supa-hero-icon">
                      <Database size={20} />
                    </div>
                    <div className="supa-hero-info">
                      <h3>
                        Supabase
                        {supaStatus.connected && <span className="supa-badge"><Check size={10} /> Povezano</span>}
                      </h3>
                      <p>
                        {supaStatus.connected
                          ? 'Agent može da pravi projekte, baze i tabele direktno u tvom Supabase nalogu.'
                          : 'Poveži svoj Supabase nalog jednim klikom. Agent će automatski praviti baze, tabele, autentifikaciju.'}
                      </p>
                    </div>
                    {!supaStatus.connected ? (
                      <button
                        className="supa-connect-btn"
                        onClick={handleSupaConnect}
                        disabled={supaLoading}
                      >
                        {supaLoading ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
                        Poveži Supabase
                      </button>
                    ) : (
                      <button className="supa-disconnect-btn" onClick={handleSupaDisconnect}>
                        Prekini
                      </button>
                    )}
                  </div>

                  {supaError && <div className="supa-error">{supaError}</div>}

                  {supaStatus.connected && supaProjects.length > 0 && (
                    <div className="supa-projects">
                      <div className="supa-projects-header">Tvoji projekti:</div>
                      {supaProjects.map(p => (
                        <button
                          key={p.id}
                          className="supa-project-item"
                          onClick={() => handleUseProject(p)}
                          disabled={supaLoading}
                        >
                          <Database size={12} />
                          <span className="supa-project-name">{p.name}</span>
                          <span className="supa-project-region">{p.region}</span>
                          <span className="supa-project-use">Koristi →</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {supaStatus.connected && (
                    <div className="supa-create">
                      {!showCreateProject ? (
                        <button className="supa-create-toggle" onClick={() => setShowCreateProject(true)}>
                          <Plus size={12} /> Kreiraj novi Supabase projekat
                        </button>
                      ) : (
                        <div className="supa-create-form">
                          <input
                            type="text"
                            placeholder="Ime projekta"
                            value={newProjectName}
                            onChange={(e) => setNewProjectName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject() }}
                            disabled={creatingProject}
                          />
                          <button onClick={handleCreateProject} disabled={creatingProject || !newProjectName.trim()}>
                            {creatingProject ? <Loader2 size={12} className="spin" /> : 'Kreiraj'}
                          </button>
                          <button className="supa-cancel" onClick={() => { setShowCreateProject(false); setNewProjectName('') }}>
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {saved === 'supabase-oauth' && (
                    <div className="supa-success"><Check size={12} /> Projekat povezan! Agent može da ga koristi.</div>
                  )}
                </div>
              )}

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

              {/* ── Environment Secrets ── */}
              <h3 className="settings-section-title" style={{ marginTop: 32 }}>
                <Key size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: -1 }} />
                Environment Variables
              </h3>
              <p className="settings-section-desc">
                API ključevi koje agent automatski ubacuje u <code>.env</code> fajl projekta.
                Bezbedno čuvani u tvom browser-u, nikad ne idu na server.
              </p>

              <div className="secrets-list">
                {secrets.length === 0 && (
                  <div className="secrets-empty">Nema sačuvanih env varijabli</div>
                )}
                {secrets.map((secret) => (
                  <div key={secret.key} className="secret-row">
                    <div className="secret-key">{secret.key}</div>
                    <div className="secret-value">
                      <code>
                        {showSecretValue[secret.key]
                          ? secret.value
                          : '•'.repeat(Math.min(secret.value.length, 24))}
                      </code>
                    </div>
                    <div className="secret-actions">
                      <button
                        className="secret-action-btn"
                        onClick={() => toggleShowSecret(secret.key)}
                        title={showSecretValue[secret.key] ? 'Sakrij' : 'Prikaži'}
                      >
                        {showSecretValue[secret.key] ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                      <button
                        className="secret-action-btn secret-delete"
                        onClick={() => handleRemoveSecret(secret.key)}
                        title="Obriši"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="secret-add">
                <input
                  type="text"
                  placeholder="OPENAI_API_KEY"
                  value={newSecretKey}
                  onChange={(e) => setNewSecretKey(e.target.value)}
                  className="secret-input secret-input-key"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddSecret() }}
                />
                <input
                  type="password"
                  placeholder="vrednost"
                  value={newSecretValue}
                  onChange={(e) => setNewSecretValue(e.target.value)}
                  className="secret-input secret-input-value"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddSecret() }}
                />
                <button
                  className="secret-add-btn"
                  onClick={handleAddSecret}
                  disabled={!newSecretKey.trim() || !newSecretValue.trim()}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
