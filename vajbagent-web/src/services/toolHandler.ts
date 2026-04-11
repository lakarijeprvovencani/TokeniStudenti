import { writeFile, readFile, listFiles, runCommand, getAllFiles } from './webcontainer'
import { parseToolCallArguments } from './toolArgsParse'

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

function getApiKey(): string {
  return localStorage.getItem('vajb_api_key') || ''
}

// Unsplash API key (same as extension)
const UNSPLASH_KEY = [103,48,114,106,97,103,121,90,65,68,65,55,79,100,87,104,73,98,102,100,103,108,50,95,122,112,73,99,107,50,120,98,113,48,83,89,116,76,100,89,69,122,107].map(c => String.fromCharCode(c)).join('')

interface ToolCall {
  id: string
  function: {
    name: string
    arguments: string
  }
}

interface ToolResult {
  tool_call_id: string
  role: 'tool'
  content: string
}

export async function executeToolCall(
  tc: ToolCall,
  onFileChange: (files: Record<string, string>) => void
): Promise<ToolResult> {
  const name = tc.function.name
  let args: Record<string, unknown> = {}
  let wasRecovered = false

  try {
    args = JSON.parse(tc.function.arguments)
  } catch {
    if (name === 'write_file') {
      const truncMsg = 'GRESKA: Sadrzaj fajla je presecen (JSON isecen). Fajl NIJE upisan. MORAS da razdvojis kod u vise manjih fajlova — svaki ispod 120 linija.'
      console.error('[Tool] write_file truncated JSON — rejected')
      return { tool_call_id: tc.id, role: 'tool', content: truncMsg }
    }

    const recovered = parseToolCallArguments(tc.function.arguments)
    if (recovered && Object.keys(recovered).length > 0) {
      args = recovered
      wasRecovered = true
      console.log(`[Tool] Recovered truncated args for ${name}: ${Object.keys(recovered).join(', ')}`)
    } else {
      console.error(`[Tool] Failed to parse args for ${name}:`, tc.function.arguments.substring(0, 200))
      return { tool_call_id: tc.id, role: 'tool', content: `Greska: neispravan JSON u argumentima za ${name}.` }
    }
  }

  if (wasRecovered && name === 'replace_in_file') {
    const recoveredContent = (args.new_text as string) || ''
    if (recoveredContent.length < 50) {
      return { tool_call_id: tc.id, role: 'tool', content: 'GRESKA: replace_in_file sadrzaj je presecen. Probaj sa manjom izmenom.' }
    }
  }

  try {
    switch (name) {
      case 'write_file': {
        const path = (args.path as string || '').replace(/^\/+/, '')
        let content = (args.content as string) || ''

        // Auto-patch: ensure vite.config has server.host = true for WebContainers
        if ((path === 'vite.config.ts' || path === 'vite.config.js') && !content.includes('host')) {
          if (content.includes('plugins:') && !content.includes('server:')) {
            // Add server config after plugins
            content = content.replace(
              /plugins:\s*\[([^\]]*)\]/,
              (match) => `${match},\n  server: { host: true }`
            )
          } else if (content.includes('server:') && !content.includes('host')) {
            // Add host to existing server config
            content = content.replace(
              /server:\s*\{/,
              'server: { host: true,'
            )
          }
          console.log('[Tool] Auto-patched vite.config with server.host = true')
        }

        const result = await writeFile(path, content)
        const allFiles = await getAllFiles()
        console.log('[Tool] write_file done:', path, '| total files:', Object.keys(allFiles).length)
        onFileChange(allFiles)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'read_file': {
        const path = (args.path as string || '').replace(/^\/+/, '')
        const content = await readFile(path)
        return { tool_call_id: tc.id, role: 'tool', content: content }
      }

      case 'list_files': {
        const path = (args.path as string || '.').replace(/^\/+/, '') || '.'
        const files = await listFiles(path)
        return { tool_call_id: tc.id, role: 'tool', content: files.join('\n') || 'Prazan folder' }
      }

      case 'replace_in_file': {
        const path = (args.path as string || '').replace(/^\/+/, '')
        const oldText = args.old_text as string || ''
        const newText = args.new_text as string || ''
        const content = await readFile(path)
        if (!content.includes(oldText)) {
          return { tool_call_id: tc.id, role: 'tool', content: `Tekst nije pronadjen u ${path}` }
        }
        const updated = content.replace(oldText, newText)
        await writeFile(path, updated)
        const allFiles = await getAllFiles()
        onFileChange(allFiles)
        return { tool_call_id: tc.id, role: 'tool', content: `Fajl azuriran: ${path}` }
      }

      case 'execute_command': {
        const command = args.command as string || ''
        const parts = command.split(' ')
        const result = await runCommand(parts[0], parts.slice(1))

        // After build commands, refresh files so dist/ appears in preview
        if (/\b(build|generate|export)\b/i.test(command)) {
          try {
            const allFiles = await getAllFiles()
            onFileChange(allFiles)
            console.log('[Tool] Post-build file refresh:', Object.keys(allFiles).filter(f => f.startsWith('dist/')).length, 'dist files')
          } catch (e) {
            console.warn('[Tool] Post-build file refresh failed:', e)
          }
        }

        return { tool_call_id: tc.id, role: 'tool', content: result.substring(0, 3000) }
      }

      case 'search_files': {
        const result = await handleSearchFiles(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'fetch_url': {
        const result = await handleFetchUrl(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'web_search': {
        const result = await handleWebSearch(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'search_images': {
        const result = await handleSearchImages(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'download_file': {
        const result = await handleDownloadFile(args, onFileChange)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      default:
        return { tool_call_id: tc.id, role: 'tool', content: `Alat ${name} nije podrzan u web verziji.` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { tool_call_id: tc.id, role: 'tool', content: `Greska: ${msg}` }
  }
}

// ─── search_files ────────────────────────────────────────────────────────────

async function handleSearchFiles(args: Record<string, unknown>): Promise<string> {
  const searchPath = ((args.path as string) || '.').replace(/^\/+/, '') || '.'
  const pattern = args.pattern as string || ''
  const fileGlob = args.file_glob as string || ''

  if (!pattern) return 'Greska: pattern je obavezan'

  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'g')
  } catch {
    return `Greska: neispravan regex pattern: ${pattern}`
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage'])
  const MAX_RESULTS = 100

  const allPaths = await listFiles(searchPath)
  const results: string[] = []

  // Convert glob to regex if provided
  let globRegex: RegExp | null = null
  if (fileGlob) {
    const globPattern = fileGlob.replace(/\./g, '\\.').replace(/\*/g, '.*')
    globRegex = new RegExp(globPattern + '$')
  }

  for (const filePath of allPaths) {
    if (results.length >= MAX_RESULTS) break
    if (filePath.endsWith('/')) continue

    // Skip ignored directories
    const parts = filePath.split('/')
    if (parts.some(p => SKIP_DIRS.has(p))) continue

    // Apply glob filter
    if (globRegex && !globRegex.test(filePath)) continue

    try {
      const content = await readFile(filePath)
      if (content.startsWith('Greska:')) continue

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_RESULTS) break
        regex.lastIndex = 0
        if (regex.test(lines[i])) {
          results.push(`${filePath}:${i + 1}: ${lines[i].trim().substring(0, 200)}`)
        }
      }
    } catch { /* skip unreadable files */ }
  }

  if (results.length === 0) return `No matches found for pattern: ${pattern}`
  return results.join('\n')
}

// ─── fetch_url ───────────────────────────────────────────────────────────────

async function handleFetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = args.url as string || ''
  const method = (args.method as string || 'GET').toUpperCase()
  const headers = args.headers as Record<string, string> || {}
  const body = args.body as string || undefined

  if (!url) return 'Greska: url je obavezan'

  // Block private/internal URLs
  if (/localhost|127\.0\.0\.1|::1|0\.0\.0\.0|\.local|169\.254\.|10\.\d|172\.(1[6-9]|2\d|3[01])\.|192\.168\./i.test(url)) {
    return 'Greska: pristup internim/privatnim adresama nije dozvoljen'
  }

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Accept': 'text/html,application/json,text/plain,*/*',
        ...headers,
      },
      body: method !== 'GET' ? body : undefined,
      signal: AbortSignal.timeout(15000),
    })

    const text = await res.text()
    const truncated = text.substring(0, 30000)
    return `HTTP ${res.status}\n\n${truncated}${text.length > 30000 ? '\n\n... (truncated)' : ''}`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
      return `Greska: ne mogu da pristupim URL-u (moguc CORS problem). URL: ${url}`
    }
    return `Greska: ${msg}`
  }
}

// ─── web_search ──────────────────────────────────────────────────────────────

async function handleWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = (args.query as string || '').trim()
  const maxResults = (args.max_results as number) || 5

  if (!query) return 'Greska: query je obavezan'

  try {
    const res = await fetch(`${API_URL}/v1/web-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        include_answer: true,
      }),
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) return `Greska: web search vratio ${res.status}`

    const data = await res.json()
    const parts: string[] = [`Search: "${data.query || query}"`]

    if (data.answer) {
      parts.push(`\n## Answer\n${data.answer}`)
    }

    if (data.results && data.results.length > 0) {
      parts.push(`\n## Results (${data.results.length})`)
      for (const r of data.results) {
        parts.push(`\n### ${r.title}\nURL: ${r.url}\n${(r.content || '').substring(0, 500)}`)
      }
    }

    return parts.join('\n').substring(0, 5000)
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── search_images (Unsplash) ────────────────────────────────────────────────

async function handleSearchImages(args: Record<string, unknown>): Promise<string> {
  const query = (args.query as string || '').trim()
  const count = Math.min(Math.max((args.count as number) || 5, 1), 10)
  const orientation = args.orientation as string || ''

  if (!query) return 'Greska: query je obavezan'

  try {
    let url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}`
    if (orientation) url += `&orientation=${orientation}`

    const res = await fetch(url, {
      headers: {
        'Authorization': `Client-ID ${UNSPLASH_KEY}`,
        'Accept-Version': 'v1',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (res.status === 403 || res.status === 429) {
      return 'Greska: Unsplash API rate limit dostignut (50 req/sat). Pokusaj ponovo za par minuta.'
    }

    if (!res.ok) return `Greska: Unsplash API vratio ${res.status}`

    const data = await res.json()
    if (!data.results || data.results.length === 0) {
      return `Nema rezultata za "${query}". Pokusaj sa drugacijim upitom na engleskom.`
    }

    const parts: string[] = [`Found ${data.results.length} image(s) for "${query}":\n`]

    for (let i = 0; i < data.results.length; i++) {
      const photo = data.results[i]
      const imgUrl = photo.urls?.regular || photo.urls?.small || ''
      const alt = photo.alt_description || photo.description || 'No description'
      const photographer = photo.user?.name || 'Unknown'
      const profileUrl = photo.user?.links?.html || ''

      parts.push(`${i + 1}. ${alt}`)
      parts.push(`   URL: ${imgUrl}`)
      parts.push(`   Credit: Photo by ${photographer} on Unsplash`)
      if (profileUrl) parts.push(`   Profile: ${profileUrl}?utm_source=vajbagent&utm_medium=referral`)
      parts.push('')

      // Fire download tracking (required by Unsplash API)
      if (photo.links?.download_location) {
        fetch(`${photo.links.download_location}?client_id=${UNSPLASH_KEY}`).catch(() => {})
      }
    }

    parts.push('IMPORTANT: In this browser environment, use the image URLs DIRECTLY in your HTML <img src="URL"> tags. Do NOT use download_file for images — WebContainers cannot store binary files. Always include Unsplash attribution.')
    return parts.join('\n')
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── download_file ───────────────────────────────────────────────────────────

async function handleDownloadFile(
  args: Record<string, unknown>,
  onFileChange: (files: Record<string, string>) => void
): Promise<string> {
  const url = args.url as string || ''
  const path = (args.path as string || '').replace(/^\/+/, '')

  if (!url || !path) return 'Greska: url i path su obavezni'

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 VajbAgent/1.0' },
      signal: AbortSignal.timeout(30000),
    })

    if (!res.ok) return `Download FAILED: HTTP ${res.status} from ${url}`

    const contentType = res.headers.get('content-type') || ''

    // For images/binary: WebContainers can't store binary files properly
    // Instead, tell the agent to use the URL directly in HTML
    if (contentType.startsWith('image/') || contentType.startsWith('font/') || contentType.startsWith('application/pdf')) {
      return `NAPOMENA: WebContainers ne podrzava binarne fajlove. Umesto download-a, koristi URL direktno u HTML-u:\n<img src="${url}" alt="..." loading="lazy">\n\nNE pokusavaj ponovo sa download_file za slike. Koristi URL direktno.`
    }

    // Text files: write normally
    const text = await res.text()
    const truncated = text.substring(0, 50000)
    await writeFile(path, truncated)

    const allFiles = await getAllFiles()
    onFileChange(allFiles)

    return `Downloaded OK: ${path}\nSize: ${truncated.length} chars | Type: ${contentType}\nURL: ${url}`
  } catch (err) {
    return `Download FAILED from: ${url}\nError: ${err instanceof Error ? err.message : String(err)}`
  }
}
