# TokeniStudenti — Project Context

## Overview
OpenAI-compatible API proxy server that routes requests to multiple AI providers (OpenAI, Anthropic).
Designed for a student mentoring platform where students get AI coding assistance with per-user billing.
The primary product is the **VajbAgent VS Code Extension** — works in VS Code, Cursor (including free tier), and any VS Code fork.

## Architecture
- **Runtime:** Node.js 18+, ES modules
- **Framework:** Express.js
- **Storage:** Upstash Redis (sessions, balances, usage, OAuth tokens, **project metadata + text files + chat history**)
- **Binary Storage:** Cloudflare R2 (images, video — presigned upload from browser, backend serves signed URLs)
- **Providers:** OpenAI (GPT-5 family) and Anthropic (Claude Sonnet/Opus)
- **Deployment:** Backend on Render (vajbagent.com), Web extension on Netlify (vajbagent.netlify.app)
- **Clients:** VajbAgent VS Code Extension (`vajbagent-vscode/`), VajbAgent Web Extension (`vajbagent-web/`)

## Key Files

### Backend (`src/`)
- `src/index.js` — Main server, API routes, model routing, streaming, admin dashboard, **project CRUD endpoints** (`/api/projects/*`), **R2 upload sign/commit endpoints**
- `src/auth.js` — Student API key authentication middleware, session management (Redis-backed)
- `src/balance.js` — Per-student balance tracking, cost calculation, pricing per model
- `src/convert.js` — OpenAI ↔ Anthropic message format conversion, context trimming, `MODEL_INPUT_LIMITS`
- `src/students.js` — Student CRUD, API key management, registration
- `src/usage.js` — Usage logging and analytics
- `src/utils.js` — Shared utilities (IP normalization, whitelist)
- `src/redis.js` — Redis connection and helpers
- `src/r2.js` — **Cloudflare R2 wrapper** (S3-compatible): putObject, deleteObject, deletePrefix, headObject, getSignedUploadUrl, publicUrl
- `src/projectStore.js` — **Redis-backed project CRUD**: listProjects, loadProject, saveProject, deleteProject (with R2 cascade cleanup)
- `src/netlifyOAuth.js` — Netlify OAuth + deploy (handles data URLs **and R2 URLs** — fetches binary from R2 before sending to Netlify)
- `src/githubOAuth.js` — GitHub OAuth + push (same R2 URL handling as Netlify)
- `src/supabaseOAuth.js` — Supabase OAuth integration (independent from project storage)

### Frontend
- `public/index.html` — Landing page (extension-first messaging, comparison with Cursor/Cline)
- `public/admin.html` — Admin dashboard (student management, balance, usage stats)
- `public/dashboard.html` — Student panel (API key, setup instructions, usage)

### Extension (`vajbagent-vscode/`)
- `src/extension.ts` — Entry point, command registration
- `src/agent.ts` — Core agent loop, conversation history, API calls, system prompt, context estimation
- `src/webview.ts` — Webview provider, message handling between UI and agent
- `src/settings.ts` — API key (SecretStorage), API URL, model selection, auto-approve settings
- `src/tools.ts` — Tool implementations (read/write/search files, execute commands, fetch URLs, web search, diff preview)
- `src/mcp.ts` — MCP client (stdio transport, JSON-RPC protocol, tool discovery, server lifecycle)
- `media/chat.html` — Full chat UI (markdown rendering, tool blocks, settings panel, MCP status, history, welcome screen)
- `media/vajb-logo.png` — Branding logo
- `vajbagent-X.Y.Z.vsix` — Packaged extension for install (always lives in `vajbagent-vscode/`)

### Web Extension (`vajbagent-web/`)
Browser-based AI code editor (like Bolt.new). React + Vite + WebContainers.

**Core files:**
- `src/App.tsx` — Root component: auth check, auto-resume last project (remote → local fallback), migration banner for IndexedDB→cloud
- `src/components/Welcome.tsx` — Landing page: prompt input, image attach, model selector, templates, project list (remote → local fallback)
- `src/components/IDELayout.tsx` — Main IDE: file explorer, code editor, chat panel, preview, terminal. **Autosave** (debounced 5s) uploads images/video to R2, saves project to backend (Redis), then IndexedDB as fallback. Persists `deployUrl` and `nlSiteId` in project data.
- `src/components/ChatPanel.tsx` — Chat with AI agent: streaming, tool calls, image attach (multimodal), code blocks
- `src/components/PreviewPanel.tsx` — Iframe preview: dev server URL (WebContainers) or static blob HTML. **Inlines image/video** refs (data URLs + R2 URLs) into blob preview HTML.
- `src/components/CodeEditor.tsx` — Monaco-based code editor
- `src/components/FileExplorer.tsx` — File tree with image thumbnails, drag & drop, paste for images **and video** (mp4/webm)
- `src/components/Terminal.tsx` — Terminal connected to WebContainers shell

**Services:**
- `src/services/remoteProjectStore.ts` — **API client** for backend project CRUD (matches IndexedDB store interface). Handles: listProjects, loadProject, saveProject, deleteProject, signUpload, commitUpload.
- `src/services/projectStore.ts` — **IndexedDB** project storage (offline fallback, per-user scoped). `SavedProject` interface includes: files, chatHistory, displayMessages, model, prompt, deployUrl, nlSiteId.
- `src/services/userAssets.ts` — **Media upload pipeline** (images + video):
  - Images: resize via canvas → data URL → write to WebContainer → autosave uploads to R2
  - Video: no resize (15MB limit, max 3 per project) → data URL → write to WC → autosave uploads to R2
  - `hydrateImagesIntoWc()`: on resume, fetches images/video from R2 URLs (or decodes data URLs) and writes binary into WebContainer
  - `uploadAllImagesToR2()`: batch-uploads all data-URL media entries to R2 via presigned URLs
- `src/services/webcontainer.ts` — WebContainer boot, filesystem operations, dev server management
- `src/services/netlifyIntegration.ts` — Frontend Netlify OAuth flow (communicates with backend `/api/netlify/*`)
- `src/services/githubIntegration.ts` — Frontend GitHub OAuth flow
- `src/services/storageScope.ts` — Per-user storage isolation (scopes IndexedDB + localStorage by userId)
- `src/services/deploy.ts` — Legacy client-side deploy helpers (ZIP-based); main path uses backend OAuth deploy
- `src/systemPrompt.ts` — Agent system prompt (Serbian, tool definitions)
- `src/tools.ts` — Tool definitions for the agent
- `src/services/toolHandler.ts` — Executes tool calls from the agent in WebContainers

### Docs
- `docs/ADDING_MODELS.md` — Guide for adding/changing model tiers (backend + extension)

## Model System
7 model tiers mapped to backend providers:

| Tier | Backend Model | Context Window | Max Output | Reasoning | Notes |
|------|--------------|---------------|------------|-----------|-------|
| Lite | GPT-5 Mini | 400K | 128K | Yes (`reasoning_effort`) | Cheapest, fast |
| Turbo | Claude Haiku 4.5 | 200K | 64K | No | Fast, cheap Anthropic tool-caller |
| Pro | GPT-5 | 400K | 128K | Yes (`reasoning_effort`) | Strong generalist |
| Max | Claude Sonnet 4.6 | 1M | 64K | No | **Default on web** — best balance |
| Power | GPT-5.4 | 1.05M | 128K | Yes (`reasoning_effort`) | Flagship OpenAI |
| Ultra | Claude Opus 4.6 | 1M | 128K | No | Premium Anthropic |
| Architect | Claude Opus 4.6 | 1M | 128K | No | Opus + architect system prompt |

Students select tier in extension UI; backend resolves to real provider model.
Web extension default is **Max (Sonnet 4.6)** as of April 2026. VS Code extension default is still Turbo.

## Billing
- Students have USD balances topped up via admin or Stripe
- Each API call: estimate tokens → calculate cost (with 1.25x markup) → deduct balance → log usage
- Pricing per million tokens (input/output) defined in `src/balance.js`
- Verified against official OpenAI and Anthropic pricing (March 2026)

## Admin
- `/admin/*` routes — protected by ADMIN_SECRET env var
- Dashboard: student management, balance top-ups, usage analytics, model stats, profit tracking
- Self-registration endpoint for students with anti-abuse (IP limiting)

## API
- `POST /v1/chat/completions` — Main endpoint (OpenAI-compatible)
- `POST /v1/web-search` — Web search endpoint (Tavily API), used by agent's `web_search` tool
- Supports: streaming (SSE), tool/function calling, vision (images)
- Context trimming: automatically trims conversation to fit model limits (`MODEL_INPUT_LIMITS` in `src/convert.js`)

## VS Code Extension Features
- **Chat UI** with streaming markdown (tables, code blocks, headings, lists, blockquotes)
- **8 agent tools:** `read_file`, `write_file`, `replace_in_file`, `list_files`, `search_files`, `execute_command`, `fetch_url`, `web_search`
- **Inline diff preview** with accept/reject buttons for file changes
- **Inline command approval** with run/reject buttons
- **Auto-approve settings** per tool type (write, replace, execute)
- **Settings panel** with API key input, API URL config, auto-approve toggles
- **Chat history** — persistent sessions, browse/load/delete past chats
- **Context token bar** — real-time token usage indicator per model limit
- **Model selector** in footer dropdown (Lite/Turbo/Pro/Max/Power/Ultra/Architect)
- **Image support** — paste or file picker for vision-capable models
- **Welcome screen** with branding on empty chat
- **System prompt** with anti-hallucination rules, explore-before-edit strategy, identity protection
- **MCP Support** — connect external MCP servers (stdio transport), auto-discover tools, agent can invoke them
  - Configure via `vajbagent.mcpServers` in VS Code Settings
  - Status visible in settings panel with restart button
  - Tools prefixed as `mcp_<server>_<tool>` and automatically merged with built-in tools
  - Supports any MCP-compatible server (GitHub, databases, Slack, custom APIs, etc.)

## Web Extension Features (`vajbagent-web`)
Browser-based code editor. Users describe a website and the AI agent builds it in real time.

- **WebContainers**: In-browser Node.js runtime — agent runs npm install, npm run dev, file I/O, shell commands
- **Live Preview**: Iframe shows dev server output or static HTML blob (auto-detects)
- **AI Chat**: Streaming responses, tool calls (write_file, read_file, execute_command, etc.), multimodal (images)
- **Templates**: Astro, Next.js, React, Vanilla, or blank — agent scaffolds automatically
- **File Explorer**: Tree view, rename, delete, drag & drop images/video, paste images/video, inline thumbnails
- **Monaco Code Editor**: Syntax highlighting, multi-file tabs
- **Terminal**: Connected to WebContainers shell (read-only output display)
- **Netlify Deploy**: One-click publish via OAuth, persists deploy URL and site ID across sessions
- **GitHub Push**: One-click push via OAuth, creates repo if needed
- **Supabase Connect**: Link user's Supabase project for DB/auth in generated apps
- **Cloud Storage**: All projects, chat history, and media saved to Redis + R2 (cross-device, persistent)
- **Offline Fallback**: IndexedDB as backup when offline or not logged in
- **Migration Banner**: Prompts existing users to move local projects to cloud
- **Model Selector**: Command palette (Ctrl/Cmd+K) for switching AI model mid-session
- **Image Uploads**: Drag, drop, or paste — auto-resize, R2 cloud backup, works in preview and deploy
- **Video Uploads**: mp4/webm up to 15MB, stored in R2, works in preview and deploy (max 3 per project)

## agent-test folder (HTML/CSS vežbalište)
- `agent-test/index.html` — landing page sa svim sekcijama, dark mode u footeru
- `agent-test/style.css` — zajednički CSS (1392 linija) sa CSS varijablama, dark mode, responsive
- `agent-test/portfolio.html` — kompletna portfolio stranica:
  - Hero sekcija sa avatar, tagovima, mini-statistikama
  - Galerija 6 projekata (kartice sa slikama iz `img/proj1-6.jpg`, hover efekti, badge)
  - Kontakt forma sa validacijom, select, textarea, live blur validacija
  - Toast notifikacija (success/error)
  - Dark mode toggle u **headeru** (okrugli button)
  - Smooth scroll navigacija (anchor linkovi)
  - Responsive: 3 kolone → 2 → 1 (breakpoints 800px, 550px)
- `agent-test/img/` — 6 slika projekata (Unsplash, localhost)

## Cloud Project Storage (R2 + Redis)

Projects are persisted server-side for cross-device access. IndexedDB remains as offline fallback.

### Storage Layout
```
Upstash Redis:
  vajb:projects:{ownerKeyId}             → JSON array of project summaries [{id, name, model, updatedAt, fileCount}]
  vajb:project:{ownerKeyId}:{projectId}  → full project JSON {id, name, files, chatHistory, displayMessages, model, prompt, deployUrl, nlSiteId, ...}

Cloudflare R2 (bucket: vajbagent):
  {ownerKeyId}/{projectId}/{filename}    → binary assets (images, video)
```

### API Endpoints (all require auth)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/projects` | GET | List projects for current user |
| `/api/projects/:id` | GET | Load full project (files + chat) |
| `/api/projects` | POST | Create new project |
| `/api/projects/:id` | PUT | Save/autosave (upsert) |
| `/api/projects/:id` | DELETE | Delete project + cleanup R2 |
| `/api/projects/:id/uploads/sign` | POST | Get presigned R2 PUT URL |
| `/api/projects/:id/uploads/commit` | POST | Verify upload landed on R2 |

### Media Upload Flow
1. User drops/picks image or video in File Explorer
2. File resized (images only), written as binary to WebContainer for instant preview
3. Data URL stored in React `files` state temporarily
4. Autosave (5s debounce): `uploadAllImagesToR2()` → presigned PUT to R2 → data URL replaced with R2 public URL in `files` map
5. Full project saved to Redis via `PUT /api/projects/:id`
6. IndexedDB backup save runs in parallel

### Media Limits
| Type | Max per file | Max per project | Resize |
|------|-------------|-----------------|--------|
| Images (jpg/png/webp/gif/svg/avif) | 2MB (auto-resized) | 20 | Yes (canvas, max 1600px edge) |
| Video (mp4/webm) | 15MB | 3 | No |

### Resume Flow
1. App boot → `fetchUserInfo()` → check session
2. Read `vajb_last_active_project::{scope}` from localStorage
3. `loadProjectRemote(id)` → Redis → full project (fallback: IndexedDB)
4. Text files → `wcWriteFile()` to WebContainer
5. Media (R2 URLs or data URLs) → `hydrateImagesIntoWc()` → fetch binary → `writeBinaryFile()` to WC
6. `deployUrl` and `nlSiteId` restored → "Objavljeno" shows instead of "Objavi"

### Migration (existing users)
- On login, if user has IndexedDB projects but no remote projects → blue banner: "Prebaci X projekata u cloud?"
- Migration uploads images to R2 and saves projects to Redis
- IndexedDB is kept as offline fallback (never deleted)

### Deploy with R2 Images
- `netlifyOAuth.js` and `githubOAuth.js` detect R2 URLs in `files` map
- Backend fetches binary from R2 before uploading to Netlify/GitHub
- Pattern: `content.startsWith('https://') && (content.includes('.r2.') || content.includes('cloudflarestorage'))`

### R2 Configuration
- Env vars on Render: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`
- CORS on R2 bucket (Cloudflare Dashboard): allow origins `vajbagent.netlify.app`, `vajbagent.com`, `localhost:5173`, `localhost:3000`; methods GET/PUT/HEAD; headers Content-Type/Content-Length

### Security
- Every R2 key prefixed with `ownerKeyId` — cross-user access impossible
- Presigned URLs expire in 5 minutes
- Backend validates file size, content type, image/video count before signing
- Session cookie required for all `/api/projects/*` endpoints

## OAuth Integrations (implemented)
- **GitHub**: Push project files to repo (creates repo if needed, tree-based commit)
- **Netlify**: Deploy project as static site (file digest API, supports updating existing site)
- **Supabase**: Connect user's Supabase project for database + auth in generated apps
- All OAuth flows go through backend (vajbagent.com) as proxy — tokens stored in Redis per user

## Recent Changes (April 2026)

### Model Specs Updated (convert.js, index.js, CONTEXT.md)
- Claude Sonnet 4.6 and Opus 4.6 context windows updated from 200K to **1M** (official Anthropic docs, March 2026)
- GPT-4.1 input limit raised from 200K to **900K** tokens (1M context - 32K output)
- `MODEL_INPUT_LIMITS` in `src/convert.js` updated for all models
- CONTEXT.md model table corrected (Turbo was listed as o4-mini, actually GPT-4.1)
- `reasoning_effort` already correctly applied to GPT-5 family + o4-mini in `handleOpenAI()` (line ~1791 in index.js)

### Reasoning Token Fix (index.js)
- GPT-5 models added to `isReasoning` check (`resolved.backendModel.startsWith('gpt-5')`)
- Without this, GPT-5 Mini spent all output tokens on reasoning, returning empty `content` with `finish_reason: "length"`
- `reasoning_effort: 'low'` for small requests (<=2048 tokens), `'medium'` for coding tasks

### Newline/Escape Fix (toolHandler.ts) — REPLACED in session 2026-04-15
- **Old heuristic (removed):** if textual file has `\\n` literals AND (<=3 lines OR avg line >500 chars), auto-converts. This was fragile and broke JS strings with legitimate `\\n`.
- **New (conservative):** convert `\\n`→`\n` ONLY if the file has ZERO real newlines (model collapsed entire file into one line). Ported from vajbagent-vscode/src/tools.ts:499.

### Prompt Enhancer (Welcome.tsx, Welcome.css)
- "Poboljšaj prompt" button (Sparkles icon) on Welcome screen
- Calls `/v1/chat/completions` with `vajb-agent-lite` (GPT-5 Mini), `stream: false`, `max_tokens: 4096`
- System prompt instructs model to enhance user's web project description
- Opt-in only — user clicks button, result replaces textarea content

### Drag & Drop Improvements
- **Welcome screen**: drag & drop images now works on the main input area (was missing)
- **Chat panel**: drop zone expanded from small input area to entire chat panel div
- Both support same image formats as file picker

### File Explorer Enhancements (FileExplorer.tsx, FileExplorer.css)
- **Folder right-click menu**: "Novi fajl" (create file), "Dodaj sliku / video" (upload), "Preimenuj", "Obriši folder"
- **File right-click menu**: added "Dodaj sliku / video" option
- Context menu positioning fixed (`left: 24px`, `min-width: 170px`, `white-space: nowrap`)
- Toolbar and drop overlay text updated to include video

### Refresh Flash Fix (App.tsx)
- New `'booting'` state (dark background + orange spinner) shown while app checks for active project
- Prevents brief flash of Welcome page before resuming to IDE
- State flow: `booting` → `ide` (if project resumes) or `booting` → `welcome` (if no project)

### Deploy Persistence (IDELayout.tsx)
- `deployUrl` and `nlSiteId` saved in project data (Redis + IndexedDB)
- On resume, "Objavljeno" button shows instead of "Objavi" if site was previously deployed

### R2 + Redis Migration (completed earlier)
- Full migration from IndexedDB-only to cloud storage (R2 for binary, Redis for metadata)
- Video support added (mp4/webm, 15MB limit, max 3 per project)
- Media upload pipeline: presigned URLs, R2 public URLs replace data URLs on autosave
- Resume flow fetches R2 binaries and hydrates into WebContainer
- Deploy (Netlify/GitHub) fetches R2 binaries before uploading

### Backend Fix (index.js)
- `req` parameter was undefined in `handleOpenAINonStream` and `handleOpenAIStream` — fixed by passing it from `chatCompletionsHandler`

### Session 2026-04-15/16 — Major Web Extension Hardening

#### Tool Parsing Overhaul (toolHandler.ts)
- **Fuzzy whitespace matching in `replace_in_file`**: ported from vajbagent-vscode/src/tools.ts:598-619. Trims trailing whitespace per line and does sequential line-by-line match. Falls back to this when exact `.includes()` fails. Also adds duplicate-match guard: if `old_text` appears >1 time, rejects with "proširite old_text" instead of silently replacing the wrong instance.
- **Newline heuristic replaced**: old heuristic (<=3 lines OR avg >500 chars) was fragile. New: convert `\\n`→`\n` ONLY when content has zero real `\n` chars (model collapsed entire file). Cannot break multi-line files.
- **Truncation detection for write_file**: HTML checked for missing `</html>`, JS/TS/CSS/JSON checked for unbalanced braces via a string/comment-aware state machine (skips `'...'`, `"..."`, `` `...` ``, `//...`, `/*...*/`). This is MORE accurate than the VS Code extension's naive brace count.

#### Git Agent Tools (toolHandler.ts, tools.ts)
- 3 new tools: `git_status`, `git_list_repos`, `git_push`
- Reuse backend GitHub OAuth flow (`githubIntegration.ts` + `src/githubOAuth.js`)
- Same security filters as UI push button: `filterForPush()` strips .env/secrets, `ensureGitignoreSafety()` patches .gitignore, `scanForSecrets()` + `redactSecrets()` auto-redacts hardcoded API keys
- Agent cannot bypass any security — filters run unconditionally

#### R2 Upload Retry (userAssets.ts)
- `uploadImageToR2()` now retries 3x with exponential backoff (500ms, 1500ms)
- Retry on 5xx, 408, 429, network errors. Fail-fast on 4xx (wrong size, expired auth)
- Existing data-URL fallback in caller (`uploadAllImagesToR2`) preserved — if all retries fail, data URL stays in files map

#### Agent Loop Improvements (ChatPanel.tsx)
- **MAX_ITERATIONS 20 → 50**: complex builds need more steps
- **Iteration warning as `role: 'system'`** instead of `role: 'user'` with `[SYSTEM]` prefix
- **max_tokens: 32000** sent to API (was missing entirely → backend defaulted to 4096 → truncated CSS → "write_file truncated JSON — rejected" → model wasted 3 min splitting CSS into 5 tiny files). 32K is well within all models' MAX_OUTPUT (64K–128K), no cost penalty.
- **Lazy-parroting recovery**: if model returns text-only on a clear build prompt with no files written yet, injects runtime system nudge and retries once. Fully silent — no UI messages.
- **Section completeness check**: when model finishes and wrote <3 files, reads index.html and checks for missing sections the user requested (stem-based Serbian patterns: `/uslug/`, `/tim/`, `/cena/`). If missing → silent nudge to add them. Does NOT fire if model wrote 3+ files (real attempt, our regex just might not match the class names).
- **Graceful post-build failures**: if an API call fails after files are already written, catch block ends gracefully instead of retrying 3x. The site is built; the failing call was a bonus pass.
- **Retry status messages only in footer bar**, not as chat bubbles.

#### First-Shot Quality Directive (ChatPanel.tsx)
- On first user message with build intent (>40 chars + build keywords), a high-priority system message is injected before the user message in historyRef. Tells model: complete every section, no lorem ipsum, no placeholders, use search_images for real photos, cohesive design system, WOW first impression.
- Runtime context injection — systemPrompt.ts is NOT modified.

#### Preview Flash Fix (PreviewPanel.tsx)
- FNV-1a hash of rendered HTML prevents iframe reload when the output is bit-identical to the previous frame. Autosave, R2 URL swap, non-visible file writes no longer cause visible flashing.

#### Preview Reveal Shield (PreviewPanel.tsx)
- JS-only shield (NO !important CSS) injected into blob preview HTML
- Adds marker classes (`visible`, `in-view`, `aos-animate`, `animated`, `revealed`) to known scroll-reveal selectors (`.fade-in`, `.reveal`, `.slide-in`, `[data-aos]`, etc.)
- Runs on DOMContentLoaded + 50ms/300ms/1000ms intervals
- Previous version used CSS `[class*="fade-"]` with `!important` — broke legitimate layouts (mobile menu toggles, Tailwind classes). Removed entirely.

#### UTF-8 Fix (PreviewPanel.tsx)
- Blob preview iframe now gets `<meta charset="UTF-8">` injected into `<head>` if missing
- Blob MIME type set to `text/html;charset=utf-8`
- Fixes Serbian diacritics (ć/č/š/đ/ž) rendering as Latin-1 mojibake

#### Prompt Caching (balance.js, index.js)
- **Anthropic tools caching**: last tool in array gets `cache_control: { type: 'ephemeral' }` so the ~4-5K token tools block is cached alongside system prompt
- **`providerCostUsdWithCache()` / `costUsdWithCache()`**: split billable input into uncached (100%), cache-read (10%), cache-create (Anthropic 125%, OpenAI 100%)
- **Anthropic stream + non-stream**: reads `cache_read_input_tokens` and `cache_creation_input_tokens` from usage, logs cache hits, applies discounted cost
- **OpenAI stream + non-stream**: reads `prompt_tokens_details.cached_tokens`, applies same discounted logic
- Estimated savings for 20-iteration Sonnet session: ~80% reduction in input token costs
- Old `costUsd()` remains for backward compatibility (admin dashboard, legacy paths)

#### Early WebContainer Preboot (App.tsx)
- `preboot()` called on app mount instead of waiting for IDELayout mount
- WC boots in parallel with auth check, project list fetch, and user typing their first prompt
- By the time user clicks Send, WC is usually already warm — saves 3-8s on first-run preview
- `preboot()` is idempotent, second call from IDELayout is a no-op

#### Model Swap: Turbo GPT-4.1 → Claude Haiku 4.5
- `src/index.js` VAJB_MODELS: Turbo now routes to `backend: 'anthropic'`, `backendModel: 'claude-haiku-4-5'`
- `src/index.js` MAX_OUTPUT: added `'claude-haiku-4-5': 64000`
- `src/convert.js` MODEL_INPUT_LIMITS: Haiku promoted from legacy section (`130000 tokens / 520000 chars`)
- `src/balance.js`: Haiku pricing already existed ($1 input / $5 output per 1M tokens)
- **Why**: GPT-4.1 had weak tool-calling discipline and consistently parroted long briefs back to users instead of calling write_file. Haiku 4.5 is Anthropic's fast tier with aggressive tool-calling behavior. Cheaper ($1/$5 vs $2/$8), faster, and eliminates lazy-parroting entirely.
- `isReasoning` check does NOT apply to Haiku (routes through `handleAnthropic`, never enters `handleOpenAI`).

#### Web Extension Default Model: Max (Sonnet 4.6)
- `vajbagent-web/src/models.ts`: `DEFAULT_MODEL = 'vajb-agent-max'`
- Max tagged as "Preporučeno" in model selector UI
- Model descriptions no longer expose vendor names (no "Claude Haiku" or "Claude Sonnet" in UI)
- VS Code extension default unchanged — still Turbo (now Haiku under the hood)

#### Context Limits Fixed (ChatPanel.tsx)
- Turbo: 1M → 200K (Haiku 4.5 has 200K context)
- Max: 200K → 1M (was stale — Sonnet 4.6 has 1M since March 2026)
- Ultra: 200K → 1M (same — Opus 4.6 has 1M)
- Architect: 200K → 1M

#### WebContainer Memory Leak Fix (webcontainer.ts)
- `previewErrors` array capped at 100 entries to prevent unbounded growth over long sessions

#### Empty Catch Blocks
- Added clarifying comments to bare `catch {}` blocks in ChatPanel.tsx and webcontainer.ts

---

**What to watch for (next agent):**
- `src/convert.js` — `MODEL_INPUT_LIMITS` must match real context windows. If Anthropic/OpenAI release new models, update here.
- `src/index.js` line ~62 — `MAX_OUTPUT` table must match official max output tokens.
- `src/index.js` line ~77 — `VAJB_MODELS`: Turbo now routes to Anthropic (`backend: 'anthropic'`, `backendModel: 'claude-haiku-4-5'`). Do NOT accidentally change it back to OpenAI.
- `src/index.js` line ~1791 — `isReasoning` check: any new reasoning model needs to be included here. Haiku is NOT a reasoning model and does NOT enter this branch (it goes through `handleAnthropic`, not `handleOpenAI`).
- `src/index.js` line ~1800 — `reasoning_effort` logic: `'low'` for small requests, `'medium'` for coding. GPT-5 supports: minimal, low, medium, high, xhigh.
- `vajbagent-web/src/services/toolHandler.ts` — newline heuristic: convert `\\n`→`\n` ONLY if file has zero real newlines. DO NOT make it more aggressive — previous fragile heuristic broke JS strings.
- `vajbagent-web/src/services/toolHandler.ts` — truncation detection uses string/comment-aware brace counting. If it produces false positives on valid code, check the state machine (quote/comment skip logic).
- `vajbagent-web/src/services/toolHandler.ts` — `replace_in_file` fuzzy matching: trims trailing whitespace per line. Does NOT normalize leading whitespace (intentional — prevents wrong-indent replacement). Rejects if >1 match found.
- `vajbagent-web/src/components/ChatPanel.tsx` — section completeness check only fires for <3 written files. If model wrote 3+ files, it's assumed to be a real attempt. Do NOT remove the file count guard — it caused false nudges on complete builds.
- `vajbagent-web/src/components/ChatPanel.tsx` — `max_tokens: 32000` sent to API. Do NOT reduce below 16384 — CSS truncation will return. Do NOT remove — backend defaults to 4096 without it.
- `vajbagent-web/src/components/ChatPanel.tsx` — first-shot quality directive: injected as runtime system message for first build prompts. NOT a change to systemPrompt.ts.
- `vajbagent-web/src/components/PreviewPanel.tsx` — reveal shield is JS-only. Do NOT add !important CSS selectors — previous attempt with `[class*="fade-"]` broke layouts by overriding legitimate display/visibility CSS.
- `vajbagent-web/src/components/PreviewPanel.tsx` — UTF-8 charset: injected in blob HTML AND set in Blob MIME type. Both needed for Serbian diacritics.
- `vajbagent-web/src/models.ts` — DEFAULT_MODEL is `vajb-agent-max`. Do not expose vendor model names (Haiku, Sonnet, Opus) in UI descriptions.
- **Render env var `SELF_REGISTER_BONUS`**: should be changed from `0.3` to `0.9` to give new users enough credit for a real Max session. This is NOT in code — must be set in Render dashboard.
- **Sentry**: NOT yet integrated. Next session should add Sentry to both backend (Node.js, Render) and frontend (React, Netlify). Free tier = 5K errors/month.
- Model specs verified April 2026: GPT-5 Mini (400K/128K), Claude Haiku 4.5 (200K/64K), GPT-5 (400K/128K), GPT-5.4 (1.05M/128K), Claude Sonnet 4.6 (1M/64K), Claude Opus 4.6 (1M/128K).

## Building the Extension
- Extension source: `vajbagent-vscode/`
- Build: `cd vajbagent-vscode && npm run compile && npx @vscode/vsce package --no-dependencies`
- Output: `vajbagent-vscode/vajbagent-X.Y.Z.vsix`
- Install: VS Code/Cursor → `Ctrl+Shift+P` → "Extensions: Install from VSIX..." → pick the `.vsix` file

## Branding
- **Name:** VajbAgent (Vajb in white, Agent in orange)
- **Accent color:** #FA7315 (orange)
- **Creator:** Nemanja Lakic
- **Platform:** Vajb <kodiranje/> Mentorski
