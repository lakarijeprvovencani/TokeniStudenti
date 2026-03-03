import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import express from 'express';
import { requireStudentAuth } from './auth.js';
import {
  openAIToAnthropicMessages,
  openAIToolsToAnthropic,
  toOpenAIChatCompletion,
  toOpenAIStreamChunk,
  streamDone,
} from './convert.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { logUsage, getUsageSummary, getUsageForKey } from './usage.js';
import { getBalance, deductBalance, costUsd, addBalance } from './balance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Tvoja imena agenata u Cursoru → koji Claude model koristimo (Anthropic Messages API)
// Context: 200K tokena standard (Sonnet 4.6 / Opus 4.6); 1M sa beta header za tier 4
const VAJB_MODELS = [
  { id: 'vajb-agent-pro', name: 'VajbAgent Pro', anthropic: 'claude-sonnet-4-6' },   // Sonnet 4.6
  { id: 'vajb-agent-max', name: 'VajbAgent Max', anthropic: 'claude-opus-4-6' },     // Opus 4.6
];
const DEFAULT_VAJB_MODEL = VAJB_MODELS[0].id;

function getAnthropicModel(requestedModel) {
  const id = (requestedModel || '').trim() || DEFAULT_VAJB_MODEL;
  const found = VAJB_MODELS.find((m) => m.id === id);
  return found ? found.anthropic : VAJB_MODELS[0].anthropic;
}

function getVajbModelId(requestedModel) {
  const id = (requestedModel || '').trim() || DEFAULT_VAJB_MODEL;
  const found = VAJB_MODELS.find((m) => m.id === id);
  return found ? found.id : DEFAULT_VAJB_MODEL;
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('ANTHROPIC_API_KEY is not set; chat completions will fail.');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'dummy' });

app.use(cors());

// Log every request (method + path) so we can see what Cursor calls in Render logs
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Stripe webhook mora dobiti raw body (pre express.json())
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

// Root – Render i Cursor ponekad proveravaju / ; bez ovoga dobijaju 404 i "resource not found"
app.get('/', (_req, res) => {
  res.json({
    service: 'vajb-agent',
    ok: true,
    endpoints: {
      models: 'GET /v1/models or GET /models',
      chat: 'POST /v1/chat/completions or POST /chat/completions',
      dashboard: 'GET /dashboard',
      health: 'GET /health',
    },
  });
});
app.head('/', (_req, res) => res.status(200).end());

// ---- Public (no auth): models list for Cursor dropdown ----
// Cursor može da zove /models ili /v1/models – oba vraćaju istu listu da se modeli učitaju sami
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

// ---- Chat completions: require Bearer token, check balance ----
// Cursor šalje na /chat/completions (bez /v1), OpenAI standard je /v1/chat/completions – podržavamo oba
const chatCompletionsHandler = [
  requireStudentAuth,
  async (req, res) => {
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

    const body = req.body || {};
    const { messages, stream = false, max_tokens = 4096, model, tools: openAITools } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: { message: 'Missing or empty "messages" array.' },
      });
    }

    const anthropicModelId = getAnthropicModel(model);
    const vajbModelId = getVajbModelId(model);

    const { system, messages: anthropicMessages } = openAIToAnthropicMessages(messages);
    if (anthropicMessages.length === 0) {
      return res.status(400).json({
        error: { message: 'No valid user/assistant messages after conversion.' },
      });
    }

    // Hint za Claude: da odgovori tako da Cursor ponudi "Apply" / primenu izmene, a ne "evo pa kopiraj"
    const CURSOR_EDIT_HINT = [
      'Korisnik radi u Cursor IDE. Kad predlažeš izmene koda:',
      '- Daj konkretan kod u markdown code block-u (npr. ```js ili ```html) sa jasno označenim fajlom ako je poznat.',
      '- Nemoj reći "evo ti pa kopiraj" – formuliši tako da IDE može da ponudi primenu (Apply).',
      '- Ako menjaš postojeći fajl, navedi koji fajl i daj ceo izmenjeni blok ili jasno "zameni linije X–Y sa: ...".',
    ].join(' ');
    const mergedSystem = [CURSOR_EDIT_HINT, system].filter(Boolean).join('\n\n');

    // Cursor šalje tools (edit_file, run_terminal_cmd, itd.) – prosleđujemo Claude-u da vraća tool_calls i Cursor prikaže Apply
    const anthropicTools = openAIToolsToAnthropic(openAITools);

    // Anthropic: max_tokens do 64k za neke modele; 16k dovoljno za Cursor, ostavlja prostor u 200k kontekstu
    const maxTokens = Math.min(Math.max(Number(max_tokens) || 4096, 1), 16384);
    const payload = {
      model: anthropicModelId,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      ...(mergedSystem && { system: mergedSystem }),
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
    };

    try {
      if (stream) {
        await handleStream(req, res, keyId, payload, vajbModelId, anthropicModelId);
      } else {
        await handleNonStream(req, res, keyId, payload, vajbModelId, anthropicModelId);
      }
    } catch (err) {
      console.error('Anthropic error:', err.message);
      const status = err.status || 502;
      res.status(status).json({
        error: {
          message: err.message || 'Upstream (Anthropic) error',
          type: 'api_error',
        },
      });
    }
  },
];
app.post('/v1/chat/completions', chatCompletionsHandler);
app.post('/chat/completions', chatCompletionsHandler);

async function handleNonStream(req, res, keyId, payload, vajbModelId, anthropicModelId) {
  const response = await anthropic.messages.create({
    ...payload,
    stream: false,
  });

  const usage = {
    input_tokens: response.usage?.input_tokens ?? 0,
    output_tokens: response.usage?.output_tokens ?? 0,
  };
  const usd = costUsd(usage.input_tokens, usage.output_tokens, anthropicModelId);
  deductBalance(keyId, usd);
  logUsage(keyId, usage);

  const openAI = toOpenAIChatCompletion(
    response,
    response.usage,
    vajbModelId,
    response.id || 'vajb-' + Date.now()
  );
  res.json(openAI);
}

async function handleStream(req, res, keyId, payload, vajbModelId, anthropicModelId) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const streamId = 'vajb-' + Date.now();
  let usage = { input_tokens: 0, output_tokens: 0 };

  const stream = await anthropic.messages.create({
    ...payload,
    stream: true,
  });

  for await (const event of stream) {
    if (event.type === 'message_start' && event.message?.usage) {
      usage.input_tokens = event.message.usage.input_tokens ?? 0;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        const chunk = toOpenAIStreamChunk(delta.text, { id: streamId, model: vajbModelId });
        res.write(chunk);
        if (res.flush) res.flush();
      }
    }
    if (event.type === 'message_delta' && event.usage) {
      if (event.usage.input_tokens != null) usage.input_tokens = event.usage.input_tokens;
      if (event.usage.output_tokens != null) usage.output_tokens = event.usage.output_tokens;
    }
  }

  res.write(toOpenAIStreamChunk('', { id: streamId, model: vajbModelId, finish: true }));
  res.write(streamDone());
  res.end();

  const usd = costUsd(usage.input_tokens, usage.output_tokens, anthropicModelId);
  deductBalance(keyId, usd);
  logUsage(keyId, usage);
}

// Usage + balance for current key (dashboard)
app.get('/me', requireStudentAuth, (req, res) => {
  const keyId = req.studentKeyId;
  const balanceUsd = getBalance(keyId);
  const data = getUsageForKey(keyId);
  if (!data) {
    return res.json({
      key_id: keyId,
      balance_usd: balanceUsd,
      input_tokens: 0,
      output_tokens: 0,
      requests: 0,
      last_used: null,
      estimated_cost_usd: 0,
    });
  }
  const input = data.input_tokens || 0;
  const output = data.output_tokens || 0;
  const estimatedCost = costUsd(input, output);
  res.json({
    key_id: keyId,
    balance_usd: balanceUsd,
    input_tokens: input,
    output_tokens: output,
    requests: data.requests || 0,
    last_used: data.last_used || null,
    estimated_cost_usd: Math.round(estimatedCost * 100) / 100,
  });
});

// Student: kreira Stripe Checkout za dopunu (1 USD uplate = 1 USD kredita)
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

// Admin: add credits to a key (secret iz headera ili body za formu)
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

// All usage (admin)
app.get('/usage', requireStudentAuth, (_req, res) => {
  res.json(getUsageSummary());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vajb-agent' });
});

// Dashboard (static page)
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// Admin: forma za dopunu kredita
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin-add-credits.html'));
});

// 404 – unknown path (so we see in logs what Cursor actually requested)
app.use((req, res) => {
  console.log(`404 Not Found: ${req.method} ${req.path}`);
  res.status(404).json({
    error: { message: 'Not found', path: req.path, method: req.method },
  });
});

app.listen(PORT, () => {
  console.log(`VajbAgent proxy listening on http://localhost:${PORT}`);
  console.log(`  GET  /v1/models`);
  console.log(`  POST /v1/chat/completions (Bearer token required)`);
  console.log(`  GET  /dashboard – student dashboard`);
});
