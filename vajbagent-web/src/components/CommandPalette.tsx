import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FlaskConical, Wrench, FileText, GitCommitHorizontal, MessageCircleQuestion, RefreshCw,
  Palette, Zap, Database, Gauge, ShieldCheck, ArrowLeftRight, Sparkles,
  Terminal, Star
} from 'lucide-react'
import { ALL_COMMANDS, type Command } from '../commands'
import './CommandPalette.css'

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  FlaskConical, Wrench, FileText, GitCommitHorizontal, MessageCircleQuestion, RefreshCw,
  Palette, Zap, Database, Gauge, ShieldCheck, ArrowLeftRight, Sparkles,
  Terminal, Star,
}

function CommandIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICON_MAP[name]
  if (Icon) return <Icon size={14} className={className} />
  return <Terminal size={14} className={className} />
}

interface Props {
  inputValue: string
  visible: boolean
  onSelect: (command: Command) => void
  onClose?: () => void
}

export default function CommandPalette({ inputValue, visible, onSelect, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Filter commands based on input — find last / in text
  const slashIdx = inputValue.lastIndexOf('/')
  const query = slashIdx >= 0 ? inputValue.substring(slashIdx + 1).toLowerCase() : ''
  const filteredCommands = query
    ? ALL_COMMANDS.filter(c => c.name.includes(query) || c.description.toLowerCase().includes(query))
    : ALL_COMMANDS

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Capture-phase keyboard handler. We run in the capture phase so we
  // preempt the textarea's own Enter/Tab/Arrow handling — without this,
  // ArrowDown/Up would move the textarea caret and Enter/Tab would submit
  // the chat instead of picking the highlighted command.
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const cmd = filteredCommands[selectedIndex]
        if (cmd) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(cmd)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose?.()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [visible, filteredCommands, selectedIndex, onSelect, onClose])

  if (!visible || filteredCommands.length === 0) return null

  // Split into commands and skills for display
  const showCommands = filteredCommands.filter(c => c.type === 'command')
  const showSkills = filteredCommands.filter(c => c.type === 'skill')

  return (
    <AnimatePresence>
      <motion.div
        className="cmd-palette"
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="cmd-list" ref={listRef}>
          {showCommands.length > 0 && (
            <>
              <div className="cmd-section">
                <Terminal size={11} className="cmd-section-icon" />
                <span>KOMANDE</span>
              </div>
              {showCommands.map((cmd) => {
                const globalIdx = filteredCommands.indexOf(cmd)
                return (
                  <button
                    key={cmd.name}
                    className={`cmd-item ${globalIdx === selectedIndex ? 'selected' : ''}`}
                    onClick={() => onSelect(cmd)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                  >
                    <div className="cmd-icon">
                      <CommandIcon name={cmd.icon} />
                    </div>
                    <span className="cmd-name">{cmd.label}</span>
                    <span className="cmd-desc">{cmd.description}</span>
                  </button>
                )
              })}
            </>
          )}

          {showSkills.length > 0 && (
            <>
              <div className="cmd-section cmd-section-skills">
                <Sparkles size={11} className="cmd-section-icon" />
                <span>SKILLS</span>
              </div>
              {showSkills.map((cmd) => {
                const globalIdx = filteredCommands.indexOf(cmd)
                return (
                  <button
                    key={cmd.name}
                    className={`cmd-item ${globalIdx === selectedIndex ? 'selected' : ''}`}
                    onClick={() => onSelect(cmd)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                  >
                    <div className="cmd-icon cmd-icon-skill">
                      <CommandIcon name={cmd.icon} />
                    </div>
                    <span className="cmd-name">{cmd.label}</span>
                    <span className="cmd-desc">{cmd.description}</span>
                  </button>
                )
              })}
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

/** Hook to handle keyboard navigation in command palette */
export function useCommandPaletteKeys(
  visible: boolean,
  filteredCount: number,
  selectedIndex: number,
  setSelectedIndex: (i: number) => void,
  onSelect: (index: number) => void,
  onClose: () => void,
) {
  useEffect(() => {
    if (!visible) return

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(Math.min(selectedIndex + 1, filteredCount - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(Math.max(selectedIndex - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        onSelect(selectedIndex)
      } else if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible, filteredCount, selectedIndex])
}
