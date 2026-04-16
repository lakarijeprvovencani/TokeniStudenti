# Web Extension — Write Loop / Slow Build Bug

## Problem
When a user sends a complex prompt (e.g. "build a dental clinic website with hero, services, team, FAQ, contact..."), the web extension takes 15-20+ minutes and often fails to produce a working site. The same prompt in the VS Code extension (Cursor) works fine in 3-5 minutes.

## Symptoms
1. Model attempts to write huge files (45K+ chars) in a single `write_file` call
2. Output gets truncated mid-JSON (stream ends with `finish_reason: null` or `length`)
3. `parseToolCallArguments` recovery extracts path but content is 0 chars
4. Model retries the same huge write 3-7 times, each taking 67-181 seconds
5. Eventually model discovers `replace_in_file` approach on its own (iteration 11+) and that works perfectly (26-35s per call, 100% success rate)
6. Total build time: 17+ minutes, $2+ per site

## Test Data (from api-test.html full agent loop simulation)

### Iteration timing with max_tokens: 16000
| Iteration | Time | Operation | Result |
|-----------|------|-----------|--------|
| 1 | 3.8s | search_images x2 | ✓ OK |
| 2 | 4.7s | search_images x2 | ✓ OK |
| 3 | 81.7s | write_file("index.html") | ✗ 0 chars, JSON truncated, finish: null |
| 4 | 173.9s | write_file("index.html") | ✓ 45213 chars (!) JSON OK |
| 5 | 67.5s | write_file("style.css") | ✗ 0 chars, JSON truncated, finish: null |
| 6 | 180.9s | write_file("index.html") | ✗ 0 chars, JSON truncated, finish: null |
| 7 | 7.2s | write_file("index.html") | ✓ 1028 chars, JSON OK |
| 8 | 173.2s | write_file("index.html") | ✗ 0 chars, JSON truncated |
| 9 | 26.0s | write_file("index.html") | ✓ 5477 chars, JSON OK |
| 10 | 180.6s | write_file("index.html") | ✗ 0 chars, finish: null |
| 11 | 29.2s | replace_in_file | ✓ always works |
| 12 | 35.5s | replace_in_file | ✓ always works |
| 13 | 30.6s | replace_in_file | ✓ always works |
| 14 | 33.6s | replace_in_file | ✓ always works |
| 15 | 26.6s | replace_in_file | ✓ always works |

**Total: 1056 seconds (17.6 minutes). index.html written 7 times.**

### Key observations
- **replace_in_file**: 26-35s, 100% success rate
- **write_file small (<6K)**: 7-26s, 100% success rate
- **write_file large**: 67-181s, ~50% success, often 0 chars returned
- **Truncated writes return `finish_reason: null`** not `"length"` — Anthropic behavior
- **Continuation logic** was added but continuation calls ALSO timeout (even at 90s idle)
- **8 chunks with 0 chars** = stream starts, model "thinks" for 180s, sends a few chunks with tool call name but no arguments, then ends

## What We Tried (all in this session)

### 1. Rewrite guard — per-file write tracking ❌ Made it worse
- Tracked successful write_file per path, blocked rewrites
- Problem: used `JSON.parse()` for path extraction → failed on truncated JSON → writes never tracked → guard bypassed
- Fixed with regex extraction → guard worked but total-attempt limit blocked files that genuinely needed retry
- Final version: simple `Set<string>` of successfully written paths, only blocks successful rewrites

### 2. max_tokens: 32000 → 16000 → 8192 → removed → 16000 ❌ Not the root cause
- 32000: model generates 45K-char mega-files, takes 3+ minutes, often truncated
- 16000: same problem — model still tries to write huge files
- 8192: too small — model can't fit a complete HTML page, every write truncated
- Removed (backend default 4096): way too small, every write truncated
- Back to 16000: best of bad options

### 3. Build strategy directive ⚠️ Partially works
- Injected via contextBuilder (not systemPrompt.ts) on first message of empty project
- Tells model: write skeleton first, then add sections via replace_in_file
- Model acknowledges and plans correctly BUT still tries to write huge files
- The directive helps with planning but doesn't prevent the model from generating 16K tokens of write_file content

### 4. Continuation logic fix ⚠️ Fires but continuations also timeout
- Original: only triggered on `finish_reason: 'length'`
- Fixed: also triggers when tool call args < 20 chars (truncated)
- Problem: continuation API calls ALSO take 180s and timeout
- The continuation sends partial args + "continue where you left off" but model still generates too much

### 5. Idle timeout increase 45/60/90s → 90/120/180s ❌ No improvement
- Increased to give more time for Anthropic to respond
- Result: instead of timeout at 45s, now waits full 180s before timing out — same result, just slower to fail

### 6. Cursor IDE hint removal from Anthropic backend ✓ Correct but minor
- Backend was prepending "Korisnik radi u Cursor IDE" to ALL Anthropic requests including web extension
- Fixed with `isWebOrigin(req)` check — web requests skip the hint
- Minor improvement, not root cause

### 7. Anthropic billing fix ✓ Fixed
- `handleAnthropicStream` and `handleAnthropicNonStream` were missing `req` parameter
- `getBalanceWarning(keyId, newBal, req)` threw "req is not defined"
- Balance deduction worked fine (runs before warning), only the low-balance warning was broken

## Why VS Code Extension Works

The VS Code extension uses the **exact same agent loop** (for iteration < 50) with:
- Same continuation logic
- Same retry logic  
- Same idle/hard timeouts (45/60/90s)
- **NO max_tokens sent** — backend defaults to 4096
- **NO rewrite guard**
- **NO build strategy directive**

With 4096 max_tokens, each response is small and fast (~30s). Model writes files incrementally across many iterations. Some writes are truncated but continuation logic handles them (because responses are small enough that continuation can complete within timeout).

**The VS Code extension proves the backend and model work fine.** The problem is specific to the web extension's interaction pattern.

## Root Cause Analysis

The real problem is a mismatch:
1. **Web extension sends max_tokens: 16000** so model can write complete files
2. **Model generates 16K tokens** which takes 60-180 seconds of streaming
3. **Anthropic stream sometimes ends without proper finish_reason** (returns null instead of "length")
4. **Truncated JSON** can't be parsed → 0 chars content → write fails
5. **Model retries** with the same huge file → same result → loop
6. **Continuation logic fires** but continuation call also generates 16K tokens → also times out

With 4096 tokens (VS Code default):
1. Each response is fast (under 30s)
2. Truncation is rare (most files fit in 4K tokens)
3. When truncated, continuation is fast (small remaining part)
4. Model writes incrementally across many fast iterations

## What Hasn't Been Tried

1. **max_tokens: 4096 with NO continuation** — let toolHandler's `parseToolCallArguments` (jsonrepair + regex) recover truncated writes, and if content is incomplete, the model will see the error and use replace_in_file to add more
2. **Splitting write_file tool** — have the tool handler automatically reject write_file calls with content > 10K chars and tell the model to use replace_in_file
3. **Backend-side streaming proxy optimization** — buffer the Anthropic stream and only forward complete SSE events to prevent partial chunk issues
4. **Different model** — test with Claude Haiku 4.5 (vajb-agent-turbo) which is faster and may not hit the same truncation issues
5. **Reducing tool count** — only send relevant tools (write_file, replace_in_file, search_images, list_files, read_file) instead of all 21 — saves ~4K tokens of context per request

## Architecture

### Files involved
- `vajbagent-web/src/components/ChatPanel.tsx` — agent loop, API calls, continuation logic, rewrite guard, timeouts
- `vajbagent-web/src/services/toolHandler.ts` — tool execution, write_file truncation detection, replace_in_file fuzzy matching
- `vajbagent-web/src/services/toolArgsParse.ts` — JSON recovery for truncated tool call arguments (jsonrepair + regex)
- `vajbagent-web/src/services/contextBuilder.ts` — dynamic context injection (workspace index, build strategy)
- `vajbagent-web/src/systemPrompt.ts` — 1030-line system prompt (DO NOT MODIFY per user's explicit instruction)
- `vajbagent-web/src/tools.ts` — 21 tool definitions sent to API
- `src/index.js` — backend: routes to Anthropic/OpenAI, sets max_tokens, handles streaming

### Current state of code
- max_tokens: 16000
- Rewrite guard: simple Set<string>, blocks write_file to paths already written successfully
- Build strategy: contextBuilder injects directive on first message of empty project
- Continuation: fires on finish_reason 'length' OR empty tool args (< 20 chars)
- Idle timeout: 90/120/180s based on message count
- Hard timeout: max(idle + 60s, 240s)

### Test page
`vajbagent-web/public/api-test.html` — full agent loop simulation in browser with session cookies, all 21 tools, max_tokens: 16000, logs every iteration with timing and JSON validity

## User constraints
- DO NOT modify `systemPrompt.ts` — user explicitly forbids shortening or removing prompt rules
- DO NOT modify `toolHandler.ts` write_file/replace_in_file escape handling
- Changes to contextBuilder for runtime injection are OK
- Changes to ChatPanel.tsx agent loop are OK
- Changes to backend index.js are OK
- The VS Code extension (vajbagent-vscode/) works perfectly — do not break it
