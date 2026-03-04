import 'dotenv/config';
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
  toOpenAIStreamChunkToolCalls,
  streamDone,
  trimOpenAIMessages,
} from './convert.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logUsage, getUsageSummary, getUsageForKey, getModelStats } from './usage.js';
import { getBalance, deductBalance, costUsd, addBalance } from './balance.js';
import { seedFromEnv, getAllStudents, addStudent, removeStudent, toggleStudent, findByKey, canRegisterFromIP, trackRegistrationIP } from './students.js';

await seedFromEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---- Model registry: 5 tiers, dual backend (OpenAI + Anthropic) ----
const MAX_OUTPUT = {
  'gpt-4o-mini': 16384,
  'gpt-4o':      16384,
  'claude-haiku-4-5': 65536,
  'claude-sonnet-4-6': 65536,
  'claude-opus-4-6': 131072,
};

const VAJB_MODELS = [
  { id: 'vajb-agent-nano',  name: 'VajbAgent Nano',  backend: 'openai',    backendModel: 'gpt-4o-mini',      desc: 'Najjeftiniji, za svakodnevna pitanja' },
  { id: 'vajb-agent-lite',  name: 'VajbAgent Lite',  backend: 'openai',    backendModel: 'gpt-4o',           desc: 'Daily coding, odličan za cenu' },
  { id: 'vajb-agent-pro',   name: 'VajbAgent Pro',   backend: 'anthropic', backendModel: 'claude-haiku-4-5',  desc: 'Brz Claude, solidno kodiranje' },
  { id: 'vajb-agent-max',   name: 'VajbAgent Max',   backend: 'anthropic', backendModel: 'claude-sonnet-4-6', desc: 'Ozbiljan rad, kompleksni projekti' },
  { id: 'vajb-agent-ultra', name: 'VajbAgent Ultra', backend: 'anthropic', backendModel: 'claude-opus-4-6',   desc: 'Premium, najjači za agente' },
];
const DEFAULT_VAJB_MODEL = VAJB_MODELS[0].id;

function resolveModel(requestedModel) {
  const id = (requestedModel || '').trim();
  if (!id) return null;
  return VAJB_MODELS.find((m) => m.id === id) || null;
}

// ---- Clients ----
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY is not set; Anthropic models (Pro/Max/Ultra) will fail.');
}
if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is not set; OpenAI models (Nano/Lite) will fail.');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'dummy' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'dummy' });

async function withRetry(fn, { retries = 2, delayMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.statusCode || 0;
      const retryable = status === 429 || status === 529 || status === 503;
      if (!retryable || attempt >= retries) throw err;
      const wait = delayMs * (attempt + 1);
      console.log(`Retrying after ${status} (attempt ${attempt + 1}/${retries}, wait ${wait}ms)`);
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

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && auth.length > 12) return 'key:' + auth.slice(7, 27);
    return 'ip:' + (req.ip || 'unknown');
  },
  validate: false,
  handler: (_req, res) => res.status(429).json({ error: { message: 'Previše zahteva. Pokušaj ponovo za 15 minuta.', code: 'rate_limit' } }),
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  validate: { trustProxy: false },
  handler: (_req, res) => res.status(429).json({ error: { message: 'Previše admin zahteva. Sačekaj.', code: 'rate_limit' } }),
});

function normalizeIP(ip) {
  if (!ip) return ip;
  return ip.replace(/^::ffff:/, '');
}

const WHITELIST_IPS = new Set(
  (process.env.WHITELIST_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
);

function isWhitelistedIP(req) {
  const raw = req.ip || req.connection?.remoteAddress || '';
  return WHITELIST_IPS.has(normalizeIP(raw));
}

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
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

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
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
});

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

app.post('/register', registerLimiter, async (req, res) => {
  const { first_name, last_name, honeypot, token } = req.body || {};

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

  const fullName = first_name.trim() + ' ' + last_name.trim();
  const result = await addStudent(fullName);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  if (REGISTER_BONUS > 0) {
    await addBalance(result.student.key, REGISTER_BONUS);
  }

  await trackRegistrationIP(clientIP);
  console.log(`Self-registration: "${fullName}" → key ${result.student.key.slice(0, 12)}... [IP: ${clientIP}]`);

  res.json({
    name: result.student.name,
    key: result.student.key,
    balance_usd: await getBalance(result.student.key),
  });
});

// ---- Chat completions handler ----
const chatCompletionsHandler = [
  authLimiter,
  requireStudentAuth,
  async (req, res) => {
    const body = req.body || {};
    const { messages, stream = false, max_tokens = 4096, model, tools: openAITools } = body;

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
    if (messages.length > 500) {
      return res.status(400).json({
        error: { message: `Too many messages (${messages.length}). Max 500.`, code: 'too_many_messages' },
      });
    }
    if (Array.isArray(openAITools) && openAITools.length > 128) {
      return res.status(400).json({
        error: { message: `Too many tools (${openAITools.length}). Max 128.`, code: 'too_many_tools' },
      });
    }

    const keyId = req.studentKeyId;
    const balance = await getBalance(keyId);
    if (balance <= 0) {
      return res.status(402).json({
        error: {
          message: `Nedovoljno kredita (stanje: ${balance.toFixed(2)} USD). Dopuni nalog na dashboardu ili kontaktiraj administratora.`,
          code: 'insufficient_credits',
          balance_usd: balance,
        },
      });
    }

    try {
      if (resolved.backend === 'openai') {
        await handleOpenAI(req, res, keyId, resolved, messages, openAITools, stream, max_tokens);
      } else {
        await handleAnthropic(req, res, keyId, resolved, messages, openAITools, stream, max_tokens);
      }
    } catch (err) {
      console.error(`${resolved.backend} error [${err.status || '?'}]:`, err.message);
      if (res.headersSent) return;

      const status = err.status || 502;
      const msg = err.message || 'Upstream error';
      let userMsg = msg;
      let code = 'api_error';

      if (status === 429) {
        userMsg = 'API rate limit dostignut. Sačekaj par sekundi i pokušaj ponovo.';
        code = 'rate_limit';
      } else if (status === 529 || msg.includes('overloaded')) {
        userMsg = 'Backend model je trenutno preopterećen. Pokušaj ponovo za minut ili probaj jeftiniji model.';
        code = 'overloaded';
      } else if (msg.includes('context') || msg.includes('token') || msg.includes('too long') || msg.includes('maximum')) {
        userMsg = 'Kontekst je prevelik čak i posle trimovanja. Pokušaj sa kraćim promptom ili zatvori nepotrebne fajlove u Cursor-u.';
        code = 'context_too_large';
      }

      res.status(status).json({
        error: { message: userMsg, type: code, detail: msg },
      });
    }
  },
];
app.post('/v1/chat/completions', chatCompletionsHandler);
app.post('/chat/completions', chatCompletionsHandler);

// ---- OpenAI backend (Nano, Lite) ----
async function handleOpenAI(req, res, keyId, resolved, messages, openAITools, stream, max_tokens) {
  const modelMax = MAX_OUTPUT[resolved.backendModel] || 16384;
  const requested = Number(max_tokens) || 4096;
  const maxTokens = Math.min(Math.max(requested, 256), modelMax);
  const trimmedMessages = trimOpenAIMessages(messages, resolved.backendModel);

  const isReasoning = resolved.backendModel.startsWith('o') || resolved.backendModel.includes('gpt-5');

  const payload = {
    model: resolved.backendModel,
    messages: trimmedMessages,
    ...(isReasoning
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }),
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
    ...(isReasoning && { reasoning_effort: maxTokens <= 2048 ? 'low' : 'medium' }),
    ...(Array.isArray(openAITools) && openAITools.length > 0 && { tools: openAITools }),
  };

  console.log(`OpenAI request: model=${resolved.backendModel}, msgs=${messages.length}→${trimmedMessages.length}, stream=${stream}`);

  if (stream) {
    await handleOpenAIStream(res, keyId, resolved, payload);
  } else {
    await handleOpenAINonStream(res, keyId, resolved, payload);
  }
}

async function handleOpenAINonStream(res, keyId, resolved, payload) {
  const response = await withRetry(() => openai.chat.completions.create(payload));

  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
    model: resolved.backendModel,
  };
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  await deductBalance(keyId, usd);
  await logUsage(keyId, usage);

  response.model = resolved.id;
  res.json(response);
}

async function handleOpenAIStream(res, keyId, resolved, payload) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const STREAM_TIMEOUT = 5 * 60 * 1000;
  let lastChunkTime = Date.now();
  const timeoutCheck = setInterval(() => {
    if (Date.now() - lastChunkTime > STREAM_TIMEOUT) {
      clearInterval(timeoutCheck);
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    }
  }, 30000);

  const stream = await withRetry(() => openai.chat.completions.create(payload));

  let usage = { input_tokens: 0, output_tokens: 0 };
  let chunkCount = 0;

  for await (const chunk of stream) {
    lastChunkTime = Date.now();
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
    }
    chunkCount++;
    chunk.model = resolved.id;
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    if (res.flush) res.flush();
  }

  clearInterval(timeoutCheck);
  res.write('data: [DONE]\n\n');
  res.end();

  if (usage.input_tokens === 0 && usage.output_tokens === 0) {
    const estIn = Math.max(chunkCount * 50, 1000);
    const estOut = Math.max(chunkCount * 15, 200);
    usage = { input_tokens: estIn, output_tokens: estOut };
    console.log(`OpenAI stream: no usage reported, estimating ~${estIn} in / ~${estOut} out from ${chunkCount} chunks`);
  }
  usage.model = resolved.backendModel;
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  await deductBalance(keyId, usd);
  await logUsage(keyId, usage);
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
  console.log(`Anthropic request: ${originalMsgCount} msgs → ${anthropicMessages.length} msgs, ~${Math.round(ctxChars / 4000)}K tokens, model=${resolved.backendModel}`);

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

  const payload = {
    model: resolved.backendModel,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    ...(mergedSystem && { system: mergedSystem }),
    ...(anthropicTools.length > 0 && { tools: anthropicTools }),
  };

  if (stream) {
    await handleAnthropicStream(res, keyId, resolved, payload);
  } else {
    await handleAnthropicNonStream(res, keyId, resolved, payload);
  }
}

async function handleAnthropicNonStream(res, keyId, resolved, payload) {
  const response = await withRetry(() => anthropic.messages.create({ ...payload, stream: false }));

  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
    model: resolved.backendModel,
  };
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  await deductBalance(keyId, usd);
  await logUsage(keyId, usage);

  const openAIResponse = toOpenAIChatCompletion(
    response, response.usage, resolved.id, response.id || 'vajb-' + Date.now()
  );
  res.json(openAIResponse);
}

async function handleAnthropicStream(res, keyId, resolved, payload) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const streamId = 'vajb-' + Date.now();
  let usage = { input_tokens: 0, output_tokens: 0 };
  const toolCalls = [];
  let currentToolIndex = -1;

  const STREAM_TIMEOUT = 5 * 60 * 1000;
  let lastChunkTime = Date.now();
  const timeoutCheck = setInterval(() => {
    if (Date.now() - lastChunkTime > STREAM_TIMEOUT) {
      clearInterval(timeoutCheck);
      if (!res.writableEnded) { res.end(); }
    }
  }, 30000);

  const stream = await withRetry(() => anthropic.messages.create({ ...payload, stream: true }));

  for await (const event of stream) {
    lastChunkTime = Date.now();
    if (event.type === 'message_start' && event.message?.usage) {
      usage.input_tokens = event.message.usage.input_tokens ?? 0;
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const b = event.content_block;
      toolCalls.push({ id: b.id, name: b.name || 'tool', inputStr: '' });
      currentToolIndex = toolCalls.length - 1;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        res.write(toOpenAIStreamChunk(delta.text, { id: streamId, model: resolved.id }));
        if (res.flush) res.flush();
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string' && currentToolIndex >= 0 && toolCalls[currentToolIndex]) {
        toolCalls[currentToolIndex].inputStr += delta.partial_json;
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

  clearInterval(timeoutCheck);

  if (toolCalls.length > 0) {
    const openAIToolCalls = toolCalls.map((tc, i) => {
      let args = tc.inputStr || '{}';
      try { JSON.parse(args); } catch (_) { args = '{}'; }
      return { index: i, id: tc.id, name: tc.name, arguments: args };
    });
    res.write(toOpenAIStreamChunkToolCalls(openAIToolCalls, { id: streamId, model: resolved.id }));
  } else {
    res.write(toOpenAIStreamChunk('', { id: streamId, model: resolved.id, finish: true }));
  }
  res.write(streamDone());
  res.end();

  usage.model = resolved.backendModel;
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  await deductBalance(keyId, usd);
  await logUsage(keyId, usage);
}

// ---- Usage + balance for current key (dashboard) ----
app.get('/me', authLimiter, requireStudentAuth, async (req, res) => {
  const keyId = req.studentKeyId;
  const name = req.studentName || 'Unknown';
  const balanceUsd = await getBalance(keyId);
  const data = await getUsageForKey(keyId);
  if (!data) {
    return res.json({
      key_id: keyId, name, balance_usd: balanceUsd,
      input_tokens: 0, output_tokens: 0, requests: 0, last_used: null, estimated_cost_usd: 0,
    });
  }
  const input = data.input_tokens || 0;
  const output = data.output_tokens || 0;
  const estimatedCost = costUsd(input, output);
  res.json({
    key_id: keyId, name, balance_usd: balanceUsd,
    input_tokens: input, output_tokens: output,
    requests: data.requests || 0, last_used: data.last_used || null,
    estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
  });
});

// ---- Stripe checkout ----
app.post('/create-checkout', authLimiter, requireStudentAuth, async (req, res) => {
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
});

// ---- Admin: add credits ----
app.post('/admin/add-credits', adminLimiter, async (req, res) => {
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
});

// ---- Admin: student management ----
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret || req.body?.admin_secret;
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/admin/students', adminLimiter, requireAdmin, async (_req, res) => {
  const allStudents = await getAllStudents();
  const students = [];
  for (const s of allStudents) {
    students.push({ ...s, balance_usd: await getBalance(s.key) });
  }
  res.json(students);
});

app.post('/admin/students', adminLimiter, requireAdmin, async (req, res) => {
  const { name, initial_balance } = req.body || {};
  const result = await addStudent(name);
  if (result.error) return res.status(400).json({ error: result.error });
  const bal = Number(initial_balance);
  if (Number.isFinite(bal) && bal > 0) {
    await addBalance(result.student.key, bal);
  }
  res.json({
    ...result.student,
    balance_usd: await getBalance(result.student.key),
  });
});

app.delete('/admin/students/:key', adminLimiter, requireAdmin, async (req, res) => {
  const result = await removeStudent(req.params.key);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

app.patch('/admin/students/:key', adminLimiter, requireAdmin, async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Body: { "active": true/false }' });
  }
  const result = await toggleStudent(req.params.key, active);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result.student);
});

// ---- Admin usage ----
app.get('/usage', adminLimiter, requireAdmin, async (_req, res) => {
  res.json(await getUsageSummary());
});

// ---- Admin: full overview (all users, models, earnings) ----
app.get('/admin/api/overview', adminLimiter, async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const allUsage = await getUsageSummary();
  const markup = parseFloat(process.env.STUDENT_MARKUP) || 1;
  const users = [];
  for (const [keyId, data] of Object.entries(allUsage)) {
    const bal = await getBalance(keyId);
    const student = await findByKey(keyId);
    users.push({ key_id: keyId, name: student?.name || keyId, balance_usd: bal, ...data });
  }
  const modelStats = await getModelStats();
  const firstUse = Object.values(allUsage)
    .map(u => u.last_used).filter(Boolean).sort()[0] || null;

  res.json({
    models: VAJB_MODELS.map((m) => ({
      id: m.id, name: m.name, backend: m.backend, backendModel: m.backendModel, desc: m.desc,
    })),
    users,
    markup,
    model_stats: modelStats,
    first_use: firstUse,
  });
});

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
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

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

app.get('/debug/redis', adminLimiter, async (req, res) => {
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
});

app.listen(PORT, () => {
  console.log(`VajbAgent proxy listening on http://localhost:${PORT}`);
  console.log(`  Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'configured' : 'NOT configured (file fallback)'}`);
  console.log(`  Models: ${VAJB_MODELS.map(m => m.id).join(', ')}`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions (Bearer token required)`);
  console.log(`  GET  /dashboard – student dashboard`);
  console.log(`  GET  /setup – setup instructions`);
  console.log(`  GET  /admin/info – model info (admin only)`);
});
