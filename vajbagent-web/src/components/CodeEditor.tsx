import { useState, useEffect, useRef, useCallback } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileCode, Hash, FileJson, FileText, Undo2, Redo2 } from 'lucide-react'
import './CodeEditor.css'

interface CodeEditorProps {
  files: Record<string, string>
  activeFile: string | null
  onFileEdit?: (path: string, content: string) => void
  onSelectFile?: (path: string) => void
  isAgentStreaming?: boolean
  onSelectionChange?: (selection: string | null) => void
  streamingStatus?: string
}

function getLanguage(path: string): string {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return 'typescript'
  if (path.endsWith('.ts')) return 'typescript'
  if (path.endsWith('.js')) return 'javascript'
  if (path.endsWith('.html')) return 'html'
  if (path.endsWith('.css') || path.endsWith('.scss')) return 'css'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.md')) return 'markdown'
  return 'plaintext'
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (ext === 'html' || ext === 'htm') return <FileCode size={12} className="tab-icon tab-icon-html" />
  if (ext === 'css' || ext === 'scss') return <Hash size={12} className="tab-icon tab-icon-css" />
  if (ext === 'tsx' || ext === 'jsx' || ext === 'ts' || ext === 'js') return <FileCode size={12} className="tab-icon tab-icon-js" />
  if (ext === 'json') return <FileJson size={12} className="tab-icon tab-icon-json" />
  return <FileText size={12} className="tab-icon" />
}

const STEPS_COUNT = 12

const STATUS_FALLBACKS = [
  'Razmišljam...',
  'Pišem kod...',
  'Čitam fajlove...',
  'Gradim strukturu...',
  'Dodajem detalje...',
  'Proveravam greške...',
  'Finalizujem...',
]

export default function CodeEditor({ files, activeFile, onFileEdit, onSelectFile, isAgentStreaming, onSelectionChange, streamingStatus }: CodeEditorProps) {
  // Rotate through friendly fallback status labels when agent hasn't set one explicitly.
  const [fallbackIdx, setFallbackIdx] = useState(0)
  useEffect(() => {
    if (!isAgentStreaming || streamingStatus) return
    const timer = setInterval(() => {
      setFallbackIdx(i => (i + 1) % STATUS_FALLBACKS.length)
    }, 2200)
    return () => clearInterval(timer)
  }, [isAgentStreaming, streamingStatus])
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const editorRef = useRef<any>(null)
  // Track whether the user is actively typing in the editor.
  // When true, we do NOT overwrite the editor's internal model from props —
  // that used to revert every keystroke when a user-driven onChange triggered
  // a parent re-render before Monaco could sync its controlled value.
  const userFocusRef = useRef(false)
  // Tracks the most recent content we received from props so we only push
  // imperative updates when the file actually changes (switching tabs) or
  // when the AGENT writes to the currently-open file while the user is idle.
  const lastSyncedContentRef = useRef<string>('')
  const lastSyncedPathRef = useRef<string>('')

  // Track open tabs
  useEffect(() => {
    if (activeFile && !openTabs.includes(activeFile)) {
      setOpenTabs(prev => [...prev, activeFile])
    }
  }, [activeFile])

  // Clean tabs when files are removed
  useEffect(() => {
    const fileKeys = Object.keys(files)
    setOpenTabs(prev => prev.filter(t => fileKeys.includes(t)))
  }, [files])

  const closeTab = useCallback((path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setOpenTabs(prev => {
      const filtered = prev.filter(t => t !== path)
      // If closing active tab, switch to next/prev tab
      if (path === activeFile && filtered.length > 0) {
        const idx = prev.indexOf(path)
        const next = filtered[idx] || filtered[idx - 1] || filtered[0]
        if (next) onSelectFile?.(next)
      }
      return filtered
    })
  }, [activeFile, onSelectFile])

  // Middle-click closes tab
  const handleTabAuxClick = (path: string, e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault()
      closeTab(path)
    }
  }

  // Ctrl+W to close active tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && activeFile) {
        e.preventDefault()
        closeTab(activeFile)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeFile, closeTab])

  // Auto-scroll active tab into view
  const tabBarRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!activeFile || !tabBarRef.current) return
    const el = tabBarRef.current.querySelector(`[data-tab="${CSS.escape(activeFile)}"]`) as HTMLElement
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeFile])

  // Monaco mount handler — track selection + focus
  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor

    editor.onDidFocusEditorText(() => { userFocusRef.current = true })
    editor.onDidBlurEditorText(() => { userFocusRef.current = false })

    editor.onDidChangeCursorSelection(() => {
      const selection = editor.getSelection()
      if (!selection || selection.isEmpty()) {
        onSelectionChange?.(null)
        return
      }
      const selectedText = editor.getModel()?.getValueInRange(selection) || null
      if (selectedText && selectedText.trim().length > 0) {
        onSelectionChange?.(selectedText)
      } else {
        onSelectionChange?.(null)
      }
    })
  }, [onSelectionChange])

  // Imperatively sync editor content with props WITHOUT fighting user input.
  // - File switch: always update + move cursor to top.
  // - Same file, content changed externally (agent): only update if the user
  //   isn't currently focused in the editor (prevents keystroke revert).
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !activeFile) return
    const content = files[activeFile] ?? ''
    const fileChanged = activeFile !== lastSyncedPathRef.current
    const contentChanged = content !== lastSyncedContentRef.current
    if (!fileChanged && !contentChanged) return

    const currentEditorValue = editor.getValue()
    if (currentEditorValue === content) {
      // Editor already matches — just record what we saw
      lastSyncedPathRef.current = activeFile
      lastSyncedContentRef.current = content
      return
    }

    // If the user is typing right now and only content changed (not file), skip.
    // We'd overwrite their work. They'll get the agent's version next time they blur.
    if (!fileChanged && userFocusRef.current) return

    // Preserve cursor position when agent updates the current file while user isn't focused
    const position = editor.getPosition()
    editor.setValue(content)
    if (!fileChanged && position) {
      try { editor.setPosition(position) } catch { /* ignore */ }
    }
    lastSyncedPathRef.current = activeFile
    lastSyncedContentRef.current = content
  }, [activeFile, files])

  // Empty / building state — only when NO file is actively selected.
  // If the user has picked a file (even a brand-new empty one), fall through
  // to the real editor so they can type into it.
  const hasActiveFile = !!activeFile && activeFile in files
  if (!hasActiveFile) {
    return (
      <div className="editor-panel">
        <div className="editor-empty">
          {isAgentStreaming ? (
            <motion.div
              className="editor-building"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              {/* Animated code skeleton lines */}
              <div className="building-lines">
                {[0.7, 0.5, 0.85, 0.4, 0.65, 0.3, 0.75, 0.55, 0.9, 0.45, 0.6, 0.8].map((w, i) => (
                  <motion.div
                    key={i}
                    className={`building-line ${i % 3 === 0 ? 'indent-0' : i % 3 === 1 ? 'indent-1' : 'indent-2'}`}
                    initial={{ opacity: 0, x: -20, scaleX: 0 }}
                    animate={{ opacity: [0, 0.6, 0.3], x: 0, scaleX: 1 }}
                    transition={{
                      duration: 0.6,
                      delay: i * 0.12,
                      repeat: Infinity,
                      repeatDelay: STEPS_COUNT * 0.12 + 0.5,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    style={{ width: `${w * 100}%` }}
                  />
                ))}
              </div>
              <div className="building-label">
                <div className="building-dots">
                  <span /><span /><span />
                </div>
                <motion.span
                  key={streamingStatus || `fb-${fallbackIdx}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                >
                  {streamingStatus || STATUS_FALLBACKS[fallbackIdx]}
                </motion.span>
              </div>
            </motion.div>
          ) : (
            <motion.div
              className="editor-empty-content"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="editor-empty-icon-wrap">
                <div className="editor-empty-icon">{'</>'}</div>
                <div className="editor-empty-ring" />
              </div>
              <p>Izaberi fajl ili sačekaj da agent kreira kod</p>
            </motion.div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="editor-panel">
      {/* Tab bar */}
      {openTabs.length > 0 && (
        <div className="editor-tabs" ref={tabBarRef}>
          <AnimatePresence initial={false}>
            {openTabs.map(tab => (
              <motion.button
                key={tab}
                layout
                initial={{ opacity: 0, scale: 0.85, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.85, y: -4 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                data-tab={tab}
                className={`editor-tab ${tab === activeFile ? 'active' : ''}`}
                onClick={() => onSelectFile?.(tab)}
                onAuxClick={(e) => handleTabAuxClick(tab, e)}
                title={tab}
              >
                {getFileIcon(tab)}
                <span className="tab-name">{tab.split('/').pop()}</span>
                <span className="tab-close" onClick={(e) => closeTab(tab, e)}>
                  <X size={10} />
                </span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Breadcrumb + Undo/Redo */}
      <div className="editor-breadcrumb">
        {activeFile.includes('/') ? (
          <>
            <span className="breadcrumb-folder">{activeFile.split('/').slice(0, -1).join('/')}</span>
            <span className="breadcrumb-sep">/</span>
          </>
        ) : null}
        <span className="breadcrumb-file">{activeFile.split('/').pop()}</span>
        <div className="breadcrumb-actions">
          <button
            className="breadcrumb-btn"
            title="Undo (Ctrl+Z)"
            onClick={() => editorRef.current?.trigger('toolbar', 'undo', null)}
          >
            <Undo2 size={13} />
          </button>
          <button
            className="breadcrumb-btn"
            title="Redo (Ctrl+Y)"
            onClick={() => editorRef.current?.trigger('toolbar', 'redo', null)}
          >
            <Redo2 size={13} />
          </button>
        </div>
        <span className="breadcrumb-lang">{getLanguage(activeFile).toUpperCase()}</span>
      </div>

      <Editor
        height="100%"
        language={getLanguage(activeFile)}
        defaultValue={files[activeFile] ?? ''}
        path={activeFile}
        theme="vs-dark"
        onMount={handleEditorMount}
        onChange={(value) => {
          if (activeFile && onFileEdit && value !== undefined) {
            lastSyncedContentRef.current = value
            onFileEdit(activeFile, value)
          }
        }}
        options={{
          readOnly: false,
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
          fontLigatures: true,
          minimap: { enabled: false },
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: 'gutter',
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
          wordWrap: 'on',
          cursorBlinking: 'blink',
          cursorSmoothCaretAnimation: 'on',
          smoothScrolling: true,
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true },
          tabSize: 2,
        }}
      />
    </div>
  )
}
