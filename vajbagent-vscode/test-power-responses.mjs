/**
 * Test Power (gpt-5.4) across the new Responses API path.
 * Three scenarios verify the three hot paths of the translation layer:
 *   1. Plain text streaming (response.output_text.delta -> delta.content)
 *   2. Tool call streaming  (output_item.added + function_call_arguments.delta
 *                            -> delta.tool_calls[])
 *   3. Multi-turn with tool result (tool message -> function_call_output,
 *                                   final text after tool call)
 */

import https from 'https';

const API_URL = 'https://vajbagent.com';
const API_KEY = 'va-nikola-jovanovic-0651badf';
const MODEL = 'vajb-agent-power';

function request({ path, body, stream }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      API_URL + path,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + API_KEY,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 300_000,
      },
      (res) => {
        let buf = '';
        const events = [];
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          if (!stream) return;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = block.split('\n').map(l => l.replace(/^data:\s*/, '')).filter(Boolean);
            for (const line of lines) {
              if (line === '[DONE]') { events.push({ done: true }); continue; }
              try { events.push(JSON.parse(line)); } catch { /* ignore comments / partial */ }
            }
          }
        });
        res.on('end', () => {
          if (stream) resolve({ status: res.statusCode, events });
          else {
            try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
            catch { resolve({ status: res.statusCode, body: buf }); }
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    req.write(payload);
    req.end();
  });
}

function header(title) {
  console.log('\n' + '━'.repeat(60));
  console.log('  ' + title);
  console.log('━'.repeat(60));
}

function summariseStreamEvents(events) {
  let firstDeltaAt = null;
  const startedAt = Date.now();
  let contentChars = 0;
  const toolCalls = new Map(); // index -> { id, name, args }
  let finishReason = null;
  let errorMsg = null;

  for (const e of events) {
    if (e.done) continue;
    if (e.error) { errorMsg = e.error.message; }
    const choice = e.choices?.[0];
    if (!choice) continue;
    if (firstDeltaAt === null && (choice.delta?.content || choice.delta?.tool_calls)) {
      firstDeltaAt = Date.now() - startedAt;
    }
    const d = choice.delta || {};
    if (typeof d.content === 'string') contentChars += d.content.length;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const existing = toolCalls.get(tc.index) || { id: null, name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        toolCalls.set(tc.index, existing);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return { contentChars, toolCalls: Array.from(toolCalls.values()), finishReason, errorMsg };
}

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Returns the current weather for a city as plain text.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. Belgrade' },
      },
      required: ['city'],
    },
  },
}];

async function test1PlainText() {
  header('TEST 1 — plain text streaming');
  const t0 = Date.now();
  const { status, events } = await request({
    path: '/v1/chat/completions',
    stream: true,
    body: {
      model: MODEL,
      stream: true,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'You answer concisely in Serbian.' },
        { role: 'user', content: 'Koji je glavni grad Srbije? Odgovori u jednoj recenici.' },
      ],
    },
  });
  const dt = Date.now() - t0;
  const s = summariseStreamEvents(events);
  console.log(`status=${status} time=${dt}ms events=${events.length} contentChars=${s.contentChars} finish=${s.finishReason}${s.errorMsg ? ' ERR=' + s.errorMsg : ''}`);
  if (s.errorMsg) return false;
  if (s.contentChars < 5) { console.log('FAIL: no text content'); return false; }
  if (s.finishReason !== 'stop') { console.log('FAIL: expected finish=stop, got ' + s.finishReason); return false; }
  console.log('PASS');
  return true;
}

async function test2ToolCall() {
  header('TEST 2 — tool call streaming');
  const t0 = Date.now();
  const { status, events } = await request({
    path: '/v1/chat/completions',
    stream: true,
    body: {
      model: MODEL,
      stream: true,
      max_tokens: 500,
      tools,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that uses tools when asked about the weather.' },
        { role: 'user', content: 'What is the weather in Belgrade right now? Call the get_weather tool.' },
      ],
    },
  });
  const dt = Date.now() - t0;
  const s = summariseStreamEvents(events);
  console.log(`status=${status} time=${dt}ms events=${events.length} tools=${s.toolCalls.length} finish=${s.finishReason}${s.errorMsg ? ' ERR=' + s.errorMsg : ''}`);
  for (const tc of s.toolCalls) {
    console.log(`   tool: name=${tc.name} id=${tc.id} args=${tc.args}`);
  }
  if (s.errorMsg) return false;
  if (s.toolCalls.length === 0) { console.log('FAIL: model did not call tool'); return false; }
  const tc = s.toolCalls[0];
  if (!tc.id || !tc.name) { console.log('FAIL: tool call missing id/name'); return false; }
  try { JSON.parse(tc.args); } catch { console.log('FAIL: tool args not valid JSON'); return false; }
  if (s.finishReason !== 'tool_calls') { console.log('FAIL: expected finish=tool_calls, got ' + s.finishReason); return false; }
  console.log('PASS');
  return { toolCall: tc };
}

async function test3ToolFollowup(firstToolCall) {
  header('TEST 3 — tool result follow-up');
  const t0 = Date.now();
  const { status, events } = await request({
    path: '/v1/chat/completions',
    stream: true,
    body: {
      model: MODEL,
      stream: true,
      max_tokens: 300,
      tools,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. After you receive a tool result, reply briefly in Serbian.' },
        { role: 'user', content: 'What is the weather in Belgrade right now? Call the get_weather tool.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: firstToolCall.id,
            type: 'function',
            function: { name: firstToolCall.name, arguments: firstToolCall.args || '{"city":"Belgrade"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: firstToolCall.id,
          content: 'Sunčano, 24°C, lagan vetar',
        },
      ],
    },
  });
  const dt = Date.now() - t0;
  const s = summariseStreamEvents(events);
  console.log(`status=${status} time=${dt}ms events=${events.length} contentChars=${s.contentChars} finish=${s.finishReason}${s.errorMsg ? ' ERR=' + s.errorMsg : ''}`);
  if (s.errorMsg) return false;
  if (s.contentChars < 5) { console.log('FAIL: no text after tool result'); return false; }
  if (s.finishReason !== 'stop') { console.log('FAIL: expected finish=stop, got ' + s.finishReason); return false; }
  console.log('PASS');
  return true;
}

(async () => {
  const results = {};
  try {
    results.text = await test1PlainText();
    const t2 = await test2ToolCall();
    results.tool = !!t2;
    if (t2 && t2.toolCall) {
      results.followup = await test3ToolFollowup(t2.toolCall);
    } else {
      console.log('\nSkipping test 3 — no tool call to follow up on.');
      results.followup = false;
    }
  } catch (err) {
    console.error('\nTEST RUNNER ERROR:', err?.message || err);
  }
  console.log('\n' + '═'.repeat(60));
  console.log('  SUMMARY');
  console.log('═'.repeat(60));
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(10)} ${v ? 'PASS' : 'FAIL'}`);
  }
  const allPass = Object.values(results).every(Boolean);
  process.exit(allPass ? 0 : 1);
})();
