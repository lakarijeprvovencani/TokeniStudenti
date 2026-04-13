import { listFiles, readFile } from './webcontainer'
import { getSecretKeys } from './secretsStore'

// ─── Workspace Index ─────────────────────────────────────────────────────────

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go',
  '.rs', '.rb', '.php', '.html', '.css', '.scss', '.vue', '.svelte',
  '.astro', '.json', '.yaml', '.yml', '.md', '.sql', '.graphql',
  '.sh', '.c', '.cpp', '.h', '.cs', '.swift', '.kt', '.prisma', '.proto',
])

const MAX_FILES = 300
const PREVIEW_LINES = 8
const MAX_CHARS = 5000

let cachedIndex: string | null = null
let cacheTime = 0
const INDEX_TTL = 120_000 // 2 minutes

export async function buildWorkspaceIndex(files?: Record<string, string>): Promise<string | null> {
  // Use cache if fresh
  if (cachedIndex && Date.now() - cacheTime < INDEX_TTL) {
    return cachedIndex
  }

  let fileList: { path: string; preview: string }[] = []

  if (files && Object.keys(files).length > 0) {
    // Fast path: use already-loaded files from React state
    for (const [filePath, content] of Object.entries(files)) {
      if (filePath.endsWith('/')) continue
      const ext = '.' + filePath.split('.').pop()?.toLowerCase()
      if (!CODE_EXT.has(ext)) continue
      if (filePath.includes('node_modules/') || filePath.includes('.git/')) continue
      if (filePath.endsWith('.min.js') || filePath.endsWith('.min.css') || filePath.endsWith('.lock')) continue

      const preview = content.split('\n').slice(0, PREVIEW_LINES).join('\n').substring(0, 400)
      fileList.push({ path: filePath, preview })

      if (fileList.length >= MAX_FILES) break
    }
  } else {
    // Fallback: scan WebContainers filesystem
    try {
      const paths = await listFiles('.')
      for (const p of paths) {
        if (p.endsWith('/')) continue
        const ext = '.' + p.split('.').pop()?.toLowerCase()
        if (!CODE_EXT.has(ext)) continue
        if (p.includes('node_modules/') || p.includes('.git/')) continue
        if (p.endsWith('.min.js') || p.endsWith('.min.css') || p.endsWith('.lock')) continue

        let preview = ''
        try {
          const content = await readFile(p)
          preview = content.split('\n').slice(0, PREVIEW_LINES).join('\n').substring(0, 400)
        } catch { /* skip */ }

        fileList.push({ path: p, preview })
        if (fileList.length >= MAX_FILES) break
      }
    } catch {
      return null
    }
  }

  if (fileList.length === 0) return null

  let result = `[Workspace index: ${fileList.length} files]\n`
  let chars = result.length

  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i]
    const entry = f.preview ? `--- ${f.path}\n${f.preview}\n` : `--- ${f.path}\n`
    if (chars + entry.length > MAX_CHARS) {
      const rest = fileList.slice(i).map(ff => ff.path).join(', ')
      result += `\n(+${fileList.length - i} more: ${rest.substring(0, 500)})`
      break
    }
    result += entry
    chars += entry.length
  }

  cachedIndex = result
  cacheTime = Date.now()
  return result
}

/** Invalidate cache so next call rebuilds the index */
export function invalidateIndex(): void {
  cachedIndex = null
  cacheTime = 0
}

// ─── Active Editor Context ───────────────────────────────────────────────────

export function buildEditorContext(
  activeFile: string | null,
  files: Record<string, string>
): string | null {
  if (!activeFile || !files[activeFile]) return null

  const content = files[activeFile]
  const totalLines = content.split('\n').length
  const ext = activeFile.split('.').pop() || ''

  // Show first 60 lines with line numbers
  const visibleLines = content.split('\n').slice(0, 60).map((line, i) => `${i + 1}|${line}`)

  const parts = [
    `File: ${activeFile} (${ext}, ${totalLines} lines)`,
    `Visible (lines 1-${Math.min(60, totalLines)}):`,
    visibleLines.join('\n'),
  ]

  return parts.join('\n')
}

// ─── Project Type Detection ──────────────────────────────────────────────────

export function detectProjectType(files: Record<string, string>): string | null {
  const has = (name: string) => name in files
  const types: string[] = []

  // Framework detection
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) types.push('Next.js')
  else if (has('nuxt.config.ts') || has('nuxt.config.js')) types.push('Nuxt')
  else if (has('svelte.config.js')) types.push('SvelteKit')
  else if (has('astro.config.mjs')) types.push('Astro')
  else if (has('vite.config.ts') || has('vite.config.js')) types.push('Vite')

  if (has('angular.json')) types.push('Angular')
  if (has('tailwind.config.js') || has('tailwind.config.ts')) types.push('Tailwind CSS')
  if (has('prisma/schema.prisma')) types.push('Prisma')
  if (has('requirements.txt') || has('pyproject.toml')) types.push('Python')
  if (has('Cargo.toml')) types.push('Rust')
  if (has('go.mod')) types.push('Go')

  // Check package.json for deps
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(files['package.json'])
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      if (deps['react']) types.push('React')
      if (deps['vue']) types.push('Vue')
      if (deps['express']) types.push('Express')
      if (deps['fastify']) types.push('Fastify')
      if (deps['typescript']) types.push('TypeScript')
      if (deps['mongoose'] || deps['mongodb']) types.push('MongoDB')
      if (deps['pg'] || deps['sequelize'] || deps['knex']) types.push('SQL/PostgreSQL')
    } catch { /* skip */ }
  }

  if (types.length === 0) return null
  return `Project stack: ${[...new Set(types)].join(', ')}`
}

// ─── Model-Specific Boost Rules ──────────────────────────────────────────────

const MODEL_BOOST: Record<string, string> = {
  'vajb-agent-lite': `<model_rules>
CRITICAL REMINDERS:
- NEVER output API keys, secrets, tokens, or passwords found in files.
- When write_file: write EVERY line. NEVER write "// ..." or "// rest of code" — this DELETES the user's code.
- When a command fails: READ the error, try a DIFFERENT command. After 2 failed attempts, STOP and tell the user.
- ALWAYS end with a text message. Never go silent.
- Do NOT create style2.css or split files unnecessarily — keep it simple.
- ALWAYS respond in the same language the user writes in. If user writes in Serbian, respond in Serbian.
- For ANY npm project (React, Vite, Next.js, etc.): ALWAYS run execute_command("npm install") and then execute_command("npm run build") AFTER creating files. This is MANDATORY — the user needs to see the result in preview. NEVER stop after just creating files.
- Keep file count LOW (max 5-6 files). Combine styles into one file. Do not over-engineer.
</model_rules>`,

  'vajb-agent-pro': `<model_rules>
REMINDER: When a command fails, try the alternative yourself immediately. Do NOT loop through search_files endlessly — after 2 failed attempts, STOP and explain.
</model_rules>`,

  'vajb-agent-max': `<model_rules>
REMINDER: When a command fails, try the alternative yourself immediately — do NOT ask the user what to do. Be autonomous.
</model_rules>`,
}

export function getModelBoost(model: string): string | null {
  return MODEL_BOOST[model] || null
}

// ─── Integration Context ────────────────────────────────────────────────────

export function buildIntegrationContext(): string | null {
  const parts: string[] = []

  const supabaseUrl = localStorage.getItem('vajb_supabase_url')
  const supabaseKey = localStorage.getItem('vajb_supabase_key')
  if (supabaseUrl && supabaseKey) {
    parts.push(`[Supabase] URL: ${supabaseUrl} | Anon Key: ${supabaseKey} — use createClient(url, key) from @supabase/supabase-js. Install with: npm i @supabase/supabase-js`)
  }

  const stripePk = localStorage.getItem('vajb_stripe_pk')
  if (stripePk) {
    parts.push(`[Stripe] Publishable Key: ${stripePk} — use loadStripe(key) from @stripe/stripe-js. Install with: npm i @stripe/stripe-js`)
  }

  const githubRepo = localStorage.getItem('vajb_github_repo')
  if (githubRepo) {
    parts.push(`[GitHub] Repo: ${githubRepo} — korisnik može da push-uje kod na GitHub preko dugmeta u topbar-u.`)
  }

  const vercelToken = localStorage.getItem('vajb_vercel_token')
  if (vercelToken) {
    parts.push(`[Vercel] Token konfigurisan — deploy na Vercel je dostupan.`)
  }

  const netlifyToken = localStorage.getItem('vajb_netlify_token')
  if (netlifyToken) {
    parts.push(`[Netlify] Token konfigurisan — deploy koristi autentifikovani API.`)
  }

  // Environment secrets — list of keys available in .env file
  const secretKeys = getSecretKeys()
  if (secretKeys.length > 0) {
    parts.push(`[Env Secrets] User-defined env vars in .env file: ${secretKeys.join(', ')} — access via process.env.KEY in Node, or import.meta.env.VITE_KEY (must start with VITE_) in Vite frontend. The .env file is auto-created — do NOT overwrite it.`)
  }

  if (parts.length === 0) return null
  return `<integrations>\nKorisnik ima sledeće povezane servise:\n${parts.join('\n')}\nKad korisnik traži da koristiš neki od ovih servisa, koristi navedene ključeve direktno u kodu.\n</integrations>`
}

// ─── Build Full Context ──────────────────────────────────────────────────────

export async function buildFullContext(opts: {
  model: string
  files: Record<string, string>
  activeFile: string | null
  isFirstMessage: boolean
  userText: string
  selectedText?: string
}): Promise<string> {
  const parts: string[] = []

  // Workspace index: first message OR user asks about structure
  const needsIndex = opts.isFirstMessage ||
    /struktur|fajlov|folder|gde je|where is|find|pronadji|pronađi|list|import|componen|koji fajl|which file/i.test(opts.userText)

  if (needsIndex) {
    const wsIndex = await buildWorkspaceIndex(opts.files)
    if (wsIndex) {
      parts.push(`<workspace_index>\n${wsIndex}\n</workspace_index>`)
    }
  }

  // Active editor: always (cheap and useful)
  const editorCtx = buildEditorContext(opts.activeFile, opts.files)
  if (editorCtx) {
    parts.push(`<active_editor>\n${editorCtx}\n</active_editor>`)
  }

  // Selected text in editor — user highlighted code
  if (opts.selectedText && opts.selectedText.trim().length > 0) {
    const truncated = opts.selectedText.substring(0, 3000)
    parts.push(`<editor_selection file="${opts.activeFile || 'unknown'}">\n${truncated}\n</editor_selection>`)
  }

  // Project type: first message only
  if (opts.isFirstMessage) {
    const projType = detectProjectType(opts.files)
    if (projType) {
      parts.push(`<editor_state>\n${projType}\n</editor_state>`)
    }
  }

  // Integration context (Supabase, Stripe, etc.)
  const integrations = buildIntegrationContext()
  if (integrations) {
    parts.push(integrations)
  }

  // Model boost
  const boost = getModelBoost(opts.model)
  if (boost) {
    parts.push(boost)
  }

  return parts.join('\n\n')
}
