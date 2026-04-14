import { WebContainer } from '@webcontainer/api'

let instance: WebContainer | null = null
let bootingPromise: Promise<WebContainer> | null = null
let bootFailed = false

// If boot doesn't complete within this window, reject. StackBlitz silently
// rejects origins that aren't registered (vajbagent.com falls into that
// bucket) and the internal boot promise just never resolves — without this
// timeout every awaiting caller would hang indefinitely on the chat path.
const BOOT_TIMEOUT_MS = 8000

export async function getWebContainer(): Promise<WebContainer> {
  if (instance) return instance
  if (bootFailed) throw new Error('WebContainer unavailable on this origin')
  if (bootingPromise) return bootingPromise

  const bootRace = Promise.race<WebContainer>([
    WebContainer.boot({
      coep: 'credentialless',
      forwardPreviewErrors: true,
    }),
    new Promise<WebContainer>((_, rej) =>
      setTimeout(() => rej(new Error('WebContainer boot timeout — origin blocked?')), BOOT_TIMEOUT_MS)
    ),
  ])

  bootingPromise = bootRace
    .then(wc => {
      instance = wc
      console.log('[WebContainer] Booted successfully (coep=credentialless)')
      ensureServerListener(wc)
      ensurePreviewErrorListener(wc)
      return wc
    })
    .catch(err => {
      bootFailed = true
      bootingPromise = null
      console.error('[WebContainer] Boot failed permanently:', err.message)
      throw err
    })

  return bootingPromise
}

/** Pre-boot WebContainer so it's ready when first tool call arrives */
export function preboot(): void {
  getWebContainer().catch(err => {
    console.error('[WebContainer] Boot failed:', err)
  })
}

// ─── Dev Server Support ──────────────────────────────────────────────────────

let serverUrl: string | null = null
let serverReadyCallbacks: ((url: string) => void)[] = []
let serverListenerAttached = false

/** Get current dev server URL if running */
export function getServerUrl(): string | null {
  return serverUrl
}

/** Register callback for when dev server becomes ready */
export function onServerReady(callback: (url: string) => void): () => void {
  if (serverUrl) {
    callback(serverUrl)
    return () => {}
  }
  serverReadyCallbacks.push(callback)
  return () => {
    serverReadyCallbacks = serverReadyCallbacks.filter(cb => cb !== callback)
  }
}

function ensureServerListener(wc: WebContainer) {
  if (serverListenerAttached) return
  serverListenerAttached = true

  wc.on('port', (_port: number, type: string, url: string) => {
    if (type === 'open') {
      console.log('[WebContainer] Port open:', _port, url)
      serverUrl = url
      for (const cb of serverReadyCallbacks) cb(url)
      serverReadyCallbacks = []
    }
  })

  wc.on('server-ready', (_port: number, url: string) => {
    console.log('[WebContainer] server-ready:', _port, url)
    if (!serverUrl) {
      serverUrl = url
      for (const cb of serverReadyCallbacks) cb(url)
      serverReadyCallbacks = []
    }
  })
}

let previewErrorListenerAttached = false
let previewErrors: { type: string; message: string; stack?: string }[] = []
let previewErrorCallbacks: ((err: { type: string; message: string; stack?: string }) => void)[] = []

function ensurePreviewErrorListener(wc: WebContainer) {
  if (previewErrorListenerAttached) return
  previewErrorListenerAttached = true

  wc.on('preview-message', (message: unknown) => {
    const msg = message as Record<string, unknown>
    const err = {
      type: String(msg.type || 'unknown'),
      message: String((msg as Record<string, unknown>).message || 'Preview error'),
      stack: (msg as Record<string, unknown>).stack as string | undefined,
    }
    console.warn('[WebContainer] Preview error:', err)
    previewErrors.push(err)
    for (const cb of previewErrorCallbacks) cb(err)
  })
}

export function onPreviewError(callback: (err: { type: string; message: string; stack?: string }) => void): () => void {
  previewErrorCallbacks.push(callback)
  return () => { previewErrorCallbacks = previewErrorCallbacks.filter(cb => cb !== callback) }
}

export function getPreviewErrors() { return previewErrors }

export async function writeFile(path: string, content: string): Promise<string> {
  try {
    const wc = await getWebContainer()
    const dir = path.substring(0, path.lastIndexOf('/'))
    if (dir) {
      await wc.fs.mkdir(dir, { recursive: true })
    }
    await wc.fs.writeFile(path, content)
    console.log('[WC] Written:', path, `(${content.length} chars)`)
    return `Fajl kreiran: ${path}`
  } catch (err) {
    console.error('[WC] Write failed:', path, err)
    throw err
  }
}

export async function readFile(path: string): Promise<string> {
  const wc = await getWebContainer()
  try {
    const content = await wc.fs.readFile(path, 'utf-8')
    return content
  } catch {
    return `Greška: fajl ${path} ne postoji`
  }
}

export async function listFiles(path: string = '.'): Promise<string[]> {
  const wc = await getWebContainer()
  try {
    const entries = await wc.fs.readdir(path, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const fullPath = path === '.' ? entry.name : `${path}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next' || entry.name === '.cache') continue
        files.push(fullPath + '/')
        const subFiles = await listFiles(fullPath)
        files.push(...subFiles)
      } else {
        files.push(fullPath)
      }
    }
    return files
  } catch {
    return []
  }
}

/** Clear all files from WebContainers filesystem (for new project) */
export async function clearFilesystem(): Promise<void> {
  const wc = await getWebContainer()
  try {
    const entries = await wc.fs.readdir('/', { withFileTypes: true })
    for (const entry of entries) {
      try {
        if (entry.isDirectory()) {
          await wc.fs.rm('/' + entry.name, { recursive: true })
        } else {
          await wc.fs.rm('/' + entry.name)
        }
      } catch { /* some system dirs can't be removed, that's fine */ }
    }
    // Reset dev server state
    serverUrl = null
    serverListenerAttached = false
    serverReadyCallbacks = []
    console.log('[WebContainer] Filesystem cleared')
  } catch (err) {
    console.warn('[WebContainer] Clear failed:', err)
  }
}

// Detect if command is a long-running dev server
const SERVER_PATTERNS = /\b(dev|start|serve|preview|watch)\b/i

export async function runCommand(cmd: string, args: string[]): Promise<string> {
  const wc = await getWebContainer()
  ensureServerListener(wc)

  const fullCmd = [cmd, ...args].join(' ')
  const isServer = SERVER_PATTERNS.test(fullCmd)
  const process = await wc.spawn(cmd, args)

  let output = ''
  const reader = process.output.getReader()

  if (isServer) {
    // Dev server: collect initial output for 8s then return, leave process running
    console.log('[WC] Starting dev server:', fullCmd)
    const startTime = Date.now()
    const INITIAL_WAIT = 8000

    try {
      while (Date.now() - startTime < INITIAL_WAIT) {
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>(r =>
            setTimeout(() => r({ done: true, value: undefined }), INITIAL_WAIT - (Date.now() - startTime))
          ),
        ])
        if (result.done) break
        if (result.value) output += result.value

        // If server URL detected in output, we can return early
        if (serverUrl || /localhost:\d+|ready in|compiled|Local:/.test(output)) {
          break
        }
      }
    } catch { /* stream may error on timeout race, that's fine */ }

    // Don't kill the process, don't await exit
    const url = serverUrl || 'starting...'
    return `Dev server pokrenut: ${url}\n\n${output.substring(0, 2000)}`
  }

  // Regular command: wait for completion with timeout
  // Build commands get longer timeout (90s) since Next.js/Vite builds can be slow in WebContainers
  const isBuild = /\b(build|generate|export)\b/i.test(fullCmd)
  const isInstall = /\b(install|ci)\b/i.test(fullCmd)
  const timeoutMs = isBuild ? 180000 : isInstall ? 90000 : 30000
  const timeout = setTimeout(() => {
    try { process.kill() } catch {}
  }, timeoutMs)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      output += value
    }
  } catch {}

  clearTimeout(timeout)
  const exitCode = await process.exit
  return output + (exitCode !== 0 ? `\n(exit code: ${exitCode})` : '')
}

export async function getAllFiles(): Promise<Record<string, string>> {
  const wc = await getWebContainer()
  const paths = await listFiles('.')
  const files: Record<string, string> = {}

  for (const p of paths) {
    if (p.endsWith('/')) continue
    try {
      files[p] = await wc.fs.readFile(p, 'utf-8')
    } catch (err) {
      console.warn('[WC] Failed to read:', p, err)
    }
  }

  console.log('[WC] getAllFiles:', Object.keys(files))
  return files
}
