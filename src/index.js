import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import cors from 'cors';
import express from 'express';
import { requireStudentAuth } from './auth.js';
import {
  openAIToAnthropicMessages,
  openAIToolsToAnthropic,
  toOpenAIChatCompletion,
  toOpenAIStreamChunk,
  toOpenAIStreamChunkToolCalls,
  streamDone,
} from './convert.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { logUsage, getUsageSummary, getUsageForKey } from './usage.js';
import { getBalance, deductBalance, costUsd, addBalance } from './balance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ---- Model registry: 5 tiers, dual backend (OpenAI + Anthropic) ----
const VAJB_MODELS = [
  { id: 'vajb-agent-nano',  name: 'VajbAgent Nano',  backend: 'openai',    backendModel: 'gpt-5-nano',       desc: 'Najjeftiniji, za svakodnevna pitanja' },
  { id: 'vajb-agent-lite',  name: 'VajbAgent Lite',  backend: 'openai',    backendModel: 'gpt-5-mini',       desc: 'Daily coding, odličan za cenu' },
  { id: 'vajb-agent-pro',   name: 'VajbAgent Pro',   backend: 'anthropic', backendModel: 'claude-haiku-4-5',  desc: 'Brz Claude, solidno kodiranje' },
  { id: 'vajb-agent-max',   name: 'VajbAgent Max',   backend: 'anthropic', backendModel: 'claude-sonnet-4-6', desc: 'Ozbiljan rad, kompleksni projekti' },
  { id: 'vajb-agent-ultra', name: 'VajbAgent Ultra', backend: 'anthropic', backendModel: 'claude-opus-4-6',   desc: 'Premium, najjači za agente' },
];
const DEFAULT_VAJB_MODEL = VAJB_MODELS[0].id;

function resolveModel(requestedModel) {
  const id = (requestedModel || '').trim() || DEFAULT_VAJB_MODEL;
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

app.use(cors());

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// ---- Stripe webhook (raw body before express.json) ----
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
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
    return res.status(400).send('Webhook signature verification failed');
  }
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).send();
  }
  const session = event.data.object;
  const keyId = session.metadata?.key_id;
  const amountCents = session.amount_total;
  if (!keyId || amountCents == null || amountCents < 0) {
    console.warn('Stripe webhook: missing key_id or amount_total', { key_id: keyId, amount_total: amountCents });
    return res.status(200).send();
  }
  const amountUsd = Math.round((amountCents / 100) * 100) / 100;
  addBalance(keyId.trim(), amountUsd);
  console.log('Credits added', { key_id: keyId, amount_usd: amountUsd });
  res.status(200).send();
});

app.use(express.json());

// ---- Root ----
app.get('/', (_req, res) => {
  res.json({
    service: 'vajb-agent',
    ok: true,
    models: VAJB_MODELS.map((m) => m.id),
    endpoints: {
      models: 'GET /v1/models',
      chat: 'POST /v1/chat/completions',
      dashboard: 'GET /dashboard',
      setup: 'GET /setup',
      health: 'GET /health',
    },
  });
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
app.get('/admin/models', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
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

// ---- Chat completions handler ----
const chatCompletionsHandler = [
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

    const keyId = req.studentKeyId;
    const balance = getBalance(keyId);
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
      console.error(`${resolved.backend} error:`, err.message);
      const status = err.status || 502;
      res.status(status).json({
        error: {
          message: err.message || 'Upstream error',
          type: 'api_error',
        },
      });
    }
  },
];
app.post('/v1/chat/completions', chatCompletionsHandler);
app.post('/chat/completions', chatCompletionsHandler);

// ---- OpenAI backend (Nano, Lite) ----
// OpenAI API is already in OpenAI format, so we pass through with minimal changes.
async function handleOpenAI(req, res, keyId, resolved, messages, openAITools, stream, max_tokens) {
  const maxTokens = Math.min(Math.max(Number(max_tokens) || 4096, 1), 16384);

  const payload = {
    model: resolved.backendModel,
    messages,
    max_completion_tokens: maxTokens,
    stream,
    ...(Array.isArray(openAITools) && openAITools.length > 0 && { tools: openAITools }),
  };

  console.log(`OpenAI request: model=${resolved.backendModel}, msgs=${messages.length}, stream=${stream}`);

  if (stream) {
    await handleOpenAIStream(res, keyId, resolved, payload);
  } else {
    await handleOpenAINonStream(res, keyId, resolved, payload);
  }
}

async function handleOpenAINonStream(res, keyId, resolved, payload) {
  const response = await openai.chat.completions.create(payload);

  const usage = {
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
  };
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  deductBalance(keyId, usd);
  logUsage(keyId, usage);

  response.model = resolved.id;
  res.json(response);
}

async function handleOpenAIStream(res, keyId, resolved, payload) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const stream = await openai.chat.completions.create(payload);

  let usage = { input_tokens: 0, output_tokens: 0 };

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
    }
    chunk.model = resolved.id;
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
    if (res.flush) res.flush();
  }

  res.write('data: [DONE]\n\n');
  res.end();

  if (usage.input_tokens === 0 && usage.output_tokens === 0) {
    usage = { input_tokens: 500, output_tokens: 200 };
  }
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  deductBalance(keyId, usd);
  logUsage(keyId, usage);
}

// ---- Anthropic backend (Pro, Max, Ultra) ----
async function handleAnthropic(req, res, keyId, resolved, messages, openAITools, stream, max_tokens) {
  const originalMsgCount = messages.length;
  const { system, messages: anthropicMessages } = openAIToAnthropicMessages(messages);

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
  const maxTokens = Math.min(Math.max(Number(max_tokens) || 4096, 1), 16384);

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
  const response = await anthropic.messages.create({ ...payload, stream: false });

  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  deductBalance(keyId, usd);
  logUsage(keyId, usage);

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

  const stream = await anthropic.messages.create({ ...payload, stream: true });

  for await (const event of stream) {
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

  const usd = costUsd(usage.input_tokens, usage.output_tokens, resolved.backendModel);
  deductBalance(keyId, usd);
  logUsage(keyId, usage);
}

// ---- Usage + balance for current key (dashboard) ----
app.get('/me', requireStudentAuth, (req, res) => {
  const keyId = req.studentKeyId;
  const balanceUsd = getBalance(keyId);
  const data = getUsageForKey(keyId);
  if (!data) {
    return res.json({
      key_id: keyId, balance_usd: balanceUsd,
      input_tokens: 0, output_tokens: 0, requests: 0, last_used: null, estimated_cost_usd: 0,
    });
  }
  const input = data.input_tokens || 0;
  const output = data.output_tokens || 0;
  const estimatedCost = costUsd(input, output);
  res.json({
    key_id: keyId, balance_usd: balanceUsd,
    input_tokens: input, output_tokens: output,
    requests: data.requests || 0, last_used: data.last_used || null,
    estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
  });
});

// ---- Stripe checkout ----
app.post('/create-checkout', requireStudentAuth, async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(503).json({ error: 'Plaćanje nije konfigurisano.' });
  }
  const amountUsd = Number(req.body?.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1000) {
    return res.status(400).json({ error: 'amount_usd mora biti između 1 i 1000.' });
  }
  const baseUrl = process.env.BASE_URL || (req.protocol + '://' + req.get('host'));
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(stripeKey);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'VajbAgent kredit', description: amountUsd + ' USD kredita za potrošnju' },
        unit_amount: Math.round(amountUsd * 100),
      },
      quantity: 1,
    }],
    metadata: { key_id: req.studentKeyId },
    success_url: baseUrl + '/dashboard?paid=1',
    cancel_url: baseUrl + '/dashboard',
  });
  res.json({ url: session.url });
});

// ---- Admin: add credits ----
app.post('/admin/add-credits', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.body?.admin_secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { key_id, amount_usd } = req.body || {};
  const amount = Number(amount_usd);
  if (!key_id || typeof key_id !== 'string' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Body: { "key_id": "...", "amount_usd": 5 }' });
  }
  const newBalance = addBalance(key_id.trim(), amount);
  res.json({ key_id: key_id.trim(), added_usd: amount, balance_usd: newBalance });
});

// ---- Admin usage ----
app.get('/usage', requireStudentAuth, (_req, res) => {
  res.json(getUsageSummary());
});

// ---- Admin: full overview (all users, models, earnings) ----
app.get('/admin/api/overview', (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const allUsage = getUsageSummary();
  const markup = parseFloat(process.env.STUDENT_MARKUP) || 1;
  const users = Object.entries(allUsage).map(([keyId, data]) => {
    const bal = getBalance(keyId);
    return { key_id: keyId, balance_usd: bal, ...data };
  });
  res.json({
    models: VAJB_MODELS.map((m) => ({
      id: m.id, name: m.name, backend: m.backend, backendModel: m.backendModel, desc: m.desc,
    })),
    users,
    markup,
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vajb-agent' });
});

// ---- Static pages ----
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/setup', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'setup.html'));
});
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-add-credits.html'));
});
app.get('/admin/info', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-info.html'));
});

// ---- 404 ----
app.use((req, res) => {
  console.log(`404 Not Found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: { message: 'Not found', path: req.path, method: req.method },
  });
});

app.listen(PORT, () => {
  console.log(`VajbAgent proxy listening on http://localhost:${PORT}`);
  console.log(`  Models: ${VAJB_MODELS.map(m => m.id).join(', ')}`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions (Bearer token required)`);
  console.log(`  GET  /dashboard – student dashboard`);
  console.log(`  GET  /setup – setup instructions`);
  console.log(`  GET  /admin/info – model info (admin only)`);
});
