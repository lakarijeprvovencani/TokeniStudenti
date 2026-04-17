/**
 * Stress test — simulates a full agent loop against EVERY Vajb model and
 * measures how each one behaves under a realistic multi-file coding task.
 *
 * What we measure per model:
 *   - turns           : number of assistant round-trips
 *   - wall time       : total latency end-to-end
 *   - output tokens   : billed output tokens summed across turns
 *   - tool calls      : total tool calls emitted
 *   - truncated calls : tool calls whose JSON args failed to parse
 *   - duplicate writes: same path written more than once (loop signal)
 *   - finish reasons  : distribution of stop / tool_calls / length / error
 *   - files created   : names of files the model ACTUALLY wrote on disk
 *   - completed       : model emitted a final text response after writing
 *   - loop detected   : any file written 3+ times total
 *
 * Scenario: a realistic multi-file site. Big enough to stress tool-call
 * sizing (>10KB per file), but bounded so a healthy model finishes in
 * <20 turns. A model that loops, truncates, or bails early will show up
 * clearly in the summary matrix at the end.
 */

import https from 'https';

const API_URL = 'https://vajbagent.com';
const API_KEY = 'va-nikola-jovanovic-0651badf';

const MODELS = [
  { id: 'vajb-agent-lite',      label: 'Lite       (gpt-5-mini)' },
  { id: 'vajb-agent-turbo',     label: 'Turbo      (haiku-4-5)' },
  { id: 'vajb-agent-pro',       label: 'Pro        (gpt-5)' },
  { id: 'vajb-agent-max',       label: 'Max        (sonnet-4-6)' },
  { id: 'vajb-agent-power',     label: 'Power      (gpt-5.4)' },
  { id: 'vajb-agent-ultra',     label: 'Ultra      (opus-4-7)' },
  { id: 'vajb-agent-architect', label: 'Architect  (opus-4-7)' },
];

const MAX_TURNS = 20;
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000; // 6 min per request (Power/Opus can stall)

// ── Mock filesystem so the agent can actually "work" ──────────────────
function makeFs() {
  const files = new Map();
  return {
    files,
    write(path, content) {
      files.set(path, content);
      return { ok: true, path, bytes: (content || '').length };
    },
    read(path) {
      if (!files.has(path)) return { ok: false, error: 'File not found: ' + path };
      return { ok: true, path, content: files.get(path) };
    },
    list() {
      return { ok: true, files: Array.from(files.keys()).sort() };
    },
    replace(path, oldText, newText) {
      if (!files.has(path)) return { ok: false, error: 'File not found: ' + path };
      const cur = files.get(path);
      if (!cur.includes(oldText)) return { ok: false, error: 'old_text not found in ' + path };
      files.set(path, cur.replace(oldText, newText));
      return { ok: true, path };
    },
  };
}

// ── Tool schema (matches the real Vajb tool surface, trimmed) ─────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (or overwrite) the ENTIRE file at the given path. Pass complete file content — no placeholders, no "rest of code" markers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path, e.g. index.html' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file you previously wrote. Only needed if you need to verify or diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files currently on disk.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace old_text with new_text inside an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a coding agent. You work by calling tools.

RULES:
- When the user asks for files, use write_file — DO NOT dump file content in chat.
- One write_file per file; pass the ENTIRE file contents (no "...rest of code" markers).
- After all files are written, respond with ONE short summary paragraph in Serbian.
- Never write the same file twice.
- Never call a tool just to "verify" — trust your writes.`;

const USER_TASK = `Napravi modernu landing page za zubnu ordinaciju "Dr. Marković Dental Studio" u Beogradu.

Tri fajla:
1. index.html — hero ("Osmeh koji pamtite."), sekcija usluga (4 kartice: Estetska, Implanti, Dečja, Hitne), sekcija "Zašto mi?" sa 3 statistike, kontakt forma sa poljima (ime, telefon, poruka) + adresa (Knez Mihailova 42).
2. style.css — čist moderan dizajn, accent #14b8a6, font Inter sa Google Fonts, hover efekti, mobile responsive (media queries).
3. script.js — smooth scroll za navigaciju + validacija forme (min. ime 2 slova, telefon min. 6 cifara, poruka min. 10 karaktera) + alert na submit.

Napiši SAMO ova 3 fajla — ne pravi dodatne fajlove.`;

// ── HTTPS helper ──────────────────────────────────────────────────────
function postJson(path, body, { stream = true, onChunk } = {}) {
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
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        const events = [];
        const contentType = res.headers['content-type'] || '';
        const isSse = contentType.includes('text/event-stream');
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          if (!stream || !isSse) return;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = block.split('\n').map(l => l.replace(/^data:\s*/, '')).filter(Boolean);
            for (const line of lines) {
              if (line === '[DONE]') { events.push({ done: true }); continue; }
              try {
                const e = JSON.parse(line);
                events.push(e);
                if (onChunk) onChunk(e);
              } catch { /* ignore comments / partial */ }
            }
          }
        });
        res.on('end', () => {
          if (!isSse) {
            // Backend rejected the request before opening a stream — typically
            // a JSON error body. Surface it so the test runner can report the
            // real cause instead of silently "no finish reason".
            let parsed;
            try { parsed = JSON.parse(buf); } catch { parsed = null; }
            const msg = parsed?.error?.message || parsed?.message || buf.slice(0, 200) || ('HTTP ' + res.statusCode);
            resolve({ status: res.statusCode, events: [{ error: { message: msg } }] });
            return;
          }
          if (stream) resolve({ status: res.statusCode, events });
          else {
            try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
            catch { resolve({ status: res.statusCode, body: buf }); }
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('client timeout after ' + REQUEST_TIMEOUT_MS + 'ms')));
    req.write(payload);
    req.end();
  });
}

// ── Aggregate a stream of Chat Completions chunks into one turn ───────
function aggregateTurn(events) {
  let text = '';
  const toolCalls = new Map();
  let finishReason = null;
  let errorMsg = null;
  let usage = null;

  for (const e of events) {
    if (e.done) continue;
    if (e.error) errorMsg = e.error.message;
    if (e.usage) usage = e.usage;
    const choice = e.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === 'string') text += d.content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        const existing = toolCalls.get(idx) || { id: null, name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        toolCalls.set(idx, existing);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  return {
    text,
    toolCalls: Array.from(toolCalls.values()).sort((a, b) => (a.id || '').localeCompare(b.id || '')),
    finishReason,
    errorMsg,
    usage,
  };
}

// ── One end-to-end run for one model ──────────────────────────────────
async function runModel(modelId) {
  const fs = makeFs();
  const history = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_TASK },
  ];

  const stats = {
    model: modelId,
    turns: 0,
    totalOutputTokens: 0,
    totalInputTokens: 0,
    toolCallCount: 0,
    truncatedToolCalls: 0,
    duplicateWrites: 0,
    writesByPath: new Map(),
    finishReasons: {},
    wallMs: 0,
    completed: false,
    loopDetected: false,
    firstChunkLatencies: [],
    error: null,
  };

  const t0 = Date.now();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    stats.turns = turn + 1;
    const turnStart = Date.now();
    let sawFirstDelta = false;
    let result;
    try {
      const { events } = await postJson('/v1/chat/completions', {
        model: modelId,
        stream: true,
        max_tokens: 8000, // what the real frontend sends — backend applies floors
        messages: history,
        tools: TOOLS,
      }, {
        onChunk: (e) => {
          if (sawFirstDelta) return;
          const d = e.choices?.[0]?.delta;
          if (d && (d.content || d.tool_calls)) {
            sawFirstDelta = true;
            stats.firstChunkLatencies.push(Date.now() - turnStart);
          }
        }
      });
      result = aggregateTurn(events);
    } catch (err) {
      stats.error = 'transport: ' + (err?.message || String(err));
      break;
    }

    if (result.errorMsg) {
      stats.error = 'upstream: ' + result.errorMsg;
      break;
    }
    if (result.usage) {
      stats.totalOutputTokens += result.usage.completion_tokens || 0;
      stats.totalInputTokens += result.usage.prompt_tokens || 0;
    }
    const fr = result.finishReason || 'none';
    stats.finishReasons[fr] = (stats.finishReasons[fr] || 0) + 1;

    // Check tool calls for truncation + dedup signals
    for (const tc of result.toolCalls) {
      stats.toolCallCount++;
      let args;
      try {
        args = JSON.parse(tc.args);
      } catch {
        stats.truncatedToolCalls++;
        args = null;
      }
      if (tc.name === 'write_file' && args?.path) {
        const prev = stats.writesByPath.get(args.path) || 0;
        stats.writesByPath.set(args.path, prev + 1);
        if (prev >= 1) stats.duplicateWrites++;
        if (prev >= 2) stats.loopDetected = true;
      }
    }

    if (result.toolCalls.length === 0) {
      // Pure text turn. If we have at least one file written, consider completed.
      if (fs.files.size > 0 && result.text && result.text.trim().length > 0) {
        stats.completed = true;
      }
      break;
    }

    // Append assistant turn to history
    history.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    // Execute each tool call, append result
    for (const tc of result.toolCalls) {
      let args;
      try { args = JSON.parse(tc.args); } catch { args = null; }
      let content;
      if (!args) {
        content = 'GRESKA: Tool args JSON invalid — try again with a smaller payload.';
      } else if (tc.name === 'write_file') {
        const r = fs.write(args.path, args.content);
        content = JSON.stringify(r);
      } else if (tc.name === 'read_file') {
        const r = fs.read(args.path);
        content = JSON.stringify(r);
      } else if (tc.name === 'list_files') {
        const r = fs.list();
        content = JSON.stringify(r);
      } else if (tc.name === 'replace_in_file') {
        const r = fs.replace(args.path, args.old_text, args.new_text);
        content = JSON.stringify(r);
      } else {
        content = 'GRESKA: unknown tool ' + tc.name;
      }
      history.push({ role: 'tool', tool_call_id: tc.id, content });
    }

    if (stats.loopDetected) {
      stats.error = 'loop: same file written 3+ times';
      break;
    }
  }

  stats.wallMs = Date.now() - t0;
  stats.filesCreated = Array.from(fs.files.keys()).sort();
  stats.fileBytes = Array.from(fs.files.entries())
    .map(([p, c]) => ({ path: p, bytes: (c || '').length }));
  return stats;
}

// ── Format results ────────────────────────────────────────────────────
function verdict(s) {
  if (s.error) return 'FAIL (' + s.error.slice(0, 40) + ')';
  if (s.loopDetected) return 'LOOP';
  if (!s.completed) return 'INCOMPLETE';
  if (s.truncatedToolCalls > 0) return 'PASS (truncation seen)';
  if (s.duplicateWrites > 0) return 'PASS (dup writes seen)';
  return 'PASS';
}

function formatSummary(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + '═'.repeat(120));
  console.log('  STRESS TEST SUMMARY — 1 realistic multi-file task, full agent loop');
  console.log('═'.repeat(120));
  console.log(
    pad('Model', 28) +
    pad('Verdict', 24) +
    pad('Turns', 7) +
    pad('Wall', 9) +
    pad('Out tok', 10) +
    pad('Tools', 8) +
    pad('Truncs', 8) +
    pad('DupW', 6) +
    'Files'
  );
  console.log('─'.repeat(120));
  for (const s of rows) {
    const fileList = (s.filesCreated || []).join(',') || '(none)';
    console.log(
      pad(s.label, 28) +
      pad(verdict(s), 24) +
      pad(s.turns, 7) +
      pad((s.wallMs / 1000).toFixed(1) + 's', 9) +
      pad(s.totalOutputTokens, 10) +
      pad(s.toolCallCount, 8) +
      pad(s.truncatedToolCalls, 8) +
      pad(s.duplicateWrites, 6) +
      fileList
    );
  }
  console.log('═'.repeat(120));
}

// ── Runner ─────────────────────────────────────────────────────────────
(async () => {
  console.log('Starting stress test — ' + MODELS.length + ' models, task: 3-file dentist site');
  console.log('Running SERIALLY (backend has a per-key concurrency guard)\n');
  const rows = [];
  for (const m of MODELS) {
    const tStart = Date.now();
    process.stdout.write('  [' + m.label + '] start…');
    try {
      const s = await runModel(m.id);
      s.label = m.label;
      rows.push(s);
      process.stdout.write(
        ' done in ' + ((Date.now() - tStart) / 1000).toFixed(1) + 's — ' +
        verdict(s) + ', ' + (s.filesCreated?.length || 0) + ' files\n'
      );
    } catch (err) {
      rows.push({
        label: m.label,
        model: m.id,
        error: 'runner: ' + (err?.message || String(err)),
        turns: 0, wallMs: Date.now() - tStart, totalOutputTokens: 0,
        toolCallCount: 0, truncatedToolCalls: 0, duplicateWrites: 0,
        filesCreated: [],
      });
      process.stdout.write(' FAILED: ' + (err?.message || err) + '\n');
    }
  }

  // Keep the summary in the original MODELS order for readability.
  rows.sort((a, b) => MODELS.findIndex(m => m.id === a.model) - MODELS.findIndex(m => m.id === b.model));

  formatSummary(rows);

  // Per-model detail dump for failing/interesting runs.
  for (const s of rows) {
    const v = verdict(s);
    if (v === 'PASS') continue;
    console.log('\n── Detail: ' + s.label + ' ── ' + v);
    console.log('   finishReasons:', s.finishReasons);
    console.log('   writesByPath:', Object.fromEntries(s.writesByPath || []));
    if (s.error) console.log('   error:', s.error);
    if (s.firstChunkLatencies?.length) {
      const avg = Math.round(s.firstChunkLatencies.reduce((a, b) => a + b, 0) / s.firstChunkLatencies.length);
      console.log('   avg first-chunk latency: ' + avg + 'ms (across ' + s.firstChunkLatencies.length + ' turns)');
    }
    if (s.fileBytes?.length) {
      console.log('   fileBytes:', s.fileBytes);
    }
  }

  const passes = rows.filter(r => verdict(r).startsWith('PASS')).length;
  console.log('\n' + passes + '/' + rows.length + ' models PASS');
  process.exit(passes === rows.length ? 0 : 1);
})();
