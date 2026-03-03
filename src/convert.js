/**
 * Convert OpenAI Chat Completions request/response to/from Anthropic Messages API.
 */

/**
 * Extract text from OpenAI message content (string or array of parts).
 */
function getOpenAITextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && (p.type === 'text' || (p.type === 'input_text' && p.text)))
    .map((p) => p.text || p.input_text || '')
    .join('\n');
}

// Približno max ulaznih tokena (ostavljamo prostor za odgovor). ~4 karaktera po tokenu.
const MAX_INPUT_CHARS = 600000; // ~150k tokena

/**
 * Ogranici system + messages na ukupno max karaktera (da ne pređemo Anthropic limit).
 * Skraćuje od početka (stariji kontekst), zadnje poruke ostaju što više cela.
 */
function applyInputLimit(system, messages) {
  let total = (system || '').length;
  for (const m of messages) total += (m.content || '').length;
  if (total <= MAX_INPUT_CHARS) return { system, messages };

  const NOTE = '[Kontekst skraćen zbog ograničenja...]\n\n';
  let budget = MAX_INPUT_CHARS;

  const outMessages = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const content = m.content || '';
    const len = content.length;
    if (budget >= len) {
      outMessages.unshift(m);
      budget -= len;
    } else if (budget > NOTE.length + 100) {
      const maxContent = budget - NOTE.length;
      outMessages.unshift({
        role: m.role,
        content: NOTE + content.slice(-maxContent),
      });
      budget = 0;
      break;
    } else {
      break;
    }
  }
  let outSystem = null;
  if (system && budget > NOTE.length + 100) {
    const sys = system;
    outSystem = sys.length <= budget ? sys : NOTE + sys.slice(-(budget - NOTE.length));
  }
  return { system: outSystem, messages: outMessages };
}

/**
 * OpenAI messages → Anthropic messages + system.
 * - system role → top-level system
 * - user/assistant → messages (only user/assistant; drop other roles or merge into user)
 * - ograničava ukupni ulaz da ne pređe Anthropic limit (Cursor šalje puno konteksta)
 */
export function openAIToAnthropicMessages(openAIMessages) {
  let system = null;
  const messages = [];

  for (const msg of openAIMessages || []) {
    const role = (msg.role || '').toLowerCase();
    const text = getOpenAITextContent(msg.content);
    if (!text && role !== 'system') continue;

    if (role === 'system') {
      system = system ? system + '\n' + text : text;
      continue;
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: text });
      continue;
    }
    if (role === 'assistant') {
      messages.push({ role: 'assistant', content: text });
      continue;
    }
    // 'developer' or other: treat as user turn for compatibility
    messages.push({ role: 'user', content: text });
  }

  return applyInputLimit(system, messages);
}

/**
 * Build OpenAI-style non-streaming choice from Anthropic message.
 */
export function anthropicToOpenAIChoice(anthropicMessage, model = 'vajb-agent') {
  const content = Array.isArray(anthropicMessage.content)
    ? anthropicMessage.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
    : anthropicMessage.content || '';
  return {
    index: 0,
    message: {
      role: 'assistant',
      content: content || null,
    },
    finish_reason: 'stop',
  };
}

/**
 * Build OpenAI usage from Anthropic usage.
 */
export function anthropicToOpenAIUsage(anthropicUsage) {
  return {
    prompt_tokens: anthropicUsage?.input_tokens ?? 0,
    completion_tokens: anthropicUsage?.output_tokens ?? 0,
    total_tokens: (anthropicUsage?.input_tokens ?? 0) + (anthropicUsage?.output_tokens ?? 0),
  };
}

/**
 * Create OpenAI chat completion response (non-streaming).
 */
export function toOpenAIChatCompletion(anthropicMessage, anthropicUsage, model = 'vajb-agent', id = 'vajb-' + Date.now()) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [anthropicToOpenAIChoice(anthropicMessage, model)],
    usage: anthropicToOpenAIUsage(anthropicUsage),
  };
}

/**
 * SSE line for one chunk (OpenAI stream format).
 */
export function toOpenAIStreamChunk(deltaContent, options = {}) {
  const { id = 'vajb-' + Date.now(), model = 'vajb-agent', finish = false } = options;
  const choice = {
    index: 0,
    delta: finish ? {} : { content: deltaContent },
    finish_reason: finish ? 'stop' : null,
  };
  const obj = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
  };
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

/**
 * SSE line for [DONE].
 */
export function streamDone() {
  return 'data: [DONE]\n\n';
}
