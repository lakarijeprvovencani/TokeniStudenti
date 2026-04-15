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
 * Convert OpenAI message content to Anthropic content blocks (with vision support).
 * Handles text, image_url (base64 and URLs).
 */
function openAIContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  
  const blocks = [];
  
  for (const part of content) {
    if (!part) continue;
    
    // Text content
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    }
    // Input text (alternative format)
    else if (part.type === 'input_text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    }
    // Image URL content
    else if (part.type === 'image_url' && part.image_url) {
      const imgUrl = part.image_url.url || part.image_url;
      
      if (typeof imgUrl === 'string') {
        // Base64 data URL
        if (imgUrl.startsWith('data:')) {
          const match = imgUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) {
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1],
                data: match[2],
              },
            });
          }
        }
        // Regular URL - Anthropic supports URL images too
        else if (imgUrl.startsWith('http://') || imgUrl.startsWith('https://')) {
          blocks.push({
            type: 'image',
            source: {
              type: 'url',
              url: imgUrl,
            },
          });
        }
      }
    }
  }
  
  // If only text blocks, return as string for simpler format
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return blocks[0].text;
  }
  
  // If no blocks, return empty string
  if (blocks.length === 0) {
    return getOpenAITextContent(content) || '';
  }
  
  return blocks;
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

// Per-model input token limits (leave room for output).
// ~4 chars per token on average.
const MODEL_INPUT_LIMITS = {
  // OpenAI GPT-5 family (context windows from developers.openai.com, March 2026)
  'gpt-5-mini':   { tokens: 270000, chars: 1080000 },  // 400K context - 128K max output
  'gpt-5':        { tokens: 270000, chars: 1080000 },  // 400K context - 128K max output
  'gpt-5.4':      { tokens: 900000, chars: 3600000 },  // 1.05M context - 128K max output
  'o4-mini':      { tokens: 100000, chars: 400000 },   // 200K context - 100K max output
  // OpenAI GPT-4.1 models — 1M context, 32K max output (developers.openai.com)
  'gpt-4.1-mini': { tokens: 900000, chars: 3600000 },
  'gpt-4.1':      { tokens: 900000, chars: 3600000 },
  // Claude models — 1M context as of March 2026 (docs.anthropic.com)
  'claude-haiku-4-5':  { tokens: 130000, chars: 520000 },   // 200K context - 64K max output
  'claude-sonnet-4-6': { tokens: 900000, chars: 3600000 },  // 1M context - 64K max output
  'claude-opus-4-6':   { tokens: 870000, chars: 3480000 },  // 1M context - 128K max output
  // Legacy
  'gpt-4o-mini':       { tokens: 100000, chars: 400000 },
  'gpt-4o':            { tokens: 100000, chars: 400000 },
};
const DEFAULT_LIMIT = { tokens: 100000, chars: 400000 };

function getModelLimit(backendModel) {
  return MODEL_INPUT_LIMITS[backendModel] || DEFAULT_LIMIT;
}

const MAX_TOOL_RESULT_CHARS = 10000;
const MAX_SINGLE_MESSAGE_CHARS = 30000;
const MAX_RECENT_MESSAGE_CHARS = 80000;
const SYSTEM_BUDGET_CHARS = 8000;

function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b && b.type === 'text' && b.text) n += b.text.length;
    else if (b && (b.type === 'tool_use' || b.type === 'tool_result')) n += JSON.stringify(b).length;
  }
  return n;
}

/**
 * Truncate a tool_result content string, keeping the start and end so the
 * model sees the structure but not every line of a huge file.
 */
function truncateToolResult(text, max) {
  if (!text || text.length <= max) return text;
  const keep = Math.floor((max - 80) / 2);
  const cut = text.length - keep * 2;
  if (cut > 5000) {
    console.log(`[context] Tool result truncated: ${text.length} → ${max} chars (-${cut} chars, ${Math.round(cut/text.length*100)}% lost)`);
  }
  return text.slice(0, keep)
    + '\n\n[... skraćeno ' + cut + ' karaktera ...]\n\n'
    + text.slice(-keep);
}

/**
 * Shrink a single message's content to fit within a char budget.
 * Handles both string content and array content (tool_use / tool_result blocks).
 */
function shrinkMessage(msg, maxChars) {
  const content = msg.content;

  if (typeof content === 'string') {
    if (content.length <= maxChars) return msg;
    const keep = Math.floor((maxChars - 60) / 2);
    return {
      ...msg,
      content: content.slice(0, keep) + '\n[... skraćeno ...]\n' + content.slice(-keep),
    };
  }

  if (!Array.isArray(content)) return msg;

  let budget = maxChars;
  const shrunk = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const raw = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
      const capped = truncateToolResult(raw, Math.min(MAX_TOOL_RESULT_CHARS, budget));
      shrunk.push({ ...block, content: capped });
      budget -= capped.length;
    } else if (block.type === 'tool_use') {
      const serialized = JSON.stringify(block.input || {});
      const cappedInput = serialized.length > MAX_TOOL_RESULT_CHARS
        ? JSON.parse('{}')
        : block.input;
      const entry = { ...block, input: cappedInput };
      const len = JSON.stringify(entry).length;
      shrunk.push(entry);
      budget -= len;
    } else if (block.type === 'text' && block.text) {
      const maxText = Math.max(budget, 200);
      const text = block.text.length <= maxText
        ? block.text
        : block.text.slice(0, Math.floor(maxText / 2)) + '\n[... skraćeno ...]\n' + block.text.slice(-Math.floor(maxText / 2));
      shrunk.push({ ...block, text });
      budget -= text.length;
    } else {
      shrunk.push(block);
    }
    if (budget <= 0) break;
  }
  return { ...msg, content: shrunk };
}

/**
 * Smart context manager: keeps recent messages, summarizes/trims older ones,
 * always preserves system prompt and the last user message fully.
 *
 * Strategy (like Cursor does internally):
 * 1. System prompt is always kept (up to SYSTEM_BUDGET_CHARS).
 * 2. Last 2 messages (current user prompt + preceding context) kept in full.
 * 3. Older messages: tool_results are aggressively truncated, text is summarized.
 * 4. If still over budget, drop oldest messages first.
 */
function applyInputLimit(system, messages, backendModel) {
  const limit = getModelLimit(backendModel);
  const MAX_INPUT_CHARS = limit.chars;

  let systemOut = system || null;
  if (systemOut && systemOut.length > SYSTEM_BUDGET_CHARS) {
    systemOut = systemOut.slice(0, SYSTEM_BUDGET_CHARS) + '\n[... system skraćen ...]';
  }

  const systemCost = (systemOut || '').length;
  const messageBudget = MAX_INPUT_CHARS - systemCost;

  if (messages.length === 0) return { system: systemOut, messages };

  // Phase 1: shrink every individual message (cap tool results, long texts)
  const shrunkMessages = messages.map((m, i) => {
    const isRecent = i >= messages.length - 2;
    const perMsgMax = isRecent ? MAX_SINGLE_MESSAGE_CHARS * 3 : MAX_SINGLE_MESSAGE_CHARS;
    return shrinkMessage(m, perMsgMax);
  });

  // Phase 2: check total - if under budget, done
  let total = 0;
  for (const m of shrunkMessages) total += contentLength(m.content);
  if (total <= messageBudget) return { system: systemOut, messages: shrunkMessages };

  // Phase 3: keep messages from the end until budget runs out
  const NOTE_MSG = { role: 'user', content: '[Stariji kontekst je izostavljen zbog ograničenja veličine. Nastavlja se od ovde.]' };
  const NOTE_LEN = contentLength(NOTE_MSG.content);
  let budget = messageBudget - NOTE_LEN;
  const kept = [];

  for (let i = shrunkMessages.length - 1; i >= 0; i--) {
    const m = shrunkMessages[i];
    const len = contentLength(m.content);
    if (len <= budget) {
      kept.unshift(m);
      budget -= len;
    } else if (budget > 500 && i > 0) {
      kept.unshift(shrinkMessage(m, budget));
      budget = 0;
      break;
    } else {
      break;
    }
  }

  if (kept.length < shrunkMessages.length) {
    const dropped = shrunkMessages.length - kept.length;
    console.log(`[context] Dropped ${dropped} older messages to fit budget (kept ${kept.length}/${shrunkMessages.length})`);
    // Ensure first message is 'user' (Anthropic requires it)
    if (kept.length === 0 || kept[0].role !== 'user') {
      kept.unshift(NOTE_MSG);
    } else {
      kept.unshift(NOTE_MSG);
    }
  }

  // Anthropic requires alternating user/assistant - fix any violations
  const fixed = fixAlternation(kept);

  return { system: systemOut, messages: fixed };
}

/**
 * Ensure messages alternate user/assistant as Anthropic requires.
 * Merge consecutive same-role messages and ensure starts with user.
 */
function fixAlternation(messages) {
  if (messages.length === 0) return messages;
  const out = [];
  for (const m of messages) {
    if (out.length > 0 && out[out.length - 1].role === m.role) {
      const prev = out[out.length - 1];
      if (typeof prev.content === 'string' && typeof m.content === 'string') {
        prev.content += '\n' + m.content;
      } else {
        const prevArr = Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content || '' }];
        const currArr = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }];
        prev.content = [...prevArr, ...currArr];
      }
    } else {
      out.push({ ...m });
    }
  }
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '[Početak konverzacije]' });
  }
  return out;
}

/**
 * Estimate char length of an OpenAI-format message (string content, array content, tool_calls).
 */
function openAIMsgLength(msg) {
  if (!msg) return 0;
  const c = msg.content;
  let n = 0;
  if (typeof c === 'string') n += c.length;
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (p.text) n += p.text.length;
      else if (p.input_text) n += p.input_text.length;
      else n += JSON.stringify(p).length;
    }
  }
  if (Array.isArray(msg.tool_calls)) n += JSON.stringify(msg.tool_calls).length;
  return n;
}

/**
 * Truncate a string keeping start+end with a note in the middle.
 */
function truncateStr(str, max) {
  if (!str || str.length <= max) return str;
  const keep = Math.floor((max - 60) / 2);
  return str.slice(0, keep) + '\n[... skraćeno ' + (str.length - keep * 2) + ' chars ...]\n' + str.slice(-keep);
}

/**
 * Shrink an OpenAI-format message to fit within maxChars.
 */
function shrinkOpenAIMsg(msg, maxChars) {
  let content = msg.content;

  if (typeof content === 'string' && content.length > maxChars) {
    return { ...msg, content: truncateStr(content, maxChars) };
  }

  if (Array.isArray(content)) {
    let budget = maxChars;
    const parts = [];
    for (const p of content) {
      if (p.type === 'text' && p.text && p.text.length > budget) {
        parts.push({ ...p, text: truncateStr(p.text, Math.max(budget, 200)) });
        budget = 0;
      } else {
        parts.push(p);
        budget -= (p.text || p.input_text || JSON.stringify(p)).length;
      }
      if (budget <= 0) break;
    }
    return { ...msg, content: parts };
  }

  return msg;
}

/**
 * Trim OpenAI-format messages to fit within a backend model's input limit.
 * Used for the OpenAI backend (Nano/Lite) where messages go through as-is.
 *
 * Strategy:
 * 1. System messages stay (trimmed if huge)
 * 2. Last 2 messages are preserved fully
 * 3. Older tool messages and large content are aggressively trimmed
 * 4. If still over limit, drop oldest non-system messages
 */
export function trimOpenAIMessages(messages, backendModel) {
  const limit = getModelLimit(backendModel);
  const maxChars = limit.chars;

  if (!messages || messages.length === 0) return messages;

  let total = 0;
  for (const m of messages) total += openAIMsgLength(m);
  if (total <= maxChars) return messages;

  console.log(`trimOpenAIMessages: ${messages.length} msgs, ~${Math.round(total/4000)}K tokens, limit ~${Math.round(maxChars/4000)}K tokens. Trimming...`);

  // Phase 1: shrink individual messages
  const shrunk = messages.map((m, i) => {
    const isRecent = i >= messages.length - 2;
    const role = (m.role || '').toLowerCase();
    const isSystem = role === 'system';
    const isTool = role === 'tool';

    if (isSystem) {
      return shrinkOpenAIMsg(m, SYSTEM_BUDGET_CHARS);
    }
    if (isTool) {
      return shrinkOpenAIMsg(m, MAX_TOOL_RESULT_CHARS);
    }
    if (isRecent) {
      return shrinkOpenAIMsg(m, MAX_RECENT_MESSAGE_CHARS);
    }
    return shrinkOpenAIMsg(m, MAX_SINGLE_MESSAGE_CHARS);
  });

  total = 0;
  for (const m of shrunk) total += openAIMsgLength(m);
  if (total <= maxChars) {
    console.log(`trimOpenAIMessages: after shrink → ~${Math.round(total/4000)}K tokens. OK.`);
    return shrunk;
  }

  // Phase 2: keep system messages + messages from the end until budget fills
  const systemMsgs = shrunk.filter(m => (m.role || '').toLowerCase() === 'system');
  const nonSystem = shrunk.filter(m => (m.role || '').toLowerCase() !== 'system');

  let budget = maxChars;
  for (const s of systemMsgs) budget -= openAIMsgLength(s);

  const kept = [];
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const len = openAIMsgLength(nonSystem[i]);
    if (len <= budget) {
      kept.unshift(nonSystem[i]);
      budget -= len;
    } else if (budget > 500) {
      kept.unshift(shrinkOpenAIMsg(nonSystem[i], budget));
      budget = 0;
      break;
    } else {
      break;
    }
  }

  const dropped = nonSystem.length - kept.length;
  const result = [...systemMsgs];
  if (dropped > 0) {
    console.log(`[context] OpenAI: Dropped ${dropped} older messages to fit budget (kept ${kept.length}/${nonSystem.length})`);
    result.push({ role: 'user', content: `[${dropped} starijih poruka izostavljeno zbog ograničenja konteksta]` });
  }
  result.push(...kept);

  total = 0;
  for (const m of result) total += openAIMsgLength(m);
  console.log(`trimOpenAIMessages: after drop → ${result.length} msgs, ~${Math.round(total/4000)}K tokens.`);

  return result;
}

/**
 * OpenAI messages → Anthropic messages + system.
 * - system role → top-level system
 * - user/assistant/tool → messages; assistant tool_calls → tool_use, tool → tool_result
 * - ograničava ukupni ulaz da ne pređe Anthropic limit (Cursor šalje puno konteksta)
 */
export function openAIToAnthropicMessages(openAIMessages, backendModel) {
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
      // Use openAIContentToAnthropic to preserve images for Claude Vision
      const content = openAIContentToAnthropic(msg.content);
      messages.push({ role: 'user', content: content || '' });
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

  return applyInputLimit(system, messages, backendModel);
}

/**
 * Build OpenAI-style non-streaming choice from Anthropic message.
 * Ako Claude vrati tool_use, vraćamo tool_calls da Cursor prikaže Apply i izvrši.
 */
export function anthropicToOpenAIChoice(anthropicMessage, model = 'vajb-agent') {
  const blocks = Array.isArray(anthropicMessage.content) ? anthropicMessage.content : [];
  // Extract text blocks (skip thinking blocks - they're internal reasoning)
  const textParts = blocks.filter((b) => b && b.type === 'text').map((b) => b.text);
  // If no text blocks, content is null (model only thought, no response)
  const content = textParts.length > 0 ? textParts.join('') : null;
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
 * SSE chunk sa tool_call delta (stream args u realnom vremenu).
 */
export function toOpenAIStreamChunkToolCallDelta(index, id, name, argsDelta, options = {}) {
  const { id: streamId = 'vajb-' + Date.now(), model = 'vajb-agent' } = options;
  const tc = { index, type: 'function', function: {} };
  if (id) tc.id = id;
  if (name) tc.function.name = name;
  if (argsDelta) tc.function.arguments = argsDelta;
  const obj = {
    id: streamId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
  };
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

/**
 * SSE chunk sa tool_calls (za kraj streama kad Claude vrati tool_use).
 * Cursor očekuje delta.tool_calls da prikaže Apply i izvrši.
 */
export function toOpenAIStreamChunkToolCalls(toolCalls, options = {}) {
  const { id = 'vajb-' + Date.now(), model = 'vajb-agent' } = options;
  const choice = {
    index: 0,
    delta: {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((tc) => ({
        index: tc.index,
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
        },
      })),
    },
    finish_reason: 'tool_calls',
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
