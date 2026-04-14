import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Rocket, Plus, Loader2, Check, Search, ExternalLink, Globe, RefreshCw } from 'lucide-react'
import * as nl from '../services/netlifyIntegration'
import './GitHubPushModal.css'

interface Props {
  open: boolean
  onClose: () => void
  onDeploy: (opts: { siteId?: string; siteName?: string }) => Promise<{ url: string; site_id: string }>
  defaultName: string
  currentSiteId: string | null
}

type Tab = 'existing' | 'new'

export default function NetlifyDeployModal({ open, onClose, onDeploy, defaultName, currentSiteId }: Props) {
  const [tab, setTab] = useState<Tab>('existing')
  const [sites, setSites] = useState<nl.NetlifySite[]>([])
  const [loadingSites, setLoadingSites] = useState(false)
  const [search, setSearch] = useState('')
  const [newSiteName, setNewSiteName] = useState(defaultName)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSites = async () => {
    setLoadingSites(true)
    try {
      const s = await nl.listSites()
      setSites(s)
      if (currentSiteId || s.length > 0) setTab('existing')
      else setTab('new')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setLoadingSites(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setNewSiteName(defaultName)
    setError(null)
    loadSites()
  }, [open, defaultName])

  const deployTo = async (opts: { siteId?: string; siteName?: string }) => {
    setDeploying(true)
    setError(null)
    try {
      await onDeploy(opts)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška'
      // Detect subdomain collision → suggest auto-retry with suffix
      if (/subdomain.*unique|must be unique/i.test(msg) && opts.siteName) {
        const suffix = Math.random().toString(36).slice(2, 6)
        setError(`Ime "${opts.siteName}" je zauzeto. Probaj "${opts.siteName}-${suffix}" ili drugo ime.`)
        setNewSiteName(`${opts.siteName}-${suffix}`)
        setTab('new')
      } else {
        setError(msg)
      }
    } finally {
      setDeploying(false)
    }
  }

  const handleDeployExisting = (site: nl.NetlifySite) => {
    deployTo({ siteId: site.id })
  }

  const handleDeployNew = () => {
    const name = newSiteName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (!name) return
    deployTo({ siteName: name })
  }

  const filtered = search
    ? sites.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    : sites

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="gh-modal-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="gh-modal"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="gh-modal-close" onClick={onClose}>
              <X size={16} />
            </button>

            <div className="gh-modal-header">
              <div className="gh-modal-icon" style={{ background: 'rgba(0, 173, 159, 0.12)', borderColor: 'rgba(0, 173, 159, 0.3)', color: '#00AD9F' }}>
                <Rocket size={20} />
              </div>
              <div>
                <h2>Objavi na Netlify</h2>
                <p>Izaberi postojeći sajt ili napravi novi</p>
              </div>
            </div>

            <div className="gh-modal-tabs">
              <button
                className={`gh-tab ${tab === 'existing' ? 'active' : ''}`}
                onClick={() => setTab('existing')}
              >
                Postojeći sajt
                {sites.length > 0 && <span className="gh-tab-count">{sites.length}</span>}
              </button>
              <button
                className={`gh-tab ${tab === 'new' ? 'active' : ''}`}
                onClick={() => setTab('new')}
              >
                <Plus size={13} /> Novi sajt
              </button>
              <button className="gh-tab-refresh" onClick={loadSites} disabled={loadingSites} title="Osveži listu">
                <RefreshCw size={12} className={loadingSites ? 'spin' : ''} />
              </button>
            </div>

            <div className="gh-modal-body">
              {tab === 'existing' && (
                <>
                  <div className="gh-search">
                    <Search size={13} />
                    <input
                      type="text"
                      placeholder="Pretraži sajtove..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>

                  {loadingSites ? (
                    <div className="gh-loading">
                      <Loader2 size={16} className="spin" /> Učitavam...
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="gh-empty">
                      {sites.length === 0 ? 'Nemaš još sajtove. Napravi novi →' : 'Nema rezultata.'}
                    </div>
                  ) : (
                    <div className="gh-repo-list">
                      {filtered.map(site => {
                        const isCurrent = site.id === currentSiteId
                        return (
                          <button
                            key={site.id}
                            className={`gh-repo-item ${isCurrent ? 'current' : ''}`}
                            onClick={() => handleDeployExisting(site)}
                            disabled={deploying}
                          >
                            <div className="gh-repo-icon" style={isCurrent ? { background: 'rgba(0, 173, 159, 0.12)', color: '#00AD9F' } : undefined}>
                              <Globe size={12} />
                            </div>
                            <div className="gh-repo-info">
                              <div className="gh-repo-name">
                                {site.name}
                                {isCurrent && <span className="gh-current-badge">trenutni</span>}
                              </div>
                              <div className="gh-repo-desc">{(site.ssl_url || site.url).replace('https://', '')}</div>
                            </div>
                            <a
                              href={site.ssl_url || site.url}
                              target="_blank"
                              rel="noopener"
                              className="gh-repo-link"
                              onClick={(e) => e.stopPropagation()}
                              title="Otvori sajt"
                            >
                              <ExternalLink size={12} />
                            </a>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </>
              )}

              {tab === 'new' && (
                <div className="gh-new-form">
                  <label>
                    <span>Ime sajta (subdomen)</span>
                    <input
                      type="text"
                      value={newSiteName}
                      onChange={(e) => setNewSiteName(e.target.value)}
                      placeholder="moj-sajt"
                      autoFocus
                    />
                    <small>
                      Biće dostupan na <strong>{(newSiteName || 'moj-sajt').toLowerCase().replace(/[^a-z0-9-]/g, '-')}.netlify.app</strong>
                      {' · '}samo slova, brojevi i crtice · mora biti jedinstveno.
                    </small>
                  </label>
                </div>
              )}
            </div>

            {error && <div className="gh-modal-error">{error}</div>}

            {tab === 'new' && (
              <div className="gh-modal-footer">
                <button className="gh-btn-ghost" onClick={onClose} disabled={deploying}>
                  Otkaži
                </button>
                <button
                  className="gh-btn-primary"
                  onClick={handleDeployNew}
                  disabled={deploying || !newSiteName.trim()}
                  style={{ background: 'linear-gradient(135deg, #00AD9F, #009688)', boxShadow: '0 4px 14px rgba(0, 173, 159, 0.35)' }}
                >
                  {deploying ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                  {deploying ? 'Objavljujem...' : 'Napravi i objavi'}
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
