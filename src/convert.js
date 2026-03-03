/**
 * Convert OpenAI Chat Completions request/response to/from Anthropic Messages API.
 * Podrška za tool calling tako da Cursor može da prikaže Apply i izvrši izmene.
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

/**
 * OpenAI tools (function declarations) → Anthropic tools.
 */
export function openAIToolsToAnthropic(openAITools) {
  if (!Array.isArray(openAITools) || openAITools.length === 0) return [];
  return openAITools
    .filter((t) => t && t.type === 'function' && t.function)
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters || { type: 'object', properties: {} };
      if (params.type !== 'object') params.type = 'object';
      return {
        name: String(fn.name || '').slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool',
        description: String(fn.description || 'No description'),
        input_schema: params,
      };
    });
}

// Anthropic: 200K context window (input+output). Ostavljamo prostor za max_tokens odgovora (~25k).
// https://docs.anthropic.com/en/docs/build-with-claude/context-windows
const MAX_INPUT_CHARS = 700000; // ~175k tokena ulaza

function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b && b.type === 'text' && b.text) n += b.text.length;
    else if (b && (b.type === 'tool_use' || b.type === 'tool_result')) n += 500 + JSON.stringify(b).length;
  }
  return n;
}

/**
 * Ogranici system + messages na ukupno max karaktera (da ne pređemo Anthropic limit).
 * Skraćuje od početka (stariji kontekst), zadnje poruke ostaju što više cela.
 */
function applyInputLimit(system, messages) {
  let total = (system || '').length;
  for (const m of messages) total += contentLength(m.content);
  if (total <= MAX_INPUT_CHARS) return { system, messages };

  const NOTE = '[Kontekst skraćen zbog ograničenja...]\n\n';
  let budget = MAX_INPUT_CHARS;

  const outMessages = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const content = m.content;
    const len = contentLength(content);
    if (budget >= len) {
      outMessages.unshift(m);
      budget -= len;
    } else if (budget > NOTE.length + 100 && typeof content === 'string') {
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
 * - user/assistant/tool → messages; assistant tool_calls → tool_use, tool → tool_result
 * - ograničava ukupni ulaz da ne pređe Anthropic limit (Cursor šalje puno konteksta)
 */
export function openAIToAnthropicMessages(openAIMessages) {
  let system = null;
  const messages = [];
  const raw = openAIMessages || [];

  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i];
    const role = (msg.role || '').toLowerCase();

    if (role === 'system') {
      const text = getOpenAITextContent(msg.content);
      if (text) system = system ? system + '\n' + text : text;
      continue;
    }

    if (role === 'user') {
      const text = getOpenAITextContent(msg.content);
      messages.push({ role: 'user', content: text || '' });
      continue;
    }

    if (role === 'assistant') {
      const toolCalls = msg.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const blocks = [];
        const text = getOpenAITextContent(msg.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of toolCalls) {
          let input = {};
          try {
            input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
          } catch (_) {}
          blocks.push({
            type: 'tool_use',
            id: tc.id || 'tc_' + i + '_' + blocks.length,
            name: tc.function?.name || 'tool',
            input,
          });
        }
        messages.push({ role: 'assistant', content: blocks });
      } else {
        const text = getOpenAITextContent(msg.content);
        if (text) messages.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (role === 'tool') {
      const toolResults = [];
      let j = i;
      while (j < raw.length && (raw[j].role || '').toLowerCase() === 'tool') {
        const t = raw[j];
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.tool_call_id || t.tool_call_ids?.[0],
          content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content || ''),
        });
        j++;
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
        i = j - 1;
      }
      continue;
    }

    const text = getOpenAITextContent(msg.content);
    if (text) messages.push({ role: 'user', content: text });
  }

  return applyInputLimit(system, messages);
}

/**
 * Build OpenAI-style non-streaming choice from Anthropic message.
 * Ako Claude vrati tool_use, vraćamo tool_calls da Cursor prikaže Apply i izvrši.
 */
export function anthropicToOpenAIChoice(anthropicMessage, model = 'vajb-agent') {
  const blocks = Array.isArray(anthropicMessage.content) ? anthropicMessage.content : [];
  const textParts = blocks.filter((b) => b && b.type === 'text').map((b) => b.text);
  const content = textParts.join('') || null;
  const toolUseBlocks = blocks.filter((b) => b && b.type === 'tool_use');
  const toolCalls = toolUseBlocks.map((b) => ({
    id: b.id,
    type: 'function',
    function: {
      name: b.name,
      arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {}),
    },
  }));

  const message = {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  };
  const finish_reason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

  return {
    index: 0,
    message,
    finish_reason,
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
