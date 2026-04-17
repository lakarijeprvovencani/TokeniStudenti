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
| Max | Claude Sonnet 4.6 | 1M | 64K | No | **Default on web** — best balance, **free tier unlocks this** |
| Power | GPT-5.4 | 1.05M | 128K | Yes (`reasoning_effort`) | Flagship OpenAI |
| Ultra | Claude Opus 4.7 | 1M | 128K | Adaptive thinking | Premium Anthropic (released 2026-04-16) |
| Architect | Claude Opus 4.7 | 1M | 128K | Adaptive thinking | Opus 4.7 + architect system prompt |

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
- **max_tokens: 16000** sent to API (backend defaults to 4096 without it, causing CSS truncation — "write_file truncated JSON — rejected" loop. 16K is well within all models' MAX_OUTPUT, no cost penalty).
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

### Session 2026-04-16/17 — Production hardening + UX overhaul

**Context for this session:** the user reported a 15-20 minute slow-build bug in the web extension. That opened into a full audit; 50+ issues were found and fixed over this round. Everything below is now live in production (backend on Render, frontend on Netlify). The user's explicit goal was "da web extenzija radi bez ikakvih problema" — treat this as the stability baseline going forward.

#### 🛡️ SECURITY + BILLING HARDENING (backend)

All of these are CRITICAL and must not regress:

- **`publicUserId` hashing (`src/auth.js`)** — `/auth/me`, `/auth/login`, `/auth/register` previously returned the raw API key as `user_id`. Now returns a deterministic SHA-256 hash. DO NOT revert — API key must never leave the backend.
- **Admin secret header-only (`src/index.js` + `public/admin.html`)** — admin endpoints removed `?secret=…` query string support; authentication is header-only (`X-Admin-Secret`). Query strings end up in access logs / Referer headers and were effectively leaking the admin key.
- **Distributed locking for balance (`src/balance.js`)** — `deductBalance` was a read-modify-write race. Now uses Redis `SET NX EX` lock + process-local lock. Also applies `Math.max(0, raw)` so balance cannot go negative from concurrent calls. Only positive deposits increment the lifetime total.
- **Distributed locking for usage (`src/usage.js`)** — same pattern as balance; `logUsage` is now serialised across processes.
- **Uncaught exception → graceful exit (`src/index.js`)** — was only logging and continuing (silently corrupt state). Now logs, gives 30s for in-flight requests, then `process.exit(1)` so Render restarts the worker.
- **`download_file` SSRF protection (`toolHandler.ts`)** — now blocks private IP ranges, file:// and chrome-extension:// protocols.
- **`replace_in_file` binary guard (`toolHandler.ts`)** — refuses to run on binary file extensions (png, jpg, webp, ico, zip, etc.) — previously could corrupt them.
- **`execute_command` arg tokenising (`toolHandler.ts`)** — `tokenizeCommand()` respects quoted arguments. Naive `command.split(' ')` broke paths with spaces.
- **Stripe secret key removed from frontend (`Settings.tsx`)** — `vajb_stripe_sk` localStorage field deleted. Note added instructing users to set it as an env var on the backend.

#### ⚡ AGENT LOOP STABILITY

**FATAL bug fixed — Anthropic `stop_reason` propagation:**
Backend was not reading `event.delta.stop_reason` from the Anthropic stream, so every tool-call that finished with `stop_reason: "max_tokens"` surfaced to the client as if it completed normally. Client then treated truncated JSON as valid. Fixed in `src/index.js` stream handler and `src/convert.js` `anthropicToOpenAIChoice`.

**FATAL bug fixed — broken continuation protocol (web + VSCode):**
Previous continuation logic (`ChatPanel.tsx`, `vajbagent-vscode/src/agent.ts`) appended an `assistant` message with `tool_calls` followed by a `user` `[SYSTEM] continue…` message. This violates the Anthropic tool-call contract (assistant-with-tool_calls MUST be followed by tool-role messages). It caused 400 errors mid-stream AND triggered apology loops. Replaced entirely by **tool-error injection**: when `finish_reason === 'length'` arrives mid tool-call, mark the IDs as truncated, let the tool-execution phase emit a neutral guiding tool-role message ("use `read_file` + `replace_in_file` to continue; do not apologise"). No more assistant→user continuation in either client.

**History repair (`ChatPanel.tsx` `repairHistory`):**
If a stream aborts mid-tool, an `assistant` message with `tool_calls` can be left without the matching `tool` responses — this breaks Anthropic on the next turn. `repairHistory()` runs on load, on resume, and in the `finally` block of `sendMessage` to clean orphans and inject synthetic tool results.

**`trimHistory` now accounts for tool args (`ChatPanel.tsx`):**
Previously ignored the size of `tool_calls.arguments`, so huge `write_file` payloads could blow past the context window. Now has a "Phase 1.5" that compacts large tool-call args before dropping messages.

**`max_tokens: 24000` (ChatPanel.tsx)** — was 16000, which was tight for CSS-heavy builds + reasoning models. Do NOT reduce without verifying the truncation recovery path.

**Backend timeouts:**
- `KEEPALIVE_INTERVAL` tightened, SSE keepalives switched from comment lines to empty `data:` chunks (proxy buffering was eating comments and triggering idle timeout on reasoning models like GPT-5 Power).
- `STREAM_TIMEOUT` extended.
- `ChatPanel.tsx` client idle/hard timeouts raised; `throw new Error()` inside `setTimeout` replaced with flag-based detection (exceptions inside timer callbacks were uncatchable).

**Stream safety:**
- **Client disconnects abort upstream (`src/index.js`)** — `req.on('close', …)` now calls `stream.controller.abort()` so we stop paying the provider when a user closes the tab mid-stream.
- **Mid-stream error propagation** — `midStreamError` captures upstream failures and emits a special `data:` chunk the client detects and throws on. Previously errors were silently swallowed.

#### 🔧 CSS APOLOGY / REWRITE LOOP KILLED

Multiple complementary fixes — this was the single most-complained-about bug (Turbo especially would rewrite `style.css` 4-5 times, apologise, rewrite again):

1. **`max_tokens` raised 16K → 24K** (`ChatPanel.tsx`).
2. **HTML / CSS / SCSS / Vue / Svelte excluded from brace counting** (`toolHandler.ts` + `vajbagent-vscode/src/tools.ts`). The check was unreliable on these languages — inline `<style>`/`<script>`, `@media` nesting, `url(data:...)` with raw SVG, and CSS custom-property fallbacks produced false positives.
3. **JS/TS/JSON brace threshold raised `>=2` → `>=5`** — minor mismatches in minified code or template literals shouldn't block the write.
4. **Hard HTML `</html>` check removed** (`toolHandler.ts` + `tools.ts`) — false-positived on legitimate snippets and fragments.
5. **150-lines / 5000-char hard block removed** (VSCode `tools.ts`) — blocked legitimate design-system / Tailwind-config writes.
6. **Error copy rewritten — everywhere.** Killed every "GREŠKA ... Fajl NIJE upisan ... MORAS razdvojiti ... NE POKUSAVAJ" message that existed. New copy starts with "Napomena:" and explicitly says "ne izvinjavaj se korisniku", guiding the model to `read_file` + incremental `replace_in_file` instead of full rewrite. This is the single biggest behavioural fix — DO NOT undo it.

#### 🧑‍💻 LIVE CODE STREAMING (new — `vajbagent-web/src/services/liveCodeStream.ts`)

Watch the agent type code character-by-character into the Monaco editor, Bolt/Lovable-style.

- `emitPartialArgs(toolCallId, partialJson)` called on every `choice.delta.tool_calls.arguments` chunk.
- `decodeJsonFragment()` leniently parses incomplete JSON to extract `path` and (partial) `content` even before the full tool call lands.
- `emitFinalArgs()` fires when the tool call completes; `resetLiveStream()` on stream end.
- `IDELayout.tsx` subscribes via `onLiveWrite`, maintains a `liveFiles` state that OVERRIDES `files` for the editor, auto-switches `activeFile` to the one being streamed, and passes the merged map to both `CodeEditor` AND `FileExplorer` so files appear in the tree live as they are written.

#### 🖥️ LIVE `execute_command` OUTPUT (terminal)

Previously `runCommand` buffered all stdout and returned it at end. Now:
- `webcontainer.ts` exposes `onAgentCommand` event bus + `emitAgentCommand({ type: 'start' | 'output' | 'end', ... })`.
- `runCommand()` emits events for start, each output chunk, and end.
- `Terminal.tsx` subscribes and mirrors agent commands to the xterm view with ANSI-coloured markers (`▸ command`, raw output, `✓ done` / `✗ failed`).
- `IDELayout.tsx` auto-opens the terminal panel on first agent command.

#### 🔤 TERMINAL INPUT FIX (multi-bug)

User reported "ne mogu da pisem u terminalnu" (terminal was frozen on "povezujem jsh shell…"). Root causes and fixes, all in `Terminal.tsx`:

1. **Input buffering** — `terminal.onData` now registered immediately; keystrokes buffered in `pendingInput` until `jsh`'s `inputWriter` is ready, then flushed.
2. **Forced focus** — `requestAnimationFrame(() => terminal.focus())` after mount + click-to-focus handler on the terminal body.
3. **Boot status** — explicit "⏳ povezujem jsh shell…" banner, cleared with `\r\x1b[2K` on first output. "✗ Ne mogu da pokrenem jsh shell" on failure.
4. **Reverted `cwd: '/home/project'`** from `wc.spawn('jsh')` — caused hangs on some WebContainer versions.
5. **Manual `reader.read()` loop** instead of `shell.output.pipeTo(…)` — avoids stream locking issues.
6. **12-second spawn timeout** via `Promise.race` — no more infinite "povezujem" hang.
7. **Newline nudge** — `writer.write('\\n')` after successful spawn so `jsh` prints its prompt.
8. **Shell cleanup on unmount** — `useEffect` cleanup kills the `jsh` process and releases the input writer lock (was leaking shell processes).

#### 🎨 UI POLISH (Lovable/Bolt-style "wow")

All under `src/index.css`, `IDELayout.css`, `ChatPanel.css`, `CodeEditor.css`:

- **Ambient background** — breathing radial orbs (orange + subtle purple, `@keyframes ambientBreath` + `ambientDrift`) + dot grid texture behind the main IDE (`.ambient-bg`, `.dot-grid` fixed-position elements in `IDELayout.tsx`).
- **Enhanced CTAs** — "Objavi" / deploy button (`.btn-deploy`) and chat send button (`.chat-send.active`) get gradient fills, layered box-shadows, amplified glow on hover/active. New shared `.btn-primary` class for general high-emphasis actions.
- **Topbar button polish** — hover state gets a soft orange tint + glow (`rgba(249,115,22,0.22)` border, multi-layer shadow).
- **Editor empty/building state** — `.editor-empty-icon-wrap::after` pulses a radial orange glow; gradient-text `.editor-empty-icon`; `.editor-empty-ring` dashed orange border rotating slowly; `.building-line` skeleton shimmers with a 3s linear gradient animation.

#### 🏗️ FILE EXPLORER FIXES

- **Context menu clipping (`FileExplorer.tsx` + `.css`)** — was clipped at the bottom of the scrollable sidebar. Switched to `position: fixed` with dynamic viewport-aware positioning (`.ctx-menu-fixed`).
- **Live files in tree** — `FileExplorer` now receives the merged `filesForEditor` prop (static files + live-streaming files) so new files appear in the tree AS the agent types them, not after completion.

#### 🖼️ PREVIEWPANEL — multi-page blob URL support

User reported "internal links break when I open the generated site in a new tab". Root cause: the old `NAV_INTERCEPT_SCRIPT` relied on `window.parent.postMessage` — only works inside the IDE iframe. Refactored `buildFullSiteBlob()` to detect multi-page static sites and emit a **hash-router shell HTML** that works in both the iframe preview AND a new browser tab. Also added `setTimeout(() => URL.revokeObjectURL(url), 60_000)` for the blob opened via the "open in new tab" button — was leaking memory for long sessions.

#### 🧠 SYSTEM PROMPT COHERENCE

The web client already sends a 60KB comprehensive system prompt. Backend was ALSO injecting its own default prompt, resulting in two system messages (wasted tokens + confused model). Fix:
- `ChatPanel.tsx` sends `X-Vajb-Client: 'web'` header on every request.
- `src/index.js` `injectSystemPrompt()` skips injection when this header is present OR when an existing system message >2KB is detected.
- CORS `allowedHeaders` updated to include `X-Vajb-Client` (missing this causes preflight failure → "Ne mogu da se povežem na server" error the user reported).

#### 🌙 FREE-TIER MODEL GATING (critical business change)

User requirement: "new free-plan users MUST get Max as default, so their first experience is wow (like Bolt/Lovable). VS Code extension stays on Lite — I don't care there, but web must default to Max."

- **Backend gating (`src/index.js`)** — `FREE_TIER_ALLOWED` = `{ lite, turbo, pro, max }`. `Power`, `Ultra`, `Architect` remain locked for free users. Error message updated.
- **Frontend auto-select (`App.tsx`)** — `useEffect` watches `user.freeTier`; if user is on a locked premium tier, auto-switches to `vajb-agent-max` (NOT `lite` as before).
- **Model selector (`ModelSelector.tsx`)** — shows lock badge + "Dopuni kredite" only for the genuinely locked premium tiers.
- **Model descriptions (`models.ts`)** — `Max`, `Power`, `Ultra`, `Architect` descriptions updated. Ultra and Architect now reference "Opus 4.7".

DO NOT revert Max to Lite as the free-tier default. Business requirement.

#### 🧠 CLAUDE OPUS 4.7 INTEGRATION (released 2026-04-16)

Ultra and Architect tiers now route to `claude-opus-4-7`. Full integration:

- **`src/index.js`:**
  - Added `claude-opus-4-7` to `MAX_OUTPUT` (128K).
  - `VAJB_MODELS` updated: `vajb-agent-ultra` and `vajb-agent-architect` → `backendModel: 'claude-opus-4-7'`.
  - **Adaptive thinking** is MANDATORY for Opus 4.7. Payload now conditionally sets `thinking: { type: 'adaptive' }` only for `claude-opus-4-7`. The old `thinking: { type: 'enabled', budget_tokens: N }` format produces 400 errors on 4.7.
- **`src/convert.js`** — `MODEL_INPUT_LIMITS` for `claude-opus-4-7`: `{ tokens: 900000, chars: 2700000 }`. 1M context minus 100K headroom for tools + adaptive-thinking output. Char budget intentionally tighter (~3 chars/token effective) because the new 4.7 tokenizer consumes up to 35% more tokens per text than 4.6.
- **`src/balance.js`** — pricing: `{ in: 5.00, out: 25.0 }` per 1M tokens (same as 4.6). `getPrice()` resolver: `opus-4-7` / `opus-4.7` variants → 4.7 price; bare `opus` falls back to 4.6.
- **`vajbagent-web/src/models.ts`** — Ultra/Architect descriptions reference "Opus 4.7".

Prompt caching (`cache_control: ephemeral` on tools and system prompt) is compatible with 4.7 — already working.

⚠️ Real cost of Opus 4.7 is ~35% higher than 4.6 for the same prompt because of the new tokenizer. Factor this into the student markup if profit margin matters.

#### 📊 ADMIN PANEL — MONTHLY EARNINGS BREAKDOWN (new)

Previously admin showed lifetime totals only. Now tracks per-month data so you can answer "how much did I earn in March" / "how much this month".

- **`src/usage.js`:**
  - `logUsage()` now writes `usage[keyId].by_month["YYYY-MM"]` alongside lifetime totals (UTC-bucketed).
  - New `getMonthlyAggregates({ isNoMarkup, providerCost, getMarkup })` walks every user's monthly buckets and computes provider cost + charged + profit per model per month. Walks per-model (not from month totals) so models with different prices bill correctly.
- **`src/index.js`** `/admin/api/overview` — now returns `monthly: [{month, requests, provider_cost_usd, charged_usd, profit_usd, ...}]` sorted ascending + `server_time` for correct current-month detection in admin JS.
- **`public/admin.html`** — three new cards on the Analytics page:
  1. **"Ovaj mesec"** — prominent green card with API cost / charged / **profit** / request count for the running month + `▲/▼ XX% vs prev month` trend.
  2. **"Mesečna projekcija"** — realistic extrapolation of current month at its pace (`profit × dim/dom`) instead of the previous naive lifetime-average heuristic. Falls back to lifetime average only when `by_month` data is empty (fresh install).
  3. **"Zarada po mesecima"** — last 12 months as a horizontal profit bar chart + numeric table (API / charged / profit). Current month subtly highlighted.

**Important:** legacy `usage.json` without `by_month` renders empty history ("Još nema mesečnih podataka…") — by design, historical data cannot be reconstructed because old records have no timestamp per request. From the deploy of this feature forward, every `logUsage()` call populates the monthly timeline.

#### 🔌 VAJBAGENT-VSCODE v2.1.0 — PORT OF WEB FIXES

The VS Code / Cursor extension carried the same truncation-handling bugs. Ported the critical client-side fixes:

- **`vajbagent-vscode/src/agent.ts`** — killed the old `[SYSTEM] continue` continuation path; now tracks `truncatedToolIds` and feeds tool-error injection on `finish_reason: length`. Rewrote all alarmist `write_file` / `replace_in_file` truncation messages to neutral "Napomena: … ne izvinjavaj se" copy.
- **`vajbagent-vscode/src/tools.ts`** — same brace-counting relaxation as web (HTML/CSS/SCSS/Vue/Svelte excluded, JS/TS/JSON threshold raised to >=5), dropped 150-line / 5000-char hard block, dropped "block write_file on files >100 lines" rule, dropped the hard HTML `</html>` reject.
- **Version bumped to 2.1.0** in `package.json`.
- **VSIX rebuilt and shipped** — `public/vajbagent-latest.vsix` replaced (413KB v2.1.0); landing page label on `public/extenzija.html` updated from "v2.0.3" to "v2.1.0"; a copy also lives in `vajbagent-vscode/vajbagent-2.1.0.vsix` for marketplace upload.
- Backend fixes (Opus 4.7 + adaptive thinking, SSE keepalive-as-data, billing atomicity, security hardening) automatically benefit this extension since the proxy is shared.

#### 📦 FILES CREATED / TOUCHED THIS SESSION

**New files:**
- `vajbagent-web/src/services/liveCodeStream.ts` — live code streaming event bus + lenient partial-JSON parser.

**Major rewrites:**
- `vajbagent-web/src/components/ChatPanel.tsx` — agent loop, truncation handling, humanised errors, `ThinkingLabel`, `trimHistory`/`repairHistory`, first-shot directive, live stream emits, `sendInFlightRef` double-send guard.
- `vajbagent-web/src/services/toolHandler.ts` — all truncation messages rewritten, SSRF guard, binary guard, `tokenizeCommand`.
- `src/index.js` — security hardening, stream safety, system-prompt coherence, monthly timeline in overview, Opus 4.7 adaptive thinking.
- `src/usage.js` — `by_month` tracking + `getMonthlyAggregates()`.
- `src/balance.js` — distributed locking, Opus 4.7 pricing.
- `vajbagent-vscode/src/agent.ts` + `tools.ts` — v2.1.0 port.
- `public/admin.html` — monthly earnings UI.

**Deployment:**
- Backend on Render — auto-deploys on push to `main`.
- Frontend on Netlify (`vajbagent-web/`) — deployed via `netlify deploy --prod --dir=dist` from **inside** `vajbagent-web/`. CRITICAL: running netlify deploy from the project root hangs with `Command failed to spawn: Aborted` — must be run from the frontend app directory.
- VS Code extension — VSIX is at `public/vajbagent-latest.vsix`; user publishes to marketplace manually.

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
- `vajbagent-web/src/components/ChatPanel.tsx` — `max_tokens: 16000` sent to API. Do NOT remove — backend defaults to 4096 without it and every multi-hundred-line file will truncate. If you reduce, you must also verify truncation recovery still routes the model to `replace_in_file` via the tool error messages in `toolHandler.ts`.
- `vajbagent-web/src/components/ChatPanel.tsx` — first-shot quality directive: injected as runtime system message for first build prompts. NOT a change to systemPrompt.ts.
- `vajbagent-web/src/components/PreviewPanel.tsx` — reveal shield is JS-only. Do NOT add !important CSS selectors — previous attempt with `[class*="fade-"]` broke layouts by overriding legitimate display/visibility CSS.
- `vajbagent-web/src/components/PreviewPanel.tsx` — UTF-8 charset: injected in blob HTML AND set in Blob MIME type. Both needed for Serbian diacritics.
- `vajbagent-web/src/models.ts` — DEFAULT_MODEL is `vajb-agent-max`. Do not expose vendor model names (Haiku, Sonnet, Opus) in UI descriptions.
- **Render env var `SELF_REGISTER_BONUS`**: should be changed from `0.3` to `0.9` to give new users enough credit for a real Max session. This is NOT in code — must be set in Render dashboard.
- **Sentry**: NOT yet integrated. Next session should add Sentry to both backend (Node.js, Render) and frontend (React, Netlify). Free tier = 5K errors/month.
- Model specs verified April 2026: GPT-5 Mini (400K/128K), Claude Haiku 4.5 (200K/64K), GPT-5 (400K/128K), GPT-5.4 (1.05M/128K), Claude Sonnet 4.6 (1M/64K), Claude Opus 4.7 (1M/128K, adaptive thinking REQUIRED).

### Watch-outs specific to session 2026-04-16/17

**DO NOT REGRESS these behaviours — they were explicit business / UX requirements:**

- **Free-tier default is `vajb-agent-max`, not `vajb-agent-lite`** — `App.tsx` auto-select + `FREE_TIER_ALLOWED` set in `src/index.js`. Business requirement ("new users must get a wow first experience like Bolt/Lovable"). `Power`, `Ultra`, `Architect` stay locked for free tier.
- **Opus 4.7 `thinking: { type: 'adaptive' }`** is mandatory. The old `{ type: 'enabled', budget_tokens: N }` format returns 400 on 4.7. The payload in `src/index.js` conditionally sets adaptive thinking ONLY for `claude-opus-4-7` — do not globally apply, other models don't support it.
- **Opus 4.7 `MODEL_INPUT_LIMITS` char budget is intentionally tight** (`2700000` for 900K tokens = ~3 chars/token, vs ~4 for 4.6). The new 4.7 tokenizer consumes up to 35% more tokens for the same text. Do NOT widen to match 4.6 or context trimming will under-estimate.
- **`X-Vajb-Client: 'web'` header must stay in `ChatPanel.tsx` requests + in backend `allowedHeaders`.** If the CORS allowlist regresses, the frontend will show "Ne mogu da se povežem na server" after deploy. If the header is removed, backend will re-inject its default system prompt alongside the 60KB web prompt, doubling token cost.
- **Agent continuation uses TOOL-ERROR INJECTION, not assistant→user `[SYSTEM] continue`** — in BOTH `vajbagent-web/src/components/ChatPanel.tsx` AND `vajbagent-vscode/src/agent.ts`. The old flow violates Anthropic's tool protocol and causes 400s. If you see anyone adding back a continuation path that appends an `assistant` with `tool_calls` followed by a `user` message, STOP.
- **Truncation error messages are deliberately neutral.** Anywhere in `toolHandler.ts`, `ChatPanel.tsx`, `vajbagent-vscode/src/agent.ts`, or `vajbagent-vscode/src/tools.ts`, the messages for truncated `write_file` / `replace_in_file` start with "Napomena:" and include "ne izvinjavaj se korisniku". DO NOT switch back to "GREŠKA ... Fajl NIJE upisan ... MORAS ..." — that wording was the direct cause of Turbo's apology/rewrite loop on CSS files.
- **Brace-counting truncation check excludes HTML / CSS / SCSS / Vue / Svelte** in both clients. These languages produce false positives (inline style/script, @media nesting, url(data:…), custom-property fallbacks). Only JS / TS / JSON run the check, with threshold `>=5` (not `>=2`).
- **`max_tokens: 24000`** in `vajbagent-web/src/components/ChatPanel.tsx`. Was 16000, pushed to 24000 to give reasoning models (especially Turbo with thinking-phase burn) more headroom. Do not reduce without verifying truncation recovery still routes through `replace_in_file`.
- **Distributed locks in `src/balance.js` + `src/usage.js`** are Redis `SET NX EX`-based. The in-process map is ONLY a micro-optimisation — the Redis lock is what protects across Render workers. If Redis is unavailable, behaviour degrades gracefully but concurrent deductions may race. Don't swap the Redis-lock pattern for plain promise chaining.
- **Admin monthly timeline** (`usage.js` `by_month`, `getMonthlyAggregates`, `/admin/api/overview` `monthly` field, `public/admin.html` "Ovaj mesec" + "Zarada po mesecima" cards) starts empty on existing installs — legacy `usage.json` has no per-request timestamps. This is documented in the UI. Do NOT backfill with fake data.
- **Live code streaming** (`vajbagent-web/src/services/liveCodeStream.ts`) parses **incomplete** JSON from the tool-call stream. The `decodeJsonFragment()` function is intentionally lenient — it may return a partial `content` string. The editor shows this as "typing in progress". Do not tighten the JSON parser to reject partial strings — that defeats the whole feature.
- **Terminal `jsh` spawn** in `Terminal.tsx` — do NOT re-add `cwd: '/home/project'` to the `wc.spawn('jsh')` call. It hangs on some WebContainer versions. The 12s `Promise.race` timeout is the fallback if spawn ever does hang.
- **`runCommand` in `webcontainer.ts` emits events to `onAgentCommand`** — the Terminal panel subscribes to mirror agent output live. If you refactor `runCommand` to just return output, the terminal stops showing agent activity.
- **`FileExplorer` receives `filesForEditor`** (merged `files + liveFiles`), NOT `files`. Reverting to raw `files` will break live file-tree updates during streaming.
- **`PreviewPanel.tsx` multi-page detection + hash-router shell** — do not delete. Previous iframe-only `NAV_INTERCEPT_SCRIPT` broke internal links when user clicked "open in new tab" on a multi-page site (the script relied on `window.parent.postMessage` which doesn't exist in a standalone tab).
- **`revokeObjectURL(url)` in PreviewPanel** after `setTimeout(…, 60000)` — blob URLs leak memory without this.
- **Netlify deploys MUST run from `vajbagent-web/`** (the frontend app dir), not project root. `netlify deploy` from root hangs with `Command failed to spawn: Aborted`.
- **Opus 4.7 effective cost is ~35% higher than headline pricing** because of the new tokenizer. If someone asks "why is my Opus bill so high", this is why.

## Building the Extension
- Extension source: `vajbagent-vscode/`
- Build: `cd vajbagent-vscode && npm run compile && npx @vscode/vsce package --no-dependencies --out vajbagent-X.Y.Z.vsix`
- Current version: **2.1.0** (bump in `vajbagent-vscode/package.json`).
- Install: VS Code/Cursor → `Ctrl+Shift+P` → "Extensions: Install from VSIX..." → pick the `.vsix` file
- **Shipping to users:**
  1. Copy the built VSIX to `public/vajbagent-latest.vsix` — this is what the landing page download button serves.
  2. Also keep a copy at `vajbagent-vscode/vajbagent-X.Y.Z.vsix` — this is what the user selects when publishing to the VS Code marketplace.
  3. Update the version label on `public/extenzija.html` (the "Preuzmi vX.Y.Z" button text is hard-coded).
  4. `.gitignore` already whitelists `public/vajbagent-latest.vsix` (`!public/vajbagent-latest.vsix`) while ignoring `*.vsix` everywhere else — so only the public download copy is committed to git.

## Branding
- **Name:** VajbAgent (Vajb in white, Agent in orange)
- **Accent color:** #FA7315 (orange)
- **Creator:** Nemanja Lakic
- **Platform:** Vajb <kodiranje/> Mentorski
