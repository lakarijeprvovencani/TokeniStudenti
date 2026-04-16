import { writeFile, readFile, listFiles, runCommand, getAllFiles } from './webcontainer'
import { parseToolCallArguments } from './toolArgsParse'
import { scopedStorage } from './storageScope'
import * as ghInt from './githubIntegration'
import { filterForPush, scanForSecrets, redactSecrets, ensureGitignoreSafety, DEFAULT_GITIGNORE } from './pushFilter'

const API_URL = import.meta.env.VITE_API_URL || 'https://vajbagent.com'

function getApiKey(): string {
  return scopedStorage.get('vajb_api_key') || ''
}

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
    // JSON parse failed — try recovery via jsonrepair + manual regex extraction.
    // This handles truncated tool calls where the model tried to write too many
    // files in one response and the last one got cut off by max_tokens.
    const recovered = parseToolCallArguments(tc.function.arguments)
    if (recovered && Object.keys(recovered).length > 0) {
      args = recovered
      wasRecovered = true
      console.log(`[Tool] Recovered truncated args for ${name}: ${Object.keys(recovered).join(', ')}`)
    } else {
      console.error(`[Tool] Failed to parse args for ${name}:`, tc.function.arguments.substring(0, 200))
      const hint = name === 'write_file'
        ? 'Pisi JEDAN fajl po pozivu — pozovi write_file ponovo samo za ovaj fajl.'
        : ''
      return { tool_call_id: tc.id, role: 'tool', content: `Greska: neispravan JSON u argumentima za ${name}. ${hint}`.trim() }
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

        // Double-escape fix: konvertuj literal \\n → \n SAMO ako fajl
        // nema nijedan pravi newline (model je ceo fajl zbio u jednu liniju).
        // Ovaj konzervativan pristup (portovan iz vajbagent-vscode/src/tools.ts:499)
        // ne moze da slomi multi-line JS stringove jer cim ima bilo koji pravi
        // \n u fajlu, preskace konverziju u potpunosti.
        if (content.includes('\\n') && !content.includes('\n')) {
          content = content.replace(/\\n/g, '\n')
        }

        // Truncation detection — only for pure JS/TS/CSS/JSON files.
        // HTML check removed: models routinely write valid HTML that doesn't
        // end with </html> (e.g. partials, components, templates with trailing
        // scripts). The </html> check caused false rejections on 370-line
        // complete pages, forcing the model to rewrite them shorter.
        // Brace check also skips HTML because inline <script> tags make
        // brace counting unreliable.
        const lowerPath = path.toLowerCase()
        if (/\.(jsx?|tsx?|css|scss|vue|svelte|json)$/i.test(lowerPath) && content.length > 500) {
          // Broj zagrada izvan stringova/komentara — jednostavan state machine
          // koji preskace '...', "...", `...`, // line comment i /* block comment */.
          let opens = 0, closes = 0
          let i = 0
          const len = content.length
          while (i < len) {
            const ch = content[i]
            const next = content[i + 1]
            // Line comment
            if (ch === '/' && next === '/') {
              while (i < len && content[i] !== '\n') i++
              continue
            }
            // Block comment
            if (ch === '/' && next === '*') {
              i += 2
              while (i < len - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++
              i += 2
              continue
            }
            // String literal (single, double, backtick) — skip until matching quote
            if (ch === '"' || ch === "'" || ch === '`') {
              const quote = ch
              i++
              while (i < len) {
                if (content[i] === '\\') { i += 2; continue }
                if (content[i] === quote) { i++; break }
                i++
              }
              continue
            }
            if (ch === '{') opens++
            else if (ch === '}') closes++
            i++
          }
          if (opens - closes >= 2) {
            return {
              tool_call_id: tc.id,
              role: 'tool',
              content: `GRESKA: Kod u ${path} je presecen — ${opens} otvorenih { vs ${closes} zatvorenih }. Fajl NIJE upisan. Pozovi write_file PONOVO samo za ovaj fajl sa kompletnim sadrzajem.`,
            }
          }
        }

        // Protect user-uploaded binary assets — the agent must never
        // stomp on a real image the user dragged in, even if it gets
        // confused and tries to "write" over the path.
        const IMAGE_RE = /\.(jpg|jpeg|png|webp|gif|svg|avif)$/i
        if (IMAGE_RE.test(path)) {
          return {
            tool_call_id: tc.id,
            role: 'tool',
            content: `Ne možeš da prepišeš ${path} — to je korisnikova slika. Samo je referenciraj u HTML-u kao <img src="/${path.replace(/^public\//, '')}">.`,
          }
        }

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

        // Auto-patch: ensure next.config has output: 'export' + unoptimized images for WebContainers
        if (/^next\.config\.(js|mjs|ts)$/.test(path)) {
          if (!content.includes("output")) {
            if (content.includes('module.exports')) {
              content = content.replace(
                /module\.exports\s*=\s*\{/,
                "module.exports = {\n  output: 'export',"
              )
            } else if (content.includes('export default')) {
              content = content.replace(
                /export\s+default\s*\{/,
                "export default {\n  output: 'export',"
              )
            } else if (content.includes('nextConfig')) {
              content = content.replace(
                /const\s+nextConfig\s*=\s*\{/,
                "const nextConfig = {\n  output: 'export',"
              )
            }
            console.log('[Tool] Auto-patched next.config with output: export')
          }
          if (!content.includes("unoptimized")) {
            content = content.replace(
              /output:\s*['"]export['"]\s*,?/,
              "output: 'export',\n  images: { unoptimized: true },"
            )
            console.log('[Tool] Auto-patched next.config with images.unoptimized')
          }
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

        if (!oldText) {
          return { tool_call_id: tc.id, role: 'tool', content: 'GRESKA: old_text je prazan.' }
        }
        if (oldText === newText) {
          return { tool_call_id: tc.id, role: 'tool', content: 'Nema izmena: old_text i new_text su identicni.' }
        }

        const content = await readFile(path)
        if (content.startsWith('Greska:')) {
          return { tool_call_id: tc.id, role: 'tool', content }
        }

        let matchedOldText = oldText
        let matchCount = 0
        let usedFuzzy = false

        if (content.includes(oldText)) {
          // Exact match path — count occurrences to detect ambiguity.
          let idx = 0
          while ((idx = content.indexOf(oldText, idx)) !== -1) {
            matchCount++
            idx += oldText.length
          }
        } else {
          // Fuzzy fallback: trim trailing whitespace per line and retry.
          // Ported from vajbagent-vscode/src/tools.ts:598-619.
          const contentLines = content.split('\n')
          const oldLines = oldText.split('\n')
          const normContent = contentLines.map(l => l.trimEnd())
          const normOld = oldLines.map(l => l.trimEnd())

          let firstMatchStart = -1
          for (let i = 0; i <= normContent.length - normOld.length; i++) {
            let found = true
            for (let j = 0; j < normOld.length; j++) {
              if (normContent[i + j] !== normOld[j]) { found = false; break }
            }
            if (found) {
              if (firstMatchStart < 0) firstMatchStart = i
              matchCount++
            }
          }

          if (firstMatchStart < 0) {
            return {
              tool_call_id: tc.id,
              role: 'tool',
              content: `Tekst nije pronadjen u ${path}. Proveri da li old_text tacno odgovara sadrzaju fajla (whitespace, indentacija, navodnici). Procitaj fajl ponovo sa read_file da vidis tacan sadrzaj.`,
            }
          }

          // Use original lines (with real whitespace) so replacement preserves indentation.
          matchedOldText = contentLines.slice(firstMatchStart, firstMatchStart + oldLines.length).join('\n')
          usedFuzzy = true
        }

        if (matchCount > 1) {
          return {
            tool_call_id: tc.id,
            role: 'tool',
            content: `GRESKA: old_text se pojavljuje ${matchCount} puta u ${path}. Prosiri old_text sa vise konteksta (nekoliko okolnih linija) da bude jedinstven, pa probaj ponovo. Ovo sprecava zamenu pogresne instance.`,
          }
        }

        const updated = content.replace(matchedOldText, newText)
        await writeFile(path, updated)
        const allFiles = await getAllFiles()
        onFileChange(allFiles)
        const fuzzyNote = usedFuzzy ? ' (fuzzy match — whitespace razlika ignorisana)' : ''
        return { tool_call_id: tc.id, role: 'tool', content: `Fajl azuriran: ${path}${fuzzyNote}` }
      }

      case 'execute_command': {
        const command = args.command as string || ''
        const parts = command.split(' ')
        const result = await runCommand(parts[0], parts.slice(1))

        // After build commands, refresh files so dist/ or out/ appears in preview
        const isBuild = /\b(build|generate|export)\b/i.test(command)
        if (isBuild) {
          try {
            const allFiles = await getAllFiles()
            onFileChange(allFiles)
            const distCount = Object.keys(allFiles).filter(f => f.startsWith('dist/') || f.startsWith('out/')).length
            console.log('[Tool] Post-build file refresh:', distCount, 'build output files')
          } catch (e) {
            console.warn('[Tool] Post-build file refresh failed:', e)
          }
        }

        // Detect build/install failures and add a fix instruction for the agent
        const trimmedResult = result.substring(0, 3000)
        const failurePatterns = /(error|failed|missing|cannot find|not found|exit code: [1-9]|Module not found|SyntaxError|TypeError|ReferenceError|EACCES|ENOENT|MODULE_NOT_FOUND|Cannot resolve|Unexpected token|ENOTFOUND)/i
        const isFailure = failurePatterns.test(trimmedResult) && (isBuild || /\b(install|test|start|dev)\b/i.test(command))

        if (isFailure) {
          const hint = `\n\n[BUILD FAILED] The command exited with errors. READ the error message above carefully, identify the root cause (missing import, syntax error, missing dependency, wrong file path, etc.), FIX it using write_file or replace_in_file, then run the command AGAIN. Do NOT stop. Do NOT ask the user. Fix it yourself and retry. If the same error happens 3 times in a row, then explain to the user what's wrong.`
          return { tool_call_id: tc.id, role: 'tool', content: trimmedResult + hint }
        }

        return { tool_call_id: tc.id, role: 'tool', content: trimmedResult }
      }

      case 'search_files': {
        const result = await handleSearchFiles(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_list_tables': {
        const result = await handleSupabaseListTables()
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_describe_table': {
        const result = await handleSupabaseDescribe(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_sql': {
        const result = await handleSupabaseSql(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_get_auth_config': {
        const result = await handleSupabaseGetAuthConfig()
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_update_auth_config': {
        const result = await handleSupabaseUpdateAuthConfig(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_list_functions': {
        const result = await handleSupabaseListFunctions()
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_deploy_function': {
        const result = await handleSupabaseDeployFunction(args)
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'supabase_delete_function': {
        const result = await handleSupabaseDeleteFunction(args)
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

      case 'git_status': {
        const result = await handleGitStatus()
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'git_list_repos': {
        const result = await handleGitListRepos()
        return { tool_call_id: tc.id, role: 'tool', content: result }
      }

      case 'git_push': {
        const result = await handleGitPush(args)
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
    // Route through backend so the Unsplash key never ships in the client bundle.
    const res = await fetch(`${API_URL}/v1/image-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({ query, count, orientation }),
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    })

    if (res.status === 429) return 'Greska: rate limit dostignut. Pokusaj ponovo za par minuta.'
    if (!res.ok) return `Greska: image search vratio ${res.status}`

    const data = await res.json()
    if (!data.results || data.results.length === 0) {
      return `Nema rezultata za "${query}". Pokusaj sa drugacijim upitom na engleskom.`
    }

    const parts: string[] = [`Found ${data.results.length} image(s) for "${query}":\n`]
    for (let i = 0; i < data.results.length; i++) {
      const photo = data.results[i]
      parts.push(`${i + 1}. ${photo.alt || 'No description'}`)
      parts.push(`   URL: ${photo.url}`)
      parts.push(`   Credit: Photo by ${photo.photographer} on Unsplash`)
      if (photo.profile) parts.push(`   Profile: ${photo.profile}?utm_source=vajbagent&utm_medium=referral`)
      parts.push('')
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

// ─── Supabase tools ──────────────────────────────────────────────────────────

function getSupabaseProjectRef(): string | null {
  return scopedStorage.get('vajb_supabase_project_ref')
}

async function callSupabaseApi(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
}

async function handleSupabaseListTables(): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) {
    return 'GRESKA: Nema povezanog Supabase projekta. Korisnik treba da ide u Settings → Integracije → Supabase → "Poveži Supabase" i izabere projekat pre nego što agent može da koristi bazu.'
  }
  try {
    const res = await callSupabaseApi(`/api/supabase/tables/${projectRef}`)
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return `Supabase list_tables failed: HTTP ${res.status} ${txt.substring(0, 500)}`
    }
    const data = await res.json()
    const tables = data.tables
    if (!Array.isArray(tables) || tables.length === 0) {
      return 'Baza je prazna — nema tabela u public schemi. Koristi supabase_sql sa CREATE TABLE da napraviš nove tabele.'
    }
    const lines = ['Tabele u Supabase bazi (public schema):']
    for (const t of tables) {
      lines.push(`- ${t.table_name} (${t.column_count} kolona)`)
    }
    lines.push('\nKoristi supabase_describe_table da vidiš kolone neke tabele.')
    return lines.join('\n')
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseDescribe(args: Record<string, unknown>): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) return 'GRESKA: Nema povezanog Supabase projekta.'
  const table = (args.table as string || '').trim()
  if (!table) return 'GRESKA: "table" parametar je obavezan'

  try {
    const res = await callSupabaseApi(`/api/supabase/describe/${projectRef}/${encodeURIComponent(table)}`)
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return `Supabase describe failed: HTTP ${res.status} ${txt.substring(0, 500)}`
    }
    const data = await res.json()
    const columns = data.columns
    if (!Array.isArray(columns) || columns.length === 0) {
      return `Tabela "${table}" nema kolona ili ne postoji.`
    }
    const lines = [`Tabela: ${table}`, '']
    for (const c of columns) {
      const nullable = c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'
      const def = c.column_default ? ` DEFAULT ${c.column_default}` : ''
      lines.push(`- ${c.column_name}: ${c.data_type} ${nullable}${def}`)
    }
    return lines.join('\n')
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseSql(args: Record<string, unknown>): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) {
    return 'GRESKA: Nema povezanog Supabase projekta. Korisnik treba da ide u Settings → Integracije → Supabase → "Poveži Supabase" i izabere projekat.'
  }
  const query = (args.query as string || '').trim()
  if (!query) return 'GRESKA: "query" parametar je obavezan'

  try {
    const res = await callSupabaseApi('/api/supabase/sql', {
      method: 'POST',
      body: JSON.stringify({ projectRef, query }),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      let errMsg = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(txt)
        errMsg = parsed.error || errMsg
      } catch { errMsg = txt.substring(0, 500) || errMsg }
      return `Supabase SQL failed: ${errMsg}\n\nQuery was:\n${query.substring(0, 500)}`
    }
    const data = await res.json()
    const result = data.result

    // Format result for agent
    if (Array.isArray(result)) {
      if (result.length === 0) return 'Query executed successfully. 0 rows returned.'
      const preview = result.slice(0, 20)
      const json = JSON.stringify(preview, null, 2).substring(0, 2500)
      return `Query executed. Returned ${result.length} row(s)${result.length > 20 ? ' (showing first 20)' : ''}:\n${json}`
    }
    return `Query executed successfully.\n${JSON.stringify(result).substring(0, 1500)}`
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseGetAuthConfig(): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) return 'GRESKA: Nema povezanog Supabase projekta.'
  try {
    const res = await callSupabaseApi(`/api/supabase/auth-config/${projectRef}`)
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return `Get auth config failed: HTTP ${res.status} ${txt.substring(0, 500)}`
    }
    const data = await res.json()
    const cfg = data.config || {}
    // Show only the most important fields to keep context small
    const important: Record<string, unknown> = {
      SITE_URL: cfg.SITE_URL,
      URI_ALLOW_LIST: cfg.URI_ALLOW_LIST,
      DISABLE_SIGNUP: cfg.DISABLE_SIGNUP,
      MAILER_AUTOCONFIRM: cfg.MAILER_AUTOCONFIRM,
      EXTERNAL_EMAIL_ENABLED: cfg.EXTERNAL_EMAIL_ENABLED,
      EXTERNAL_GOOGLE_ENABLED: cfg.EXTERNAL_GOOGLE_ENABLED,
      EXTERNAL_GITHUB_ENABLED: cfg.EXTERNAL_GITHUB_ENABLED,
      EXTERNAL_FACEBOOK_ENABLED: cfg.EXTERNAL_FACEBOOK_ENABLED,
      EXTERNAL_APPLE_ENABLED: cfg.EXTERNAL_APPLE_ENABLED,
      JWT_EXP: cfg.JWT_EXP,
      PASSWORD_MIN_LENGTH: cfg.PASSWORD_MIN_LENGTH,
      MAILER_OTP_EXP: cfg.MAILER_OTP_EXP,
      SMTP_HOST: cfg.SMTP_HOST ? '(custom SMTP set)' : '(default Supabase mailer)',
    }
    return `Supabase Auth Configuration:\n${JSON.stringify(important, null, 2)}\n\nFull config has more fields — ask via supabase_update_auth_config to change any field.`
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseListFunctions(): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) return 'GRESKA: Nema povezanog Supabase projekta.'
  try {
    const res = await callSupabaseApi(`/api/supabase/functions/${projectRef}`)
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return `List functions failed: HTTP ${res.status} ${txt.substring(0, 500)}`
    }
    const data = await res.json()
    const fns = data.functions
    if (!Array.isArray(fns) || fns.length === 0) {
      return 'Nema deploy-ovanih edge funkcija. Koristi supabase_deploy_function da napraviš novu.'
    }
    const lines = ['Edge funkcije u projektu:']
    for (const f of fns) {
      const status = f.status || 'unknown'
      const ver = f.version ? ` v${f.version}` : ''
      lines.push(`- ${f.slug}${ver} [${status}]${f.name && f.name !== f.slug ? ` — ${f.name}` : ''}`)
    }
    lines.push('\nFunkcije su dostupne na: https://<project>.supabase.co/functions/v1/<slug>')
    return lines.join('\n')
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseDeployFunction(args: Record<string, unknown>): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) return 'GRESKA: Nema povezanog Supabase projekta.'
  const slug = (args.slug as string || '').trim()
  const body = (args.body as string || '').trim()
  const name = (args.name as string || '').trim() || slug
  const verify_jwt = args.verify_jwt !== false

  if (!slug) return 'GRESKA: "slug" je obavezan'
  if (!body) return 'GRESKA: "body" je obavezan (kod funkcije)'
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(slug)) {
    return 'GRESKA: slug mora biti lowercase, brojevi, crtica/underscore (npr. "hello-world")'
  }

  try {
    const res = await callSupabaseApi(`/api/supabase/functions/${projectRef}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ slug, name, body, verify_jwt }),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      let errMsg = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(txt)
        errMsg = parsed.error || errMsg
      } catch { errMsg = txt.substring(0, 500) || errMsg }
      return `Deploy function failed: ${errMsg}`
    }
    return `Edge function "${slug}" uspešno deploy-ovana!\nDostupna na: https://${projectRef}.supabase.co/functions/v1/${slug}\nJWT auth: ${verify_jwt ? 'ON' : 'OFF (public endpoint)'}`
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseDeleteFunction(args: Record<string, unknown>): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) return 'GRESKA: Nema povezanog Supabase projekta.'
  const slug = (args.slug as string || '').trim()
  if (!slug) return 'GRESKA: "slug" je obavezan'
  try {
    const res = await callSupabaseApi(`/api/supabase/functions/${projectRef}/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return `Delete function failed: HTTP ${res.status} ${txt.substring(0, 500)}`
    }
    return `Edge function "${slug}" obrisana.`
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleSupabaseUpdateAuthConfig(args: Record<string, unknown>): Promise<string> {
  const projectRef = getSupabaseProjectRef()
  if (!projectRef) return 'GRESKA: Nema povezanog Supabase projekta.'
  const config = args.config as Record<string, unknown>
  if (!config || typeof config !== 'object') {
    return 'GRESKA: "config" parametar mora biti objekat sa poljima koje hoces da promenis.'
  }
  try {
    const res = await callSupabaseApi(`/api/supabase/auth-config/${projectRef}`, {
      method: 'PATCH',
      body: JSON.stringify(config),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      let errMsg = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(txt)
        errMsg = parsed.error || errMsg
      } catch { errMsg = txt.substring(0, 500) || errMsg }
      return `Update auth config failed: ${errMsg}`
    }
    const updated = Object.keys(config).join(', ')
    return `Auth config updated successfully. Changed: ${updated}`
  } catch (err) {
    return `Greska: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── Git tools ───────────────────────────────────────────────────────────────
//
// Reuses the same backend push flow as the "Objavi na GitHub" button in the UI:
// filters secrets, patches .gitignore, redacts hardcoded keys. The agent cannot
// bypass any of these safeguards — they run unconditionally.

async function handleGitStatus(): Promise<string> {
  try {
    const status = await ghInt.getStatus()
    if (!status.configured) {
      return 'GRESKA: GitHub integracija nije konfigurisana na backendu. Javi korisniku da proveri Settings.'
    }
    if (!status.connected) {
      return 'GitHub nije povezan. Javi korisniku da ide u Settings → Integracije → GitHub → "Poveži GitHub" pre nego sto pokusas git_push.'
    }
    const user = status.info?.username || '(nepoznat)'
    return `GitHub je povezan. Username: ${user}. Mozes da koristis git_list_repos i git_push.`
  } catch (err) {
    return `Greska pri proveri GitHub statusa: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleGitListRepos(): Promise<string> {
  try {
    const repos = await ghInt.listRepos()
    if (!repos || repos.length === 0) {
      return 'Korisnik nema nijedan GitHub repozitorijum jos — git_push sa create_if_missing:true ce kreirati novi.'
    }
    const lines = [`GitHub repozitorijumi (${repos.length}):`]
    for (const r of repos.slice(0, 30)) {
      const priv = r.private ? '[private]' : '[public]'
      lines.push(`- ${r.name} ${priv} (branch: ${r.default_branch})`)
    }
    if (repos.length > 30) lines.push(`... i jos ${repos.length - 30} repoa`)
    return lines.join('\n')
  } catch (err) {
    return `Greska pri listanju repoa: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handleGitPush(args: Record<string, unknown>): Promise<string> {
  const repo = ((args.repo as string) || '').trim()
  const message = ((args.message as string) || '').trim() || 'Update from VajbAgent'
  const createIfMissing = args.create_if_missing !== false

  if (!repo) return 'GRESKA: "repo" parametar je obavezan (ime repozitorijuma).'
  if (repo.includes('/')) {
    return 'GRESKA: "repo" mora biti samo ime (npr. "moj-sajt"), bez owner/ prefixa — korisnikov username se automatski koristi.'
  }

  // Preflight: mora biti povezan
  try {
    const status = await ghInt.getStatus()
    if (!status.connected) {
      return 'GRESKA: GitHub nije povezan. Javi korisniku da ide u Settings → Integracije → GitHub → "Poveži GitHub".'
    }
  } catch (err) {
    return `Greska pri proveri GitHub statusa: ${err instanceof Error ? err.message : String(err)}`
  }

  // Pokupi live stanje fajlova iz WebContainer-a
  let allFiles: Record<string, string>
  try {
    allFiles = await getAllFiles()
  } catch (err) {
    return `Greska pri citanju fajlova: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!allFiles || Object.keys(allFiles).length === 0) {
    return 'GRESKA: Nema fajlova za push. Prvo kreiraj sadrzaj projekta.'
  }

  // Isti security filter kao UI push
  const { kept, skipped } = filterForPush(allFiles)
  const secretSkips = skipped.filter(s => s.reason === 'secret').map(s => s.path)
  const buildSkips = skipped.filter(s => s.reason === 'build').length

  // Patch/create .gitignore sa safe defaults
  const existingGitignore = kept['.gitignore']
  const patched = ensureGitignoreSafety(existingGitignore)
  if (patched !== null) {
    kept['.gitignore'] = patched
  } else if (!existingGitignore) {
    kept['.gitignore'] = DEFAULT_GITIGNORE
  }

  // Auto-redact hardcoded secrete u sadrzaju fajlova (API key-evi, tokeni)
  const findings = scanForSecrets(kept)
  let redactNote = ''
  if (findings.length > 0) {
    const redacted = redactSecrets(kept)
    Object.assign(kept, redacted)
    redactNote = ` · Auto-redact-ovano ${findings.length} hardcoded secret-a`
  }

  if (Object.keys(kept).length === 0) {
    return 'GRESKA: Posle filtriranja nema fajlova za push (sve je bilo u skip liste).'
  }

  try {
    const result = await ghInt.pushFiles({
      repo,
      files: kept,
      message,
      createIfMissing,
    })
    const parts = [
      `Push uspesan na ${result.owner}/${result.repo}@${result.branch}`,
      `Fajlova: ${result.files_count}`,
      `Commit: ${result.commit_sha.substring(0, 7)}`,
      `URL: ${result.url}`,
    ]
    if (secretSkips.length > 0) parts.push(`Preskoceno (secrets): ${secretSkips.join(', ')}`)
    if (buildSkips > 0) parts.push(`Preskoceno (build/deps): ${buildSkips} fajlova`)
    if (redactNote) parts.push(redactNote.trim().replace(/^· /, ''))
    return parts.join('\n')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Git push failed: ${msg}`
  }
}
