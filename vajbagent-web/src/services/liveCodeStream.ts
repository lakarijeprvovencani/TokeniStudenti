/**
 * Live code streaming — shows the file being written char-by-char in the
 * editor as the model streams tool_call arguments, instead of a sudden
 * 200-line dump at the end. Same feel as bolt.new / lovable / Cursor.
 *
 * How it works:
 *   1. ChatPanel accumulates tool_call.function.arguments as chunks arrive.
 *      After each chunk it calls emitPartialArgs(toolId, name, rawArgs).
 *   2. We leniently extract `path` and `content` fields from the partial
 *      JSON (may be unterminated mid-string).
 *   3. Subscribers (IDELayout) receive { path, content, isDone } events
 *      and reflect them into the editor. When the tool call finalizes,
 *      we emit one last event with isDone=true so subscribers can release
 *      their override and let the real post-write refresh take over.
 *
 * Only write_file is supported — replace_in_file uses SEARCH/REPLACE
 * blocks that don't render meaningfully in a normal editor until applied.
 */

export interface LiveWriteEvent {
  toolCallId: string
  path: string
  content: string
  isDone: boolean
}

type Listener = (e: LiveWriteEvent) => void

const listeners = new Set<Listener>()
const lastEmitted = new Map<string, { path: string; contentLen: number }>()

export function onLiveWrite(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function dispatch(e: LiveWriteEvent): void {
  for (const l of listeners) {
    try { l(e) } catch (err) { console.warn('[liveCodeStream] listener threw:', err) }
  }
}

/**
 * Decode a JSON string fragment that may not be terminated yet. Trims
 * dangling backslash escapes (\, \u0XX) so JSON.parse doesn't barf on
 * an incomplete escape at the tail.
 */
function decodeJsonFragment(raw: string): string {
  let clean = raw
  // Incomplete \uXXXX escape — must be exactly 4 hex digits
  const uEsc = clean.match(/\\u[0-9a-fA-F]{0,3}$/)
  if (uEsc) clean = clean.slice(0, -uEsc[0].length)
  // Trailing lone backslash
  if (/\\$/.test(clean)) clean = clean.slice(0, -1)
  try {
    return JSON.parse('"' + clean + '"')
  } catch {
    // Last-ditch fallback: strip anything that couldn't parse.
    // This is rare and only affects the last few characters of the tail.
    return clean
  }
}

/**
 * Pull `path` and `content` out of a possibly-incomplete JSON object.
 * Works even when `content` isn't terminated (stream still ongoing).
 */
function extractWriteArgs(raw: string): { path?: string; content?: string } {
  const out: { path?: string; content?: string } = {}

  // Path usually comes first and is small, so it's almost always fully
  // delivered by the time content starts streaming.
  const pathMatch = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (pathMatch) {
    try { out.path = JSON.parse('"' + pathMatch[1] + '"') } catch { out.path = pathMatch[1] }
  }

  // Content: find the opening quote, then walk forward honoring escape
  // sequences until either end-of-buffer or unescaped closing quote.
  const contentStart = raw.match(/"content"\s*:\s*"/)
  if (contentStart && contentStart.index !== undefined) {
    const startIdx = contentStart.index + contentStart[0].length
    let endIdx = -1
    for (let i = startIdx; i < raw.length; i++) {
      const ch = raw[i]
      if (ch === '\\') { i++; continue }
      if (ch === '"') { endIdx = i; break }
    }
    const body = endIdx === -1 ? raw.slice(startIdx) : raw.slice(startIdx, endIdx)
    out.content = decodeJsonFragment(body)
  }

  return out
}

/**
 * Called by ChatPanel after each streamed arguments chunk.
 * Cheap no-op when:
 *   - tool name isn't write_file
 *   - path hasn't appeared yet
 *   - content length hasn't changed since last emit (dedup)
 */
export function emitPartialArgs(toolCallId: string, name: string, rawArgs: string): void {
  if (name !== 'write_file') return
  if (!rawArgs || rawArgs.length < 12) return
  const { path, content } = extractWriteArgs(rawArgs)
  if (!path || content === undefined) return

  const prev = lastEmitted.get(toolCallId)
  if (prev && prev.path === path && prev.contentLen === content.length) return
  lastEmitted.set(toolCallId, { path, contentLen: content.length })

  dispatch({ toolCallId, path, content, isDone: false })
}

/** Called once the tool_call is finalized (args fully parsed, tool executed). */
export function emitFinalArgs(toolCallId: string, name: string, rawArgs: string): void {
  if (name !== 'write_file') return
  const { path, content } = extractWriteArgs(rawArgs)
  if (!path) return
  lastEmitted.delete(toolCallId)
  dispatch({ toolCallId, path, content: content ?? '', isDone: true })
}

/** Wipe all per-tool state. Called when a run finishes or is aborted. */
export function resetLiveStream(): void {
  lastEmitted.clear()
}
