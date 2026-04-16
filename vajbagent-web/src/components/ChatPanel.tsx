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
import { ALL_COMMANDS, type Command } from '../commands'
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
  const trimmed = history.map(m => ({ ...m }))
  const keepRecent = Math.min(10, trimmed.length)
  const trimZone = trimmed.length - keepRecent

  // Phase 0 (ALWAYS): Compact old tool results
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

  // Phase 2: If still over threshold, drop oldest messages
  const trimmedTokens = Math.ceil(
    trimmed.reduce((sum, m) => sum + m.content.length, 0) / 3.5
  )
  if (trimmedTokens > limit * 0.85 && trimmed.length > 20) {
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

function buildFallbackSummary(history: Message[]): string {
  const created: string[] = []
  const modified: string[] = []
  const commands: string[] = []

  for (const msg of history) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        try {
          const args = JSON.parse(tc.function.arguments)
          const fname = (args.path || '').split('/').pop() || ''
          if (tc.function.name === 'write_file' && fname) {
            if (!created.includes(fname)) created.push(fname)
          } else if (tc.function.name === 'replace_in_file' && fname) {
            if (!modified.includes(fname)) modified.push(fname)
          } else if (tc.function.name === 'execute_command' && args.command) {
            commands.push(args.command)
          }
        } catch { /* skip */ }
      }
    }
  }

  const parts: string[] = ['Gotovo!']
  if (created.length > 0) {
    parts.push(`Kreirani fajlovi: ${created.join(', ')}`)
  }
  if (modified.length > 0) {
    parts.push(`Izmenjeni fajlovi: ${modified.join(', ')}`)
  }
  if (commands.length > 0) {
    parts.push(`Izvršene komande: ${commands.join(', ')}`)
  }
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
      historyRef.current = resumeHistory as Message[]
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
      historyRef.current = session.history
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
      },
      credentials: 'include',
      body: JSON.stringify({
        model,
        messages: apiMessages,
        tools: TOOL_DEFINITIONS,
        stream: true,
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

    // Idle timeout — if no data for N seconds, abort
    const msgCount = messages.length
    const idleMs = msgCount > 20 ? 90_000 : msgCount > 10 ? 60_000 : 45_000
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        reader.cancel().catch(() => {})
        throw new Error(`Nema odgovora od servera (${idleMs / 1000}s idle). Probaj ponovo.`)
      }, idleMs)
    }

    // Hard timeout — absolute max wait
    const hardMs = Math.max(idleMs + 30_000, 120_000)
    const hardTimer = setTimeout(() => {
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

          try {
            const parsed = JSON.parse(data)
            const choice = parsed.choices?.[0]
            if (!choice) continue

            if (choice.finish_reason) {
              finishReason = choice.finish_reason
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
              }
            }
          } catch (e) {
            console.warn('[SSE] Failed to parse:', data, e)
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      clearTimeout(hardTimer)
    }

    // Verify we got something. If we got a finish_reason but no text and
    // no tool calls, that's actually a valid "model decided to stop" — the
    // provider sent the terminator without content. Treat it as empty
    // completion instead of a fatal error so we don't trigger the retry
    // loop on something that worked.
    const resultToolCalls = Object.values(toolCalls)
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

    // ─── Rewrite guard ──────────────────────────────────────────────
    // One rule: once a file is written SUCCESSFULLY, block further write_file
    // to that path. Model must use replace_in_file for changes.
    // Failed writes are NOT tracked — model can retry unlimited (same as
    // the VS Code extension which has no guard at all and works fine).
    const fileWriteOk = new Set<string>()

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
                ? 'Zahtev je odbijen (403). Moguć razlog: prevelik kontekst ili privremeno ograničenje. Pokušaj ponovo ili osveži stranicu da resetuješ kontekst.'
                : errorMsg

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

        // ─── Auto-continuation for truncated output ──────────────────
        if (result.finishReason === 'length' && result.toolCalls.length > 0) {
          const MAX_CONTINUATIONS = 3
          for (let cont = 0; cont < MAX_CONTINUATIONS; cont++) {
            if (signal.aborted) break
            console.log(`[API] Output truncated, continuation ${cont + 1}/${MAX_CONTINUATIONS}`)
            setStatusText('Nastavljam generisanje...')

            const partialArgs = result.toolCalls.map(tc => tc.function.arguments).join('')
            const contMessages: Message[] = [
              ...trimmedHistory,
              { role: 'assistant', content: result.text, tool_calls: result.toolCalls },
              {
                role: 'user',
                content: '[SYSTEM] Your previous response was cut off (output token limit reached). The last tool call arguments ended with: "...' + partialArgs.slice(-200) + '"\n\nContinue generating ONLY the remaining part of the tool call arguments, starting exactly where you left off. Do NOT repeat what was already generated.',
              },
            ]

            try {
              const contResult = await callAPI(contMessages, signal, fullSystemPrompt)

              if (contResult.toolCalls.length > 0) {
                const lastTc = result.toolCalls[result.toolCalls.length - 1]
                lastTc.function.arguments += contResult.toolCalls[0].function.arguments
              } else if (contResult.text) {
                const lastTc = result.toolCalls[result.toolCalls.length - 1]
                lastTc.function.arguments += contResult.text
              }

              if (contResult.finishReason !== 'length') {
                console.log(`[API] Continuation complete after ${cont + 1} attempts`)
                break
              }
            } catch (contErr) {
              console.warn(`[API] Continuation failed:`, (contErr as Error).message)
              break
            }
          }
        }

        // ─── Process result ──────────────────────────────────────────

        if (result.toolCalls.length === 0) {
          // Pure text response — done.
          if (result.text) {
            historyRef.current = [...historyRef.current, { role: 'assistant', content: result.text }]
            setDisplayMessages(prev => [...prev, { role: 'assistant', content: result.text }])
            lastAssistantHadText = true
          }
          setStreamText('')
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
          let statusLabel = toolName
          try {
            const args = JSON.parse(tc.function.arguments)
            if (toolName === 'write_file') statusLabel = `Pišem ${args.path}`
            else if (toolName === 'read_file') statusLabel = `Čitam ${args.path}`
            else if (toolName === 'list_files') statusLabel = `Pregledam fajlove`
            else if (toolName === 'replace_in_file') statusLabel = `Menjam ${args.path}`
            else if (toolName === 'execute_command') statusLabel = `${(args.command || '').substring(0, 40)}`
            else if (toolName === 'search_files') statusLabel = 'Pretražujem fajlove'
            else if (toolName === 'search_images') statusLabel = 'Tražim slike'
            else if (toolName === 'git_push') statusLabel = 'Objavljujem na GitHub'
            else if (toolName === 'git_status') statusLabel = 'Proveravam GitHub'
          } catch {
            // JSON partial/truncated — use friendly generic labels instead of raw tool name
            const FRIENDLY: Record<string, string> = {
              write_file: 'Pišem fajl…',
              read_file: 'Čitam fajl…',
              replace_in_file: 'Menjam fajl…',
              list_files: 'Pregledam fajlove',
              execute_command: 'Izvršavam komandu…',
              search_files: 'Pretražujem fajlove',
              search_images: 'Tražim slike',
            }
            statusLabel = FRIENDLY[toolName] || toolName
          }

          // ─── Rewrite guard ─────────────────────────────────────────────
          // Silent in UI — blocked writes never show "Pišem ..." status.
          // ─── Rewrite guard: block write_file to paths already written ──
          if (toolName === 'write_file') {
            const pathMatch = tc.function.arguments.match(/"path"\s*:\s*"([^"]+)"/)
            const wPath = pathMatch ? pathMatch[1].replace(/^\/+/, '') : ''
            if (wPath && fileWriteOk.has(wPath)) {
              historyRef.current = [...historyRef.current, {
                role: 'tool' as const,
                content: `BLOCKED: ${wPath} was already written successfully. Use replace_in_file for changes.`,
                tool_call_id: tc.id,
              }]
              continue
            }
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

          // Track successful write_file for rewrite guard
          if (toolName === 'write_file') {
            const isOk = !/^(GRESKA:|Greska:|Ne možeš|BLOKIRANO|BLOCKED)/.test(toolResult.content)
            if (isOk) {
              const pathMatch = tc.function.arguments.match(/"path"\s*:\s*"([^"]+)"/)
              const wPath = pathMatch ? pathMatch[1].replace(/^\/+/, '') : ''
              if (wPath) fileWriteOk.add(wPath)
            }
          }

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
        const errMsg = err instanceof Error ? err.message : 'Greška pri povezivanju'
        setDisplayMessages(prev => [...prev, { role: 'error', content: errMsg }])
      }
      setStreamText('')
    } finally {
      setStreaming(false)
      onStreamingChange?.(false)
      setStatusText('')
      abortRef.current = null
      // Save session (use ref to get latest displayMessages, not stale closure)
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

    if (streaming) {
      // Queue the message — will be sent when agent finishes
      queuedRef.current = trimmed
      setInput('')
      setDisplayMessages(prev => [...prev, { role: 'queued', content: trimmed }])
      return
    }

    sendMessage(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // If command palette is open, let it handle Enter/Tab/Arrow keys
    if (showCommands && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault()
      const slashIdx = input.lastIndexOf('/')
      const query = slashIdx >= 0 ? input.substring(slashIdx + 1).toLowerCase() : ''
      const filtered = query
        ? ALL_COMMANDS.filter(c => c.name.includes(query) || c.description.toLowerCase().includes(query))
        : ALL_COMMANDS
      if (filtered.length > 0) {
        handleCommandSelect(filtered[0])
      }
      return
    }
    if (showCommands && e.key === 'Escape') {
      e.preventDefault()
      setShowCommands(false)
      // Only clear the /command part, keep text before it
      const slashIdx = input.lastIndexOf('/')
      if (slashIdx > 0) {
        setInput(input.substring(0, slashIdx))
      } else {
        setInput('')
      }
      return
    }

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
            <span>{statusText || 'Razmišljam...'}</span>
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
