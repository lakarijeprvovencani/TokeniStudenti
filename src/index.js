import 'dotenv/config';

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { requireStudentAuth } from './auth.js';
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
import { getBalance, deductBalance, costUsd, addBalance, getTotalDeposited, loadStudentMarkupFlags, setStudentNoMarkup, getStudentMarkup, providerCostUsd, getPrices } from './balance.js';
import { seedFromEnv, getAllStudents, addStudent, removeStudent, toggleStudent, toggleStudentMarkup, findByKey, findByEmail, canRegisterFromIP, trackRegistrationIP } from './students.js';
import { sendWelcomeEmail, sendRecoveryEmail, isEmailConfigured } from './email.js';

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
  'claude-sonnet-4-6': 64000,    // verified: platform.claude.com/docs/en/about-claude/models/overview
  'gpt-5.4':           128000,   // verified: developers.openai.com/api/docs/models/gpt-5.4
  'claude-opus-4-6':   128000,   // verified: platform.claude.com/docs/en/about-claude/models/overview
  // Legacy (fallback)
  'gpt-4.1-mini':      32768,    // verified: developers.openai.com/api/docs/models/gpt-4.1
  'gpt-4.1':           32768,    // verified: developers.openai.com/api/docs/models/gpt-4.1
};

const VAJB_MODELS = [
  { id: 'vajb-agent-lite',      name: 'VajbAgent Lite',      backend: 'openai',    backendModel: 'gpt-5-mini',      desc: 'GPT-5 Mini — svakodnevno kodiranje, best value' },
  { id: 'vajb-agent-turbo',     name: 'VajbAgent Turbo',     backend: 'openai',    backendModel: 'gpt-4.1',          desc: 'GPT-4.1 — brz i precizan, jak u kodiranju' },
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

app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors());

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
  if (req.query.secret) logPath = req.path + '?secret=***';
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
      let data = await r.get(STRIPE_REDIS_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && typeof data === 'object' && data[eventId]) return true;
    } catch {}
  }
  const file = readStripeEventsFile();
  return !!file[eventId];
}
async function markStripeEventProcessed(eventId) {
  const now = Date.now();
  const r = getRedis();
  let events = {};
  if (r) {
    try {
      let data = await r.get(STRIPE_REDIS_KEY);
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      if (data && typeof data === 'object') events = data;
    } catch {}
  } else {
    events = readStripeEventsFile();
  }
  for (const [id, ts] of Object.entries(events)) {
    if (now - ts > STRIPE_EVENT_TTL) delete events[id];
  }
  events[eventId] = now;
  if (r) { try { await r.set(STRIPE_REDIS_KEY, events); } catch {} }
  try { writeStripeEventsFile(events); } catch {}
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
  if (await isStripeEventProcessed(event.id)) {
    console.log('Stripe webhook: duplicate event ignored', event.id);
    return res.status(200).send();
  }
  await markStripeEventProcessed(event.id);

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

app.use(express.json({ limit: '10mb' }));
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Payload prevelik. Max 10MB.', code: 'payload_too_large' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Neispravan JSON.', code: 'invalid_json' } });
  }
  next(err);
});

// ---- Root: landing page ----
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.head('/', (_req, res) => res.status(200).end());

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
  const secret = req.headers['x-admin-secret'] || req.query.secret;
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
const REGISTER_TOKEN_SECRET = process.env.ADMIN_SECRET || 'fallback-reg-secret';
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
const LOW_BALANCE_THRESHOLD = 1.0;
const _balanceWarningSent = new Map();
async function getBalanceWarning(keyId, newBalance) {
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
  requireStudentAuth,
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
      const enhancedMessages = injectSystemPrompt(messages, resolved.isPower === true);

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

      res.status(status).json({
        error: { message: userMsg, type: code, detail: msg },
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

  const isReasoning = resolved.backendModel.startsWith('o');
  const isGpt5 = resolved.backendModel.startsWith('gpt-5');

  const payload = {
    model: resolved.backendModel,
    messages: trimmedMessages,
    max_completion_tokens: maxTokens,
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
    ...(isReasoning && { reasoning_effort: maxTokens <= 2048 ? 'low' : 'medium' }),
    ...(Array.isArray(openAITools) && openAITools.length > 0 && { tools: openAITools }),
  };

  const poolEntry = acquireFromPool(openaiPool, 'OpenAI');
  console.log(`OpenAI request: model=${resolved.backendModel}, msgs=${messages.length}→${trimmedMessages.length}, stream=${stream}, pool=${openaiPool.indexOf(poolEntry)+1}/${openaiPool.length}`);

  try {
    if (stream) {
      await handleOpenAIStream(res, keyId, resolved, payload, poolEntry.client);
    } else {
      await handleOpenAINonStream(res, keyId, resolved, payload, poolEntry.client);
    }
  } finally {
    releaseFromPool(poolEntry);
  }
}

async function handleOpenAINonStream(res, keyId, resolved, payload, client) {
  const response = await withRetry(() => client.chat.completions.create(payload));

  // Validate response has content
  if (!response?.choices?.[0]?.message) {
    console.error('OpenAI returned empty/invalid response:', JSON.stringify(response));
    return res.status(502).json({
      error: { message: 'Model returned empty response. Please try again.', code: 'empty_response' }
    });
  }

  const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    model: resolved.backendModel,
  };
  if (reasoning > 0) {
    console.log(`OpenAI reasoning tokens: ${reasoning} (billed as output, total output=${usage.output_tokens})`);
  }
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel, keyId);
  const newBal = await deductBalance(keyId, usd);
  await logUsage(keyId, usage);

  const warning = await getBalanceWarning(keyId, newBal);
  if (warning && response.choices?.[0]?.message?.content) {
    response.choices[0].message.content += warning;
  }

  response.model = resolved.id;
  res.json(response);
}

async function handleOpenAIStream(res, keyId, resolved, payload, client) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const STREAM_TIMEOUT = 2 * 60 * 1000;
  const KEEPALIVE_INTERVAL = 15000;
  let lastChunkTime = Date.now();

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
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

  try {
    for await (const chunk of stream) {
      if (res.writableEnded) break;
      lastChunkTime = Date.now();
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
        usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
        usage.reasoning_tokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0;
      }
      chunkCount++;
      chunk.model = resolved.id;
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      if (res.flush) res.flush();
    }
  } catch (streamErr) {
    console.error('OpenAI stream error mid-flight:', streamErr.message);
  }

  clearInterval(timeoutCheck);
  clearInterval(keepAlive);

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
    const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel, keyId);
    const newBal = await deductBalance(keyId, usd);
    await logUsage(keyId, usage);

    const warning = await getBalanceWarning(keyId, newBal);
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

  const CURSOR_EDIT_HINT = [
    'Korisnik radi u Cursor IDE. Kad predlažeš izmene koda:',
    '- Daj konkretan kod u markdown code block-u sa jasno označenim fajlom ako je poznat.',
    '- Formuliši tako da IDE može da ponudi primenu (Apply).',
    '- Ako menjaš postojeći fajl, navedi koji fajl i daj ceo izmenjeni blok.',
  ].join(' ');
  const mergedSystem = [CURSOR_EDIT_HINT, system].filter(Boolean).join('\n\n');

  const anthropicTools = openAIToolsToAnthropic(openAITools);
  const modelMax = MAX_OUTPUT[resolved.backendModel] || 16384;
  const maxTokens = Math.min(Math.max(Number(max_tokens) || 4096, 1), modelMax);

  // Anthropic prompt caching: send system as structured block with cache_control
  // Cached system prompt tokens cost 90% less on repeat calls
  const systemPayload = mergedSystem
    ? [{ type: 'text', text: mergedSystem, cache_control: { type: 'ephemeral' } }]
    : undefined;

  const payload = {
    model: resolved.backendModel,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    ...(systemPayload && { system: systemPayload }),
    ...(anthropicTools.length > 0 && { tools: anthropicTools }),
  };

  const poolEntry = acquireFromPool(anthropicPool, 'Anthropic');
  console.log(`Anthropic request: ${originalMsgCount} msgs → ${anthropicMessages.length} msgs, ~${Math.round(ctxChars / 4000)}K tokens, model=${resolved.backendModel}, pool=${anthropicPool.indexOf(poolEntry)+1}/${anthropicPool.length}`);

  try {
    if (stream) {
      await handleAnthropicStream(res, keyId, resolved, payload, poolEntry.client);
    } else {
      await handleAnthropicNonStream(res, keyId, resolved, payload, poolEntry.client);
    }
  } finally {
    releaseFromPool(poolEntry);
  }
}

async function handleAnthropicNonStream(res, keyId, resolved, payload, client) {
  const response = await withRetry(() => client.messages.create({ ...payload, stream: false }));

  // Validate response has content
  if (!response?.content || response.content.length === 0) {
    console.error('Anthropic returned empty/invalid response:', JSON.stringify(response));
    return res.status(502).json({
      error: { message: 'Model returned empty response. Please try again.', code: 'empty_response' }
    });
  }

  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    model: resolved.backendModel,
  };
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel, keyId);
  const newBal = await deductBalance(keyId, usd);
  await logUsage(keyId, usage);

  const openAIResponse = toOpenAIChatCompletion(
    response, response.usage, resolved.id, response.id || 'vajb-' + Date.now()
  );

  const warning = await getBalanceWarning(keyId, newBal);
  if (warning && openAIResponse.choices?.[0]?.message?.content) {
    openAIResponse.choices[0].message.content += warning;
  }

  res.json(openAIResponse);
}

async function handleAnthropicStream(res, keyId, resolved, payload, client) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const streamId = 'vajb-' + Date.now();
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolCalls = [];
  let currentToolIndex = -1;

  const STREAM_TIMEOUT = 2 * 60 * 1000;
  const KEEPALIVE_INTERVAL = 15000;
  let lastChunkTime = Date.now();

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
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
  
  try {
    for await (const event of stream) {
      lastChunkTime = Date.now();
      
      if (event.type === 'message_start' && event.message?.usage) {
        usage.input_tokens = event.message.usage.input_tokens ?? 0;
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
      
      if (event.type === 'message_delta' && event.usage) {
        if (event.usage.input_tokens != null) usage.input_tokens = event.usage.input_tokens;
        if (event.usage.output_tokens != null) usage.output_tokens = event.usage.output_tokens;
      }
    }
  } catch (streamErr) {
    console.error('Anthropic stream error:', streamErr.message);
  }

  clearInterval(timeoutCheck);
  clearInterval(keepAlive);

  if (toolCalls.length > 0) {
    // Validate accumulated JSON for each tool call (fix if broken)
    for (const tc of toolCalls) {
      try {
        JSON.parse(tc.inputStr || '{}');
      } catch (parseErr) {
        console.warn(`Tool call JSON parse failed for ${tc.name}: ${parseErr.message}. Raw: ${(tc.inputStr || '').slice(0, 200)}...`);
      }
    }
    // Send finish_reason: tool_calls (args were already streamed via deltas)
    const finishChunk = {
      id: streamId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: resolved.id,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    };
    res.write('data: ' + JSON.stringify(finishChunk) + '\n\n');
    if (res.flush) res.flush();
  } else {
    res.write(toOpenAIStreamChunk('', { id: streamId, model: resolved.id, finish: true }));
    if (res.flush) res.flush();
  }

  try {
    usage.model = resolved.backendModel;
    const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel, keyId);
    const newBal = await deductBalance(keyId, usd);
    await logUsage(keyId, usage);

    const warning = await getBalanceWarning(keyId, newBal);
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
app.get('/me', authLimiter, requireStudentAuth, asyncHandler(async (req, res) => {
  const keyId = req.studentKeyId;
  const name = req.studentName || 'Unknown';
  const balanceUsd = await getBalance(keyId);
  const totalDeposited = await getTotalDeposited(keyId);
  const data = await getUsageForKey(keyId);
  const regBonus = parseFloat(process.env.SELF_REGISTER_BONUS) || 2;
  const freeTier = totalDeposited <= regBonus;
  if (!data) {
    return res.json({
      key_id: keyId, name, balance_usd: balanceUsd, total_deposited: totalDeposited,
      free_tier: freeTier,
      input_tokens: 0, output_tokens: 0, requests: 0, last_used: null, estimated_cost_usd: 0,
    });
  }
  const input = data.input_tokens || 0;
  const output = data.output_tokens || 0;
  const lastModel = data.model || 'gpt-5-mini';
  const estimatedCost = costUsd(input, output, lastModel, keyId);
  res.json({
    key_id: keyId, name, balance_usd: balanceUsd, total_deposited: totalDeposited,
    free_tier: freeTier,
    input_tokens: input, output_tokens: output,
    requests: data.requests || 0, last_used: data.last_used || null,
    estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
  });
}));

// ---- Stripe checkout ----
app.post('/create-checkout', authLimiter, requireStudentAuth, asyncHandler(async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(503).json({ error: 'Plaćanje nije konfigurisano.' });
  }
  const amountUsd = Number(req.body?.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1000) {
    return res.status(400).json({ error: 'amount_usd mora biti između 1 i 1000.' });
  }
  const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
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
    params.append('success_url', baseUrl + '/payment-status?status=success&amount=' + amountUsd);
    params.append('cancel_url', baseUrl + '/payment-status?status=cancelled');

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
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret || req.body?.admin_secret;
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
app.get('/admin/api/overview', adminLimiter, asyncHandler(async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
  const secret = req.headers['x-admin-secret'] || req.query.secret;
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
app.post('/v1/web-search', authLimiter, requireStudentAuth, asyncHandler(async (req, res) => {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey || tavilyKey === 'tvly-YOUR_KEY_HERE') {
    return res.status(503).json({ error: { message: 'Web search nije konfigurisan.', code: 'search_not_configured' } });
  }

  const { query, max_results = 5, include_answer = true } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: { message: 'Parametar "query" je obavezan (min 2 karaktera).', code: 'invalid_query' } });
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

// ---- Voice transcription (Whisper) ----
app.post('/v1/audio/transcribe', authLimiter, requireStudentAuth, asyncHandler(async (req, res) => {
  const { audio, format } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: { message: 'Parametar "audio" (base64) je obavezan.', code: 'invalid_audio' } });
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

    // Log usage
    const userId = req.studentId || 'unknown';
    console.log(`Whisper transcription: user=${userId}, size=${audioBuffer.length}b, text="${(transcription.text || '').substring(0, 50)}..."`);

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
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return;
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
