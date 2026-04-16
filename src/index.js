import 'dotenv/config';

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
// Uncaught exceptions leave the process in an undefined state — log and exit
// so Render's supervisor can restart cleanly instead of serving traffic from a
// half-dead worker. 30s grace window lets in-flight SSE streams flush.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (exiting in 30s):', err);
  setTimeout(() => process.exit(1), 30_000).unref();
});

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { requireStudentAuth, requireAuth, createSession, destroySession, setSessionCookie, clearSessionCookie, parseCookies, validateSession, keyId, publicUserId } from './auth.js';
import {
  openAIToAnthropicMessages,
  openAIToolsToAnthropic,
  toOpenAIChatCompletion,
  toOpenAIStreamChunk,
  toOpenAIStreamChunkToolCallDelta,
  toOpenAIStreamChunkToolCalls,
  streamDone,
  trimOpenAIMessages,
} from './convert.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logUsage, getUsageSummary, getUsageForKey, getModelStats } from './usage.js';
import { getBalance, deductBalance, costUsd, costUsdWithCache, addBalance, getTotalDeposited, loadStudentMarkupFlags, setStudentNoMarkup, getStudentMarkup, providerCostUsd, getPrices } from './balance.js';
import { seedFromEnv, getAllStudents, addStudent, removeStudent, toggleStudent, toggleStudentMarkup, findByKey, findByEmail, canRegisterFromIP, trackRegistrationIP, addStudentWithPassword, authenticateWithPassword, setStudentPassword, studentHasPassword } from './students.js';
import { sendWelcomeEmail, sendRecoveryEmail, isEmailConfigured } from './email.js';
import * as supabaseOAuth from './supabaseOAuth.js';
import * as githubOAuth from './githubOAuth.js';
import * as netlifyOAuth from './netlifyOAuth.js';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

try {
  await seedFromEnv();
} catch (err) {
  console.error('FATAL: Failed to initialize:', err.message);
  process.exit(1);
}

// Load student markup flags from storage
try {
  const allStudentsInit = await getAllStudents();
  loadStudentMarkupFlags(allStudentsInit);
} catch (err) {
  console.error('WARNING: Failed to load students:', err.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---- Model registry: 7 tiers (OpenAI GPT-5 + Anthropic) ----
const MAX_OUTPUT = {
  'gpt-5-mini':        128000,   // verified: developers.openai.com/api/docs/models/gpt-5-mini
  'o4-mini':           100000,
  'gpt-5':             128000,   // verified: developers.openai.com/api/docs/models/gpt-5
  'claude-haiku-4-5':  64000,    // verified: Anthropic docs — 64K output, 200K context
  'claude-sonnet-4-6': 64000,    // verified: platform.claude.com/docs/en/about-claude/models/overview
  'gpt-5.4':           128000,   // verified: developers.openai.com/api/docs/models/gpt-5.4
  'claude-opus-4-6':   128000,   // verified: platform.claude.com/docs/en/about-claude/models/overview
  // Legacy (fallback)
  'gpt-4.1-mini':      32768,    // verified: developers.openai.com/api/docs/models/gpt-4.1
  'gpt-4.1':           32768,    // verified: developers.openai.com/api/docs/models/gpt-4.1
};

const VAJB_MODELS = [
  { id: 'vajb-agent-lite',      name: 'VajbAgent Lite',      backend: 'openai',    backendModel: 'gpt-5-mini',      desc: 'GPT-5 Mini — svakodnevno kodiranje, best value' },
  { id: 'vajb-agent-turbo',     name: 'VajbAgent Turbo',     backend: 'anthropic', backendModel: 'claude-haiku-4-5', desc: 'Claude Haiku 4.5 — brz, jeftin, jak tool-caller' },
  { id: 'vajb-agent-pro',       name: 'VajbAgent Pro',       backend: 'openai',    backendModel: 'gpt-5',            desc: 'GPT-5 — ozbiljniji projekti, jak i pametan' },
  { id: 'vajb-agent-max',       name: 'VajbAgent Max',       backend: 'anthropic', backendModel: 'claude-sonnet-4-6', desc: 'Claude Sonnet — kompleksni zadaci' },
  { id: 'vajb-agent-power',     name: 'VajbAgent Power',     backend: 'openai',    backendModel: 'gpt-5.4',          desc: 'GPT-5.4 — najjači OpenAI, flagship' },
  { id: 'vajb-agent-ultra',     name: 'VajbAgent Ultra',     backend: 'anthropic', backendModel: 'claude-opus-4-6',   desc: 'Claude Opus — premium Anthropic' },
  { id: 'vajb-agent-architect', name: 'VajbAgent Architect', backend: 'anthropic', backendModel: 'claude-opus-4-6',   desc: 'Opus Architect — full-stack arhitekta', isPower: true },
];
const DEFAULT_VAJB_MODEL = VAJB_MODELS[0].id;

const MODEL_ALIASES = {
  'vajb-agent-power-old': 'vajb-agent-architect',
};

function resolveModel(requestedModel) {
  const id = (requestedModel || '').trim();
  if (!id) return null;
  const resolved = MODEL_ALIASES[id] || id;
  return VAJB_MODELS.find((m) => m.id === resolved) || null;
}

// ---- API Key Pools ----
const openaiKeys = (process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const anthropicKeys = (process.env.ANTHROPIC_API_KEYS || process.env.ANTHROPIC_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);

if (openaiKeys.length === 0) console.warn('No OpenAI API keys configured; OpenAI models will fail.');
if (anthropicKeys.length === 0) console.warn('No Anthropic API keys configured; Anthropic models will fail.');

const openaiPool = openaiKeys.map(key => ({ client: new OpenAI({ apiKey: key }), active: 0 }));
const anthropicPool = anthropicKeys.map(key => ({ client: new Anthropic({ apiKey: key }), active: 0 }));

function acquireFromPool(pool, provider) {
  if (pool.length === 0) throw Object.assign(new Error(`No ${provider} API keys configured`), { status: 503 });
  if (pool.length === 1) { pool[0].active++; return pool[0]; }
  const entry = pool.reduce((best, curr) => curr.active < best.active ? curr : best);
  entry.active++;
  return entry;
}

function releaseFromPool(entry) {
  entry.active = Math.max(0, entry.active - 1);
}

// ---- VajbAgent System Prompt ----
const VAJB_SYSTEM_PROMPT = `# ROLE: VajbAgent - Autonomous Coding Assistant

You are VajbAgent, an AI assistant for "vibe coders" - people who code by feel, not formal training.

## CORE RULES:

### 1. THINK FIRST
Before making changes:
- Analyze the existing code structure
- Understand how files connect
- Plan minimal changes needed

### 2. EXPLORE BEFORE EDITING
If tools are available (read_file, list_files, etc.):
- USE THEM to understand the project
- Don't guess file paths or structure
- Look at existing patterns before adding new code

### 3. MINIMAL CHANGES ONLY
- Edit ONLY what's needed for the request
- Do NOT rewrite entire files
- Preserve existing comments, formatting, style
- Match the existing code patterns

### 4. USE TOOLS WHEN AVAILABLE
- If you have terminal access, run commands directly
- If you can edit files, edit them - don't just show code
- Use web_search for up-to-date info (latest docs, library versions, error messages, APIs)
- After web_search, use fetch_url to read specific pages from the results
- Act, don't just explain

### 5. HANDLE ERRORS
- If something fails, try to fix it
- Read error messages carefully
- Suggest solutions, not just problems

### 6. PROJECT CONTEXT (IMPORTANT!)
When file tools are available:

**AT START:**
- Check if \`CONTEXT.md\` exists in root folder
- If YES: Read it first to understand project history and structure
- If NO: Note that you should create it after completing the task

**CONTEXT.md FORMAT:**
\`\`\`markdown
# Project Context

## Overview
[What this project does]

## Tech Stack
[Languages, frameworks, tools]

## Structure
[Key folders and files]

## Recent Changes
- [Date]: [What was changed]

## Notes
[Important info for future sessions]
\`\`\`

**AT END:**
- If you made significant changes, update or create CONTEXT.md
- Add what you did to "Recent Changes" section
- Keep it concise but useful for next session

## STYLE:
- Be concise. Act more, talk less.
- Use the user's language (Serbian OK).
- You are the engine; the user is the pilot.
`;

// ---- Power Agent System Prompt (Full-Stack Architect) ----
const POWER_SYSTEM_PROMPT = `# VajbAgent Architect — Premium Full-Stack Agent

You are VajbAgent Architect, the most capable agent in the VajbAgent lineup. You are a senior full-stack architect powered by the strongest model. You NEVER give up, NEVER leave work unfinished, and NEVER produce incomplete code.

## ABSOLUTE RULES — NEVER BREAK THESE:

1. ALWAYS FINISH WHAT YOU START. If you begin writing a file, write it COMPLETELY. If you start a task, finish it. NEVER stop halfway.
2. WRITE COMPLETE CODE. When using write_file, write the ENTIRE file — every line. NEVER use "// ... rest of the code", "// existing code", or any truncation pattern. An incomplete write_file DESTROYS the user's code.
3. READ EVERY TOOL RESULT. After EVERY tool call, READ the output before proceeding. If it says error — it IS an error, fix it immediately. NEVER claim success without proof.
4. RECOVER FROM ERRORS. If a command fails, READ the error, understand WHY, and try a DIFFERENT approach. If "npm run dev" fails, read package.json and find the correct script. NEVER retry the exact same failing command. After 2 failed attempts with different approaches, STOP and explain.
5. ALWAYS END WITH A MESSAGE. After your last tool call, ALWAYS write a final response to the user. NEVER end with silence.
6. ACT, DON'T EXPLAIN. When the user asks you to build, fix, or create something — DO IT with tools. Don't just show code in chat. When asked for review or opinion — analyze first, then ask before changing.

## YOUR EXPERTISE:

You have deep knowledge across the full stack:
- Backend: Node.js, Express, APIs, auth (JWT, sessions, Supabase RLS), database design, Stripe payments
- Frontend: React, Next.js, HTML/CSS/JS, Tailwind, responsive design, state management, animations
- DevOps: Docker, CI/CD, Vercel, environment configs, deployment
- Security: Input validation, sanitization, never trust client data, never expose secrets
- Architecture: Clean separation of concerns, scalable file structure, reusable components

## HOW TO WORK:

1. UNDERSTAND first — what does the user actually want?
2. READ existing code before editing — understand patterns, conventions, tech stack
3. PLAN your changes — think about what files need to change and in what order
4. EXECUTE efficiently — make changes with minimal tool calls, but NEVER skip necessary steps
5. VERIFY your work — run the build, start the server, curl the endpoint. READ the output to confirm it works
6. When editing existing files — match the project's style, patterns, and conventions. Don't introduce new patterns unnecessarily
7. Check \`.vajbagent/CONTEXT.md\` if available for project history and decisions

## QUALITY — CHECK BEFORE FINISHING:
- Does it work? Did you verify with actual tool output?
- Is the code complete? No truncation, no placeholders?
- Security: no hardcoded secrets, inputs validated where needed?
- If UI change: responsive, accessible, matches project style?

## STYLE:
- Be thorough but concise in explanations
- Use Serbian if the user writes in Serbian
- You are the premium agent — deliver premium results
`;

function injectSystemPrompt(messages, isPower = false) {
  if (!messages || messages.length === 0) return messages;
  
  const prompt = isPower ? POWER_SYSTEM_PROMPT : VAJB_SYSTEM_PROMPT;
  const hasSystemMsg = messages.some(m => (m.role || '').toLowerCase() === 'system');
  
  if (hasSystemMsg) {
    return messages.map(m => {
      if ((m.role || '').toLowerCase() === 'system') {
        const existingContent = typeof m.content === 'string' ? m.content : '';
        return { ...m, content: prompt + '\n\n---\n\n' + existingContent };
      }
      return m;
    });
  } else {
    return [{ role: 'system', content: prompt }, ...messages];
  }
}

async function withRetry(fn, { retries = 3, delayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      
      if (!result) {
        throw new Error('Empty response from model');
      }
      
      return result;
    } catch (err) {
      const status = err.status || err.statusCode || 0;
      const msg = (err.message || '').toLowerCase();
      
      const isRateLimit = status === 429;
      const retryable = 
        isRateLimit ||
        status === 529 || 
        status === 503 ||
        status === 502 ||
        status === 504 ||
        msg.includes('timeout') ||
        msg.includes('econnreset') ||
        msg.includes('econnrefused') ||
        msg.includes('network') ||
        msg.includes('empty response') ||
        msg.includes('socket hang up');
      
      if (!retryable || attempt >= retries) throw err;
      
      const baseDelay = isRateLimit ? 3000 : delayMs;
      const wait = baseDelay * Math.pow(2, attempt);
      console.log(`Retrying after error: ${status || msg} (attempt ${attempt + 1}/${retries}, wait ${Math.round(wait)}ms)`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const strA = String(a);
  const strB = String(b);
  const hashA = crypto.createHash('sha256').update(strA).digest();
  const hashB = crypto.createHash('sha256').update(strB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Trust only one proxy hop (Render sits in front) — prevents XFF spoofing
// which would otherwise let an attacker bypass IP-based rate limits / registration caps.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS: strict allowlist ────────────────────────────────────────────────
// Production origins can be set via WEB_ORIGINS env var (comma-separated).
// The default list includes vajbagent.com + the web app deploy and local dev.
// IMPORTANT: never fall through to `cb(null, true)` when credentials are allowed —
// that would let any site read authenticated responses (session cookie hijack / api key exfiltration).
const DEFAULT_ALLOWED_ORIGINS = [
  'https://vajbagent.com',
  'https://www.vajbagent.com',
  'https://vajbagent.netlify.app',
  'https://papaya-cat-45b818.netlify.app',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
];
// WEB_ORIGINS env var adds to the default list — never replaces it.
// A stale env value that forgets vajbagent.com used to break the
// whole web UI (SPA assets served with crossorigin attribute got 500
// when the CORS check rejected the origin → fell through to the
// global error handler with application/json response).
const ALLOWED_ORIGINS = Array.from(new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.WEB_ORIGINS ? process.env.WEB_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : []),
]));

// Allow Netlify deploy preview URLs for both the new branded site and the
// legacy papaya-cat deploy.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-f0-9]+--vajbagent\.netlify\.app$/,
  /^https:\/\/[a-f0-9]+--papaya-cat-45b818\.netlify\.app$/,
];

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin));
}

app.use(cors({
  origin: (origin, cb) => {
    // Requests with no Origin header (curl, server-to-server, extension) are allowed
    // but the `credentials` flag for the response header is set to false in that case
    // (since there's no cookie to protect). This is safe for Bearer-token auth.
    if (!origin) return cb(null, true);
    if (isOriginAllowed(origin)) return cb(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Secret'],
  maxAge: 600,
}));

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && auth.length > 12) return 'key:' + auth.slice(7, 27);
    return 'ip:' + (req.ip || 'unknown');
  },
  validate: false,
  handler: (_req, res) => res.status(429).json({ error: { message: 'Previše zahteva. Pokušaj ponovo za par minuta.', code: 'rate_limit' } }),
});

// Per-email login limiter — blocks credential stuffing across many accounts
// from a single IP. 8 attempts per email per 10 minutes.
const loginEmailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body?.email || '').toString().trim().toLowerCase();
    return 'email:' + (email || req.ip || 'unknown');
  },
  validate: false,
  skip: (req) => !req.body?.email,
  handler: (_req, res) => res.status(429).json({ error: 'Previše pokušaja prijave za ovaj email. Pokušaj ponovo za 10 minuta.' }),
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  handler: (_req, res) => res.status(429).json({ error: { message: 'Previše admin zahteva. Sačekaj 1 minut.', code: 'rate_limit' } }),
});

import { normalizeIP, WHITELIST_IPS } from './utils.js';

function isWhitelistedIP(req) {
  const raw = req.ip || req.connection?.remoteAddress || '';
  return WHITELIST_IPS.has(normalizeIP(raw));
}

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isWhitelistedIP(req),
  handler: (_req, res) => res.status(429).json({ error: 'Previše registracija. Pokušaj ponovo za sat vremena.' }),
});

app.use((req, res, next) => {
  let logPath = req.path;
  // Redact any sensitive query params if they ever appear (defense-in-depth — server now
  // only accepts admin secrets in headers).
  if (req.query.secret || req.query.admin_secret || req.query.key || req.query.token) {
    logPath = req.path + '?[redacted]';
  }
  const ip = normalizeIP(req.ip || req.connection?.remoteAddress || '?');
  if (logPath.includes('register')) {
    console.log(`${req.method} ${logPath} [IP: ${ip}, raw: ${req.ip}, xff: ${req.headers['x-forwarded-for'] || 'none'}]`);
  } else {
    console.log(`${req.method} ${logPath}`);
  }
  next();
});

// ---- Stripe webhook (raw body before express.json) ----
import { getRedis } from './redis.js';

const STRIPE_EVENTS_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'stripe-events.json');
const STRIPE_EVENT_TTL = 24 * 60 * 60 * 1000;
const STRIPE_REDIS_KEY = 'vajb:stripe_events';

function readStripeEventsFile() {
  try {
    if (!fs.existsSync(STRIPE_EVENTS_FILE)) return {};
    return JSON.parse(fs.readFileSync(STRIPE_EVENTS_FILE, 'utf8')) || {};
  } catch { return {}; }
}
function writeStripeEventsFile(events) {
  const dir = path.dirname(STRIPE_EVENTS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STRIPE_EVENTS_FILE, JSON.stringify(events, null, 2), 'utf8');
}
async function isStripeEventProcessed(eventId) {
  const r = getRedis();
  if (r) {
    try {
      // Use a dedicated per-event key instead of one big object — no race.
      const exists = await r.get(`vajb:stripe_event:${eventId}`);
      if (exists) return true;
    } catch {}
  }
  const file = readStripeEventsFile();
  return !!file[eventId];
}

/**
 * Atomically claims a Stripe event for processing. Returns true ONLY if this
 * call is the first to see the event — concurrent webhook deliveries cannot
 * both return true, preventing double-credit bugs.
 *
 * Uses Redis SET with NX + EX. Falls back to file mode (non-atomic) if Redis is unavailable.
 */
async function claimStripeEvent(eventId) {
  const r = getRedis();
  if (r) {
    try {
      // Upstash compat: SET key value NX EX ttl
      const result = await r.set(`vajb:stripe_event:${eventId}`, String(Date.now()), { nx: true, ex: STRIPE_EVENT_TTL / 1000 });
      return result === 'OK' || result === true || result === 1;
    } catch (err) {
      console.warn('[stripe] redis claim failed, falling back to file:', err.message);
    }
  }
  // Fallback: file mode (non-atomic — only used when Redis isn't configured at all)
  const file = readStripeEventsFile();
  if (file[eventId]) return false;
  file[eventId] = Date.now();
  // Clean expired entries
  const now = Date.now();
  for (const [id, ts] of Object.entries(file)) {
    if (now - ts > STRIPE_EVENT_TTL) delete file[id];
  }
  try { writeStripeEventsFile(file); } catch {}
  return true;
}

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  console.log('Stripe webhook received:', { hasBody: !!req.body, bodyLen: req.body?.length, hasSig: !!req.headers['stripe-signature'] });
  const Stripe = (await import('stripe')).default;
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!secret || !stripeKey) {
    console.warn('STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY not set');
    return res.status(500).send('Webhook not configured');
  }
  let event;
  try {
    const stripe = new Stripe(stripeKey);
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).send();
  }
  // Atomically claim the event — if another concurrent webhook delivery already
  // claimed it, we exit without crediting (prevents double-credit on retries).
  const claimed = await claimStripeEvent(event.id);
  if (!claimed) {
    console.log('Stripe webhook: duplicate event ignored', event.id);
    return res.status(200).send();
  }

  const session = event.data.object;
  if (session.payment_status !== 'paid') {
    console.warn('Stripe webhook: session not paid', { status: session.payment_status });
    return res.status(200).send();
  }
  const keyId = session.metadata?.key_id;
  const amountCents = session.amount_total;
  if (!keyId || typeof keyId !== 'string' || keyId.length < 3) {
    console.warn('Stripe webhook: invalid key_id', { key_id: keyId });
    return res.status(200).send();
  }
  if (!amountCents || amountCents <= 0 || amountCents > 100000) {
    console.warn('Stripe webhook: invalid amount', { amount_total: amountCents });
    return res.status(200).send();
  }
  const amountUsd = Math.round((amountCents / 100) * 100) / 100;
  await addBalance(keyId.trim(), amountUsd);
  console.log('Credits added via Stripe', { key_id: keyId.slice(0, 8) + '...', amount_usd: amountUsd });
  res.status(200).send();
}));

app.use(express.json({ limit: '20mb' }));
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Payload prevelik. Max 10MB.', code: 'payload_too_large' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Neispravan JSON.', code: 'invalid_json' } });
  }
  next(err);
});

// ---- Web app (primary landing — bolt-style AI coder) ----
// We serve the built Vite bundle from vajbagent-web/dist.
// WebContainers need cross-origin isolation headers on the document AND
// on every static asset; we set them on the dist/ static middleware and
// on the / route handler.
const WEB_APP_DIST = path.join(__dirname, '..', 'vajbagent-web', 'dist');
const WEB_APP_INDEX = path.join(WEB_APP_DIST, 'index.html');

// Safety net: Render's Build Command is pinned to `npm install` and the
// Start Command runs `node src/index.js` directly, bypassing npm's
// pre/postinstall hooks. If the SPA bundle is missing at boot, build it
// in-process synchronously so the `/` handler has something to serve.
if (!fs.existsSync(WEB_APP_INDEX)) {
  try {
    const { execSync } = await import('node:child_process');
    const buildScript = path.join(__dirname, '..', 'scripts', 'postinstall.js');
    if (fs.existsSync(buildScript)) {
      console.log('[web-app] dist/index.html missing — building SPA in-process…');
      execSync(`node "${buildScript}"`, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    }
  } catch (err) {
    console.error('[web-app] In-process build failed — will fall back to extenzija.html:', err.message);
  }
}
const webAppIndexExists = fs.existsSync(WEB_APP_INDEX);

function setWebAppHeaders(res) {
  // credentialless matches what Netlify was serving and keeps 3rd-party
  // resources (images, fonts) loadable without CORP headers on their side.
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

// WebContainers on vajbagent.com requires each visitor to complete a
// StackBlitz OAuth popup (free tier behavior — auth.init returns
// {status:'need-auth'} on non-grandfathered origins). That's unusable
// for a public product, so the root is redirected to the Netlify
// deploy where WebContainers "just works" via the *.netlify.app
// grandfathered origin. Flip WEB_APP_AT_ROOT=1 on Render once a
// StackBlitz Enterprise/OSS license for vajbagent.com is approved
// and the SPA will be served locally again.
const WEB_APP_AT_ROOT = process.env.WEB_APP_AT_ROOT === '1';
const WEB_APP_REDIRECT_URL = (process.env.WEB_APP_REDIRECT_URL || 'https://vajbagent.netlify.app').replace(/\/$/, '');

app.get('/', (req, res) => {
  if (!WEB_APP_AT_ROOT) {
    const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res.redirect(302, WEB_APP_REDIRECT_URL + '/' + qs);
  }
  if (webAppIndexExists) {
    setWebAppHeaders(res);
    return res.sendFile(path.join(WEB_APP_DIST, 'index.html'));
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'extenzija.html'));
});
app.head('/', (_req, res) => res.status(200).end());

// Serve the hashed JS/CSS assets from vajbagent-web/dist with COOP/COEP
if (webAppIndexExists) {
  app.use(express.static(WEB_APP_DIST, {
    index: false,
    setHeaders: (res, filePath) => {
      setWebAppHeaders(res);
      // Hashed assets are immutable — long cache. Non-hashed index.html
      // should never be fetched from here (/, above, serves it).
      if (/-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpg|jpeg|gif|webp)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
}

// ---- Cursor/VS Code extension landing (moved from `/` on 2026-04-14) ----
app.get('/extenzija', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'extenzija.html'));
});

// ---- Models list ----
const modelsResponse = () => ({
  object: 'list',
  data: VAJB_MODELS.map((m) => ({
    id: m.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'vajb-agent',
  })),
});
app.get('/v1/models', (_req, res) => res.json(modelsResponse()));
app.get('/models', (_req, res) => res.json(modelsResponse()));

// ---- Admin: model info (only for you) ----
app.get('/admin/models', adminLimiter, (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json(VAJB_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    backend: m.backend,
    backendModel: m.backendModel,
    desc: m.desc,
  })));
});

// ---- Self-registration ----
// Require a real secret — never fall back to a hardcoded string (that would let
// anyone forge registration tokens and bypass anti-abuse limits).
const REGISTER_TOKEN_SECRET = process.env.REGISTER_TOKEN_SECRET || process.env.ADMIN_SECRET;
if (!REGISTER_TOKEN_SECRET || REGISTER_TOKEN_SECRET.length < 16) {
  console.error('FATAL: REGISTER_TOKEN_SECRET (or ADMIN_SECRET) must be set and ≥16 chars. Registration tokens cannot be issued safely without it.');
  process.exit(1);
}
const REGISTER_BONUS = (() => {
  const v = parseFloat(process.env.SELF_REGISTER_BONUS);
  return Number.isFinite(v) && v >= 0 ? v : 2;
})();
const REGISTER_MIN_WAIT_MS = 2000;

function createRegisterToken() {
  const ts = Date.now().toString();
  const hmac = crypto.createHmac('sha256', REGISTER_TOKEN_SECRET).update(ts).digest('hex');
  return ts + '.' + hmac;
}

function verifyRegisterToken(token) {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'bad_format' };
  const [ts, sig] = parts;
  const expected = crypto.createHmac('sha256', REGISTER_TOKEN_SECRET).update(ts).digest('hex');
  if (!safeEqual(sig, expected)) return { valid: false, reason: 'bad_signature' };
  const age = Date.now() - Number(ts);
  if (age < REGISTER_MIN_WAIT_MS) return { valid: false, reason: 'too_fast' };
  if (age > 30 * 60 * 1000) return { valid: false, reason: 'expired' };
  return { valid: true };
}

// ─── Web App Auth Routes ────────────────────────────────────────────────────

app.post('/auth/register', registerLimiter, asyncHandler(async (req, res) => {
  const { first_name, last_name, email, password } = req.body || {};

  if (!first_name || typeof first_name !== 'string' || first_name.trim().length < 2) {
    return res.status(400).json({ error: 'Ime mora imati najmanje 2 karaktera.' });
  }
  if (!last_name || typeof last_name !== 'string' || last_name.trim().length < 2) {
    return res.status(400).json({ error: 'Prezime mora imati najmanje 2 karaktera.' });
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Unesite ispravnu email adresu.' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Lozinka mora imati najmanje 8 karaktera.' });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: 'Lozinka je predugačka.' });
  }

  const clientIP = normalizeIP(req.ip || req.connection?.remoteAddress || 'unknown');
  const canReg = await canRegisterFromIP(clientIP);
  if (!canReg) {
    return res.status(403).json({ error: 'Maksimalan broj naloga sa ove adrese je dostignut.' });
  }

  const fullName = first_name.trim() + ' ' + last_name.trim();
  const result = await addStudentWithPassword(fullName, email.trim(), password);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  if (REGISTER_BONUS > 0) {
    await addBalance(result.student.key, REGISTER_BONUS);
  }
  await trackRegistrationIP(clientIP);

  // Create session & set cookie
  const session = await createSession(result.student.key);
  setSessionCookie(res, session.token);

  console.log(`[Auth] Registered: "${fullName}" <${result.student.email}> [IP: ${clientIP}]`);
  const regBal = await getBalance(result.student.key);
  const regDep = await getTotalDeposited(result.student.key);
  const regBonusVal = parseFloat(process.env.SELF_REGISTER_BONUS) || 2;
  res.json({
    name: result.student.name,
    email: result.student.email,
    user_id: publicUserId(result.student.key),
    balance_usd: regBal,
    free_tier: regDep <= regBonusVal,
  });
}));

app.post('/auth/login', loginEmailLimiter, authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email i lozinka su obavezni.' });
  }

  const student = await authenticateWithPassword(email.trim(), password);
  if (!student) {
    // Check if student exists but has no password (old account)
    const exists = await findByEmail(email.trim());
    if (exists && !exists.password_hash) {
      return res.status(400).json({ error: 'Ovaj nalog nema postavljenu lozinku. Koristi "Postavi lozinku" opciju.' });
    }
    return res.status(401).json({ error: 'Pogrešan email ili lozinka.' });
  }

  const session = await createSession(student.key);
  setSessionCookie(res, session.token);

  console.log(`[Auth] Login: "${student.name}" <${student.email}>`);
  const loginBal = await getBalance(student.key);
  const loginDep = await getTotalDeposited(student.key);
  const loginBonusVal = parseFloat(process.env.SELF_REGISTER_BONUS) || 2;
  res.json({
    name: student.name,
    email: student.email,
    user_id: publicUserId(student.key),
    balance_usd: loginBal,
    free_tier: loginDep <= loginBonusVal,
  });
}));

app.post('/auth/logout', asyncHandler(async (_req, res) => {
  const cookies = parseCookies(_req);
  if (cookies.vajb_session) await destroySession(cookies.vajb_session);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.get('/auth/me', authLimiter, requireAuth, asyncHandler(async (req, res) => {
  const balance = await getBalance(req.studentApiKey);
  const deposited = await getTotalDeposited(req.studentApiKey);
  const regBonus = parseFloat(process.env.SELF_REGISTER_BONUS) || 2;
  // Only return the raw api_key when explicitly requested via ?include_key=1
  // AND authenticated via the session cookie (not Bearer — Bearer already has it).
  const cookies = parseCookies(req);
  const includeKey = req.query.include_key === '1' && !!cookies.vajb_session;
  res.json({
    name: req.studentName,
    // Stable, non-secret user identifier — sha256-prefix of the student key,
    // safe to expose to the SPA for scoping browser-side storage (projects,
    // secrets) per user so two people sharing a browser profile never see
    // each other's data, and a leaked localStorage dump can't be replayed as
    // a Bearer token.
    user_id: publicUserId(req.studentApiKey),
    balance_usd: balance,
    free_tier: deposited <= regBonus,
    ...(includeKey && { api_key: req.studentApiKey }),
  });
}));

app.post('/auth/set-password', authLimiter, asyncHandler(async (req, res) => {
  const { email, current_key, new_password } = req.body || {};

  if (!email || !current_key || !new_password) {
    return res.status(400).json({ error: 'Email, API ključ i nova lozinka su obavezni.' });
  }

  const student = await findByEmail(email.trim());
  if (!student || student.key !== current_key.trim()) {
    return res.status(401).json({ error: 'Pogrešan email ili API ključ.' });
  }

  const result = await setStudentPassword(student.key, new_password);
  if (result.error) return res.status(400).json({ error: result.error });

  // Invalidate any existing sessions for this key — a stolen session cookie
  // must not survive a password change.
  try {
    const { destroyAllSessionsForKey } = await import('./auth.js');
    await destroyAllSessionsForKey(student.key);
  } catch (e) { console.warn('[set-password] destroyAllSessionsForKey failed:', e.message); }

  // Create fresh session
  const session = await createSession(student.key);
  setSessionCookie(res, session.token);

  console.log(`[Auth] Password set: "${student.name}" <${student.email}>`);
  res.json({ ok: true, name: student.name });
}));

// ─── Supabase OAuth Integration ─────────────────────────────────────────────

// Public check — no auth required, just "is OAuth enabled on this server"
app.get('/api/supabase/config-check', (_req, res) => {
  res.json({ configured: supabaseOAuth.isSupabaseOAuthConfigured() });
});

// Start OAuth flow — redirects user to Supabase login
app.get('/auth/supabase/start', requireAuth, asyncHandler(async (req, res) => {
  if (!supabaseOAuth.isSupabaseOAuthConfigured()) {
    return res.status(503).json({ error: 'Supabase OAuth not configured on backend' });
  }
  try {
    const url = supabaseOAuth.buildAuthorizeUrl(req.studentApiKey);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// OAuth callback — Supabase redirects user back here after authorization
app.get('/auth/supabase/callback', asyncHandler(async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const pageShell = (inner) => `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<title>VajbAgent — Supabase</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: radial-gradient(circle at top, #1a1a1f 0%, #0a0a0d 60%);
    color: #fff;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    max-width: 460px;
    width: 100%;
    background: rgba(24, 24, 30, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 44px 36px;
    text-align: center;
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(20px);
  }
  .icon {
    width: 72px; height: 72px;
    margin: 0 auto 20px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 20px;
    font-size: 38px;
  }
  .icon.success {
    background: linear-gradient(135deg, rgba(62, 207, 142, 0.2), rgba(62, 207, 142, 0.05));
    border: 1px solid rgba(62, 207, 142, 0.3);
  }
  .icon.error {
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(239, 68, 68, 0.05));
    border: 1px solid rgba(239, 68, 68, 0.3);
  }
  h1 {
    font-size: 1.4rem;
    font-weight: 700;
    margin-bottom: 10px;
    letter-spacing: -0.01em;
  }
  p {
    font-size: 0.92rem;
    color: #aaa;
    line-height: 1.55;
    margin-bottom: 24px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    background: linear-gradient(135deg, #f97316, #ea580c);
    color: white;
    text-decoration: none;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 600;
    transition: all 0.2s;
    border: none;
    cursor: pointer;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(249, 115, 22, 0.35); }
  .small {
    margin-top: 18px;
    font-size: 0.76rem;
    color: #666;
  }
  code {
    background: rgba(255, 255, 255, 0.05);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.82em;
    color: #f97316;
  }
</style>
</head>
<body>
  <div class="card">${inner}</div>
</body>
</html>`;

  if (oauthError) {
    return res.send(pageShell(`
      <div class="icon error">⚠</div>
      <h1>Autorizacija odbijena</h1>
      <p>${String(oauthError).substring(0, 200)}</p>
      <button class="btn" onclick="window.close()">Zatvori</button>
    `));
  }

  if (!code || !state) {
    return res.status(400).send(pageShell(`
      <div class="icon error">⚠</div>
      <h1>Greška</h1>
      <p>Nedostaje code ili state parametar. Pokušaj ponovo.</p>
      <button class="btn" onclick="window.close()">Zatvori</button>
    `));
  }

  // Resolve the current session so we can verify the callback is the same user
  // who initiated the flow. This prevents OAuth login-CSRF.
  const _sbCookies = parseCookies(req);
  const _sbSession = _sbCookies.vajb_session ? await validateSession(_sbCookies.vajb_session) : null;
  const _sbExpectedKey = _sbSession?.studentKey || null;
  if (!_sbExpectedKey) {
    return res.status(401).send(pageShell(`
      <div class="icon error">⚠</div>
      <h1>Sesija je istekla</h1>
      <p>Moraš biti ulogovan u istom browseru da bi završio povezivanje.</p>
      <button class="btn" onclick="window.close()">Zatvori</button>
    `));
  }

  try {
    await supabaseOAuth.handleCallback(String(code), String(state), _sbExpectedKey);
    // Success — notify opener, but DO NOT close automatically.
    // User sees confirmation and clicks button to close.
    res.send(pageShell(`
      <div class="icon success">✓</div>
      <h1>Supabase je povezan!</h1>
      <p>Vraćam te u VajbAgent — možeš da nastaviš sa kreiranjem projekta. Ovaj prozor možeš zatvoriti.</p>
      <button class="btn" onclick="window.close()">Zatvori prozor</button>
      <div class="small">Ako dugme ne radi, samo zatvori tab ručno.</div>
      <script>
        // Notify opener multiple times to be safe (postMessage can fail on first try)
        function notify() {
          if (window.opener && !window.opener.closed) {
            try { window.opener.postMessage({ type: 'supabase-connected' }, '*'); } catch (e) {}
          }
        }
        notify();
        setTimeout(notify, 500);
        setTimeout(notify, 1500);
        setTimeout(notify, 3000);
      </script>
    `));
  } catch (err) {
    console.error('[Supabase OAuth] Callback error:', err.message);
    res.status(500).send(pageShell(`
      <div class="icon error">✕</div>
      <h1>Greška pri povezivanju</h1>
      <p>${String(err.message).substring(0, 300)}</p>
      <button class="btn" onclick="window.close()">Zatvori</button>
    `));
  }
}));

// Check connection status
app.get('/api/supabase/status', requireAuth, asyncHandler(async (req, res) => {
  const connected = await supabaseOAuth.isConnected(req.studentApiKey);
  res.json({ connected, configured: supabaseOAuth.isSupabaseOAuthConfigured() });
}));

// Disconnect
app.post('/api/supabase/disconnect', requireAuth, asyncHandler(async (req, res) => {
  await supabaseOAuth.disconnect(req.studentApiKey);
  res.json({ ok: true });
}));

// List user's organizations
app.get('/api/supabase/organizations', requireAuth, asyncHandler(async (req, res) => {
  try {
    const orgs = await supabaseOAuth.listOrganizations(req.studentApiKey);
    res.json({ organizations: orgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// List user's existing projects
app.get('/api/supabase/projects', requireAuth, asyncHandler(async (req, res) => {
  try {
    const projects = await supabaseOAuth.listProjects(req.studentApiKey);
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Create a new project
app.post('/api/supabase/create-project', requireAuth, asyncHandler(async (req, res) => {
  const { orgId, name, region } = req.body || {};
  if (!orgId || !name) {
    return res.status(400).json({ error: 'orgId and name are required' });
  }
  try {
    const project = await supabaseOAuth.createProject(req.studentApiKey, { orgId, name, region });
    res.json({ project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Get credentials (URL + anon key) for a specific project
app.get('/api/supabase/credentials/:projectRef', requireAuth, asyncHandler(async (req, res) => {
  try {
    const creds = await supabaseOAuth.getProjectCredentials(req.studentApiKey, req.params.projectRef);
    res.json(creds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Run SQL against a project (for agent tools)
app.post('/api/supabase/sql', requireAuth, asyncHandler(async (req, res) => {
  const { projectRef, query } = req.body || {};
  if (!projectRef || !query) {
    return res.status(400).json({ error: 'projectRef and query are required' });
  }
  try {
    const result = await supabaseOAuth.runSql(req.studentApiKey, projectRef, query);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// List tables in a project (agent helper)
app.get('/api/supabase/tables/:projectRef', requireAuth, asyncHandler(async (req, res) => {
  try {
    const tables = await supabaseOAuth.listTables(req.studentApiKey, req.params.projectRef);
    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Describe a table's columns
app.get('/api/supabase/describe/:projectRef/:tableName', requireAuth, asyncHandler(async (req, res) => {
  try {
    const columns = await supabaseOAuth.describeTable(req.studentApiKey, req.params.projectRef, req.params.tableName);
    res.json({ columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Get auth configuration (site URL, providers, email, etc.)
app.get('/api/supabase/auth-config/:projectRef', requireAuth, asyncHandler(async (req, res) => {
  try {
    const config = await supabaseOAuth.getAuthConfig(req.studentApiKey, req.params.projectRef);
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Update auth configuration
app.patch('/api/supabase/auth-config/:projectRef', requireAuth, asyncHandler(async (req, res) => {
  const config = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'config object required' });
  }
  try {
    const result = await supabaseOAuth.updateAuthConfig(req.studentApiKey, req.params.projectRef, config);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ─── Edge Functions ─────────────────────────────────────────────────────────

// List all edge functions
app.get('/api/supabase/functions/:projectRef', requireAuth, asyncHandler(async (req, res) => {
  try {
    const functions = await supabaseOAuth.listFunctions(req.studentApiKey, req.params.projectRef);
    res.json({ functions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Get function body
app.get('/api/supabase/functions/:projectRef/:slug/body', requireAuth, asyncHandler(async (req, res) => {
  try {
    const body = await supabaseOAuth.getFunctionBody(req.studentApiKey, req.params.projectRef, req.params.slug);
    res.json({ body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Deploy (create or update) function
app.post('/api/supabase/functions/:projectRef/deploy', requireAuth, asyncHandler(async (req, res) => {
  const { slug, name, body, verify_jwt } = req.body || {};
  if (!slug || !body) {
    return res.status(400).json({ error: 'slug and body are required' });
  }
  try {
    const result = await supabaseOAuth.deployFunction(req.studentApiKey, req.params.projectRef, {
      slug,
      name,
      body,
      verify_jwt: verify_jwt !== false,
    });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Delete function
app.delete('/api/supabase/functions/:projectRef/:slug', requireAuth, asyncHandler(async (req, res) => {
  try {
    const result = await supabaseOAuth.deleteFunction(req.studentApiKey, req.params.projectRef, req.params.slug);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ─── GitHub OAuth Integration ───────────────────────────────────────────────

app.get('/api/github/config-check', (_req, res) => {
  res.json({ configured: githubOAuth.isGitHubOAuthConfigured() });
});

app.get('/auth/github/start', requireAuth, asyncHandler(async (req, res) => {
  if (!githubOAuth.isGitHubOAuthConfigured()) {
    return res.status(503).json({ error: 'GitHub OAuth not configured on backend' });
  }
  try {
    const url = githubOAuth.buildAuthorizeUrl(req.studentApiKey);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.get('/auth/github/callback', asyncHandler(async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const pageShell = (icon, title, msg, color = '#3ecf8e') => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>VajbAgent — GitHub</title><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: radial-gradient(circle at top, #1a1a1f, #0a0a0d); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { max-width: 460px; width: 100%; background: rgba(24, 24, 30, 0.9); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 44px 36px; text-align: center; backdrop-filter: blur(20px); }
.icon { width: 72px; height: 72px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; border-radius: 20px; font-size: 38px; background: ${color}1a; border: 1px solid ${color}4d; color: ${color}; }
h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 10px; }
p { font-size: 0.92rem; color: #aaa; line-height: 1.55; margin-bottom: 24px; }
.btn { display: inline-flex; gap: 8px; padding: 12px 24px; background: linear-gradient(135deg, #f97316, #ea580c); color: white; border: none; border-radius: 10px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
</style></head><body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${msg}</p><button class="btn" onclick="window.close()">Zatvori prozor</button>
<script>function n(){if(window.opener&&!window.opener.closed){try{window.opener.postMessage({type:'github-connected'},'*');}catch(e){}}}n();setTimeout(n,500);setTimeout(n,1500);setTimeout(n,3000);</script>
</div></body></html>`;

  if (oauthError) {
    return res.send(pageShell('⚠', 'Autorizacija odbijena', String(oauthError).substring(0, 200), '#ef4444'));
  }
  if (!code || !state) return res.status(400).send(pageShell('⚠', 'Greška', 'Nedostaje code ili state', '#ef4444'));

  // Anti-CSRF: require a live session and pass its studentKey to handleCallback.
  const _ghCookies = parseCookies(req);
  const _ghSession = _ghCookies.vajb_session ? await validateSession(_ghCookies.vajb_session) : null;
  const _ghExpectedKey = _ghSession?.studentKey || null;
  if (!_ghExpectedKey) {
    return res.status(401).send(pageShell('⚠', 'Sesija je istekla', 'Moraš biti ulogovan u istom browseru da bi završio povezivanje.', '#ef4444'));
  }

  try {
    const result = await githubOAuth.handleCallback(String(code), String(state), _ghExpectedKey);
    res.send(pageShell('✓', 'GitHub je povezan!', `Povezan kao <strong>@${result.username || ''}</strong>. Možeš zatvoriti ovaj prozor.`));
  } catch (err) {
    console.error('[GitHub OAuth] Callback error:', err.message);
    res.status(500).send(pageShell('✕', 'Greška pri povezivanju', String(err.message).substring(0, 300), '#ef4444'));
  }
}));

app.get('/api/github/status', requireAuth, asyncHandler(async (req, res) => {
  const connected = await githubOAuth.isConnected(req.studentApiKey);
  const info = connected ? await githubOAuth.getConnectionInfo(req.studentApiKey) : null;
  res.json({ connected, configured: githubOAuth.isGitHubOAuthConfigured(), info });
}));

app.post('/api/github/disconnect', requireAuth, asyncHandler(async (req, res) => {
  await githubOAuth.disconnect(req.studentApiKey);
  res.json({ ok: true });
}));

app.get('/api/github/repos', requireAuth, asyncHandler(async (req, res) => {
  try {
    const repos = await githubOAuth.listRepos(req.studentApiKey);
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// Hard limits for push/deploy payloads — prevents OOM, abuse of GitHub/Netlify rate limits,
// and protects against payloads full of junk files.
const MAX_PUSH_FILES = 500;
// User-uploaded images arrive as base64 data URLs from the frontend, which
// inflate file size ~33% over the actual binary. 4MB keeps room for a
// ~2.8MB decoded image after resizeImage caps at 2MB. Total raised to 35MB
// to accommodate a full portfolio project with several user photos.
const MAX_PUSH_FILE_SIZE = 4_000_000;
const MAX_PUSH_TOTAL_SIZE = 35_000_000;

// Validates path: no absolute paths, no `..`, no leading slash, no null bytes.
// Reject anything that would escape the intended repo root.
function validateRepoPath(p) {
  if (typeof p !== 'string') return false;
  if (p.length === 0 || p.length > 500) return false;
  if (p.includes('\0')) return false;
  if (p.startsWith('/')) return false;
  if (p.startsWith('\\')) return false;
  if (/(^|\/)\.\.(\/|$)/.test(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // windows drive letter
  return true;
}

function validateAndLimitFiles(files) {
  if (!files || typeof files !== 'object') {
    return { error: 'files must be an object of path → content' };
  }
  const entries = Object.entries(files);
  if (entries.length === 0) return { error: 'nema fajlova' };
  if (entries.length > MAX_PUSH_FILES) {
    return { error: `Previše fajlova (maks ${MAX_PUSH_FILES}).` };
  }
  let total = 0;
  for (const [p, c] of entries) {
    if (!validateRepoPath(p)) {
      return { error: `Nevažeća putanja: ${String(p).slice(0, 80)}` };
    }
    if (typeof c !== 'string') {
      return { error: `Sadržaj fajla ${p} mora biti tekst.` };
    }
    if (c.length > MAX_PUSH_FILE_SIZE) {
      return { error: `Fajl ${p} je prevelik (maks 4MB).` };
    }
    total += c.length;
    if (total > MAX_PUSH_TOTAL_SIZE) {
      return { error: 'Ukupna veličina fajlova premašuje 35MB.' };
    }
  }
  return { ok: true };
}

app.post('/api/github/push', requireAuth, asyncHandler(async (req, res) => {
  const { repo, files, message, branch, createIfMissing } = req.body || {};
  if (!repo || typeof repo !== 'string' || repo.length > 100) {
    return res.status(400).json({ error: 'repo is required (max 100 chars)' });
  }
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(repo)) {
    return res.status(400).json({ error: 'Nevažeće ime repozitorijuma.' });
  }
  const check = validateAndLimitFiles(files);
  if (!check.ok) return res.status(400).json({ error: check.error });
  if (typeof message === 'string' && message.length > 500) {
    return res.status(400).json({ error: 'commit message is too long' });
  }
  try {
    const result = await githubOAuth.pushFiles(req.studentApiKey, {
      repo, files, message, branch, createIfMissing,
    });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ─── Netlify OAuth Integration ──────────────────────────────────────────────

app.get('/api/netlify/config-check', (_req, res) => {
  res.json({ configured: netlifyOAuth.isNetlifyOAuthConfigured() });
});

app.get('/auth/netlify/start', requireAuth, asyncHandler(async (req, res) => {
  if (!netlifyOAuth.isNetlifyOAuthConfigured()) {
    return res.status(503).json({ error: 'Netlify OAuth not configured on backend' });
  }
  try {
    const url = netlifyOAuth.buildAuthorizeUrl(req.studentApiKey);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.get('/auth/netlify/callback', asyncHandler(async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const pageShell = (icon, title, msg, color = '#00ad9f') => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>VajbAgent — Netlify</title><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: radial-gradient(circle at top, #1a1a1f, #0a0a0d); color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { max-width: 460px; width: 100%; background: rgba(24, 24, 30, 0.9); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 44px 36px; text-align: center; backdrop-filter: blur(20px); }
.icon { width: 72px; height: 72px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; border-radius: 20px; font-size: 38px; background: ${color}1a; border: 1px solid ${color}4d; color: ${color}; }
h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 10px; }
p { font-size: 0.92rem; color: #aaa; line-height: 1.55; margin-bottom: 24px; }
.btn { display: inline-flex; gap: 8px; padding: 12px 24px; background: linear-gradient(135deg, #f97316, #ea580c); color: white; border: none; border-radius: 10px; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
</style></head><body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${msg}</p><button class="btn" onclick="window.close()">Zatvori prozor</button>
<script>function n(){if(window.opener&&!window.opener.closed){try{window.opener.postMessage({type:'netlify-connected'},'*');}catch(e){}}}n();setTimeout(n,500);setTimeout(n,1500);setTimeout(n,3000);</script>
</div></body></html>`;

  if (oauthError) {
    return res.send(pageShell('⚠', 'Autorizacija odbijena', String(oauthError).substring(0, 200), '#ef4444'));
  }
  if (!code || !state) return res.status(400).send(pageShell('⚠', 'Greška', 'Nedostaje code ili state', '#ef4444'));

  // Anti-CSRF: require a live session.
  const _nlCookies = parseCookies(req);
  const _nlSession = _nlCookies.vajb_session ? await validateSession(_nlCookies.vajb_session) : null;
  const _nlExpectedKey = _nlSession?.studentKey || null;
  if (!_nlExpectedKey) {
    return res.status(401).send(pageShell('⚠', 'Sesija je istekla', 'Moraš biti ulogovan u istom browseru da bi završio povezivanje.', '#ef4444'));
  }

  try {
    const result = await netlifyOAuth.handleCallback(String(code), String(state), _nlExpectedKey);
    res.send(pageShell('✓', 'Netlify je povezan!', `Povezan kao <strong>${result.email || ''}</strong>. Možeš zatvoriti ovaj prozor.`));
  } catch (err) {
    console.error('[Netlify OAuth] Callback error:', err.message);
    res.status(500).send(pageShell('✕', 'Greška pri povezivanju', String(err.message).substring(0, 300), '#ef4444'));
  }
}));

app.get('/api/netlify/status', requireAuth, asyncHandler(async (req, res) => {
  const connected = await netlifyOAuth.isConnected(req.studentApiKey);
  const info = connected ? await netlifyOAuth.getConnectionInfo(req.studentApiKey) : null;
  res.json({ connected, configured: netlifyOAuth.isNetlifyOAuthConfigured(), info });
}));

app.post('/api/netlify/disconnect', requireAuth, asyncHandler(async (req, res) => {
  await netlifyOAuth.disconnect(req.studentApiKey);
  res.json({ ok: true });
}));

app.get('/api/netlify/sites', requireAuth, asyncHandler(async (req, res) => {
  try {
    const sites = await netlifyOAuth.listSites(req.studentApiKey);
    res.json({ sites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.post('/api/netlify/deploy', requireAuth, asyncHandler(async (req, res) => {
  const { files, siteId, siteName } = req.body || {};
  const check = validateAndLimitFiles(files);
  if (!check.ok) return res.status(400).json({ error: check.error });
  if (siteId && (typeof siteId !== 'string' || siteId.length > 100)) {
    return res.status(400).json({ error: 'Nevažeći siteId.' });
  }
  if (siteName && (typeof siteName !== 'string' || !/^[a-z0-9-]{1,63}$/.test(siteName))) {
    return res.status(400).json({ error: 'Nevažeće ime sajta. Samo slova, brojevi i crtice, do 63 karaktera.' });
  }
  try {
    const result = await netlifyOAuth.deploySite(req.studentApiKey, { files, siteId, siteName });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ─── Project Storage (R2 + Redis) ────────────────────────────────────────────

import * as projectStore from './projectStore.js';
import * as r2 from './r2.js';

const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'image/svg+xml', 'image/x-icon',
  'video/mp4', 'video/webm',
  'font/woff', 'font/woff2',
]);
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024; // 15MB per file
const MAX_UPLOADS_PER_PROJECT = 30;

app.get('/api/projects', requireAuth, asyncHandler(async (req, res) => {
  const list = await projectStore.listProjects(req.studentKeyId);
  res.json({ projects: list });
}));

app.get('/api/projects/:id', requireAuth, asyncHandler(async (req, res) => {
  const project = await projectStore.loadProject(req.studentKeyId, req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
}));

app.post('/api/projects', requireAuth, asyncHandler(async (req, res) => {
  const { id, name, model, prompt, files, chatHistory, displayMessages } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
  const project = {
    id, name: name || '', model: model || '', prompt: prompt || '',
    files: files || {}, chatHistory: chatHistory || [], displayMessages: displayMessages || [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const summary = await projectStore.saveProject(req.studentKeyId, project);
  res.json({ summary });
}));

app.put('/api/projects/:id', requireAuth, asyncHandler(async (req, res) => {
  const existing = await projectStore.loadProject(req.studentKeyId, req.params.id);
  const body = req.body || {};
  const project = {
    ...(existing || {}),
    ...body,
    id: req.params.id,
    updatedAt: Date.now(),
  };
  if (!project.createdAt) project.createdAt = Date.now();
  const summary = await projectStore.saveProject(req.studentKeyId, project);
  res.json({ summary });
}));

app.delete('/api/projects/:id', requireAuth, asyncHandler(async (req, res) => {
  await projectStore.deleteProject(req.studentKeyId, req.params.id);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/uploads/sign', requireAuth, asyncHandler(async (req, res) => {
  if (!r2.isR2Configured()) return res.status(503).json({ error: 'Storage not configured' });
  const { path: filePath, contentType, sizeBytes } = req.body || {};
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' });
  if (!contentType || !ALLOWED_UPLOAD_TYPES.has(contentType)) {
    return res.status(400).json({ error: `Content type not allowed: ${contentType}` });
  }
  if (!sizeBytes || sizeBytes > MAX_UPLOAD_SIZE) {
    return res.status(400).json({ error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` });
  }
  const sanitized = filePath.replace(/^\/+/, '').replace(/\.\./g, '');
  const r2Key = `${req.studentKeyId}/${req.params.id}/${sanitized}`;
  const uploadUrl = await r2.getSignedUploadUrl(r2Key, contentType, 300);
  const publicFileUrl = r2.publicUrl(r2Key);
  res.json({ uploadUrl, publicUrl: publicFileUrl, r2Key });
}));

app.post('/api/projects/:id/uploads/commit', requireAuth, asyncHandler(async (req, res) => {
  if (!r2.isR2Configured()) return res.status(503).json({ error: 'Storage not configured' });
  const { r2Key, filePath } = req.body || {};
  if (!r2Key || !filePath) return res.status(400).json({ error: 'r2Key and filePath required' });
  if (!r2Key.startsWith(`${req.studentKeyId}/`)) {
    return res.status(403).json({ error: 'Key does not belong to this user' });
  }
  const head = await r2.headObject(r2Key);
  if (!head) return res.status(404).json({ error: 'Object not found in storage' });
  const fileUrl = r2.publicUrl(r2Key);
  res.json({ url: fileUrl, size: head.size, contentType: head.contentType });
}));

// ─── Legacy Registration (extension/landing page) ───────────────────────────

app.get('/register/token', registerLimiter, (_req, res) => {
  res.json({ token: createRegisterToken() });
});

app.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const { first_name, last_name, email, honeypot, token } = req.body || {};

  if (honeypot) {
    return res.status(400).json({ error: 'Neispravan zahtev.' });
  }

  const clientIP = normalizeIP(req.ip || req.connection?.remoteAddress || 'unknown');
  console.log(`Registration attempt from IP: ${clientIP} (raw: ${req.ip})`);
  const canReg = await canRegisterFromIP(clientIP);
  if (!canReg) {
    return res.status(403).json({ error: 'Maksimalan broj naloga sa ove adrese je dostignut.' });
  }

  const tokenCheck = verifyRegisterToken(token);
  if (!tokenCheck.valid) {
    if (tokenCheck.reason === 'too_fast') {
      return res.status(429).json({ error: 'Sačekaj nekoliko sekundi pre slanja forme.' });
    }
    if (tokenCheck.reason === 'expired') {
      return res.status(400).json({ error: 'Forma je istekla. Osveži stranicu i pokušaj ponovo.' });
    }
    return res.status(400).json({ error: 'Neispravan sigurnosni token. Osveži stranicu.' });
  }

  if (!first_name || typeof first_name !== 'string' || first_name.trim().length < 2) {
    return res.status(400).json({ error: 'Ime mora imati najmanje 2 karaktera.' });
  }
  if (!last_name || typeof last_name !== 'string' || last_name.trim().length < 2) {
    return res.status(400).json({ error: 'Prezime mora imati najmanje 2 karaktera.' });
  }
  if (first_name.length > 50 || last_name.length > 50) {
    return res.status(400).json({ error: 'Ime i prezime ne mogu biti duži od 50 karaktera.' });
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Unesite ispravnu email adresu.' });
  }
  if (email.length > 100) {
    return res.status(400).json({ error: 'Email ne može biti duži od 100 karaktera.' });
  }

  const fullName = first_name.trim() + ' ' + last_name.trim();
  const result = await addStudent(fullName, email.trim());
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  if (REGISTER_BONUS > 0) {
    await addBalance(result.student.key, REGISTER_BONUS);
  }

  await trackRegistrationIP(clientIP);
  console.log(`Self-registration: "${fullName}" <${result.student.email}> → key ${result.student.key.slice(0, 12)}... [IP: ${clientIP}]`);

  // Send welcome email with API key (async, don't block response)
  sendWelcomeEmail(result.student).catch(err => console.error('Welcome email failed:', err.message));

  res.json({
    name: result.student.name,
    email: result.student.email,
    key: result.student.key,
    balance_usd: await getBalance(result.student.key),
  });
}));

// ---- Balance warning (injected into AI response) ----
// Extension-only: the web app has its own PaywallModal popup triggered by
// client-side balance checks, so injecting a message into the stream would
// duplicate the UX. When the request comes from a known web origin we skip
// the injection entirely and let the frontend handle it.
const LOW_BALANCE_THRESHOLD = 1.0;
const _balanceWarningSent = new Map();

function isWebOrigin(req) {
  if (!req) return false;
  const origin = req.get?.('Origin') || req.get?.('Referer') || '';
  if (!origin) return false;
  const webOrigins = (process.env.WEB_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    const parsed = new URL(origin);
    return webOrigins.includes(parsed.origin);
  } catch { return false; }
}

async function getBalanceWarning(keyId, newBalance, req) {
  // Web app handles its own low-balance UX via PaywallModal — don't double up.
  if (isWebOrigin(req)) return null;

  if (newBalance <= LOW_BALANCE_THRESHOLD) {
    const lastWarn = _balanceWarningSent.get(keyId + ':low') || 0;
    if (Date.now() - lastWarn < 10 * 60 * 1000) return null;
    _balanceWarningSent.set(keyId + ':low', Date.now());
    return `\n\n---\n⚠️ **Tvoj VajbAgent balans je nizak ($${newBalance.toFixed(2)}).** Dopuni kredite na https://vajbagent.com/dashboard → Dopuna`;
  }
  const deposited = await getTotalDeposited(keyId);
  if (deposited > 0 && newBalance < deposited * 0.5) {
    const lastWarn = _balanceWarningSent.get(keyId + ':50pct') || 0;
    if (Date.now() - lastWarn < 30 * 60 * 1000) return null;
    _balanceWarningSent.set(keyId + ':50pct', Date.now());
    return `\n\n---\n📊 **Potrošio si više od 50% kredita** (preostalo: $${newBalance.toFixed(2)}). Dopuni kad ti odgovara na https://vajbagent.com/dashboard → Dopuna`;
  }
  return null;
}

// ---- Per-user concurrency limit ----
const userConcurrency = new Map();
const MAX_CONCURRENT_PER_USER = 2;

function acquireConcurrency(keyId) {
  const current = userConcurrency.get(keyId) || 0;
  if (current >= MAX_CONCURRENT_PER_USER) return false;
  userConcurrency.set(keyId, current + 1);
  return true;
}

function releaseConcurrency(keyId) {
  const current = userConcurrency.get(keyId) || 0;
  if (current <= 1) userConcurrency.delete(keyId);
  else userConcurrency.set(keyId, current - 1);
}

// ---- Chat completions handler ----
const chatCompletionsHandler = [
  authLimiter,
  requireAuth,
  async (req, res) => {
    const body = req.body || {};
    let { messages, stream = false, max_tokens = 4096, model, tools: openAITools } = body;

    // First: check model is valid (before balance, so user sees the right error)
    const resolved = resolveModel(model);
    if (!resolved) {
      const available = VAJB_MODELS.map((m) => m.id).join(', ');
      console.log(`Rejected unknown model: "${model}" (valid: ${available})`);
      return res.status(400).json({
        error: {
          message: `Model "${model}" nije podržan. Dostupni modeli: ${available}. U Cursoru: Settings → Models → Add Custom Model → upiši jedan od ovih.`,
          code: 'unknown_model',
          available_models: VAJB_MODELS.map((m) => ({ id: m.id, name: m.name })),
        },
      });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: { message: 'Missing or empty "messages" array.' },
      });
    }
    const MAX_MESSAGES = 500;
    if (messages.length > MAX_MESSAGES) {
      const systemMsgs = messages.filter(m => (m.role || '').toLowerCase() === 'system');
      const nonSystem = messages.filter(m => (m.role || '').toLowerCase() !== 'system');
      const keepCount = MAX_MESSAGES - systemMsgs.length;
      const trimmed = [...systemMsgs, ...nonSystem.slice(-keepCount)];
      console.log(`[context] Message limit: ${messages.length} → ${trimmed.length} (dropped ${messages.length - trimmed.length} oldest non-system messages)`);
      messages = trimmed;
    }
    if (Array.isArray(openAITools) && openAITools.length > 128) {
      return res.status(400).json({
        error: { message: `Too many tools (${openAITools.length}). Max 128.`, code: 'too_many_tools' },
      });
    }

    const keyId = req.studentKeyId;
    const balance = await getBalance(keyId);
    if (balance <= 0) {
      const baseUrl = process.env.BASE_URL || 'https://vajbagent.com';
      return res.status(402).json({
        error: {
          message: `Nedovoljno kredita (stanje: ${balance.toFixed(2)} USD). Dopuni nalog da nastaviš.`,
          code: 'insufficient_credits',
          balance_usd: balance,
          dashboard_url: `${baseUrl.replace(/\/$/, '')}/dashboard`,
        },
      });
    }

    // Free tier: only Lite model allowed
    if (resolved.id !== 'vajb-agent-lite') {
      const totalDep = await getTotalDeposited(keyId);
      const regBonus = parseFloat(process.env.SELF_REGISTER_BONUS) || 2;
      if (totalDep <= regBonus) {
        const baseUrl = process.env.BASE_URL || 'https://vajbagent.com';
        return res.status(403).json({
          error: {
            message: `Model "${resolved.name}" je dostupan samo uz dopunu kredita. Besplatan nalog koristi Lite model. Dopuni na: ${baseUrl}/dashboard`,
            code: 'free_tier_model_locked',
            dashboard_url: `${baseUrl.replace(/\/$/, '')}/dashboard`,
          },
        });
      }
    }

    if (!acquireConcurrency(keyId)) {
      return res.status(429).json({
        error: {
          message: 'Imaš već aktivne zahteve u toku. Sačekaj da se završe pre nego što pošalješ novi.',
          code: 'concurrent_limit',
        },
      });
    }

    try {
      // Web client (vajbagent.com SPA) ships its own ~1000-line WebContainers-
      // aware prompt. Stacking VAJB/POWER on top would only inflate context
      // and contradict the web prompt. Detect via explicit header OR via
      // presence of a substantial system message already in the transcript.
      const clientHeader = (req.headers['x-vajb-client'] || '').toString().toLowerCase();
      const existingSystem = messages.find(m => (m.role || '').toLowerCase() === 'system');
      const existingSystemLen = typeof existingSystem?.content === 'string' ? existingSystem.content.length : 0;
      const skipInject = clientHeader === 'web' || existingSystemLen > 1500;

      const enhancedMessages = skipInject
        ? messages
        : injectSystemPrompt(messages, resolved.isPower === true);

      if (resolved.backend === 'openai') {
        await handleOpenAI(req, res, keyId, resolved, enhancedMessages, openAITools, stream, max_tokens);
      } else {
        await handleAnthropic(req, res, keyId, resolved, enhancedMessages, openAITools, stream, max_tokens);
      }
    } catch (err) {
      console.error(`${resolved.backend} error [${err.status || '?'}]:`, err.message);
      if (res.headersSent) return;

      const status = err.status || 502;
      const msg = err.message || 'Upstream error';
      let userMsg = msg;
      let code = 'api_error';

      const msgLower = msg.toLowerCase();

      if (status === 429 || (status === 403 && (msgLower.includes('rate') || msgLower.includes('limit') || msgLower.includes('quota')))) {
        userMsg = 'AI provajder je preopterećen (rate limit). Agent će automatski pokušati ponovo za par sekundi.';
        code = 'rate_limit';
      } else if (status === 529 || msgLower.includes('overloaded')) {
        userMsg = 'Backend model je trenutno preopterećen. Pokušaj ponovo za minut ili probaj jeftiniji model.';
        code = 'overloaded';
      } else if (
        msgLower.includes('context length') ||
        msgLower.includes('context window') ||
        msgLower.includes('too many tokens') ||
        msgLower.includes('maximum context') ||
        msgLower.includes('token limit') ||
        msgLower.includes('too long') ||
        msgLower.includes('input too large') ||
        msgLower.includes('prompt is too long')
      ) {
        userMsg = 'Kontekst je prevelik čak i posle trimovanja. Pokušaj sa kraćim promptom ili zatvori nepotrebne fajlove u Cursor-u.';
        code = 'context_too_large';
      } else if (status === 401) {
        userMsg = 'Problem sa autentifikacijom prema AI provajderu. Kontaktiraj podršku.';
        code = 'auth_error';
      } else if (status === 403) {
        userMsg = 'AI provajder je odbio zahtev (403). Pokušaj ponovo za par sekundi ili probaj drugi model.';
        code = 'provider_rejected';
      }

      // Never leak raw upstream error bodies to clients — they may contain
      // prompt fragments, provider names, model IDs, internal limits, etc.
      res.status(status).json({
        error: { message: userMsg, type: code },
      });
    } finally {
      releaseConcurrency(keyId);
    }
  },
];
app.post('/v1/chat/completions', chatCompletionsHandler);
app.post('/chat/completions', chatCompletionsHandler);

// ---- OpenAI backend (Lite, Pro) ----
async function handleOpenAI(req, res, keyId, resolved, messages, openAITools, stream, max_tokens) {
  const modelMax = MAX_OUTPUT[resolved.backendModel] || 16384;
  const requested = Number(max_tokens) || 4096;
  const maxTokens = Math.min(Math.max(requested, 256), modelMax);
  const trimmedMessages = trimOpenAIMessages(messages, resolved.backendModel);

  const isReasoning = resolved.backendModel.startsWith('o') || resolved.backendModel.startsWith('gpt-5');
  const isGpt5 = resolved.backendModel.startsWith('gpt-5');

  const payload = {
    model: resolved.backendModel,
    messages: trimmedMessages,
    max_completion_tokens: maxTokens,
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
    ...(isReasoning && { reasoning_effort: maxTokens <= 2048 ? 'low' : 'medium' }),
    ...(Array.isArray(openAITools) && openAITools.length > 0 && { tools: openAITools }),
    // OpenAI routes cache lookups by a stable per-user key. Without it the
    // cache bucket is load-balancer-dependent and the same prompt prefix
    // from the same user can miss cache on back-to-back requests. With
    // keyId as the cache key we pin every user's conversation to the same
    // cache shard → higher hit rate → lower billed input tokens for us
    // AND for the student.
    ...(keyId && { prompt_cache_key: String(keyId) }),
  };

  const poolEntry = acquireFromPool(openaiPool, 'OpenAI');
  console.log(`OpenAI request: model=${resolved.backendModel}, msgs=${messages.length}→${trimmedMessages.length}, stream=${stream}, pool=${openaiPool.indexOf(poolEntry)+1}/${openaiPool.length}`);

  try {
    if (stream) {
      await handleOpenAIStream(req, res, keyId, resolved, payload, poolEntry.client);
    } else {
      await handleOpenAINonStream(req, res, keyId, resolved, payload, poolEntry.client);
    }
  } finally {
    releaseFromPool(poolEntry);
  }
}

async function handleOpenAINonStream(req, res, keyId, resolved, payload, client) {
  const response = await withRetry(() => client.chat.completions.create(payload));

  // Validate response has content
  if (!response?.choices?.[0]?.message) {
    console.error('OpenAI returned empty/invalid response:', JSON.stringify(response));
    return res.status(502).json({
      error: { message: 'Model returned empty response. Please try again.', code: 'empty_response' }
    });
  }

  const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const cachedInput = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const totalInput = response.usage?.prompt_tokens ?? 0;
  const uncachedInput = Math.max(0, totalInput - cachedInput);
  const usage = {
    input_tokens: totalInput,
    output_tokens: response.usage?.completion_tokens ?? 0,
    cached_input_tokens: cachedInput,
    model: resolved.backendModel,
  };
  if (reasoning > 0) {
    console.log(`OpenAI reasoning tokens: ${reasoning} (billed as output, total output=${usage.output_tokens})`);
  }
  if (cachedInput > 0) {
    console.log(`OpenAI cache hit: cached=${cachedInput}/${totalInput} input tokens`);
  }
  const usd = costUsdWithCache({
    uncachedInput,
    cacheReadInput: cachedInput,
    cacheCreationInput: 0, // OpenAI doesn't charge for cache writes
    outputTokens: usage.output_tokens,
  }, resolved.backendModel, keyId);
  const newBal = await deductBalance(keyId, usd);
  await logUsage(keyId, usage);

  const warning = await getBalanceWarning(keyId, newBal, req);
  if (warning && response.choices?.[0]?.message?.content) {
    response.choices[0].message.content += warning;
  }

  response.model = resolved.id;
  res.json(response);
}

async function handleOpenAIStream(req, res, keyId, resolved, payload, client) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // If the browser disconnects mid-stream (tab closed, navigated away, user
  // clicked Stop and didn't wait), keep generating upstream = pure waste of
  // tokens that the user still pays for. We cancel the upstream the moment
  // the socket goes away.
  let clientClosed = false;
  const onClientClose = () => { clientClosed = true; };
  req.on('close', onClientClose);

  // Reasoning models (gpt-5.*) can legitimately "think" silently for 2-3 min
  // before emitting the first token. We must (a) keep the connection from
  // being idle-killed by proxies, and (b) not close the upstream too early.
  const STREAM_TIMEOUT = 5 * 60 * 1000;
  const KEEPALIVE_INTERVAL = 10000;
  let lastChunkTime = Date.now();

  // Proxies (Cloudflare, some Render edges) sometimes BUFFER SSE comment
  // lines (those starting with ":") and only flush on real `data:` events.
  // If that happens the client hits its idle timeout even though the server
  // is faithfully emitting comments. Work around it by sending a real
  // no-op data chunk (empty delta) — proxies always pass these through.
  const heartbeatChunk = {
    id: 'vajb-heartbeat',
    object: 'chat.completion.chunk',
    model: resolved.id,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  const heartbeatLine = 'data: ' + JSON.stringify(heartbeatChunk) + '\n\n';

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(heartbeatLine);
      if (res.flush) res.flush();
    }
  }, KEEPALIVE_INTERVAL);

  const timeoutCheck = setInterval(() => {
    if (Date.now() - lastChunkTime > STREAM_TIMEOUT) {
      clearInterval(timeoutCheck);
      clearInterval(keepAlive);
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    }
  }, 30000);

  res.write(': stream-start\n\n');
  const initChunk = { id: 'vajb-init', object: 'chat.completion.chunk', model: resolved.id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(initChunk) + '\n\n');
  if (res.flush) res.flush();

  let stream;
  try {
    stream = await withRetry(() => client.chat.completions.create(payload));
  } catch (err) {
    clearInterval(timeoutCheck);
    clearInterval(keepAlive);
    throw err;
  }

  let usage = { input_tokens: 0, output_tokens: 0 };
  let chunkCount = 0;

  let midStreamError = null;

  try {
    for await (const chunk of stream) {
      if (res.writableEnded || clientClosed) {
        // Stop pulling chunks upstream if the client is gone.
        try { stream.controller?.abort(); } catch { /* ignore */ }
        break;
      }
      lastChunkTime = Date.now();
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
        usage.reasoning_tokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0;
        usage.cached_input_tokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cached_input_tokens ?? 0;
      }
      chunkCount++;
      chunk.model = resolved.id;
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      if (res.flush) res.flush();
    }
  } catch (streamErr) {
    midStreamError = streamErr;
    console.error('OpenAI stream error mid-flight:', streamErr.message);
  }

  clearInterval(timeoutCheck);
  clearInterval(keepAlive);
  req.off?.('close', onClientClose);

  // If an error was thrown mid-stream, tell the client so it can retry or
  // surface a proper message instead of treating the partial text as a
  // successful completion.
  if (midStreamError && !res.writableEnded && !clientClosed) {
    const errChunk = {
      id: 'vajb-error',
      object: 'chat.completion.chunk',
      model: resolved.id,
      choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      error: { message: 'Stream prekinut: ' + (midStreamError.message || 'upstream error') },
    };
    res.write('data: ' + JSON.stringify(errChunk) + '\n\n');
    if (res.flush) res.flush();
  }

  if (usage.input_tokens === 0 && usage.output_tokens === 0) {
    const estIn = Math.max(chunkCount * 50, 1000);
    const estOut = Math.max(chunkCount * 15, 200);
    usage = { input_tokens: estIn, output_tokens: estOut };
    console.log(`OpenAI stream: no usage reported, estimating ~${estIn} in / ~${estOut} out from ${chunkCount} chunks`);
  }
  if (usage.reasoning_tokens > 0) {
    console.log(`OpenAI stream reasoning tokens: ${usage.reasoning_tokens} (billed as output, total output=${usage.output_tokens})`);
  }
  try {
    usage.model = resolved.backendModel;
    const cachedInput = usage.cached_input_tokens || 0;
    const uncachedInput = Math.max(0, (usage.input_tokens || 0) - cachedInput);
    if (cachedInput > 0) {
      console.log(`OpenAI stream cache hit: cached=${cachedInput}/${usage.input_tokens} input tokens`);
    }
    const usd = costUsdWithCache({
      uncachedInput,
      cacheReadInput: cachedInput,
      cacheCreationInput: 0,
      outputTokens: usage.output_tokens,
    }, resolved.backendModel, keyId);
    const newBal = await deductBalance(keyId, usd);
    await logUsage(keyId, usage);

    const warning = await getBalanceWarning(keyId, newBal, req);
    if (warning && !res.writableEnded) {
      const warnChunk = { id: 'vajb-warn', object: 'chat.completion.chunk', model: resolved.id, choices: [{ index: 0, delta: { content: warning }, finish_reason: null }] };
      res.write('data: ' + JSON.stringify(warnChunk) + '\n\n');
    }
  } catch (billingErr) {
    console.error('Post-stream billing error:', billingErr.message);
  }
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// ---- Anthropic backend (Pro, Max, Ultra) ----
async function handleAnthropic(req, res, keyId, resolved, messages, openAITools, stream, max_tokens) {
  const originalMsgCount = messages.length;
  const { system, messages: anthropicMessages } = openAIToAnthropicMessages(messages, resolved.backendModel);

  if (anthropicMessages.length === 0) {
    return res.status(400).json({
      error: { message: 'No valid user/assistant messages after conversion.' },
    });
  }

  const ctxChars = (system || '').length + anthropicMessages.reduce((s, m) =>
    s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);

  // Only inject Cursor IDE hint for VS Code extension requests (not web).
  // Web extension sends its own system prompt with WebContainers context.
  const isWebExt = isWebOrigin(req);
  const mergedSystem = isWebExt
    ? system
    : [
        'Korisnik radi u Cursor IDE. Kad predlažeš izmene koda:',
        '- Daj konkretan kod u markdown code block-u sa jasno označenim fajlom ako je poznat.',
        '- Formuliši tako da IDE može da ponudi primenu (Apply).',
        '- Ako menjaš postojeći fajl, navedi koji fajl i daj ceo izmenjeni blok.',
        system,
      ].filter(Boolean).join('\n\n');

  const anthropicTools = openAIToolsToAnthropic(openAITools);
  const modelMax = MAX_OUTPUT[resolved.backendModel] || 16384;
  const maxTokens = Math.min(Math.max(Number(max_tokens) || 4096, 1), modelMax);

  // Anthropic prompt caching: send system as structured block with cache_control.
  // Cached tokens cost 10% of normal input price on repeat calls; first write costs 1.25x.
  const systemPayload = mergedSystem
    ? [{ type: 'text', text: mergedSystem, cache_control: { type: 'ephemeral' } }]
    : undefined;

  // Tools caching: mark the last tool with cache_control so the entire tools
  // array (same identity across every request) gets cached as one block.
  // Tools are ~4–5k tokens and never change — this is a pure win.
  const cachedAnthropicTools = anthropicTools.length > 0
    ? anthropicTools.map((t, i) => i === anthropicTools.length - 1
        ? { ...t, cache_control: { type: 'ephemeral' } }
        : t)
    : anthropicTools;

  const payload = {
    model: resolved.backendModel,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    ...(systemPayload && { system: systemPayload }),
    ...(cachedAnthropicTools.length > 0 && { tools: cachedAnthropicTools }),
  };

  const poolEntry = acquireFromPool(anthropicPool, 'Anthropic');
  console.log(`Anthropic request: ${originalMsgCount} msgs → ${anthropicMessages.length} msgs, ~${Math.round(ctxChars / 4000)}K tokens, model=${resolved.backendModel}, pool=${anthropicPool.indexOf(poolEntry)+1}/${anthropicPool.length}`);

  try {
    if (stream) {
      await handleAnthropicStream(req, res, keyId, resolved, payload, poolEntry.client);
    } else {
      await handleAnthropicNonStream(req, res, keyId, resolved, payload, poolEntry.client);
    }
  } finally {
    releaseFromPool(poolEntry);
  }
}

async function handleAnthropicNonStream(req, res, keyId, resolved, payload, client) {
  const response = await withRetry(() => client.messages.create({ ...payload, stream: false }));

  // Validate response has content
  if (!response?.content || response.content.length === 0) {
    console.error('Anthropic returned empty/invalid response:', JSON.stringify(response));
    return res.status(502).json({
      error: { message: 'Model returned empty response. Please try again.', code: 'empty_response' }
    });
  }

  const cacheRead = response.usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = response.usage?.cache_creation_input_tokens ?? 0;
  const uncachedInput = response.usage?.input_tokens ?? 0;
  const usage = {
    input_tokens: uncachedInput + cacheRead + cacheCreate, // total billable tokens for logging
    output_tokens: response.usage?.output_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
    model: resolved.backendModel,
  };
  const usd = costUsdWithCache({
    uncachedInput,
    cacheReadInput: cacheRead,
    cacheCreationInput: cacheCreate,
    outputTokens: usage.output_tokens,
  }, resolved.backendModel, keyId);
  if (cacheRead > 0 || cacheCreate > 0) {
    console.log(`Anthropic cache: read=${cacheRead}, created=${cacheCreate}, uncached=${uncachedInput}, cost=$${usd.toFixed(5)}`);
  }
  const newBal = await deductBalance(keyId, usd);
  await logUsage(keyId, usage);

  const openAIResponse = toOpenAIChatCompletion(
    response, response.usage, resolved.id, response.id || 'vajb-' + Date.now()
  );

  const warning = await getBalanceWarning(keyId, newBal, req);
  if (warning && openAIResponse.choices?.[0]?.message?.content) {
    openAIResponse.choices[0].message.content += warning;
  }

  res.json(openAIResponse);
}

async function handleAnthropicStream(req, res, keyId, resolved, payload, client) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Cancel upstream when the browser disconnects — same reason as OpenAI.
  let clientClosed = false;
  const onClientClose = () => { clientClosed = true; };
  req.on('close', onClientClose);

  const streamId = 'vajb-' + Date.now();
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolCalls = [];
  let currentToolIndex = -1;
  // Capture Anthropic stop_reason so we can translate it to a proper OpenAI
  // finish_reason. Without this, truncation due to max_tokens is invisible to
  // the client and the agent loop cannot detect that a tool call was cut off
  // mid-JSON. Anthropic emits this on `message_delta` events.
  let anthropicStopReason = null;

  // Anthropic streams are usually faster to first-token than reasoning
  // models, but Opus on huge prompts with tools can still take 30-60s of
  // silence. Keep the same heartbeat-as-data-chunk strategy so proxies
  // don't buffer our keepalives into oblivion.
  const STREAM_TIMEOUT = 5 * 60 * 1000;
  const KEEPALIVE_INTERVAL = 10000;
  let lastChunkTime = Date.now();

  const heartbeatChunk = {
    id: streamId,
    object: 'chat.completion.chunk',
    model: resolved.id,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  const heartbeatLine = 'data: ' + JSON.stringify(heartbeatChunk) + '\n\n';

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(heartbeatLine);
      if (res.flush) res.flush();
    }
  }, KEEPALIVE_INTERVAL);

  const timeoutCheck = setInterval(() => {
    if (Date.now() - lastChunkTime > STREAM_TIMEOUT) {
      clearInterval(timeoutCheck);
      clearInterval(keepAlive);
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    }
  }, 30000);

  res.write(': stream-start\n\n');
  const initChunk = { id: streamId, object: 'chat.completion.chunk', model: resolved.id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(initChunk) + '\n\n');
  if (res.flush) res.flush();

  let stream;
  try {
    stream = await withRetry(() => client.messages.create({ ...payload, stream: true }));
  } catch (err) {
    clearInterval(timeoutCheck);
    clearInterval(keepAlive);
    throw err;
  }

  let isThinking = false;
  let thinkingIndicatorSent = false;
  let midStreamError = null;

  try {
    for await (const event of stream) {
      if (clientClosed || res.writableEnded) {
        try { stream.controller?.abort(); } catch { /* ignore */ }
        break;
      }
      lastChunkTime = Date.now();
      
      if (event.type === 'message_start' && event.message?.usage) {
        usage.input_tokens = event.message.usage.input_tokens ?? 0;
        usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens ?? 0;
        usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens ?? 0;
      }
      
      // Detect thinking block start - send indicator
      if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
        isThinking = true;
        if (!thinkingIndicatorSent) {
          res.write(toOpenAIStreamChunk('🧠 *Razmišljam...*\n\n', { id: streamId, model: resolved.id }));
          if (res.flush) res.flush();
          thinkingIndicatorSent = true;
        }
      }
      
      // Detect text block start - model finished thinking
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        isThinking = false;
      }
      
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        isThinking = false;
        const b = event.content_block;
        toolCalls.push({ id: b.id, name: b.name || 'tool', inputStr: '' });
        currentToolIndex = toolCalls.length - 1;
        res.write(toOpenAIStreamChunkToolCallDelta(currentToolIndex, b.id, b.name || 'tool', '', { id: streamId, model: resolved.id }));
        if (res.flush) res.flush();
      }
      
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          res.write(toOpenAIStreamChunk(delta.text, { id: streamId, model: resolved.id }));
          if (res.flush) res.flush();
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && currentToolIndex >= 0 && toolCalls[currentToolIndex]) {
          toolCalls[currentToolIndex].inputStr += delta.partial_json;
          res.write(toOpenAIStreamChunkToolCallDelta(currentToolIndex, null, null, delta.partial_json, { id: streamId, model: resolved.id }));
          if (res.flush) res.flush();
        }
      }
      
      if (event.type === 'content_block_stop') {
        currentToolIndex = -1;
      }
      
      if (event.type === 'message_delta') {
        if (event.usage) {
          if (event.usage.input_tokens != null) usage.input_tokens = event.usage.input_tokens;
          if (event.usage.output_tokens != null) usage.output_tokens = event.usage.output_tokens;
          if (event.usage.cache_read_input_tokens != null) usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
          if (event.usage.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
        }
        // Capture stop_reason so we can emit a correct OpenAI finish_reason.
        // Values: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal"
        if (event.delta?.stop_reason) {
          anthropicStopReason = event.delta.stop_reason;
        }
      }
    }
  } catch (streamErr) {
    midStreamError = streamErr;
    console.error('Anthropic stream error:', streamErr.message);
  }

  clearInterval(timeoutCheck);
  clearInterval(keepAlive);
  req.off?.('close', onClientClose);

  if (midStreamError && !res.writableEnded && !clientClosed) {
    const errChunk = {
      id: streamId,
      object: 'chat.completion.chunk',
      model: resolved.id,
      choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      error: { message: 'Stream prekinut: ' + (midStreamError.message || 'upstream error') },
    };
    res.write('data: ' + JSON.stringify(errChunk) + '\n\n');
    if (res.flush) res.flush();
  }

  // Map Anthropic stop_reason → OpenAI finish_reason.
  // Critical: when Anthropic hits max_tokens mid-stream (especially in a tool_use
  // JSON block), we MUST report finish_reason: 'length' so the client knows the
  // tool call arguments are truncated. Previously we hardcoded 'tool_calls' here,
  // which silently swallowed truncation and forced the model to retry its
  // half-written huge file in an endless loop.
  let mappedFinishReason;
  if (anthropicStopReason === 'max_tokens') {
    mappedFinishReason = 'length';
  } else if (anthropicStopReason === 'refusal') {
    mappedFinishReason = 'content_filter';
  } else if (toolCalls.length > 0) {
    // tool_use OR end_turn-with-tools → tool_calls
    mappedFinishReason = 'tool_calls';
  } else {
    // end_turn | stop_sequence | unknown → stop
    mappedFinishReason = 'stop';
  }

  if (toolCalls.length > 0) {
    // Validate accumulated JSON for each tool call (fix if broken)
    for (const tc of toolCalls) {
      try {
        JSON.parse(tc.inputStr || '{}');
      } catch (parseErr) {
        console.warn(`Tool call JSON parse failed for ${tc.name} (stop=${anthropicStopReason}): ${parseErr.message}. Raw: ${(tc.inputStr || '').slice(0, 200)}...`);
      }
    }
    const finishChunk = {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: resolved.id,
      choices: [{ index: 0, delta: {}, finish_reason: mappedFinishReason }],
    };
    res.write('data: ' + JSON.stringify(finishChunk) + '\n\n');
    if (res.flush) res.flush();
  } else {
    // Pure text (or empty) response — use `finish: true` for 'stop', otherwise
    // emit a custom finish chunk so we propagate 'length'/'content_filter'.
    if (mappedFinishReason === 'stop') {
      res.write(toOpenAIStreamChunk('', { id: streamId, model: resolved.id, finish: true }));
    } else {
      const finishChunk = {
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: resolved.id,
        choices: [{ index: 0, delta: {}, finish_reason: mappedFinishReason }],
      };
      res.write('data: ' + JSON.stringify(finishChunk) + '\n\n');
    }
    if (res.flush) res.flush();
  }

  try {
    usage.model = resolved.backendModel;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const uncachedInput = usage.input_tokens || 0;
    // Report total billable input in usage log (uncached + cached read + cached create)
    const totalBillableInput = uncachedInput + cacheRead + cacheCreate;
    const usd = costUsdWithCache({
      uncachedInput,
      cacheReadInput: cacheRead,
      cacheCreationInput: cacheCreate,
      outputTokens: usage.output_tokens,
    }, resolved.backendModel, keyId);
    if (cacheRead > 0 || cacheCreate > 0) {
      console.log(`Anthropic stream cache: read=${cacheRead}, created=${cacheCreate}, uncached=${uncachedInput}, cost=$${usd.toFixed(5)}`);
    }
    // Log with total billable input so usage analytics show full picture
    const loggedUsage = { ...usage, input_tokens: totalBillableInput };
    const newBal = await deductBalance(keyId, usd);
    await logUsage(keyId, loggedUsage);

    const warning = await getBalanceWarning(keyId, newBal, req);
    if (warning && !res.writableEnded) {
      const warnChunk = { id: streamId + '-warn', object: 'chat.completion.chunk', model: resolved.id, choices: [{ index: 0, delta: { content: warning }, finish_reason: null }] };
      res.write('data: ' + JSON.stringify(warnChunk) + '\n\n');
    }
  } catch (billingErr) {
    console.error('Post-stream billing error:', billingErr.message);
  }

  if (!res.writableEnded) {
    res.write(streamDone());
    res.end();
  }
}

// ---- Usage + balance for current key (dashboard) ----
app.get('/me', authLimiter, requireAuth, asyncHandler(async (req, res) => {
  const keyId = req.studentKeyId;
  const name = req.studentName || 'Unknown';
  const balanceUsd = await getBalance(keyId);
  const totalDeposited = await getTotalDeposited(keyId);
  const data = await getUsageForKey(keyId);
  const regBonus = parseFloat(process.env.SELF_REGISTER_BONUS) || 2;
  const freeTier = totalDeposited <= regBonus;

  // Only include the raw API key when the client explicitly asks for it via
  // `?include_key=1`. Default /me responses never expose the key, so idle UI
  // refreshes (balance polling, etc.) never transmit it — reducing the attack
  // surface dramatically. The explicit "Show API key" UI button must opt in.
  const cookies = parseCookies(req);
  const includeKey = cookies.vajb_session && req.query.include_key === '1';

  const base = {
    key_id: keyId, name, balance_usd: balanceUsd, total_deposited: totalDeposited,
    free_tier: freeTier,
    ...(includeKey && { api_key: req.studentApiKey }),
  };

  if (!data) {
    return res.json({ ...base, input_tokens: 0, output_tokens: 0, requests: 0, last_used: null, estimated_cost_usd: 0 });
  }
  const input = data.input_tokens || 0;
  const output = data.output_tokens || 0;
  const lastModel = data.model || 'gpt-5-mini';
  const estimatedCost = costUsd(input, output, lastModel, keyId);
  res.json({
    ...base,
    input_tokens: input, output_tokens: output,
    requests: data.requests || 0, last_used: data.last_used || null,
    estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
  });
}));

// ---- Stripe checkout ----
app.post('/create-checkout', authLimiter, requireAuth, asyncHandler(async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(503).json({ error: 'Plaćanje nije konfigurisano.' });
  }
  const amountUsd = Number(req.body?.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1000) {
    return res.status(400).json({ error: 'amount_usd mora biti između 1 i 1000.' });
  }
  const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));

  // Optional return_url from trusted origins (web app at papaya-cat-*.netlify.app, etc.)
  // Whitelist matches WEB_ORIGINS used for CORS so we never redirect to an attacker domain.
  const rawReturn = typeof req.body?.return_url === 'string' ? req.body.return_url : '';
  const webOrigins = (process.env.WEB_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  let successUrl = baseUrl + '/payment-status?status=success&amount=' + amountUsd;
  let cancelUrl = baseUrl + '/payment-status?status=cancelled';
  if (rawReturn) {
    try {
      const parsed = new URL(rawReturn);
      const origin = parsed.origin;
      if (webOrigins.includes(origin)) {
        successUrl = origin + (parsed.pathname || '/') + '?pay=ok&amount=' + amountUsd;
        cancelUrl = origin + (parsed.pathname || '/') + '?pay=cancel';
      }
    } catch { /* ignore malformed return_url */ }
  }

  try {
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('payment_method_types[0]', 'card');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', 'VajbAgent kredit');
    params.append('line_items[0][price_data][product_data][description]', amountUsd + ' USD kredita za potrošnju');
    params.append('line_items[0][price_data][unit_amount]', String(Math.round(amountUsd * 100)));
    params.append('line_items[0][quantity]', '1');
    params.append('metadata[key_id]', req.studentKeyId);
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(stripeKey + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('Stripe API error:', resp.status, JSON.stringify(data));
      return res.status(502).json({ error: 'Stripe greška: ' + (data.error?.message || resp.status) });
    }
    res.json({ url: data.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(502).json({ error: 'Greška pri kreiranju sesije plaćanja. Pokušaj ponovo.' });
  }
}));

// ---- Key recovery via email ----
const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Previše zahteva. Pokušaj ponovo za sat vremena.' }),
});

app.post('/recover-key', recoveryLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || email.trim().length < 5) {
    return res.status(400).json({ error: 'Unesite email adresu.' });
  }

  const genericMsg = 'Ako ovaj email postoji u sistemu, poslali smo API ključ na tu adresu. Proveri inbox i spam folder.';

  if (!isEmailConfigured()) {
    console.warn('Recovery requested but RESEND_API_KEY not configured');
    return res.json({ message: genericMsg });
  }

  const student = await findByEmail(email.trim());
  if (student) {
    sendRecoveryEmail(student).catch(err => console.error('Recovery email failed:', err.message));
    console.log(`Key recovery sent to ${email.trim().slice(0, 3)}***`);
  }

  res.json({ message: genericMsg });
}));

// ---- Admin: add credits ----
app.post('/admin/add-credits', adminLimiter, asyncHandler(async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body?.admin_secret;
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { key_id, amount_usd } = req.body || {};
  const amount = Number(amount_usd);
  if (!key_id || typeof key_id !== 'string' || !Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'Body: { "key_id": "...", "amount_usd": 5 }' });
  }
  if (Math.abs(amount) > 10000) {
    return res.status(400).json({ error: 'Iznos ne može biti veći od $10,000.' });
  }
  const newBalance = await addBalance(key_id.trim(), amount);
  res.json({ key_id: key_id.trim(), added_usd: amount, balance_usd: newBalance });
}));

// ---- Admin: student management ----
// Secret comes from X-Admin-Secret header ONLY — never query string or body.
// Query strings leak to access logs, Referer headers, and browser history.
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/admin/students', adminLimiter, requireAdmin, asyncHandler(async (_req, res) => {
  const allStudents = await getAllStudents();
  const usage = await getUsageSummary();
  const students = [];
  for (const s of allStudents) {
    const balance_usd = await getBalance(s.key);
    const last_used = usage[s.key]?.last_used || null;
    students.push({ ...s, balance_usd, last_used });
  }
  res.json(students);
}));

app.post('/admin/students', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const { name, email, initial_balance } = req.body || {};
  const result = await addStudent(name, email || `admin-${Date.now()}@internal`);
  if (result.error) return res.status(400).json({ error: result.error });
  const bal = Number(initial_balance);
  if (Number.isFinite(bal) && bal > 0) {
    await addBalance(result.student.key, bal);
  }
  res.json({
    ...result.student,
    balance_usd: await getBalance(result.student.key),
  });
}));

app.delete('/admin/students/:key', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const result = await removeStudent(req.params.key);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
}));

app.patch('/admin/students/:key', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Body: { "active": true/false }' });
  }
  const result = await toggleStudent(req.params.key, active);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result.student);
}));

// Toggle markup for a student (noMarkup = true means they pay raw API cost)
app.patch('/admin/students/:key/markup', adminLimiter, requireAdmin, asyncHandler(async (req, res) => {
  const { noMarkup } = req.body || {};
  if (typeof noMarkup !== 'boolean') {
    return res.status(400).json({ error: 'Body: { "noMarkup": true/false }' });
  }
  const result = await toggleStudentMarkup(req.params.key, noMarkup);
  if (result.error) return res.status(404).json({ error: result.error });
  
  // Update in-memory cache
  setStudentNoMarkup(req.params.key, noMarkup);
  
  res.json(result.student);
}));

// ---- Admin: markup management ----
app.get('/admin/markups', adminLimiter, requireAdmin, (_req, res) => {
  const prices = getPrices();
  const models = Object.keys(prices);
  const markups = {};
  for (const model of models) {
    const envKey = 'MARKUP_' + model.toUpperCase().replace(/[\.\-]/g, '_');
    markups[model] = {
      envKey,
      value: getStudentMarkup(model),
      envValue: process.env[envKey] || null,
    };
  }
  res.json({ markups, fallback: getStudentMarkup() });
});

app.patch('/admin/markups', adminLimiter, requireAdmin, (req, res) => {
  const { model, value } = req.body || {};
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'Body: { "model": "gpt-5", "value": 1.6 }' });
  }
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num < 1) {
    return res.status(400).json({ error: 'value mora biti broj >= 1' });
  }
  const envKey = 'MARKUP_' + model.toUpperCase().replace(/[\.\-]/g, '_');
  process.env[envKey] = String(num);
  res.json({ ok: true, envKey, value: num, effective: getStudentMarkup(model) });
});

// ---- Admin: email list export ----
app.get('/admin/emails', adminLimiter, requireAdmin, asyncHandler(async (_req, res) => {
  const allStudents = await getAllStudents();
  const emails = allStudents
    .filter(s => s.email && s.active)
    .map(s => ({ name: s.name, email: s.email }));
  res.json({ count: emails.length, emails });
}));

// ---- Admin usage ----
app.get('/usage', adminLimiter, requireAdmin, asyncHandler(async (_req, res) => {
  res.json(await getUsageSummary());
}));

// ---- Admin: full overview (all users, models, earnings) ----
app.get('/admin/api/overview', adminLimiter, requireAdmin, asyncHandler(async (_req, res) => {
  // Auth enforced by requireAdmin middleware (header-only, never query string).
  const allUsage = await getUsageSummary();
  const users = [];
  let totalProviderCost = 0;
  let totalCharged = 0;
  let openaiCost = 0;
  let anthropicCost = 0;
  
  const modelToProvider = {};
  VAJB_MODELS.forEach(m => { modelToProvider[m.backendModel] = m.backend; });
  
  for (const [keyId, data] of Object.entries(allUsage)) {
    const bal = await getBalance(keyId);
    const student = await findByKey(keyId);
    const noMarkup = student?.noMarkup || false;
    
    let userProviderCost = 0;
    let userCharged = 0;
    if (data.by_model) {
      for (const [model, stats] of Object.entries(data.by_model)) {
        const pCost = providerCostUsd(stats.input_tokens, stats.output_tokens, model);
        userProviderCost += pCost;
        userCharged += noMarkup ? pCost : pCost * getStudentMarkup(model);
        
        const provider = modelToProvider[model] || (model.startsWith('gpt') ? 'openai' : 'anthropic');
        if (provider === 'openai') {
          openaiCost += pCost;
        } else {
          anthropicCost += pCost;
        }
      }
    }
    totalProviderCost += userProviderCost;
    totalCharged += userCharged;
    
    users.push({
      key_id: keyId,
      name: student?.name || keyId,
      balance_usd: bal,
      noMarkup,
      provider_cost_usd: Math.round(userProviderCost * 1e6) / 1e6,
      charged_usd: Math.round(userCharged * 1e6) / 1e6,
      profit_usd: Math.round((userCharged - userProviderCost) * 1e6) / 1e6,
      ...data
    });
  }
  const modelStats = await getModelStats();
  const firstUse = Object.values(allUsage)
    .map(u => u.last_used).filter(Boolean).sort()[0] || null;

  res.json({
    models: VAJB_MODELS.map((m) => ({
      id: m.id, name: m.name, backend: m.backend, backendModel: m.backendModel, desc: m.desc,
    })),
    prices: getPrices(),
    users,
    markup: {
      openai: getStudentMarkup('gpt-5'),
      anthropic: getStudentMarkup('claude-sonnet-4-6'),
      fallback: getStudentMarkup(),
      perModel: Object.fromEntries(
        Object.keys(getPrices()).map(m => [m, getStudentMarkup(m)])
      ),
    },
    totals: {
      provider_cost_usd: Math.round(totalProviderCost * 1e6) / 1e6,
      charged_usd: Math.round(totalCharged * 1e6) / 1e6,
      profit_usd: Math.round((totalCharged - totalProviderCost) * 1e6) / 1e6,
      openai_cost_usd: Math.round(openaiCost * 1e6) / 1e6,
      anthropic_cost_usd: Math.round(anthropicCost * 1e6) / 1e6,
    },
    model_stats: modelStats,
    first_use: firstUse,
  });
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vajb-agent' });
});

app.get('/api/version', (_req, res) => {
  try {
    const extPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vajbagent-vscode', 'package.json'), 'utf-8'));
    res.json({ version: extPkg.version, download: '/vajbagent-latest.vsix' });
  } catch {
    res.json({ version: '2.0.0', download: '/vajbagent-latest.vsix' });
  }
});

// ---- Static pages ----
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/payment-status', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'payment-status.html'));
});
app.get('/setup', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});
app.get('/testiranje', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'testiranje.html'));
});
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ---- Static assets (favicon, etc.) ----
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.use('/docs', express.static(path.join(__dirname, '..', 'docs')));

// ---- Debug ----
app.get('/debug/redis', adminLimiter, asyncHandler(async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
  const { getRedis, isRedisConfigured } = await import('./redis.js');
  const configured = isRedisConfigured();
  let ping = null;
  let keys = {};
  if (configured) {
    const r = getRedis();
    try {
      ping = await r.ping();
      const bal = await r.get('vajb:balances');
      const usg = await r.get('vajb:usage');
      const stu = await r.get('vajb:students');
      keys = {
        balances: { type: typeof bal, isObj: bal && typeof bal === 'object', keys: bal ? Object.keys(bal).length : 0 },
        usage: { type: typeof usg, isObj: usg && typeof usg === 'object', keys: usg ? Object.keys(usg).length : 0 },
        students: { type: typeof stu, isArr: Array.isArray(stu), count: Array.isArray(stu) ? stu.length : 0 },
      };
    } catch (err) { ping = 'error: ' + err.message; }
  }
  res.json({ configured, ping, keys });
}));

// ---- Web Search (Tavily) ----
// Each web search costs a flat fee (approximates Tavily's ~$0.008/call + margin).
const WEB_SEARCH_COST_USD = 0.02;
app.post('/v1/web-search', authLimiter, requireStudentAuth, asyncHandler(async (req, res) => {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey || tavilyKey === 'tvly-YOUR_KEY_HERE') {
    return res.status(503).json({ error: { message: 'Web search nije konfigurisan.', code: 'search_not_configured' } });
  }

  const { query, max_results = 5, include_answer = true } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: { message: 'Parametar "query" je obavezan (min 2 karaktera).', code: 'invalid_query' } });
  }

  // Require sufficient balance before calling upstream — prevents free usage
  const preBalance = await getBalance(req.studentKeyId);
  if (preBalance < WEB_SEARCH_COST_USD) {
    return res.status(402).json({ error: { message: 'Nedovoljan kredit za web pretragu.', code: 'insufficient_funds' } });
  }

  try {
    const tavilyRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyKey,
        query: query.trim(),
        max_results: Math.min(Math.max(Number(max_results) || 5, 1), 10),
        include_answer: !!include_answer,
        include_raw_content: false,
        search_depth: 'advanced',
      }),
    });

    if (!tavilyRes.ok) {
      const errBody = await tavilyRes.text();
      console.error('Tavily API error:', tavilyRes.status, errBody);
      return res.status(502).json({ error: { message: 'Web search greška.', code: 'search_error' } });
    }

    const data = await tavilyRes.json();

    const results = (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
      score: r.score || 0,
    }));

    // Deduct flat fee on successful search
    try { await deductBalance(req.studentKeyId, WEB_SEARCH_COST_USD); } catch (e) { console.warn('[web-search] deduct failed:', e.message); }

    res.json({
      query: query.trim(),
      answer: data.answer || null,
      results,
    });
  } catch (err) {
    console.error('Web search error:', err.message);
    res.status(502).json({ error: { message: 'Web search nedostupan. Pokušaj ponovo.', code: 'search_error' } });
  }
}));

// ---- Image Search (Unsplash proxy) ----
// Key never ships to the client; backend holds it in env.
app.post('/v1/image-search', authLimiter, requireAuth, asyncHandler(async (req, res) => {
  const unsplashKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!unsplashKey) {
    return res.status(503).json({ error: { message: 'Image search nije konfigurisan.', code: 'search_not_configured' } });
  }
  const { query, count = 5, orientation } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: { message: 'query je obavezan (min 2 karaktera).' } });
  }
  const safeCount = Math.min(Math.max(Number(count) || 5, 1), 10);
  try {
    let url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query.trim())}&per_page=${safeCount}`;
    if (orientation && /^(landscape|portrait|squarish)$/.test(orientation)) {
      url += `&orientation=${orientation}`;
    }
    const upstream = await fetch(url, {
      headers: {
        'Authorization': `Client-ID ${unsplashKey}`,
        'Accept-Version': 'v1',
      },
    });
    if (upstream.status === 403 || upstream.status === 429) {
      return res.status(429).json({ error: { message: 'Rate limit dostignut.' } });
    }
    if (!upstream.ok) {
      return res.status(502).json({ error: { message: 'Image search upstream error.' } });
    }
    const data = await upstream.json();
    const results = (data.results || []).map(p => ({
      url: p.urls?.regular || p.urls?.small || '',
      alt: p.alt_description || p.description || 'No description',
      photographer: p.user?.name || 'Unknown',
      profile: p.user?.links?.html || '',
    }));
    // Fire-and-forget download tracking (required by Unsplash guidelines)
    for (const p of data.results || []) {
      if (p.links?.download_location) {
        fetch(`${p.links.download_location}?client_id=${unsplashKey}`).catch(() => {});
      }
    }
    res.json({ query: query.trim(), results });
  } catch (err) {
    console.error('[image-search] error:', err.message);
    res.status(502).json({ error: { message: 'Image search nedostupan.' } });
  }
}));

// ---- Voice transcription (Whisper) ----
// Whisper is ~$0.006/min. We cap audio at ~3MB (short clips only) and charge a flat fee per call.
const TRANSCRIBE_COST_USD = 0.02;
const MAX_AUDIO_B64_LENGTH = 4_500_000; // ~3MB decoded
app.post('/v1/audio/transcribe', authLimiter, requireStudentAuth, asyncHandler(async (req, res) => {
  const { audio, format } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: { message: 'Parametar "audio" (base64) je obavezan.', code: 'invalid_audio' } });
  }
  if (audio.length > MAX_AUDIO_B64_LENGTH) {
    return res.status(413).json({ error: { message: 'Audio zapis je prevelik. Maksimum ~3MB.', code: 'audio_too_large' } });
  }
  // Basic base64 sanity check — reject non-base64 input (prevents feeding random bytes to OpenAI)
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(audio.slice(0, 200))) {
    return res.status(400).json({ error: { message: 'Nevažeći audio format.', code: 'invalid_audio' } });
  }

  // Balance check
  const preBalance = await getBalance(req.studentKeyId);
  if (preBalance < TRANSCRIBE_COST_USD) {
    return res.status(402).json({ error: { message: 'Nedovoljan kredit za transkripciju.', code: 'insufficient_funds' } });
  }

  // Use first available OpenAI key for Whisper
  if (openaiPool.length === 0) {
    return res.status(503).json({ error: { message: 'Whisper nije konfigurisan.', code: 'whisper_not_configured' } });
  }

  const poolEntry = openaiPool[0];

  try {
    const audioBuffer = Buffer.from(audio, 'base64');
    const ext = format === 'webm' ? 'webm' : 'webm';
    const file = new File([audioBuffer], `voice.${ext}`, { type: `audio/${ext}` });

    const transcription = await poolEntry.client.audio.transcriptions.create({
      model: 'whisper-1',
      file: file,
      language: 'sr',
    });

    try { await deductBalance(req.studentKeyId, TRANSCRIBE_COST_USD); } catch (e) { console.warn('[transcribe] deduct failed:', e.message); }

    // Log usage (truncated — never log entire transcript)
    console.log(`[Whisper] key=${keyId(req.studentApiKey).slice(0, 8)}... size=${audioBuffer.length}b`);

    res.json({ text: transcription.text || '' });
  } catch (err) {
    console.error('Whisper error:', err.message);
    res.status(502).json({ error: { message: 'Greska pri transkripciji zvuka.', code: 'whisper_error' } });
  }
}));

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found' } });
});

// ---- Global error handler (never leak stack traces) ----
// IMPORTANT: mark error responses as non-cacheable so Cloudflare (or any
// upstream proxy) never locks in a broken response. We learned this the
// hard way when a transient 500 during a deploy got stuck on the CF edge.
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  res.status(500).json({ error: { message: 'Internal server error' } });
});

const server = app.listen(PORT, () => {
  console.log(`VajbAgent proxy listening on http://localhost:${PORT}`);
  console.log(`  Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'configured' : 'NOT configured (file fallback)'}`);
  console.log(`  OpenAI keys: ${openaiPool.length} | Anthropic keys: ${anthropicPool.length}`);
  console.log(`  Max concurrent per user: ${MAX_CONCURRENT_PER_USER}`);
  console.log(`  Models: ${VAJB_MODELS.map(m => m.id).join(', ')}`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions (Bearer token required)`);
  console.log(`  GET  /dashboard – student dashboard`);
  console.log(`  GET  /setup – setup instructions`);
  console.log(`  GET  /admin/info – model info (admin only)`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
