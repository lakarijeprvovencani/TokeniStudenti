# TokeniStudenti — Project Context

## Overview
OpenAI-compatible API proxy server that routes requests to multiple AI providers (OpenAI, Anthropic).
Designed for a student mentoring platform where students get AI coding assistance with per-user billing.
The primary product is the **VajbAgent VS Code Extension** — works in VS Code, Cursor (including free tier), and any VS Code fork.

## Architecture
- **Runtime:** Node.js 18+, ES modules
- **Framework:** Express.js
- **Storage:** Redis (primary) with JSON file fallback for persistence
- **Providers:** OpenAI (GPT-5 family) and Anthropic (Claude Sonnet/Opus)
- **Deployment:** Render (vajbagent.onrender.com)
- **Client:** VajbAgent VS Code Extension (`vajbagent-vscode/`)

## Key Files

### Backend
- `src/index.js` — Main server, API routes, model routing, streaming, admin dashboard
- `src/auth.js` — Student API key authentication middleware
- `src/balance.js` — Per-student balance tracking, cost calculation, pricing per model
- `src/convert.js` — OpenAI ↔ Anthropic message format conversion, context trimming, `MODEL_INPUT_LIMITS`
- `src/students.js` — Student CRUD, API key management, registration
- `src/usage.js` — Usage logging and analytics
- `src/utils.js` — Shared utilities (IP normalization, whitelist)
- `src/redis.js` — Redis connection and helpers

### Frontend
- `public/index.html` — Landing page (extension-first messaging, comparison with Cursor/Cline)
- `public/admin.html` — Admin dashboard (student management, balance, usage stats)
- `public/dashboard.html` — Student panel (API key, setup instructions, usage)

### Extension (`vajbagent-vscode/`)
- `src/extension.ts` — Entry point, command registration
- `src/agent.ts` — Core agent loop, conversation history, API calls, system prompt, context estimation
- `src/webview.ts` — Webview provider, message handling between UI and agent
- `src/settings.ts` — API key (SecretStorage), API URL, model selection, auto-approve settings
- `src/tools.ts` — Tool implementations (read/write/search files, execute commands, fetch URLs, diff preview)
- `media/chat.html` — Full chat UI (markdown rendering, tool blocks, settings panel, history, welcome screen)
- `media/vajb-logo.png` — Branding logo

### Docs
- `docs/ADDING_MODELS.md` — Guide for adding/changing model tiers (backend + extension)

## Model System
7 model tiers mapped to backend providers:

| Tier | Backend Model | Context | Notes |
|------|--------------|---------|-------|
| Lite | GPT-5 Mini | 400K | Cheapest, fast |
| Turbo | o4-mini | 200K | Reasoning model |
| Pro | GPT-5 | 400K | Strong generalist |
| Max | Claude Sonnet 4.6 | 200K | Balanced quality |
| Power | GPT-5.4 | 1.05M | Largest context |
| Ultra | Claude Opus 4.6 | 200K | Premium quality |
| Architect | Claude Opus 4.6 | 200K | Opus + architect system prompt |

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
- Supports: streaming (SSE), tool/function calling, vision (images)
- Context trimming: automatically trims conversation to fit model limits (`MODEL_INPUT_LIMITS` in `src/convert.js`)

## Extension Features (Current)
- **Chat UI** with streaming markdown (tables, code blocks, headings, lists, blockquotes)
- **7 agent tools:** `read_file`, `write_file`, `replace_in_file`, `list_files`, `search_files`, `execute_command`, `fetch_url`
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

## Planned Features

### Web Search Tool (next)
- New `web_search` tool for the agent to search the internet
- Backend endpoint that calls a search API (Tavily, SerpAPI, or Brave Search)
- Agent gets search results and can then use `fetch_url` to read specific pages
- Enables answering questions about latest docs, libraries, APIs, error messages
- Relatively simple: one new tool definition + one backend route

### MCP Support (Model Context Protocol)
- Allow users to connect MCP servers to the extension
- Extension acts as MCP client, communicating via stdio or SSE
- User configures MCP servers in extension settings (similar to Cursor/Claude Desktop)
- Agent automatically discovers and can invoke MCP tools
- Enables integrations with databases, GitHub, Slack, custom APIs, etc.
- Larger effort: requires MCP client implementation, server lifecycle management, tool discovery, config UI

## Branding
- **Name:** VajbAgent (Vajb in white, Agent in orange)
- **Accent color:** #FA7315 (orange)
- **Creator:** Nemanja Lakic
- **Platform:** Vajb <kodiranje/> Mentorski
