import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Cpu, Lock } from 'lucide-react'
import { MODELS } from '../models'
import { openPaywall } from '../services/credits'
import './ModelSelector.css'

interface ModelSelectorProps {
  value: string
  onChange: (modelId: string) => void
  compact?: boolean
  freeTier?: boolean
}

// Free tier has access to Lite, Turbo, Pro, and Max — the last one being
// our flagship-for-beginners (Claude Sonnet 4.6). This mirrors how Lovable
// and Bolt let new users build a real site on their best model during the
// trial. Power, Ultra and Architect stay locked as "premium" tiers that
// unlock when the user tops up. Source of truth for the gate lives in
// src/index.js (FREE_TIER_ALLOWED).
const FREE_ALLOWED = new Set(['vajb-agent-lite', 'vajb-agent-turbo', 'vajb-agent-pro', 'vajb-agent-max'])

export default function ModelSelector({ value, onChange, compact, freeTier }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = MODELS.find(m => m.id === value) || MODELS[0]

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleSelect = (modelId: string) => {
    if (freeTier && !FREE_ALLOWED.has(modelId)) return
    onChange(modelId)
    setOpen(false)
  }

  return (
    <div className={`model-selector ${compact ? 'compact' : ''}`} ref={ref}>
      <button className="model-trigger" onClick={() => setOpen(!open)}>
        <Cpu size={14} />
        <span>{current.name}</span>
        <ChevronDown size={12} className={`chevron ${open ? 'open' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="model-dropdown"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.15 }}
          >
            {MODELS.map(m => {
              const locked = freeTier && !FREE_ALLOWED.has(m.id)
              return (
                <button
                  key={m.id}
                  className={`model-option ${m.id === value ? 'active' : ''} ${locked ? 'locked' : ''}`}
                  onClick={() => handleSelect(m.id)}
                >
                  <div className="model-option-left">
                    <span className="model-name">{m.name}</span>
                    {m.tag && <span className="model-tag">{m.tag}</span>}
                    {locked && <Lock size={11} className="model-lock" />}
                  </div>
                  <span className="model-desc">
                    {locked ? 'Dopuni kredite' : m.desc}
                  </span>
                </button>
              )
            })}
            {freeTier && (
              <button
                type="button"
                className="model-upgrade"
                onClick={() => { setOpen(false); openPaywall() }}
              >
                Otključaj sve modele
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
