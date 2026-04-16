import { listFiles, readFile } from './webcontainer'
import { getSecretKeys } from './secretsStore'
import { scopedStorage } from './storageScope'

// ─── Workspace Index ─────────────────────────────────────────────────────────

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go',
  '.rs', '.rb', '.php', '.html', '.css', '.scss', '.vue', '.svelte',
  '.astro', '.json', '.yaml', '.yml', '.md', '.sql', '.graphql',
  '.sh', '.c', '.cpp', '.h', '.cs', '.swift', '.kt', '.prisma', '.proto',
])

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.avif'])

/**
 * Collect the user-uploaded images in the project so the agent can see them
 * in the system context and reference them in HTML/JSX instead of falling
 * back to Unsplash stock photos.
 */
function buildUserAssetSection(files: Record<string, string>): string | null {
  const assets: string[] = []
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('/')) continue
    const ext = '.' + (path.split('.').pop()?.toLowerCase() || '')
    if (!IMAGE_EXT.has(ext)) continue
    if (typeof content !== 'string' || !content.startsWith('data:')) continue
    assets.push(path)
    if (assets.length >= 40) break
  }
  if (assets.length === 0) return null
  const lines = [
    `[User uploaded images — ${assets.length} file(s) that the user dragged / pasted / picked into this project. ALWAYS prefer these over Unsplash stock photos when the user asks for "my photo", "njegovu/njenu sliku", "moju fotku", hero images, avatars, gallery items, or anything personal. Reference them as /<filename> in static HTML or /public/<filename>... wait, actually reference as the exact path shown below:]`,
  ]
  for (const a of assets) lines.push(`- ${a}`)
  return lines.join('\n')
}

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

  const fileList: { path: string; preview: string }[] = []

  // React state is the source of truth — if files is passed at all (even an
  // empty object on a brand-new project) trust it and DO NOT touch the
  // WebContainer filesystem. listFiles() awaits getWebContainer() which can
  // hang forever when the StackBlitz origin is blocked, and the hang happens
  // on the critical chat path so the user is stuck on "Razmišljam…".
  if (files !== undefined) {
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
    // No files prop at all — legacy path, scan the WebContainer fs but with
    // a short timeout so we never block the chat indefinitely.
    try {
      const paths = await Promise.race<string[]>([
        listFiles('.'),
        new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('listFiles timeout')), 3000)),
      ])
      for (const p of paths) {
        if (p.endsWith('/')) continue
        const ext = '.' + p.split('.').pop()?.toLowerCase()
        if (!CODE_EXT.has(ext)) continue
        if (p.includes('node_modules/') || p.includes('.git/')) continue
        if (p.endsWith('.min.js') || p.endsWith('.min.css') || p.endsWith('.lock')) continue

        let preview = ''
        try {
          const content = await Promise.race<string>([
            readFile(p),
            new Promise<string>((_, rej) => setTimeout(() => rej(new Error('readFile timeout')), 1500)),
          ])
          preview = content.split('\n').slice(0, PREVIEW_LINES).join('\n').substring(0, 400)
        } catch { /* skip */ }

        fileList.push({ path: p, preview })
        if (fileList.length >= MAX_FILES) break
      }
    } catch {
      return null
    }
  }

  // Append user-uploaded images section to the index so the agent always
  // knows they exist — even if it doesn't explicitly run list_files.
  const userAssets = files ? buildUserAssetSection(files) : null

  if (fileList.length === 0 && !userAssets) return null
  if (fileList.length === 0 && userAssets) {
    cachedIndex = userAssets
    cacheTime = Date.now()
    return userAssets
  }

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

  if (userAssets) {
    result += '\n\n' + userAssets
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

  const supabaseUrl = scopedStorage.get('vajb_supabase_url')
  const supabaseKey = scopedStorage.get('vajb_supabase_key')
  const supabaseProjectRef = scopedStorage.get('vajb_supabase_project_ref')
  const supabaseProjectName = scopedStorage.get('vajb_supabase_project_name')
  if (supabaseUrl && supabaseKey) {
    const projectInfo = supabaseProjectName ? ` (project: ${supabaseProjectName})` : ''
    parts.push(`[Supabase]${projectInfo} URL: ${supabaseUrl} | Anon Key: ${supabaseKey} — use createClient(url, key) from @supabase/supabase-js. Install with: npm i @supabase/supabase-js`)
  }
  if (supabaseProjectRef) {
    parts.push(`[Supabase Tools AVAILABLE — IMPORTANT]
The user has connected Supabase via OAuth. You have DIRECT LIVE database, auth, and edge function access. Use these tools INSTEAD of writing migration files or asking for SQL:

DATABASE:
- supabase_list_tables — list all tables in public schema
- supabase_describe_table(table) — get column details
- supabase_sql(query) — run ANY SQL: CREATE TABLE, INSERT, SELECT, UPDATE, DELETE, ALTER, CREATE POLICY, CREATE INDEX, etc. Also queries auth.users for user management.

AUTH:
- supabase_get_auth_config — read site URL, providers, signup, JWT settings
- supabase_update_auth_config(config) — enable Google/GitHub login, change site URL, etc.

EDGE FUNCTIONS:
- supabase_list_functions — list deployed Deno functions
- supabase_deploy_function(slug, body) — deploy serverless function
- supabase_delete_function(slug) — delete

WHEN USER ASKS:
- "koje tabele/fajlove imam u bazi" → IMMEDIATELY supabase_list_tables. NEVER say "nemam pristup".
- "koliko korisnika" → supabase_sql with "SELECT count(*) FROM auth.users"
- "dodaj tabelu X" → supabase_sql with CREATE TABLE
- "uključi Google login" → supabase_update_auth_config with EXTERNAL_GOOGLE_ENABLED
- "napravi edge funkciju za X" → supabase_deploy_function

YOU HAVE FULL DATABASE ACCESS. Never claim otherwise. Use the tools.`)
  }

  const stripePk = scopedStorage.get('vajb_stripe_pk')
  if (stripePk) {
    parts.push(`[Stripe] Publishable Key: ${stripePk} — use loadStripe(key) from @stripe/stripe-js. Install with: npm i @stripe/stripe-js`)
  }

  const githubRepo = scopedStorage.get('vajb_github_repo')
  if (githubRepo) {
    parts.push(`[GitHub] Repo: ${githubRepo} — korisnik može da push-uje kod na GitHub preko dugmeta u topbar-u.`)
  }

  const vercelToken = scopedStorage.get('vajb_vercel_token')
  if (vercelToken) {
    parts.push(`[Vercel] Token konfigurisan — deploy na Vercel je dostupan.`)
  }

  const netlifyToken = scopedStorage.get('vajb_netlify_token')
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

  // User-uploaded images section is sent on EVERY message, not just the
  // first, so the agent never forgets that the user has their own photos
  // in the project and can reference them in any turn of the conversation.
  const assets = buildUserAssetSection(opts.files)
  if (assets && !needsIndex) {
    // If we didn't push the full index this turn, surface the assets on
    // their own so the agent still sees them.
    parts.push(`<user_uploaded_images>\n${assets}\n</user_uploaded_images>`)
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

  // Build strategy — injected on first message of empty project.
  // Without this, model tries to write 45K-char mega-files that take
  // 3 minutes to generate and often get truncated. Data shows that
  // replace_in_file calls take 26-35s and ALWAYS succeed, while large
  // write_file calls take 67-181s and fail 50% of the time.
  const fileCount = Object.keys(opts.files).filter(f => !f.endsWith('/') && !f.includes('node_modules/')).length
  if (opts.isFirstMessage && fileCount <= 1) {
    parts.push(`<build_strategy>
MANDATORY BUILD APPROACH for new sites:
1. Search images first (1-2 search_images calls)
2. write_file a SKELETON index.html — basic structure with head, nav, hero, empty section placeholders, footer. Under 150 lines. Just the structure.
3. write_file style.css — core variables, reset, nav, hero, footer styles. Under 200 lines.
4. Use replace_in_file to ADD content section by section into index.html (services, team, testimonials, FAQ, etc.)
5. Use replace_in_file to ADD matching CSS for each new section into style.css
6. write_file script.js if needed

WHY: write_file with 500+ lines takes 3 minutes and often fails (output truncation). replace_in_file takes 30 seconds and always works. Build incrementally.
</build_strategy>`)
  }

  return parts.join('\n\n')
}
