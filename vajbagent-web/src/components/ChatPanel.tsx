import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUp, Loader2, User, Square } from 'lucide-react'
import { executeToolCall } from '../services/toolHandler'
import { buildFullContext, invalidateIndex } from '../services/contextBuilder'
import { fetchBalance } from '../services/userService'
import { scopedStorage as scopedStorageRef } from '../services/storageScope'
import MarkdownRenderer from './MarkdownRenderer'
import CommandPalette from './CommandPalette'
import FileMention from './FileMention'
import ModelSelector from './ModelSelector'
import { TOOL_DEFINITIONS } from '../tools'
import { WEB_SYSTEM_PROMPT } from '../systemPrompt'
import { emitPartialArgs, emitFinalArgs, resetLiveStream } from '../services/liveCodeStream'
import { type Command } from '../commands'
import './ChatPanel.css'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface StreamResult {
  text: string
  toolCalls: ToolCall[]
  finishReason: string | null
}

interface ChatPanelProps {
  initialPrompt: string
  /** Images attached on the welcome screen — injected into the very first
   *  user message so the agent sees them right away. */
  initialImages?: { name: string; dataUrl: string }[]
  model: string
  onModelChange?: (model: string) => void
  onFilesChanged: (files: Record<string, string>) => void
  onDone?: () => void
  onContextUpdate?: (used: number, limit: number) => void
  onStreamingChange?: (streaming: boolean) => void
  onStatusChange?: (status: string) => void
  onChatHistoryUpdate?: (history: unknown[], displayMessages: unknown[]) => void
  files: Record<string, string>
  activeFile: string | null
  selectionRef?: React.RefObject<string | null>
  freeTier?: boolean
  resumeHistory?: unknown[]
  resumeDisplayMessages?: unknown[]
  resumeNeedsBuild?: boolean
  /** Called when balance is critically low so parent can show the paywall */
  onLowBalance?: (balanceUsd: number) => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'
const MAX_ITERATIONS = 50
const MAX_RETRIES = 3
const RETRY_PATTERN = /timeout|predugo|idle|ECONNRESET|ENOTFOUND|socket hang up|429|502|503|529|rate.limit|ETIMEDOUT|ECONNREFUSED|Stream prekinut|Failed to fetch|network.?error|Load failed/i

const CONTEXT_LIMITS: Record<string, number> = {
  'vajb-agent-lite': 400000,
  'vajb-agent-turbo': 200000,      // Haiku 4.5: 200K context
  'vajb-agent-pro': 400000,
  'vajb-agent-max': 1000000,       // Sonnet 4.6: 1M context
  'vajb-agent-power': 1050000,
  'vajb-agent-ultra': 1000000,     // Opus 4.6: 1M context
  'vajb-agent-architect': 1000000, // Opus 4.6: 1M context
}

const SESSION_KEY = 'vajb_session'

// ─── User-facing error humanization ──────────────────────────────────────────
// Raw errors from fetch/streaming are technical ("API greska: 503", "Load failed",
// "ECONNRESET"). They leak straight into the chat as 'error' bubbles. This helper
// translates them into a single line a non-technical user can act on. Always
// returns Serbian, never exposes stack traces or HTTP internals.
function humanizeError(raw: string): string {
  const s = (raw || '').toString()
  if (!s) return 'Došlo je do greške. Probaj ponovo.'

  // Already-friendly messages that we emit ourselves — pass through untouched.
  if (/^(Nema odgovora od servera|Stream prekinut|Timeout:|Zaustavljeno|Zahtev je odbijen|Ponestalo ti je kredita|Prijava je istekla)/i.test(s)) {
    return s
  }
  // Quota / payment
  if (/402|payment required|insufficient|nedovoljno|kredit/i.test(s)) {
    return 'Nemaš dovoljno kredita za ovaj model. Dopuni nalog ili izaberi jeftiniji model.'
  }
  // Auth
  if (/401|unauthorized|autenti?fikacija|not authenticated|signed out/i.test(s)) {
    return 'Prijava je istekla. Uloguj se ponovo pa probaj opet.'
  }
  // Forbidden
  if (/403|forbidden/i.test(s)) {
    return 'Zahtev je odbijen. Moguće da je kontekst prevelik — osveži stranicu ili pokreni nov chat.'
  }
  // Not found
  if (/404|not found/i.test(s)) {
    return 'Ruta nije pronađena na serveru. Osveži stranicu i probaj ponovo.'
  }
  // Rate limit
  if (/429|rate.?limit|too many/i.test(s)) {
    return 'Previše zahteva u kratkom roku. Sačekaj 10-20 sekundi pa probaj ponovo.'
  }
  // Overloaded / server errors
  if (/\b5\d\d\b|overloaded|bad gateway|gateway timeout|service unavailable|server error/i.test(s)) {
    return 'Server je trenutno preopterećen. Sačekaj par sekundi pa probaj ponovo — obično prođe za minut.'
  }
  // Timeout-family
  if (/timeout|ETIMEDOUT|predugo/i.test(s)) {
    return 'Zahtev je predugo trajao. Prompt je verovatno pretežak — skrati ga, podeli na manje korake ili probaj drugi model.'
  }
  // Network / offline
  if (/Failed to fetch|Load failed|NetworkError|network.?error|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(s)) {
    return 'Ne mogu da se povežem na server. Proveri internet pa probaj ponovo.'
  }
  // Generic API error with status
  const statusMatch = s.match(/API greska:\s*(\d+)/i) || s.match(/status:?\s*(\d+)/i)
  if (statusMatch) {
    return `Server je vratio grešku (${statusMatch[1]}). Probaj ponovo za par sekundi.`
  }
  // Default — keep it short, strip any stack/JSON noise.
  const clean = s.split('\n')[0].replace(/^Error:\s*/i, '').slice(0, 240)
  return clean || 'Došlo je do greške. Probaj ponovo.'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resize image to max dimensions and return base64 data URL */
function resizeImage(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.82))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}

/** Strip <thinking> tags and clean stream text for display */
function cleanStreamText(text: string): string {
  // Remove complete <thinking>...</thinking> blocks
  let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
  // If there's an unclosed <thinking> tag, hide everything after it
  const openIdx = cleaned.lastIndexOf('<thinking>')
  if (openIdx !== -1) {
    cleaned = cleaned.substring(0, openIdx)
  }
  return cleaned.trim()
}

function estimateTokens(messages: Message[], systemPrompt: string): number {
  let chars = systemPrompt.length
  for (const msg of messages) {
    chars += msg.content.length
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        chars += tc.function.arguments.length + tc.function.name.length
      }
    }
  }
  return Math.ceil(chars / 3.5)
}

function getContextLimit(model: string): number {
  return CONTEXT_LIMITS[model] || 200000
}

function trimHistory(history: Message[], model: string): Message[] {
  const trimmed = history.map(m => ({
    ...m,
    tool_calls: m.tool_calls ? m.tool_calls.map(tc => ({ ...tc, function: { ...tc.function } })) : undefined,
  }))
  const keepRecent = Math.min(10, trimmed.length)
  const trimZone = trimmed.length - keepRecent

  // Phase 0 (ALWAYS): Compact old tool results — biggest offender, typically
  // read_file / execute_command dumps that the agent already consumed.
  for (let i = 0; i < trimZone; i++) {
    const msg = trimmed[i]
    if (msg.role === 'tool' && msg.content.length > 500) {
      trimmed[i] = { ...msg, content: msg.content.substring(0, 300) + '\n... (earlier result trimmed to save tokens)' }
    }
  }

  const limit = getContextLimit(model)
  const threshold = limit * 0.65
  const estimated = estimateTokens(trimmed, WEB_SYSTEM_PROMPT)
  if (estimated < threshold) return trimmed

  // Phase 1: Truncate assistant messages in older zone
  for (let i = 0; i < trimZone; i++) {
    const msg = trimmed[i]
    if (msg.role === 'assistant' && msg.content.length > 2000) {
      trimmed[i] = { ...msg, content: msg.content.substring(0, 800) + '\n... (trimmed)' }
    }
  }

  // Phase 1.5: Compact old tool_call.arguments. write_file / replace_in_file
  // arguments routinely weigh 20K+ characters — they dominate the context and
  // the old token-count ignored them. We keep the shape (path + a short hint)
  // so the model can still see "I already wrote index.html" without reading
  // the whole file back.
  for (let i = 0; i < trimZone; i++) {
    const msg = trimmed[i]
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const argsStr = tc.function.arguments || ''
        if (argsStr.length > 600) {
          let compact = argsStr.substring(0, 200) + ' ... (earlier args trimmed)'
          try {
            const parsed = JSON.parse(argsStr)
            const hint: Record<string, unknown> = {}
            if (parsed.path) hint.path = parsed.path
            if (parsed.command) hint.command = String(parsed.command).slice(0, 200)
            if (parsed.url) hint.url = parsed.url
            if (parsed.query) hint.query = String(parsed.query).slice(0, 120)
            hint._trimmed = `original ${argsStr.length} chars`
            compact = JSON.stringify(hint)
          } catch { /* keep byte-trimmed fallback */ }
          tc.function.arguments = compact
        }
      }
    }
  }

  // Phase 2: If still over threshold, drop oldest messages. Use the same
  // estimator everywhere so we actually measure the real payload (incl.
  // tool_calls args we just compacted) rather than only message content.
  const afterCompactTokens = estimateTokens(trimmed, WEB_SYSTEM_PROMPT)
  if (afterCompactTokens > limit * 0.85 && trimmed.length > 20) {
    let dropCount = Math.min(Math.floor(trimmed.length * 0.3), trimmed.length - 20)
    if (dropCount > 0) {
      // Don't break tool_call/tool response pairs
      while (dropCount < trimmed.length) {
        const msg = trimmed[dropCount]
        if (msg.role === 'tool') {
          dropCount++
        } else if (msg.role === 'assistant' && msg.tool_calls) {
          dropCount++
        } else {
          break
        }
      }
      return trimmed.slice(dropCount)
    }
  }

  return trimmed
}

/**
 * Fix up a transcript so the provider doesn't 400 us. Problems we handle:
 *   - Assistant message with tool_calls but missing tool responses (happens
 *     when the user clicks Stop in the middle of a tool loop, or when a
 *     previous page reload cut the stream mid-tool-execution).
 *   - Orphan tool messages with no preceding assistant+tool_calls.
 *   - Transcript ending on assistant+tool_calls with zero responses — the
 *     next request would be invalid.
 * Repairs in place by injecting synthetic tool responses ("Zaustavljeno —
 * nastavi normalno.") and dropping orphans. Cheap, idempotent, always safe.
 */
function repairHistory(history: Message[]): Message[] {
  const fixed: Message[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg.role === 'tool') {
      // Keep only tool responses that follow an assistant+tool_calls message
      // with a matching id. Otherwise drop (orphan).
      const prev = fixed[fixed.length - 1]
      const prevAssistant = prev && prev.role === 'assistant' && prev.tool_calls
      const hasMatchingCall = prevAssistant
        ? prev!.tool_calls!.some(tc => tc.id === msg.tool_call_id)
        : false
      // Also accept if the assistant+tool_calls is earlier in `fixed` (not
      // immediately preceding) — but the response must still come before the
      // NEXT assistant message for the protocol to be valid.
      if (hasMatchingCall) {
        fixed.push(msg)
      } else {
        // Look back through consecutive tool + assistant-with-tool_calls
        // block to find the matching id.
        let found = false
        for (let j = fixed.length - 1; j >= 0; j--) {
          const m = fixed[j]
          if (m.role === 'assistant' && m.tool_calls) {
            if (m.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
              found = true
            }
            break
          }
          if (m.role === 'tool') continue
          break
        }
        if (found) fixed.push(msg)
        // else: drop orphan silently
      }
      continue
    }
    fixed.push(msg)
  }

  // Scan assistant+tool_calls messages and ensure every tool_call id has a
  // tool response somewhere before the next assistant/user message.
  const result: Message[] = []
  for (let i = 0; i < fixed.length; i++) {
    const msg = fixed[i]
    result.push(msg)
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Gather the tool responses that immediately follow
      const responses = new Set<string>()
      let j = i + 1
      while (j < fixed.length && fixed[j].role === 'tool') {
        const id = fixed[j].tool_call_id
        if (id) responses.add(id)
        result.push(fixed[j])
        j++
      }
      // Synthesize missing responses
      for (const tc of msg.tool_calls) {
        if (!responses.has(tc.id)) {
          result.push({
            role: 'tool',
            content: 'Zaustavljeno — nastavi kad korisnik dâ sledeću instrukciju.',
            tool_call_id: tc.id,
          })
        }
      }
      i = j - 1
    }
  }

  return result
}

function buildFallbackSummary(history: Message[]): string {
  const created: string[] = []
  const modified: string[] = []
  const commands: string[] = []
  let lastToolFailed = false
  let sawAnyWrite = false
  let iterations = 0

  for (const msg of history) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      iterations++
      for (const tc of msg.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments)
          const fname = (args.path || '').split('/').pop() || ''
          if (tc.function.name === 'write_file' && fname) {
            sawAnyWrite = true
            if (!created.includes(fname)) created.push(fname)
          } else if (tc.function.name === 'replace_in_file' && fname) {
            sawAnyWrite = true
            if (!modified.includes(fname)) modified.push(fname)
          } else if (tc.function.name === 'execute_command' && args.command) {
            commands.push(args.command)
          }
        } catch { /* skip unparseable */ }
      }
    }
    if (msg.role === 'tool' && typeof msg.content === 'string' && /^GRESKA:|^Greska:/i.test(msg.content)) {
      lastToolFailed = true
    } else if (msg.role === 'tool') {
      lastToolFailed = false
    }
  }

  // Never say "Gotovo!" if nothing was actually done, or the last tool run
  // errored out, or the loop hit the iteration limit without finishing.
  const hitIterationCap = iterations >= MAX_ITERATIONS - 1
  const didNothing = created.length === 0 && modified.length === 0 && commands.length === 0

  let header = 'Gotovo.'
  if (didNothing) header = 'Agent je završio bez izmena.'
  else if (lastToolFailed) header = 'Završeno, ali poslednji korak je vratio grešku — proveri rezultat.'
  else if (hitIterationCap) header = 'Dostignut je maksimum iteracija — agent je stao. Proveri šta je uspelo, pa pošalji sledeću instrukciju.'
  else if (sawAnyWrite) header = 'Gotovo.'

  const parts: string[] = [header]
  if (created.length > 0) parts.push(`Kreirani fajlovi: ${created.join(', ')}`)
  if (modified.length > 0) parts.push(`Izmenjeni fajlovi: ${modified.join(', ')}`)
  if (commands.length > 0) parts.push(`Izvršene komande: ${commands.slice(0, 5).join(', ')}${commands.length > 5 ? ` (+${commands.length - 5})` : ''}`)
  return parts.join('\n')
}

function saveSession(history: Message[], displayMessages: { role: string; content: string }[], model: string) {
  try {
    scopedStorageRef.set(SESSION_KEY, JSON.stringify({ history, displayMessages, model, ts: Date.now() }))
  } catch { /* storage full */ }
}

function loadSession(): { history: Message[]; displayMessages: { role: string; content: string }[]; model: string } | null {
  try {
    const raw = scopedStorageRef.get(SESSION_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    // Expire sessions older than 2 hours
    if (Date.now() - data.ts > 2 * 60 * 60 * 1000) {
      scopedStorageRef.remove(SESSION_KEY)
      return null
    }
    return data
  } catch {
    return null
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChatPanel({ initialPrompt, initialImages, model, onModelChange, onFilesChanged, onDone, onContextUpdate, onStreamingChange, onStatusChange, onChatHistoryUpdate, files, activeFile, selectionRef, freeTier, resumeHistory, resumeDisplayMessages, resumeNeedsBuild, onLowBalance }: ChatPanelProps) {
  const [displayMessages, setDisplayMessages] = useState<{ role: string; content: string }[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [statusText, setStatusText] = useState('')
  const [showCommands, setShowCommands] = useState(false)
  const [showFileMention, setShowFileMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [activeSkill, setActiveSkill] = useState<string | null>(null)
  const [mode, setMode] = useState<'auto' | 'plan'>('auto')
  const [attachedImages, setAttachedImages] = useState<{ name: string; dataUrl: string }[]>([])
  const [dragging, setDragging] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const historyRef = useRef<Message[]>([])
  const displayMessagesRef = useRef(displayMessages)
  displayMessagesRef.current = displayMessages
  const didInit = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const queuedRef = useRef<string | null>(null)
  // Flips synchronously inside handleSubmit. The `streaming` state bit is
  // driven by `setState` and doesn't update until the next render, which
  // means a very fast double-click (two mousedowns in one JS tick) would
  // bypass the `if (streaming) queue` check and fire two back-to-back
  // sendMessage calls. This ref closes that gap.
  const sendInFlightRef = useRef(false)

  // Sync chat history to parent for auto-save whenever displayMessages change
  useEffect(() => {
    if (displayMessages.length > 0) {
      onChatHistoryUpdate?.(historyRef.current, displayMessages)
    }
  }, [displayMessages])

  // Restore session on mount
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    // Priority: resumeProject > localStorage session > fresh start
    if (resumeHistory && resumeHistory.length > 0) {
      // Repair the transcript before using it — projects saved mid-tool-run
      // (browser crash, abort, reload) are otherwise rejected by the API.
      historyRef.current = repairHistory(resumeHistory as Message[])
      if (resumeDisplayMessages && resumeDisplayMessages.length > 0) {
        setDisplayMessages(resumeDisplayMessages as { role: string; content: string }[])
      }
      // Auto-rebuild npm projects on resume
      if (resumeNeedsBuild) {
        setTimeout(() => {
          sendMessage('Projekat je upravo otvoren iz istorije. Fajlovi su restartovani. Pokreni npm install && npm run build da bi preview radio. Ne menjaj ništa, samo pokreni build.')
        }, 1500)
      }
      return
    }

    const session = loadSession()
    if (session && session.history.length > 0 && !initialPrompt) {
      historyRef.current = repairHistory(session.history)
      setDisplayMessages(session.displayMessages)
    } else if (initialPrompt) {
      // Pass Welcome-attached images directly as an override so the very
      // first request is multimodal. Relying on setAttachedImages + a
      // setTimeout race would commit the state after sendMessage had
      // already read the stale (empty) array.
      sendMessage(initialPrompt, initialImages)
    }
  }, [])

  // Auto-scroll: scroll to bottom unless user has intentionally scrolled up.
  // Reset when streaming ends or user sends a message.
  const userScrolledUp = useRef(false)
  const programmaticScroll = useRef(false)

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    if (!userScrolledUp.current) {
      programmaticScroll.current = true
      el.scrollTop = el.scrollHeight
      // Reset flag after browser processes the scroll event
      requestAnimationFrame(() => { programmaticScroll.current = false })
    }
  }, [displayMessages, streamText, statusText])

  // Forward status text to parent so other panels (e.g. code editor overlay)
  // can show what the agent is currently doing instead of the generic "Kreiram kod...".
  useEffect(() => {
    onStatusChange?.(statusText)
  }, [statusText, onStatusChange])

  // When streaming ends, always reset scroll lock so user can see the final message
  useEffect(() => {
    if (!streaming) {
      userScrolledUp.current = false
      const el = messagesRef.current
      if (el) {
        programmaticScroll.current = true
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight
          requestAnimationFrame(() => { programmaticScroll.current = false })
        })
      }
    }
  }, [streaming])

  const handleChatScroll = useCallback(() => {
    if (programmaticScroll.current) return
    const el = messagesRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    userScrolledUp.current = !atBottom
  }, [])

  // Cancel button handler
  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }, [])

  // ─── File attachment handlers ────────────────────────────────────────────

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'])
  const TEXT_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'html', 'css', 'json', 'md', 'txt', 'yaml', 'yml', 'sql', 'sh', 'csv', 'xml', 'toml', 'env'])
  const MAX_IMAGE_SIZE = 1600

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    for (const file of Array.from(fileList)) {
      const ext = file.name.split('.').pop()?.toLowerCase() || ''

      if (IMAGE_EXTS.has(ext) || file.type.startsWith('image/')) {
        // Image — resize and convert to base64
        const dataUrl = await resizeImage(file, MAX_IMAGE_SIZE)
        setAttachedImages(prev => [...prev, { name: file.name, dataUrl }])
      } else if (TEXT_EXTS.has(ext) || file.type.startsWith('text/')) {
        // Text file — read content and append to input
        const text = await file.text()
        const truncated = text.substring(0, 15000)
        const notice = text.length > 15000 ? `\n... (truncated, ${file.size} bytes total)` : ''
        setInput(prev => prev + `\n\n--- ${file.name} ---\n${truncated}${notice}\n`)
      }
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files)
    }
  }, [processFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragging(false)
  }, [])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files)
      e.target.value = '' // Reset so same file can be re-selected
    }
  }, [processFiles])

  const removeImage = useCallback((index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  // Show/hide command palette and @mention based on input
  useEffect(() => {
    // Detect /command: find last / preceded by start, space, or newline
    const slashIdx = input.lastIndexOf('/')
    if (slashIdx >= 0 && !streaming) {
      const beforeSlash = slashIdx === 0 ? ' ' : input[slashIdx - 1]
      const afterSlash = input.substring(slashIdx + 1)
      if ((beforeSlash === ' ' || beforeSlash === '\n' || slashIdx === 0) && !afterSlash.includes(' ')) {
        setShowCommands(true)
      } else {
        setShowCommands(false)
      }
    } else {
      setShowCommands(false)
    }

    // Detect @mention: find last @ in input and extract query after it
    const atIdx = input.lastIndexOf('@')
    if (atIdx >= 0 && !streaming) {
      const afterAt = input.substring(atIdx + 1)
      // Only show if @ is at start or preceded by space, and no space in query
      const beforeAt = atIdx === 0 ? ' ' : input[atIdx - 1]
      if ((beforeAt === ' ' || beforeAt === '\n') && !afterAt.includes(' ')) {
        setShowFileMention(true)
        setMentionQuery(afterAt)
      } else {
        setShowFileMention(false)
      }
    } else {
      setShowFileMention(false)
    }
  }, [input, streaming])

  // Handle command/skill selection
  const handleCommandSelect = useCallback((cmd: Command) => {
    setShowCommands(false)
    // Extract text before the last /command
    const slashIdx = input.lastIndexOf('/')
    const textBefore = slashIdx > 0 ? input.substring(0, slashIdx).trim() : ''

    if (cmd.type === 'skill') {
      // Activate skill — keep text before slash
      setActiveSkill(cmd.skillPrompt || null)
      setInput(textBefore)
      setDisplayMessages(prev => [...prev, { role: 'status', content: `Skill aktiviran: ${cmd.label}` }])
      inputRef.current?.focus()
    } else {
      // Command — use text before slash as context, or remaining text after command name
      const afterSlash = slashIdx >= 0 ? input.substring(slashIdx) : input
      const arg = afterSlash.replace(/^\/\w+\s*/, '').trim() || textBefore || 'trenutni kod'
      const message = (cmd.message || '').replace('{arg}', arg)
      setInput('')
      sendMessage(message)
    }
  }, [input])

  // ─── Stream API call with timeout/idle detection ─────────────────────────

  async function callAPI(messages: Message[], signal: AbortSignal, systemPrompt: string): Promise<StreamResult> {
    const apiMessages: Record<string, unknown>[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool' as const, content: m.content, tool_call_id: m.tool_call_id }
        }
        if (m.role === 'system') {
          return { role: 'system' as const, content: m.content }
        }
        if (m.tool_calls) {
          return { role: 'assistant' as const, content: m.content || null, tool_calls: m.tool_calls }
        }
        // Multimodal: if message has images, send as content array
        const images = (m as any)._images as { name: string; dataUrl: string }[] | undefined
        if (images && images.length > 0) {
          const parts: Record<string, unknown>[] = [
            { type: 'text', text: m.content },
            ...images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
          ]
          return { role: m.role as 'user', content: parts }
        }
        return { role: m.role as 'user' | 'assistant', content: m.content }
      }),
    ]

    const res = await fetch(`${API_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Signal to the backend that this request already carries its own
        // complete WebContainers-aware system prompt — so the generic
        // VajbAgent / Power prompts meant for the VS Code extension are NOT
        // prepended on top. Two stacked system prompts waste 2-5K tokens per
        // call and introduce contradictory instructions.
        'X-Vajb-Client': 'web',
      },
      credentials: 'include',
      body: JSON.stringify({
        model,
        messages: apiMessages,
        tools: TOOL_DEFINITIONS,
        stream: true,
        max_tokens: 24000,
      }),
      signal,
    })

    if (!res.ok || !res.body) throw new Error(`API greska: ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ''
    let lastCtxUpdate = 0
    const toolCalls: Record<number, ToolCall> = {}
    let sseBuffer = ''
    let finishReason: string | null = null

    // Idle timeout — if no data for N seconds, abort.
    // Reasoning models (gpt-5.*) can silently "think" for 2-3 minutes
    // before emitting the first token, especially on large prompts. The
    // backend sends heartbeat chunks every 10s to prevent this from
    // looking like an idle connection, but if a proxy in between buffers
    // SSE we still want a generous baseline here. 180s covers even the
    // slowest first-token scenarios for GPT-5.4 "Power" and Opus.
    const msgCount = messages.length
    const idleMs = msgCount > 20 ? 240_000 : msgCount > 10 ? 210_000 : 180_000
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    // Flags set from timeout callbacks. We do NOT throw inside setTimeout
    // (that just becomes an uncaught exception floating in the event loop);
    // instead we set a flag, cancel the reader so reader.read() returns
    // done=true, and then throw from the main path after the loop exits.
    let idleTimedOut = false
    let hardTimedOut = false

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimedOut = true
        reader.cancel().catch(() => {})
      }, idleMs)
    }

    const hardMs = Math.max(idleMs + 120_000, 360_000)
    const hardTimer = setTimeout(() => {
      hardTimedOut = true
      reader.cancel().catch(() => {})
    }, hardMs)

    try {
      resetIdle()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        resetIdle()
        sseBuffer += decoder.decode(value, { stream: true })
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          // Parse first — if JSON is malformed, log & skip. Then dispatch
          // OUTSIDE the parse-try so real error conditions (upstream failure,
          // finish_reason='error') can throw out to the retry loop instead
          // of being swallowed alongside transient JSON artifacts.
          let parsed: any
          try {
            parsed = JSON.parse(data)
          } catch (e) {
            console.warn('[SSE] Failed to parse:', data, e)
            continue
          }

          if (parsed.error?.message) {
            throw new Error(String(parsed.error.message))
          }

          const choice = parsed.choices?.[0]
          if (!choice) continue

          if (choice.finish_reason) {
            finishReason = choice.finish_reason
            if (choice.finish_reason === 'error') {
              throw new Error('Stream prekinut: upstream greška.')
            }
          }

          if (choice.delta?.content) {
            fullText += choice.delta.content
            setStreamText(fullText)
            // Real-time context update — throttled every ~400 chars
            if (fullText.length > 0 && fullText.length - lastCtxUpdate > 400) {
              lastCtxUpdate = fullText.length
              const streamingUsed = estimateTokens([...messages, { role: 'assistant', content: fullText }], systemPrompt)
              onContextUpdate?.(streamingUsed, getContextLimit(model))
            }
          }

          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id || `tc_${idx}`,
                  type: 'function',
                  function: { name: '', arguments: '' },
                }
              }
              if (tc.id) toolCalls[idx].id = tc.id
              if (tc.function?.name) toolCalls[idx].function.name = tc.function.name
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
              // Live-stream the file content into the editor while the
              // model is still writing it. No-op for non-write_file tools
              // and for chunks that don't yet contain a parseable path.
              const cur = toolCalls[idx]
              if (cur.function.name && cur.function.arguments) {
                emitPartialArgs(cur.id, cur.function.name, cur.function.arguments)
              }
            }
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hardTimer)
    }

    // If a timer cancelled the reader, surface a retry-able error HERE so
    // the RETRY_PATTERN below (and the outer auto-retry) can handle it.
    if (idleTimedOut) {
      throw new Error(`Nema odgovora od servera (${idleMs / 1000}s idle). Probaj ponovo.`)
    }
    if (hardTimedOut) {
      throw new Error(`Timeout: zahtev je predugo trajao (${hardMs / 1000}s). Probaj ponovo.`)
    }

    // Verify we got something. If we got a finish_reason but no text and
    // no tool calls, that's actually a valid "model decided to stop" — the
    // provider sent the terminator without content. Treat it as empty
    // completion instead of a fatal error so we don't trigger the retry
    // loop on something that worked.
    const resultToolCalls = Object.values(toolCalls)
    // Tell the editor the streamed file content is final so it can stop
    // showing the "live" overlay and fall back to the real file content
    // (which toolHandler.writeFile will push into WebContainers shortly).
    for (const tc of resultToolCalls) {
      if (tc.function.name && tc.function.arguments) {
        emitFinalArgs(tc.id, tc.function.name, tc.function.arguments)
      }
    }
    if (!fullText && resultToolCalls.length === 0) {
      if (finishReason) {
        // Clean stop with no payload — treat as empty assistant response.
        return { text: '', toolCalls: [], finishReason }
      }
      throw new Error('Stream prekinut pre nego sto je odgovor stigao. Probaj ponovo.')
    }

    return { text: fullText, toolCalls: resultToolCalls, finishReason }
  }

  // ─── Main send loop ─────────────────────────────────────────────────────

  async function sendMessage(text: string, overrideImages?: { name: string; dataUrl: string }[]) {
    // If there are attached images, include them in message content.
    // overrideImages lets callers (like the initial welcome-prompt effect)
    // pass images directly instead of going through setAttachedImages,
    // which is async and would race with this very call.
    const images = overrideImages && overrideImages.length > 0
      ? [...overrideImages]
      : [...attachedImages]
    setAttachedImages([])

    let msgContent: string
    if (images.length > 0) {
      // For display, just show text
      msgContent = text + (images.length > 0 ? `\n[${images.length} slika priloženo]` : '')
    } else {
      msgContent = text
    }

    const userMsg: Message = { role: 'user', content: msgContent }
    // If images attached, store them for API call (multimodal)
    if (images.length > 0) {
      (userMsg as any)._images = images
    }
    historyRef.current = [...historyRef.current, userMsg]
    setDisplayMessages(prev => [...prev, { role: 'user', content: msgContent }])
    setInput('')
    setStreaming(true)
    onStreamingChange?.(true)
    setStreamText('')
    setStatusText('')
    // Reset scroll — user sent a message, so scroll to bottom
    userScrolledUp.current = false

    let lastAssistantHadText = false
    let textContinuationUsed = false

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        // Check abort
        if (abortRef.current?.signal.aborted) break

        // Warn agent if approaching iteration limit (mid-conversation system directive).
        if (iteration === MAX_ITERATIONS - 10) {
          historyRef.current.push({
            role: 'system',
            content: 'You are approaching the tool call limit. Wrap up your current work — summarize what you did and what remains, then STOP calling tools.',
          })
        }

        // Trim history to fit context window
        const trimmedHistory = trimHistory(historyRef.current, model)

        // Build dynamic context (workspace index, editor, project type, model boost)
        const userMessages = historyRef.current.filter(m => m.role === 'user')
        const lastUserMsg = userMessages[userMessages.length - 1]
        const dynamicCtx = await buildFullContext({
          model,
          files,
          activeFile,
          isFirstMessage: userMessages.length <= 1,
          userText: lastUserMsg?.content || '',
          selectedText: selectionRef?.current || undefined,
        })
        let fullSystemPrompt = dynamicCtx
          ? WEB_SYSTEM_PROMPT + '\n\n' + dynamicCtx
          : WEB_SYSTEM_PROMPT

        // Inject active skill prompt if any
        if (activeSkill) {
          fullSystemPrompt += '\n\n' + activeSkill
        }

        // Plan mode: add planning instructions
        if (mode === 'plan') {
          fullSystemPrompt += '\n\n<plan_mode>\nPLAN MODE je aktivan. Pre nego što napraviš bilo kakve izmene:\n1. Napravi detaljan plan sa numerisanim fazama.\n2. Za svaku fazu opiši: šta se radi, koji fajlovi su uključeni, i koji je očekivani rezultat.\n3. Pokaži plan korisniku i sačekaj potvrdu pre nego što počneš sa implementacijom.\n4. Tek kad korisnik potvrdi, kreni sa izvršavanjem fazu po fazu.\nNIKAD ne preskači planiranje i ne kreći odmah sa kodom.\n</plan_mode>'
        }

        // Invalidate workspace index cache after tool calls modify files
        if (iteration > 0) invalidateIndex()

        // Send context update
        const used = estimateTokens(trimmedHistory, fullSystemPrompt)
        const limit = getContextLimit(model)
        onContextUpdate?.(used, limit)

        setStreamText('')
        setStatusText(iteration === 0 ? 'Obrađujem zahtev...' : 'Pripremam sledeći korak...')

        // Create new AbortController for this iteration
        abortRef.current = new AbortController()
        const signal = abortRef.current.signal

        // ─── Retry loop ──────────────────────────────────────────────
        let result: StreamResult | null = null
        let lastErr: unknown = null

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            if (signal.aborted) break

            if (attempt > 0) {
              const errMsg = lastErr instanceof Error ? lastErr.message : ''
              const isRateLimit = /429|rate.limit/i.test(errMsg)
              const delay = isRateLimit
                ? Math.min(4000 * Math.pow(2, attempt - 1), 15000)
                : Math.min(2000 * Math.pow(2, attempt - 1), 8000)

              // Status bar only — do not pollute the chat feed with retry
              // noise. User sees the subtle status line at the bottom, not
              // three separate "Pokušavam ponovo" messages.
              setStatusText(`Pokušavam ponovo (${attempt}/${MAX_RETRIES})...`)
              await new Promise(r => setTimeout(r, delay))
            }

            result = await callAPI(trimmedHistory, signal, fullSystemPrompt)
            lastErr = null
            break
          } catch (err: unknown) {
            lastErr = err
            if ((err as Error).name === 'AbortError') break

            const errorMsg = err instanceof Error ? err.message : String(err)
            const isRetryable = RETRY_PATTERN.test(errorMsg)

            // If files were already written and this is the nudge/completion
            // phase failing, don't retry — just finish gracefully. The site
            // is built; this was a bonus pass. Retrying 3x on an already-
            // complete build wastes credits and confuses the user.
            const filesAlreadyBuilt = iteration > 0 && historyRef.current.some(m =>
              m.role === 'assistant' && m.tool_calls?.some(tc => tc.function.name === 'write_file')
            )
            if (filesAlreadyBuilt) {
              console.warn('[API] Post-build API call failed, finishing gracefully:', errorMsg)
              result = { text: '', toolCalls: [], finishReason: 'stop' }
              lastErr = null
              break
            }

            if (!isRetryable || attempt >= MAX_RETRIES) {
              // On 403, clean up tool messages from history
              const is403 = /403|forbidden/i.test(errorMsg)
              if (is403) {
                while (historyRef.current.length > 0 && historyRef.current[historyRef.current.length - 1].role === 'tool') {
                  historyRef.current.pop()
                }
                if (historyRef.current.length > 0 && historyRef.current[historyRef.current.length - 1].tool_calls) {
                  historyRef.current.pop()
                }
              }

              const userErrMsg = is403
                ? 'Zahtev je odbijen. Moguće da je kontekst prevelik — osveži stranicu ili pokreni nov chat.'
                : humanizeError(errorMsg)

              setDisplayMessages(prev => [...prev, { role: 'error', content: userErrMsg }])
              setStreamText('')
              setStreaming(false)
              onStreamingChange?.(false)
              setStatusText('')
              saveSession(historyRef.current, [...displayMessagesRef.current, { role: 'error', content: userErrMsg }], model)
              return
            }

            console.warn(`[API] Attempt ${attempt + 1} failed:`, errorMsg)
          }
        }

        if (!result || signal.aborted) break

        // ─── Truncation detection ────────────────────────────────────
        // Only the LAST tool call can be truncated — earlier ones had a
        // content_block_stop before max_tokens fired. We flag it as truncated
        // *only* when its JSON can't be parsed; a valid-JSON tool call with
        // finishReason='length' is fine to execute (the model just wanted to
        // say more afterward). The reply is a `tool` role message steering
        // the model toward skeleton + replace_in_file instead of retrying
        // the giant write.
        const truncatedToolIds = new Set<string>()
        if (result.toolCalls.length > 0) {
          const lastTc = result.toolCalls[result.toolCalls.length - 1]
          const argsStr = lastTc.function.arguments || ''
          let parsesOk = false
          try { JSON.parse(argsStr); parsesOk = true } catch { /* broken */ }
          if (!parsesOk) {
            truncatedToolIds.add(lastTc.id)
            console.warn(`[API] Truncated tool call detected: ${lastTc.function.name} (finish=${result.finishReason}, args_len=${argsStr.length}, parses=false)`)
          }
        }

        // ─── Process result ──────────────────────────────────────────

        if (result.toolCalls.length === 0) {
          // Pure text response. If the model ran out of tokens mid-sentence
          // (finishReason='length'), inject a system note and loop so it can
          // finish its thought. We do this at most once per turn to avoid a
          // runaway loop if the model keeps producing huge walls of text.
          if (result.text) {
            historyRef.current = [...historyRef.current, { role: 'assistant', content: result.text }]
            setDisplayMessages(prev => [...prev, { role: 'assistant', content: result.text }])
            lastAssistantHadText = true
          }
          setStreamText('')
          if (result.finishReason === 'length' && !textContinuationUsed) {
            textContinuationUsed = true
            historyRef.current.push({
              role: 'system',
              content: 'Prethodni odgovor je presečen (iskorišćen je maksimum tokena). Nastavi odmah odakle si stao — ne ponavljaj već napisano, ne pozdravljaj ponovo, samo dovrši misao u 2-3 rečenice.',
            })
            continue
          }
          break
        }

        // Has tool calls — execute them
        const assistantMsg: Message = {
          role: 'assistant',
          content: result.text || '',
          tool_calls: result.toolCalls,
        }
        historyRef.current = [...historyRef.current, assistantMsg]

        if (result.text) {
          setDisplayMessages(prev => [...prev, { role: 'assistant', content: result.text }])
          lastAssistantHadText = true
        }
        setStreamText('')
        setStatusText('Izvršavam alate...')

        // Execute each tool call
        for (const tc of result.toolCalls) {
          if (abortRef.current?.signal.aborted) break

          const toolName = tc.function.name

          // ─── Truncated tool call: short-circuit with NEUTRAL hint ─────
          // When the LAST tool call's JSON literally won't parse we can't
          // execute it, but we also don't want to alarm the model into a
          // rewrite/apology loop. The previous message told it "file NOT
          // written, start over with a skeleton" — which made the model
          // apologize ("Izvinjavam se — imao sam problem sa CSS fajlom…")
          // and call write_file again with the exact same full content,
          // hitting the same cap. Loop.
          //
          // New tone: acknowledge the cut-off, tell it to NOT apologize,
          // NOT rewrite the same file, and just move on or append the
          // missing tail with replace_in_file. This ends the loop because
          // the model has a productive next move that isn't "write_file
          // style.css from scratch again".
          if (truncatedToolIds.has(tc.id)) {
            const truncErr = toolName === 'write_file'
              ? `Napomena: prethodni write_file poziv za ${(() => { try { const m = tc.function.arguments.match(/"path"\s*:\s*"([^"]+)/); return m ? m[1] : 'fajl' } catch { return 'fajl' } })()} je pogodio granicu output tokena i nije kompletno stigao. Moguće je da je deo sadržaja već upisan.\n\nURADI OVO:\n- NE izvinjavaj se korisniku i NE zovi write_file za ISTI fajl ponovo sa istim sadržajem (loop).\n- Pozovi read_file(${(() => { try { const m = tc.function.arguments.match(/"path"\s*:\s*"([^"]+)/); return m ? m[1] : 'fajl' } catch { return 'fajl' } })()}) da vidiš šta je stvarno upisano.\n- Ako fajl postoji i skoro kompletan: koristi replace_in_file da dodaš samo ono što fali (kratki old_text na kraju fajla → new_text sa ostatkom).\n- Ako fajl ne postoji ili je praznjikav: nastavi sa sledećim fajlom iz plana, pa se vrati posle.\n- Nastavi rad u istom tonu, bez izvinjenja.`
              : toolName === 'replace_in_file'
                ? `Napomena: prethodni replace_in_file poziv je pogodio granicu output tokena i new_text nije kompletno stigao. Izmena NIJE primenjena.\n\nNastavi sa manjim koracima: podeli izmenu na više replace_in_file poziva, svaki max ~100-150 linija new_text-a. Ne izvinjavaj se, samo kreni.`
                : `Napomena: argumenti za ${toolName} su presečeni. Probaj ponovo sa manjim argumentima, bez izvinjenja.`

            setDisplayMessages(prev => [...prev, { role: 'status', content: 'Nastavljam sa sledećim korakom…' }])
            historyRef.current = [...historyRef.current, {
              role: 'tool' as const,
              content: truncErr,
              tool_call_id: tc.id,
            }]
            setStatusText('Nastavljam…')
            continue
          }

          // Pretty per-tool status label. Fallback to a friendly generic when
          // args can't be parsed yet (streaming / truncated JSON). We cover
          // EVERY tool the backend exposes so the user never sees a raw
          // snake_case tool name bubble up into the chat.
          const FRIENDLY: Record<string, string> = {
            write_file: 'Pišem fajl…',
            read_file: 'Čitam fajl…',
            replace_in_file: 'Menjam fajl…',
            list_files: 'Pregledam fajlove',
            execute_command: 'Izvršavam komandu…',
            search_files: 'Pretražujem fajlove',
            search_images: 'Tražim slike',
            fetch_url: 'Učitavam stranicu…',
            web_search: 'Pretražujem internet…',
            download_file: 'Preuzimam fajl…',
            git_status: 'Proveravam GitHub…',
            git_list_repos: 'Učitavam GitHub repoe…',
            git_push: 'Objavljujem na GitHub…',
            supabase_list_tables: 'Čitam Supabase tabele…',
            supabase_describe_table: 'Čitam strukturu tabele…',
            supabase_get_auth_config: 'Čitam Supabase Auth…',
            supabase_list_functions: 'Čitam Edge Functions…',
            supabase_deploy_function: 'Objavljujem Edge Function…',
            supabase_delete_function: 'Brišem Edge Function…',
            supabase_update_auth_config: 'Menjam Supabase Auth…',
            supabase_sql: 'Izvršavam SQL…',
          }
          let statusLabel = FRIENDLY[toolName] || 'Radim…'
          try {
            const args = JSON.parse(tc.function.arguments)
            if (toolName === 'write_file' && args.path) statusLabel = `Pišem ${args.path}`
            else if (toolName === 'read_file' && args.path) statusLabel = `Čitam ${args.path}`
            else if (toolName === 'replace_in_file' && args.path) statusLabel = `Menjam ${args.path}`
            else if (toolName === 'execute_command' && args.command) {
              const cmd = String(args.command).trim().split('\n')[0]
              statusLabel = cmd.length > 48 ? `${cmd.slice(0, 45)}…` : cmd
            }
            else if (toolName === 'fetch_url' && args.url) {
              try { statusLabel = `Učitavam ${new URL(args.url).hostname}…` } catch { /* keep default */ }
            }
            else if (toolName === 'web_search' && args.query) statusLabel = `Pretražujem: ${String(args.query).slice(0, 40)}`
            else if (toolName === 'search_images' && args.query) statusLabel = `Tražim slike: ${String(args.query).slice(0, 40)}`
            else if (toolName === 'search_files' && args.pattern) statusLabel = `Pretražujem: ${String(args.pattern).slice(0, 40)}`
            else if (toolName === 'download_file' && args.path) statusLabel = `Preuzimam ${args.path}`
            else if (toolName === 'supabase_sql' && args.query) {
              const q = String(args.query).trim().replace(/\s+/g, ' ').slice(0, 50)
              statusLabel = `SQL: ${q}`
            }
            else if (toolName === 'supabase_describe_table' && args.table) statusLabel = `Čitam tabelu ${args.table}…`
            else if (toolName === 'supabase_deploy_function' && args.name) statusLabel = `Objavljujem function ${args.name}…`
            else if (toolName === 'supabase_delete_function' && args.name) statusLabel = `Brišem function ${args.name}…`
          } catch {
            // JSON partial/truncated — FRIENDLY default already set above.
          }

          setDisplayMessages(prev => [...prev, { role: 'status', content: statusLabel }])
          setStatusText(statusLabel)

          const toolResult = await executeToolCall(tc, (files) => {
            onFilesChanged(files)
          })

          historyRef.current = [...historyRef.current, {
            role: 'tool',
            content: toolResult.content,
            tool_call_id: toolResult.tool_call_id,
          }]

          // Show error to user if tool failed
          if (toolResult.content.startsWith('GRESKA:') || toolResult.content.startsWith('Greska:')) {
            setStatusText('Popravljam grešku...')
          }
        }

        setStatusText('Agent nastavlja...')
      }

      // ─── Fallback summary if agent ended without text ─────────────
      if (!lastAssistantHadText && historyRef.current.length > 1) {
        const summary = buildFallbackSummary(historyRef.current)
        setDisplayMessages(prev => [...prev, { role: 'assistant', content: summary }])
      }

    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setDisplayMessages(prev => [...prev, { role: 'status', content: 'Zaustavljeno.' }])
      } else {
        const rawMsg = err instanceof Error ? err.message : 'Greška pri povezivanju'
        setDisplayMessages(prev => [...prev, { role: 'error', content: humanizeError(rawMsg) }])
      }
      setStreamText('')
    } finally {
      setStreaming(false)
      onStreamingChange?.(false)
      setStatusText('')
      abortRef.current = null
      resetLiveStream()
      // If the user aborted mid-tool-run, the transcript ends on an assistant
      // message with tool_calls but missing tool responses. Repair it before
      // we persist so the next request doesn't get rejected.
      historyRef.current = repairHistory(historyRef.current)
      saveSession(historyRef.current, displayMessagesRef.current, model)
      onChatHistoryUpdate?.(historyRef.current, displayMessagesRef.current)
      // Refresh balance and warn at multiple levels
      fetchBalance().then(bal => {
        if (bal === null) return
        const credits = Math.max(0, Math.round(bal * 1000))
        const fmt = credits.toLocaleString('sr-RS')
        if (bal <= 0.05) {
          setDisplayMessages(prev => [...prev, {
            role: 'error',
            content: `Ponestalo ti je kredita (${fmt}). Dopuni nalog da nastaviš.`,
          }])
          // Trigger paywall modal on parent
          onLowBalance?.(bal)
        } else if (bal < 0.50) {
          setDisplayMessages(prev => [...prev, {
            role: 'status',
            content: `⚠ Kredit pada — preostalo ${fmt} kredita.`,
          }])
        } else if (bal < 2.00) {
          setDisplayMessages(prev => [...prev, {
            role: 'status',
            content: `Preostalo ${fmt} kredita.`,
          }])
        }
      })
      onDone?.()

      // Process queued message if any
      const queued = queuedRef.current
      if (queued) {
        queuedRef.current = null
        // Small delay so UI updates before next send
        setTimeout(() => sendMessage(queued), 100)
      }
    }
  }

  const handleSubmit = () => {
    const trimmed = input.trim()
    if (!trimmed) return

    if (streaming || sendInFlightRef.current) {
      queuedRef.current = trimmed
      setInput('')
      setDisplayMessages(prev => [...prev, { role: 'queued', content: trimmed }])
      return
    }

    sendInFlightRef.current = true
    try {
      sendMessage(trimmed)
    } finally {
      // Release on next tick — by then `streaming` state has propagated
      // and subsequent submits hit the queue branch above.
      setTimeout(() => { sendInFlightRef.current = false }, 0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // When the command palette is open, its own capture-phase listener
    // claims Enter/Tab/Arrow/Escape before this handler runs. We still
    // need to avoid triggering chat submission on those keys, so we
    // early-return instead of falling through to the submit branch.
    if (showCommands) return

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div
      className="chat-panel"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className="chat-header">
        <img src="/logo.svg" alt="V" style={{ width: 16, height: 16 }} />
        <span>Chat sa VajbAgentom</span>
        {streaming && <Loader2 size={14} className="chat-spinner" />}
      </div>

      <div className="chat-messages" ref={messagesRef} onScroll={handleChatScroll}>
        <AnimatePresence>
          {displayMessages.map((msg, i) => (
            <motion.div
              key={i}
              className={`chat-msg ${msg.role}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {msg.role === 'status' ? (
                <div className="msg-status">
                  <img src="/logo.svg" alt="" className="status-logo" />
                  <span className="status-text">{msg.content}</span>
                </div>
              ) : msg.role === 'error' ? (
                <div className="msg-error">
                  <span className="error-text">{msg.content}</span>
                </div>
              ) : msg.role === 'queued' ? (
                <div className="msg-status">
                  <User size={12} />
                  <span className="status-text">Na čekanju: {msg.content}</span>
                </div>
              ) : (
                <>
                  <div className="msg-avatar">
                    {msg.role === 'user' ? <User size={14} /> : <img src="/logo.svg" alt="V" className="avatar-logo" />}
                  </div>
                  <div className="msg-content">
                    {msg.role === 'user' ? (
                      <pre>{msg.content}</pre>
                    ) : (
                      <MarkdownRenderer text={msg.content} />
                    )}
                  </div>
                </>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {streaming && streamText && (
          <motion.div className="chat-msg assistant" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <div className="msg-avatar">
              <img src="/logo.svg" alt="V" className="avatar-logo" />
            </div>
            <div className="msg-content">
              <MarkdownRenderer text={cleanStreamText(streamText)} />
              <span className="cursor-blink" />
            </div>
          </motion.div>
        )}

        {streaming && !streamText && (
          <div className="chat-thinking">
            <img src="/logo.svg" alt="" className="thinking-logo" />
            <div className="thinking-dots">
              <span />
              <span />
              <span />
            </div>
            <ThinkingLabel statusText={statusText} />
          </div>
        )}
      </div>

      <div
        className={`chat-input-area ${dragging ? 'drag-over' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {dragging && (
          <div className="drop-overlay">Prevuci fajlove ovde</div>
        )}

        {attachedImages.length > 0 && (
          <div className="attached-images">
            {attachedImages.map((img, i) => (
              <div key={i} className="attached-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <button className="thumb-remove" onClick={() => removeImage(i)}>×</button>
              </div>
            ))}
          </div>
        )}

        <div className="chat-input-top">
          <button className="btn-attach" onClick={() => fileInputRef.current?.click()} title="Dodaj fajl">
            +
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.ts,.tsx,.js,.jsx,.py,.html,.css,.json,.md,.txt,.yaml,.yml,.sql,.sh,.csv"
            onChange={handleFileInput}
            style={{ display: 'none' }}
          />
          {onModelChange && (
            <ModelSelector value={model} onChange={onModelChange} compact freeTier={freeTier} />
          )}
          <button
            className={`mode-toggle ${mode === 'plan' ? 'plan-active' : ''}`}
            onClick={() => setMode(mode === 'auto' ? 'plan' : 'auto')}
            title={mode === 'auto' ? 'Auto edit — klikni za Plan mode' : 'Plan mode — klikni za Auto edit'}
          >
            {mode === 'auto' ? 'Auto' : 'Plan'}
          </button>
          {activeSkill && (
            <div className="active-skill-badge">
              <span>{activeSkill.match(/name="(\w+)"/)?.[1] || 'skill'}</span>
              <button onClick={() => setActiveSkill(null)}>×</button>
            </div>
          )}
        </div>
        <div className="chat-input-wrap">
          <CommandPalette
            inputValue={input}
            visible={showCommands && !showFileMention}
            onSelect={handleCommandSelect}
            onClose={() => {
              setShowCommands(false)
              const slashIdx = input.lastIndexOf('/')
              if (slashIdx > 0) setInput(input.substring(0, slashIdx))
              else setInput('')
            }}
          />
          <FileMention
            files={files}
            query={mentionQuery}
            visible={showFileMention && !showCommands}
            onSelect={(path) => {
              // Replace @query with @path in input
              const atIdx = input.lastIndexOf('@')
              const before = input.substring(0, atIdx)
              setInput(before + '`' + path + '` ')
              setShowFileMention(false)
              inputRef.current?.focus()
            }}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={streaming ? 'Kucaj poruku — poslaće se kad agent završi...' : 'Kucaj / za komande...'}
            rows={2}
          />
          {streaming ? (
            <button
              className="chat-send active cancel"
              onClick={handleCancel}
              title="Zaustavi"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className={`chat-send ${input.trim() || attachedImages.length > 0 ? 'active' : ''}`}
              onClick={handleSubmit}
              disabled={!input.trim() && attachedImages.length === 0}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Rotating thinking phrases ───────────────────────────────────────────────
// When `statusText` is empty the agent is usually in the model-reasoning phase
// (no tool calls yet, no output tokens). On Power-tier reasoning models this
// can silently last 60-180 seconds. Showing a static "Razmišljam…" the whole
// time feels frozen, so we rotate through a few natural Serbian phrases.
const THINKING_PHRASES = [
  'Razmišljam…',
  'Analiziram zahtev…',
  'Planiram korake…',
  'Biram najbolji pristup…',
  'Još malo, sklapam plan…',
  'Pripremam rešenje…',
]

function ThinkingLabel({ statusText }: { statusText: string }) {
  const [phraseIdx, setPhraseIdx] = useState(0)
  useEffect(() => {
    if (statusText) return
    const t = setInterval(() => {
      setPhraseIdx(i => (i + 1) % THINKING_PHRASES.length)
    }, 4000)
    return () => clearInterval(t)
  }, [statusText])
  if (statusText) return <span>{statusText}</span>
  return (
    <motion.span
      key={phraseIdx}
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={{ duration: 0.25 }}
    >
      {THINKING_PHRASES[phraseIdx]}
    </motion.span>
  )
}
