import { useState, useEffect, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Check, Loader2, Plus, Trash2, Eye, EyeOff, Copy,
  Plug, Key, User, Info, Zap, ExternalLink, Database, GitBranch,
  Rocket, CreditCard, ArrowLeft,
} from 'lucide-react'
import { loadSecrets, addSecret, removeSecret, type Secret } from '../services/secretsStore'
import * as supa from '../services/supabaseIntegration'
import './Settings.css'

type Tab = 'integrations' | 'secrets' | 'account' | 'about'

interface IntegrationDef {
  key: string
  name: string
  description: string
  icon: ReactNode
  color: string
  fields?: { key: string; label: string; placeholder: string; type?: string }[]
  docsUrl?: string
  oauth?: boolean  // Supabase has OAuth
}

const INTEGRATIONS: IntegrationDef[] = [
  {
    key: 'supabase',
    name: 'Supabase',
    description: 'Baza podataka, autentifikacija, storage',
    icon: <Database size={20} />,
    color: '#3ecf8e',
    oauth: true,
    fields: [
      { key: 'vajb_supabase_url', label: 'Project URL', placeholder: 'https://xxxxx.supabase.co' },
      { key: 'vajb_supabase_key', label: 'Anon Key', placeholder: 'eyJhbGciOi...', type: 'password' },
    ],
    docsUrl: 'https://supabase.com/dashboard/project/_/settings/api',
  },
  {
    key: 'netlify',
    name: 'Netlify',
    description: 'Deploy sajta jednim klikom',
    icon: <Rocket size={20} />,
    color: '#00AD9F',
    fields: [
      { key: 'vajb_netlify_token', label: 'Personal Access Token', placeholder: 'nfp_xxxxxxxxxxxx', type: 'password' },
    ],
    docsUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
  },
  {
    key: 'github',
    name: 'GitHub',
    description: 'Push koda direktno u repozitorijum',
    icon: <GitBranch size={20} />,
    color: '#f0f6fc',
    fields: [
      { key: 'vajb_github_token', label: 'Personal Access Token', placeholder: 'ghp_xxxxxxxxxxxx', type: 'password' },
      { key: 'vajb_github_repo', label: 'Repozitorijum', placeholder: 'username/repo-name' },
    ],
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    key: 'vercel',
    name: 'Vercel',
    description: 'Alternativa Netlify-u za deploy',
    icon: <Rocket size={20} />,
    color: '#ffffff',
    fields: [
      { key: 'vajb_vercel_token', label: 'Access Token', placeholder: 'xxxxxxxxxxxxxxxx', type: 'password' },
    ],
    docsUrl: 'https://vercel.com/account/tokens',
  },
  {
    key: 'stripe',
    name: 'Stripe',
    description: 'Integracija online plaćanja',
    icon: <CreditCard size={20} />,
    color: '#635bff',
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
  const [tab, setTab] = useState<Tab>('integrations')
  const [activeIntegration, setActiveIntegration] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)

  // Secrets
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [newSecretKey, setNewSecretKey] = useState('')
  const [newSecretValue, setNewSecretValue] = useState('')
  const [showSecretValue, setShowSecretValue] = useState<Record<string, boolean>>({})

  // Supabase OAuth
  const [supaStatus, setSupaStatus] = useState<{ connected: boolean; configured: boolean } | null>(null)
  const [supaLoading, setSupaLoading] = useState(false)
  const [supaError, setSupaError] = useState<string | null>(null)
  const [supaProjects, setSupaProjects] = useState<supa.SupabaseProject[]>([])
  const [supaOrgs, setSupaOrgs] = useState<supa.SupabaseOrg[]>([])
  const [creatingProject, setCreatingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [showCreateProject, setShowCreateProject] = useState(false)

  useEffect(() => {
    if (!open) return
    // Load integration values
    const loaded: Record<string, string> = {}
    for (const integration of INTEGRATIONS) {
      if (!integration.fields) continue
      for (const field of integration.fields) {
        loaded[field.key] = localStorage.getItem(field.key) || ''
      }
    }
    setValues(loaded)
    setSecrets(loadSecrets())
    // Load Supabase status
    supa.getStatus().then(s => {
      setSupaStatus(s)
      if (s.connected) loadSupaData()
    }).catch(() => setSupaStatus({ connected: false, configured: false }))
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
      localStorage.setItem('vajb_supabase_url', creds.url)
      localStorage.setItem('vajb_supabase_key', creds.anon_key)
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
      setTimeout(() => handleUseProject(project), 1000)
    } catch (err) {
      setSupaError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setCreatingProject(false)
    }
  }

  const handleSaveIntegration = (integrationKey: string) => {
    const integration = INTEGRATIONS.find(i => i.key === integrationKey)
    if (!integration?.fields) return

    for (const field of integration.fields) {
      const val = values[field.key]?.trim() || ''
      if (val) {
        localStorage.setItem(field.key, val)
        // Also save Supabase as env secrets for auto-injection
        if (integrationKey === 'supabase' && val) {
          if (field.key === 'vajb_supabase_url') {
            addSecret('SUPABASE_URL', val)
            addSecret('VITE_SUPABASE_URL', val)
          } else if (field.key === 'vajb_supabase_key') {
            addSecret('SUPABASE_ANON_KEY', val)
            addSecret('VITE_SUPABASE_ANON_KEY', val)
          }
        }
      } else {
        localStorage.removeItem(field.key)
      }
    }
    setSecrets(loadSecrets())
    setSaved(integrationKey)
    setTimeout(() => setSaved(null), 2000)
  }

  const isConnected = (integration: IntegrationDef) => {
    if (integration.key === 'supabase' && supaStatus?.connected) return true
    if (!integration.fields) return false
    return integration.fields.every(f => !!localStorage.getItem(f.key))
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

  const copySecret = async (value: string) => {
    await navigator.clipboard.writeText(value)
  }

  const currentIntegration = activeIntegration ? INTEGRATIONS.find(i => i.key === activeIntegration) : null

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="settings-overlay-v2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="settings-modal-v2"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* ── Sidebar ── */}
            <aside className="settings-sidebar">
              <div className="settings-sidebar-header">
                <h2>Podešavanja</h2>
              </div>

              <nav className="settings-nav">
                <button
                  className={`settings-nav-item ${tab === 'integrations' ? 'active' : ''}`}
                  onClick={() => { setTab('integrations'); setActiveIntegration(null) }}
                >
                  <Plug size={15} />
                  Integracije
                </button>
                <button
                  className={`settings-nav-item ${tab === 'secrets' ? 'active' : ''}`}
                  onClick={() => setTab('secrets')}
                >
                  <Key size={15} />
                  Secrets
                  {secrets.length > 0 && <span className="nav-count">{secrets.length}</span>}
                </button>
                <button
                  className={`settings-nav-item ${tab === 'account' ? 'active' : ''}`}
                  onClick={() => setTab('account')}
                >
                  <User size={15} />
                  Nalog
                </button>
                <button
                  className={`settings-nav-item ${tab === 'about' ? 'active' : ''}`}
                  onClick={() => setTab('about')}
                >
                  <Info size={15} />
                  O aplikaciji
                </button>
              </nav>
            </aside>

            {/* ── Content ── */}
            <main className="settings-content">
              <button className="settings-close-v2" onClick={onClose} aria-label="Zatvori">
                <X size={18} />
              </button>

              {tab === 'integrations' && !currentIntegration && (
                <motion.div
                  className="settings-pane"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="pane-header">
                    <h3>Integracije</h3>
                    <p>Poveži servise da bi agent mogao direktno da ih koristi.</p>
                  </div>

                  <div className="integrations-grid">
                    {INTEGRATIONS.map(integration => {
                      const connected = isConnected(integration)
                      return (
                        <button
                          key={integration.key}
                          className={`integration-tile ${connected ? 'connected' : ''}`}
                          onClick={() => setActiveIntegration(integration.key)}
                        >
                          <div
                            className="integration-tile-icon"
                            style={{ color: integration.color, background: `${integration.color}15`, borderColor: `${integration.color}40` }}
                          >
                            {integration.icon}
                          </div>
                          <div className="integration-tile-info">
                            <div className="integration-tile-name">
                              {integration.name}
                              {connected && <span className="connected-dot" />}
                            </div>
                            <div className="integration-tile-desc">{integration.description}</div>
                          </div>
                          <div className="integration-tile-status">
                            {connected ? <Check size={14} /> : <Plus size={14} />}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </motion.div>
              )}

              {/* ── Integration Detail View ── */}
              {tab === 'integrations' && currentIntegration && (
                <motion.div
                  className="settings-pane"
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <button className="pane-back" onClick={() => setActiveIntegration(null)}>
                    <ArrowLeft size={14} /> Nazad
                  </button>

                  <div className="integration-detail-header">
                    <div
                      className="integration-detail-icon"
                      style={{ color: currentIntegration.color, background: `${currentIntegration.color}15`, borderColor: `${currentIntegration.color}40` }}
                    >
                      {currentIntegration.icon}
                    </div>
                    <div className="integration-detail-title">
                      <h3>{currentIntegration.name}</h3>
                      <p>{currentIntegration.description}</p>
                    </div>
                    {currentIntegration.docsUrl && (
                      <a href={currentIntegration.docsUrl} target="_blank" rel="noopener" className="integration-detail-docs">
                        <ExternalLink size={13} /> Dokumentacija
                      </a>
                    )}
                  </div>

                  {/* Supabase OAuth Section */}
                  {currentIntegration.key === 'supabase' && supaStatus?.configured && (
                    <div className="supa-oauth-section">
                      {!supaStatus.connected ? (
                        <div className="supa-oauth-connect">
                          <div className="supa-oauth-info">
                            <h4>Poveži se jednim klikom</h4>
                            <p>Autorizuj VajbAgent na Supabase-u i agent će moći da pravi projekte, baze, auth — sve automatski.</p>
                          </div>
                          <button
                            className="btn-primary"
                            onClick={handleSupaConnect}
                            disabled={supaLoading}
                          >
                            {supaLoading ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
                            Poveži Supabase
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="supa-connected-bar">
                            <div>
                              <Check size={14} style={{ color: '#3ecf8e' }} /> Povezan preko OAuth
                            </div>
                            <button className="btn-ghost-danger" onClick={handleSupaDisconnect}>
                              Prekini
                            </button>
                          </div>

                          {supaProjects.length > 0 && (
                            <div className="supa-projects-section">
                              <h4>Tvoji projekti</h4>
                              <div className="supa-project-list">
                                {supaProjects.map(p => (
                                  <button
                                    key={p.id}
                                    className="supa-project-card"
                                    onClick={() => handleUseProject(p)}
                                    disabled={supaLoading}
                                  >
                                    <div className="supa-project-card-info">
                                      <div className="supa-project-card-name">{p.name}</div>
                                      <div className="supa-project-card-region">{p.region}</div>
                                    </div>
                                    <span className="supa-project-card-action">Koristi →</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="supa-create-section">
                            {!showCreateProject ? (
                              <button className="btn-outline" onClick={() => setShowCreateProject(true)}>
                                <Plus size={13} /> Kreiraj novi projekat
                              </button>
                            ) : (
                              <div className="supa-create-form-v2">
                                <input
                                  type="text"
                                  placeholder="Ime projekta..."
                                  value={newProjectName}
                                  onChange={(e) => setNewProjectName(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProject() }}
                                  disabled={creatingProject}
                                  autoFocus
                                />
                                <button
                                  className="btn-primary"
                                  onClick={handleCreateProject}
                                  disabled={creatingProject || !newProjectName.trim()}
                                >
                                  {creatingProject ? <Loader2 size={13} className="spin" /> : 'Kreiraj'}
                                </button>
                                <button
                                  className="btn-ghost"
                                  onClick={() => { setShowCreateProject(false); setNewProjectName('') }}
                                >
                                  ✕
                                </button>
                              </div>
                            )}
                          </div>
                        </>
                      )}

                      {supaError && <div className="alert-error">{supaError}</div>}
                      {saved === 'supabase-oauth' && <div className="alert-success"><Check size={13} /> Projekat povezan!</div>}
                    </div>
                  )}

                  {/* Manual fields (fallback or for other services) */}
                  {currentIntegration.fields && (
                    <div className="integration-manual">
                      {currentIntegration.key === 'supabase' && supaStatus?.configured && (
                        <div className="manual-divider">
                          <span>ili ručno unesi</span>
                        </div>
                      )}
                      <div className="field-list">
                        {currentIntegration.fields.map(field => (
                          <div key={field.key} className="field-item">
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
                        className="btn-primary full-width"
                        onClick={() => handleSaveIntegration(currentIntegration.key)}
                      >
                        {saved === currentIntegration.key ? <><Check size={13} /> Sačuvano!</> : 'Sačuvaj'}
                      </button>
                    </div>
                  )}
                </motion.div>
              )}

              {/* ── Secrets Tab ── */}
              {tab === 'secrets' && (
                <motion.div
                  className="settings-pane"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="pane-header">
                    <h3>Environment Secrets</h3>
                    <p>API ključevi i env varijable koje agent automatski ubacuje u <code>.env</code> fajl projekta. Čuvaju se lokalno u tvom browser-u.</p>
                  </div>

                  <div className="secrets-add-v2">
                    <input
                      type="text"
                      placeholder="KEY (npr. OPENAI_API_KEY)"
                      value={newSecretKey}
                      onChange={(e) => setNewSecretKey(e.target.value)}
                      className="secret-field secret-field-key"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddSecret() }}
                    />
                    <input
                      type="password"
                      placeholder="vrednost"
                      value={newSecretValue}
                      onChange={(e) => setNewSecretValue(e.target.value)}
                      className="secret-field"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddSecret() }}
                    />
                    <button
                      className="btn-primary"
                      onClick={handleAddSecret}
                      disabled={!newSecretKey.trim() || !newSecretValue.trim()}
                    >
                      <Plus size={14} /> Dodaj
                    </button>
                  </div>

                  {secrets.length === 0 ? (
                    <div className="empty-state">
                      <Key size={28} />
                      <p>Nema sačuvanih env varijabli</p>
                      <span>Dodaj API ključeve koje agent treba da koristi u projektima</span>
                    </div>
                  ) : (
                    <div className="secrets-list-v2">
                      {secrets.map((secret) => (
                        <div key={secret.key} className="secret-item">
                          <div className="secret-item-info">
                            <div className="secret-item-key">{secret.key}</div>
                            <div className="secret-item-value">
                              {showSecretValue[secret.key]
                                ? secret.value
                                : '•'.repeat(Math.min(secret.value.length, 32))}
                            </div>
                          </div>
                          <div className="secret-item-actions">
                            <button
                              className="icon-btn"
                              onClick={() => toggleShowSecret(secret.key)}
                              title={showSecretValue[secret.key] ? 'Sakrij' : 'Prikaži'}
                            >
                              {showSecretValue[secret.key] ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                            <button
                              className="icon-btn"
                              onClick={() => copySecret(secret.value)}
                              title="Kopiraj"
                            >
                              <Copy size={13} />
                            </button>
                            <button
                              className="icon-btn icon-btn-danger"
                              onClick={() => handleRemoveSecret(secret.key)}
                              title="Obriši"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}

              {/* ── Account Tab ── */}
              {tab === 'account' && (
                <motion.div
                  className="settings-pane"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="pane-header">
                    <h3>Nalog</h3>
                    <p>Upravljaj svojim VajbAgent nalogom i kreditima.</p>
                  </div>

                  <div className="account-card">
                    <a href="https://vajbagent.com/dashboard" target="_blank" rel="noopener" className="account-link">
                      <CreditCard size={16} />
                      <div>
                        <div className="account-link-title">Dopuni kredite</div>
                        <div className="account-link-desc">Otvori dashboard na vajbagent.com</div>
                      </div>
                      <ExternalLink size={14} />
                    </a>

                    <a href="https://vajbagent.com/dashboard" target="_blank" rel="noopener" className="account-link">
                      <User size={16} />
                      <div>
                        <div className="account-link-title">Upravljaj nalogom</div>
                        <div className="account-link-desc">Promeni email, lozinku, ime</div>
                      </div>
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </motion.div>
              )}

              {/* ── About Tab ── */}
              {tab === 'about' && (
                <motion.div
                  className="settings-pane"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="pane-header">
                    <h3>O aplikaciji</h3>
                    <p>VajbAgent — AI koji pravi kompletne aplikacije iz tvog opisa.</p>
                  </div>

                  <div className="about-grid">
                    <div className="about-card">
                      <div className="about-card-label">Verzija</div>
                      <div className="about-card-value">1.0.0</div>
                    </div>
                    <div className="about-card">
                      <div className="about-card-label">Tehnologija</div>
                      <div className="about-card-value">WebContainers</div>
                    </div>
                    <div className="about-card">
                      <div className="about-card-label">Backend</div>
                      <div className="about-card-value">vajbagent.com</div>
                    </div>
                    <div className="about-card">
                      <div className="about-card-label">Status</div>
                      <div className="about-card-value" style={{ color: '#3ecf8e' }}>● Online</div>
                    </div>
                  </div>

                  <div className="about-links">
                    <a href="https://vajbagent.com" target="_blank" rel="noopener" className="about-link-item">
                      <span>Početna</span>
                      <ExternalLink size={13} />
                    </a>
                    <a href="https://vajbagent.com/dashboard" target="_blank" rel="noopener" className="about-link-item">
                      <span>Dashboard</span>
                      <ExternalLink size={13} />
                    </a>
                  </div>
                </motion.div>
              )}
            </main>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
