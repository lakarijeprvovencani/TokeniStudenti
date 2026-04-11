import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Cpu, Lock } from 'lucide-react'
import { MODELS } from '../models'
import './ModelSelector.css'

interface ModelSelectorProps {
  value: string
  onChange: (modelId: string) => void
  compact?: boolean
  freeTier?: boolean
}

const FREE_MODEL = 'vajb-agent-lite'

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
    if (freeTier && modelId !== FREE_MODEL) return
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
              const locked = freeTier && m.id !== FREE_MODEL
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
              <a
                href="https://vajbagent.com/dashboard"
                target="_blank"
                rel="noopener"
                className="model-upgrade"
              >
                Otključaj sve modele
              </a>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
