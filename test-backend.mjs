#!/usr/bin/env node
/**
 * Backend test pre deploya: proverava glavne endpoint-e i tool/tool_calls konverziju.
 * Pokreni: node test-backend.mjs   (server mora da radi na PORT ili 3000)
 */
const BASE = process.env.TEST_URL || 'http://localhost:3000';
const STUDENT_KEY = process.env.STUDENT_KEY || 'student-key-1';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kalabunga1991';

const log = (name, ok, detail = '') => {
  const s = ok ? '✓' : '✗';
  console.log(`${s} ${name}${detail ? ': ' + detail : ''}`);
};

async function run() {
  let passed = 0;
  let failed = 0;

  // 1. GET /
  try {
    const r = await fetch(BASE + '/');
    const ok = r.ok && r.headers.get('content-type')?.includes('json');
    if (ok) {
      const j = await r.json();
      if (j.service === 'vajb-agent' && j.ok === true) {
        log('GET /', true);
        passed++;
      } else {
        log('GET /', false, 'bad body');
        failed++;
      }
    } else {
      log('GET /', false, r.status);
      failed++;
    }
  } catch (e) {
    log('GET /', false, e.message);
    failed++;
  }

  // 2. GET /v1/models
  try {
    const r = await fetch(BASE + '/v1/models');
    const ok = r.ok;
    if (ok) {
      const j = await r.json();
      const hasPro = j.data?.some((m) => m.id === 'vajb-agent-pro');
      if (hasPro) {
        log('GET /v1/models', true);
        passed++;
      } else {
        log('GET /v1/models', false, 'missing vajb-agent-pro');
        failed++;
      }
    } else {
      log('GET /v1/models', false, r.status);
      failed++;
    }
  } catch (e) {
    log('GET /v1/models', false, e.message);
    failed++;
  }

  // 3. GET /models
  try {
    const r = await fetch(BASE + '/models');
    const ok = r.ok;
    if (ok) {
      const j = await r.json();
      if (j.data?.length >= 1) {
        log('GET /models', true);
        passed++;
      } else {
        log('GET /models', false, 'empty data');
        failed++;
      }
    } else {
      log('GET /models', false, r.status);
      failed++;
    }
  } catch (e) {
    log('GET /models', false, e.message);
    failed++;
  }

  // 4. POST /chat/completions bez auth → 401
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'vajb-agent-pro', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const expect401 = r.status === 401;
    log('POST /chat/completions (no auth) → 401', expect401, expect401 ? '' : 'got ' + r.status);
    if (expect401) passed++; else failed++;
  } catch (e) {
    log('POST /chat/completions (no auth)', false, e.message);
    failed++;
  }

  // 5. POST /chat/completions sa tools u body (ne padaj)
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + STUDENT_KEY,
      },
      body: JSON.stringify({
        model: 'vajb-agent-pro',
        messages: [{ role: 'user', content: 'Reci samo: ok' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'write_file',
              description: 'Write content to a file',
              parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
            },
          },
        ],
      }),
    });
    // 402 = nedovoljno kredita (ok), 200 = uspeh; 400/500 = greška
    const ok = r.status === 200 || r.status === 402;
    if (ok) {
      if (r.status === 200) {
        const j = await r.json();
        const hasChoices = j.choices?.length > 0;
        const msg = j.choices?.[0]?.message;
        const hasContentOrToolCalls = msg && (msg.content != null || (Array.isArray(msg.tool_calls) && msg.tool_calls.length >= 0));
        log('POST /chat/completions (with tools)', hasContentOrToolCalls, 'response ok');
        if (hasContentOrToolCalls) passed++; else failed++;
      } else {
        log('POST /chat/completions (with tools)', true, '402 no credits (expected)');
        passed++;
      }
    } else {
      const text = await r.text();
      log('POST /chat/completions (with tools)', false, r.status + ' ' + text.slice(0, 80));
      failed++;
    }
  } catch (e) {
    log('POST /chat/completions (with tools)', false, e.message);
    failed++;
  }

  // 6. convert.js: openAIToolsToAnthropic
  try {
    const { openAIToolsToAnthropic } = await import('./src/convert.js');
    const out = openAIToolsToAnthropic([
      { type: 'function', function: { name: 'edit_file', description: 'Edit', parameters: { type: 'object', properties: {} } } },
    ]);
    const ok = Array.isArray(out) && out.length === 1 && out[0].name && out[0].input_schema;
    log('openAIToolsToAnthropic', ok, ok ? '' : JSON.stringify(out).slice(0, 60));
    if (ok) passed++; else failed++;
  } catch (e) {
    log('openAIToolsToAnthropic', false, e.message);
    failed++;
  }

  // 7. convert.js: messages sa tool_calls → Anthropic tool_use
  try {
    const { openAIToAnthropicMessages } = await import('./src/convert.js');
    const msgs = [
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt","content":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tc1', content: 'Done' },
    ];
    const { messages } = openAIToAnthropicMessages(msgs);
    const hasAssistant = messages.some((m) => m.role === 'assistant' && Array.isArray(m.content));
    const hasToolUse = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
    const hasToolResult = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    const ok = hasAssistant && hasToolUse && hasToolResult;
    log('openAIToAnthropicMessages (tool_calls → tool_use/tool_result)', ok, ok ? '' : 'missing block');
    if (ok) passed++; else failed++;
  } catch (e) {
    log('openAIToAnthropicMessages (tool_calls)', false, e.message);
    failed++;
  }

  // 8. GET /health
  try {
    const r = await fetch(BASE + '/health');
    const ok = r.ok;
    if (ok) {
      const j = await r.json();
      if (j.ok === true) {
        log('GET /health', true);
        passed++;
      } else {
        log('GET /health', false, 'bad body');
        failed++;
      }
    } else {
      log('GET /health', false, r.status);
      failed++;
    }
  } catch (e) {
    log('GET /health', false, e.message);
    failed++;
  }

  console.log('\n---');
  console.log(`Rezultat: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
