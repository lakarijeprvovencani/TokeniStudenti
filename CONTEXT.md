# TokeniStudenti — Project Context

## Overview
OpenAI-compatible API proxy server that routes requests to multiple AI providers (OpenAI, Anthropic).
Designed for a student mentoring platform where students get AI coding assistance with per-user billing.

## Architecture
- **Runtime:** Node.js 18+, ES modules
- **Framework:** Express.js
- **Storage:** Redis (primary) with JSON file fallback for persistence
- **Providers:** OpenAI (GPT-5 family) and Anthropic (Claude Sonnet/Opus)
- **Deployment:** Render (vajbagent.onrender.com)
- **Client:** VajbAgent VS Code Extension (`vajbagent-vscode/`)

## Key Files
- `src/index.js` — Main server, API routes, model routing, streaming, admin dashboard
- `src/auth.js` — Student API key authentication middleware
- `src/balance.js` — Per-student balance tracking, cost calculation, deductions
- `src/convert.js` — OpenAI ↔ Anthropic message format conversion, context trimming
- `src/students.js` — Student CRUD, API key management, registration
- `src/usage.js` — Usage logging and analytics
- `src/redis.js` — Redis connection and helpers
- `public/` — Landing page and static assets

## Model System
7 model tiers mapped to backend providers:
- Lite (GPT-5 Mini), Turbo (o4 Mini), Pro (GPT-5), Max (Claude Sonnet)
- Power (GPT-5.4), Ultra (Claude Opus), Architect (Claude Opus + system prompt)

Students select a model via `model` param; the server resolves it to the real provider model.

## Billing
- Students have USD balances topped up via admin or Stripe
- Each API call: estimate tokens → calculate cost → deduct balance → log usage
- Pricing per million tokens (input/output) defined in `src/balance.js`

## Admin
- `/admin/*` routes — protected by ADMIN_SECRET env var
- Dashboard: student management, balance top-ups, usage analytics, model stats
- Self-registration endpoint for students with anti-abuse (IP limiting)

## API
- `POST /v1/chat/completions` — Main endpoint (OpenAI-compatible)
- Supports: streaming (SSE), tool/function calling, vision (images)
- Context trimming: automatically trims conversation to fit model limits

## VS Code Extension (`vajbagent-vscode/`)
- Chat UI with tool calling (read/write/search files, execute commands, fetch URLs)
- Inline diff preview with accept/reject
- Auto-approve settings, chat history, context token counter
- Connects to this backend using the same student API keys
