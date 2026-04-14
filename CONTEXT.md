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
| Turbo | GPT-4.1 | 1M | 32K | No | Fast, strong at coding |
| Pro | GPT-5 | 400K | 128K | Yes (`reasoning_effort`) | Strong generalist |
| Max | Claude Sonnet 4.6 | 1M | 64K | No | Balanced quality |
| Power | GPT-5.4 | 1.05M | 128K | Yes (`reasoning_effort`) | Flagship OpenAI |
| Ultra | Claude Opus 4.6 | 1M | 128K | No | Premium Anthropic |
| Architect | Claude Opus 4.6 | 1M | 128K | No | Opus + architect system prompt |

Students select tier in extension UI; backend resolves to real provider model.

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
