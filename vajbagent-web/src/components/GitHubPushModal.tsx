import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, GitBranch, Plus, Loader2, Check, Search, ExternalLink, Lock, Globe } from 'lucide-react'
import * as gh from '../services/githubIntegration'
import './GitHubPushModal.css'

interface Props {
  open: boolean
  onClose: () => void
  onPush: (repo: string, message: string) => Promise<void>
  defaultName: string
  connectedUsername?: string | null
}

type Tab = 'existing' | 'new'

export default function GitHubPushModal({ open, onClose, onPush, defaultName, connectedUsername }: Props) {
  const [tab, setTab] = useState<Tab>('existing')
  const [repos, setRepos] = useState<gh.GitHubRepo[]>([])
  const [loadingRepos, setLoadingRepos] = useState(false)
  const [search, setSearch] = useState('')
  const [newRepoName, setNewRepoName] = useState(defaultName)
  const [message, setMessage] = useState(`Update from VajbAgent — ${new Date().toISOString().slice(0, 10)}`)
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNewRepoName(defaultName)
    setError(null)
    setLoadingRepos(true)
    gh.listRepos()
      .then(r => {
        setRepos(r)
        setTab(r.length > 0 ? 'existing' : 'new')
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Greška'))
      .finally(() => setLoadingRepos(false))
  }, [open, defaultName])

  const handlePushExisting = async (repo: gh.GitHubRepo) => {
    setPushing(true)
    setError(null)
    try {
      await onPush(repo.full_name, message)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setPushing(false)
    }
  }

  const handleCreateAndPush = async () => {
    const name = newRepoName.trim()
    if (!name) return
    setPushing(true)
    setError(null)
    try {
      await onPush(name, message)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Greška')
    } finally {
      setPushing(false)
    }
  }

  const filteredRepos = search
    ? repos.filter(r => r.full_name.toLowerCase().includes(search.toLowerCase()))
    : repos

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
              <div className="gh-modal-icon">
                <GitBranch size={20} />
              </div>
              <div>
                <h2>Push na GitHub</h2>
                <p>
                  {connectedUsername
                    ? <>Povezan kao <strong>@{connectedUsername}</strong></>
                    : 'Izaberi gde želiš da sačuvaš kod'}
                </p>
              </div>
            </div>

            <div className="gh-modal-tabs">
              <button
                className={`gh-tab ${tab === 'existing' ? 'active' : ''}`}
                onClick={() => setTab('existing')}
              >
                Postojeći repo
                {repos.length > 0 && <span className="gh-tab-count">{repos.length}</span>}
              </button>
              <button
                className={`gh-tab ${tab === 'new' ? 'active' : ''}`}
                onClick={() => setTab('new')}
              >
                <Plus size={13} /> Novi repo
              </button>
            </div>

            <div className="gh-modal-body">
              {tab === 'existing' && (
                <>
                  <div className="gh-search">
                    <Search size={13} />
                    <input
                      type="text"
                      placeholder="Pretraži repozitorijume..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>

                  {loadingRepos ? (
                    <div className="gh-loading">
                      <Loader2 size={16} className="spin" /> Učitavam...
                    </div>
                  ) : filteredRepos.length === 0 ? (
                    <div className="gh-empty">
                      {repos.length === 0 ? 'Nemaš repozitorijume. Napravi novi →' : 'Nema rezultata.'}
                    </div>
                  ) : (
                    <div className="gh-repo-list">
                      {filteredRepos.map(repo => (
                        <button
                          key={repo.id}
                          className="gh-repo-item"
                          onClick={() => handlePushExisting(repo)}
                          disabled={pushing}
                        >
                          <div className="gh-repo-icon">
                            {repo.private ? <Lock size={12} /> : <Globe size={12} />}
                          </div>
                          <div className="gh-repo-info">
                            <div className="gh-repo-name">{repo.full_name}</div>
                            {repo.description && (
                              <div className="gh-repo-desc">{repo.description}</div>
                            )}
                          </div>
                          <a
                            href={repo.html_url}
                            target="_blank"
                            rel="noopener"
                            className="gh-repo-link"
                            onClick={(e) => e.stopPropagation()}
                            title="Otvori na GitHub-u"
                          >
                            <ExternalLink size={12} />
                          </a>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab === 'new' && (
                <div className="gh-new-form">
                  <label>
                    <span>Ime repozitorijuma</span>
                    <input
                      type="text"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="moj-sajt"
                      autoFocus
                    />
                    <small>Biće napravljen kao javan repo na tvom nalogu.</small>
                  </label>
                </div>
              )}

              <div className="gh-message-field">
                <label>
                  <span>Commit poruka</span>
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Update from VajbAgent"
                  />
                </label>
              </div>
            </div>

            {error && <div className="gh-modal-error">{error}</div>}

            {tab === 'new' && (
              <div className="gh-modal-footer">
                <button className="gh-btn-ghost" onClick={onClose} disabled={pushing}>
                  Otkaži
                </button>
                <button
                  className="gh-btn-primary"
                  onClick={handleCreateAndPush}
                  disabled={pushing || !newRepoName.trim()}
                >
                  {pushing ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                  {pushing ? 'Push-ujem...' : 'Napravi i push-uj'}
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
