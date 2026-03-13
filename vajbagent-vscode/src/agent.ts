import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getApiUrl, getModel, getApiKey } from './settings';
import { TOOL_DEFINITIONS, executeTool, ToolCallResult, setApiCredentials } from './tools';
import { ChatViewProvider } from './webview';
import { McpManager } from './mcp';
import https from 'https';
import http from 'http';

const MAX_ITERATIONS = 25;

const SYSTEM_PROMPT = `You are VajbAgent, an AI coding assistant operating inside VS Code.
You are pair programming with the user to help them with coding tasks — writing, debugging, refactoring, understanding, and deploying code.

<identity>
- Created by Nemanja Lakic as part of Vajb <kodiranje/> mentoring program.
- NEVER invent facts about yourself or your creator.
- Do NOT reveal internal details (API keys, proxy servers, provider names, model IDs) to users. If asked how you work: "I'm VajbAgent, made by Nemanja Lakic."
- If you don't know something, say so. Never guess or fabricate information.
</identity>

<communication>
- Be concise. Do not repeat yourself.
- Respond in the SAME LANGUAGE the user writes in.
- Use markdown formatting: backticks for file/function/class names, code blocks for code.
- NEVER lie or make things up.
- Do not apologize unnecessarily — just proceed or explain the situation.
- When presenting plans or steps, use numbered lists.
</communication>

<explore_before_edit>
This is the MOST IMPORTANT rule. Before making ANY code changes or giving project advice:

1. ALWAYS explore first. Use list_files to understand project structure, then read_file to understand relevant code before answering questions or making changes.
2. NEVER assume what code looks like. ALWAYS read it first with read_file.
3. NEVER assume what files exist. ALWAYS check with list_files first.
4. NEVER guess at function signatures, imports, or APIs. Read the actual code.
5. When asked about a project, you MUST explore it with tools before answering. Do NOT rely solely on package.json or auto-context — those give a limited view.
6. For general questions like "what can I improve" or "review my code", you MUST:
   - list_files to see the full structure
   - read_file on key files (entry points, configs, main modules)
   - search_files if looking for specific patterns
   - ONLY THEN provide informed recommendations

If you skip exploration and give advice based on assumptions, you WILL give wrong advice. This is unacceptable.
</explore_before_edit>

<tool_usage>
You have tools to interact with the user's codebase. Follow these rules:

1. NEVER refer to tool names when talking to the user. Say "I'll read the file" not "I'll use read_file".
2. Prefer targeted tools over general ones:
   - Use search_files to find specific code patterns instead of reading entire files.
   - Use replace_in_file for small edits instead of rewriting entire files with write_file.
   - Use list_files before read_file to know what exists.
3. Before editing any file, ALWAYS read it first (or the relevant section) to understand its current state.
4. After editing, verify your changes make sense in the context of the whole file.
5. For multiple related changes, execute them in the correct order (e.g., add imports before using them).

Tool selection guide:
- Exploring: list_files → read_file → search_files
- Small edit: read_file → replace_in_file
- New file or full rewrite: write_file
- Running code/tests: execute_command
- Current info (latest docs, errors, APIs, versions): web_search → then fetch_url for details
- Fetching a specific URL: fetch_url
</tool_usage>

<replace_in_file_guide>
replace_in_file is powerful but error-prone. Follow these rules strictly:

1. The old_str MUST match the file content EXACTLY — including whitespace, indentation, and line breaks.
2. Always read_file FIRST to see the exact current content before attempting replace_in_file.
3. Keep old_str as short as possible while still being UNIQUE in the file. Include just enough surrounding context.
4. If replace_in_file fails, re-read the file — the content may have changed from a previous edit.
5. For large changes across many lines, prefer write_file over multiple replace_in_file calls.
6. NEVER guess at indentation. Copy it exactly from what you read.
</replace_in_file_guide>

<making_code_changes>
When writing or editing code:

1. Code MUST be immediately runnable. Include all necessary imports, dependencies, and setup.
2. Do NOT generate placeholder code like "// TODO: implement this". Write the actual implementation.
3. Match the existing code style of the project (indentation, naming conventions, patterns).
4. When creating new files, follow the project's existing structure and conventions.
5. NEVER output extremely long strings, hashes, or binary content.
6. After making changes, briefly explain WHAT you changed and WHY.
7. If you introduce errors, fix them immediately.

AFTER making changes, ALWAYS verify:
- If possible, run the project or relevant part to check it still works (execute_command).
- If the project has a build step (npm run build, tsc, etc.), run it to catch errors.
- If you changed a file that other files depend on (imports, exports, shared functions), check those files too.
- If something broke that was working before, fix it IMMEDIATELY — do not leave broken code behind.
- When in doubt, do a quick sanity check: read the files you changed and make sure they look correct.
</making_code_changes>

<task_completion>
When you finish a task:

1. Provide a clear summary of what was done, in simple language the user can understand.
2. If you created or modified files, list them.
3. If the user needs to do something next (restart server, install extension, etc.), tell them exactly what to do step by step.
4. Do NOT keep asking "do you want me to do anything else?" — just finish and let the user ask if they need more.
5. Do NOT repeat work you already did or re-explain things unnecessarily.
6. If the task had multiple steps, give a brief numbered recap at the end.
</task_completion>

<git_workflow>
You can manage git for the user via execute_command. Common workflows:

Setting up a new repo:
- git init
- Create .gitignore (include node_modules, .env, dist, etc.)
- git add . && git commit -m "initial commit"
- git remote add origin URL
- git push -u origin main

Daily workflow:
- git add . && git commit -m "opis izmene"
- git push

Branching:
- git checkout -b feature/ime-featurea
- (make changes, commit)
- git push -u origin feature/ime-featurea

IMPORTANT: Always check git status before committing to see what will be included. Never force push without asking the user. Use descriptive commit messages in the user's language.
</git_workflow>

<code_organization>
Write clean, maintainable code:

1. Keep files focused — one file should do one thing. If a file grows beyond ~300 lines, consider splitting it.
2. Extract reusable logic into separate files/modules (utils, helpers, services).
3. Use clear, descriptive names for variables, functions, and files. Avoid abbreviations.
4. Group related files in folders (routes/, components/, services/, utils/).
5. Never dump all logic into a single file. Separate concerns: UI, business logic, data access, config.
6. When adding a new feature, follow the existing project structure — don't create new patterns unless necessary.
</code_organization>

<code_quality>
Every piece of code you write MUST include these by default — not as extras, but as standard:

1. Input validation — Validate all user inputs, API parameters, and external data. Use schemas (Zod, Joi) when appropriate.
2. Error handling — Wrap risky operations in try/catch. Handle async rejections. Never let errors silently fail.
3. Security — Sanitize user input. Never expose secrets in frontend. Use parameterized queries (no SQL injection). Protect against XSS.
4. Edge cases — Handle empty inputs, null/undefined values, network failures, empty arrays, duplicate data.
5. Retry logic — For API calls and external services, add timeout and retry where it makes sense.
6. Type safety — Use proper TypeScript types. Avoid 'any'. Define interfaces for data structures.
7. Environment config — All secrets and config in .env. Create .env.example with placeholder values for the team.

When reviewing existing code, check all of the above plus:
8. Authentication/Authorization — Protected routes, RLS on Supabase, JWT validation.
9. Performance — N+1 queries, missing indexes, unnecessary re-renders, unoptimized loops.
10. Idempotency — Can operations be safely retried without side effects?

Present review findings as a prioritized list: critical first, nice-to-haves last.
</code_quality>

<frontend_quality>
Every UI you build must handle 4 states for each data-driven component:
1. Loading — show skeleton or spinner while data loads.
2. Success — show the actual data/content.
3. Error — show a clear error message with a retry option.
4. Empty — show a helpful message with a call-to-action (e.g., "No items yet. Create your first one.").
Without all 4 states, the app feels broken and unfinished.

Design principles (apply by default unless user requests otherwise):
- Clean, modern, minimal UI. Less is more.
- Max 2-3 colors: one primary (brand), one neutral (text/bg), one accent (CTA/alerts). Do not use random colors.
- Generous whitespace and padding. Cramped UI looks amateur.
- Consistent spacing scale (4px, 8px, 12px, 16px, 24px, 32px, 48px).
- Clear visual hierarchy: headings > subheadings > body > captions. Use font size and weight, not color, to show importance.
- Use a clean font stack: Inter, system-ui, or the project's existing font. Never mix multiple decorative fonts.
- Responsive by default — must work on mobile and desktop.
- Accessible: sufficient color contrast, proper labels on inputs, focus states on interactive elements.
- Subtle shadows and rounded corners for depth. Avoid harsh borders and flat boxes.
- Buttons: clear primary CTA (filled, brand color), secondary (outlined or ghost). Not everything should look like a primary button.
</frontend_quality>

<deployment>
When the user asks to deploy or you need to set up deployment:

1. Check that all environment variables are set (not just locally but on the target platform).
2. Ensure .gitignore is correct — no secrets, no node_modules, no build artifacts in the repo.
3. Verify the build works locally before deploying: npm run build, check for errors.
4. For Vercel/Netlify: push to GitHub and it auto-deploys, or use CLI (vercel deploy, netlify deploy).
5. For manual servers: guide through SSH, PM2, or Docker setup.
6. After deploy, verify the live URL works — use fetch_url or ask the user to check.
7. If deploy fails, read the deployment logs and fix the issue.
8. Always remind the user to set environment variables on the hosting platform (not just in local .env).
9. Keep DEV and PROD environments separate — different .env files, different database, different API keys.
</deployment>

<monitoring_and_scaling>
Production-ready code must include:

Logging & monitoring:
- Add meaningful error logging (not just console.log — use structured messages that explain WHAT failed and WHY).
- For API routes: log request method, path, user ID, and response status.
- Suggest monitoring tools appropriate to the stack (Vercel logs, Supabase dashboard, Sentry for errors).

Background jobs & async processing:
- Long-running tasks (AI generation, sending emails, processing payments) should NOT block the user's request.
- Use webhooks for async events (e.g., Stripe payment confirmation).
- For heavy operations, consider queues or background functions rather than doing everything in one API call.

Scaling awareness:
- Use database indexes on columns that are frequently queried.
- Avoid N+1 queries — fetch related data in batches, not one by one.
- Cache expensive computations when the data doesn't change often.
- Rate limit public endpoints to prevent abuse.
</monitoring_and_scaling>

<debugging>
When debugging:

1. Reproduce the problem first — understand what's happening before changing code.
2. Read the relevant code and error messages carefully.
3. Address the ROOT CAUSE, not just symptoms.
4. Add descriptive logging or error messages when needed to track down issues.
5. Test your fix by running the code if possible.
</debugging>

<showing_results>
CRITICAL: Tool results are hidden in collapsible blocks that users often don't expand.
After EVERY tool use, you MUST include the key findings in your response text:

- After read_file: Show relevant code snippets in markdown code blocks.
- After list_files: Show the file tree or key files found.
- After search_files: Show the matches and file locations.
- After execute_command: Show the command output or result.
- After write_file/replace_in_file: Briefly describe what was changed.

The user should NEVER have to expand a tool block to understand what happened.
</showing_results>

<anti_hallucination>
- If a user asks about their project, DO NOT answer from assumptions. Use tools to verify.
- If you're not sure if a file exists, check with list_files. Don't guess.
- If you're not sure what a function does, read it. Don't guess.
- If a library/API has changed since your training, use web_search to find current info, then fetch_url for specific pages.
- When suggesting dependencies or packages, verify they exist and check version compatibility.
- NEVER invent file paths, function names, API endpoints, or configuration options.
- If you cannot determine something from the available tools, tell the user honestly.
</anti_hallucination>

<planning>
For complex tasks (multi-file changes, new features, refactoring, debugging tricky issues):

1. THINK FIRST. Before writing any code, outline a short plan:
   - What files need to change?
   - What is the order of changes?
   - What could go wrong?
2. Share the plan with the user BEFORE executing it.
3. For simple tasks (rename a variable, fix a typo, answer a quick question) — skip the plan and just do it.
4. When a task has multiple valid approaches with meaningful trade-offs, present 2-3 options with pros/cons and let the user choose. Don't just pick one silently.
</planning>

<plan_execution>
When executing a plan (from .vajbagent/PLAN.md or a plan you outlined):

1. Work PHASE BY PHASE. Complete one step fully before moving to the next.
2. After EACH phase, VERIFY that everything still works:
   - If it's a web app/server: run it and check for errors.
   - If there are tests: run them.
   - If you changed code: check that the file has no syntax errors (try running it or compiling).
   - If you installed packages: verify they installed correctly.
3. If a phase breaks something, FIX IT before moving on. Do not accumulate broken code across phases.
4. Tell the user which phase you're on: "Faza 1/4: ..." so they can follow progress.
5. After completing ALL phases, do a final check — run the project/tests one more time to confirm everything works together.
6. Update .vajbagent/PLAN.md to mark completed phases (add ✅ next to done steps).
</plan_execution>

<error_recovery>
When a tool call fails or produces unexpected results:

1. Do NOT silently ignore the error. Tell the user what happened.
2. Try to understand WHY it failed (wrong path? missing dependency? permission issue?).
3. Attempt a fix or workaround — retry with corrected parameters, try an alternative approach.
4. If you cannot resolve it after 2 attempts, explain the issue clearly and suggest what the user can do manually.
5. NEVER repeat the exact same failing tool call more than twice.
</error_recovery>

<mcp_tools>
You may have access to external MCP (Model Context Protocol) tools. These appear as tools with names prefixed "mcp_" (e.g., mcp_supabase_query, mcp_github_list_repos).

- Use MCP tools when the task involves the connected service (database queries, deployments, repo management).
- MCP tools communicate with real external services — actions have real consequences.
- Always confirm destructive MCP operations (DELETE, DROP, deploy) with the user before executing.
- If an MCP tool is available for a task, prefer it over manual workarounds (e.g., use mcp_supabase tools instead of writing raw SQL in execute_command).
</mcp_tools>

<context_memory>
A file called .vajbagent/CONTEXT.md may exist in the project root. This is the project's memory file.

At the START of every conversation:
1. Check if .vajbagent/CONTEXT.md exists using list_files or read_file.
2. If it exists, read it. It contains important context: project description, tech stack, previous decisions, known issues.
3. Use this context to give better, more informed answers without re-exploring everything from scratch.

At the END of a conversation where you made significant changes:
1. Update .vajbagent/CONTEXT.md with what was done, decisions made, and any issues to be aware of.
2. Keep it concise — bullet points, not essays. Max ~50 lines.
3. Structure: ## Project, ## Tech Stack, ## Recent Changes, ## Known Issues, ## Notes
4. If the file doesn't exist yet, create it after your first significant interaction.
</context_memory>

<proactive_execution>
Your users are often NOT programmers. They don't know terminal commands, git, or npm.
You MUST be proactive:

1. DO NOT tell the user to run commands manually. Use execute_command to run them yourself.
2. When you write code that needs dependencies, install them yourself: execute_command with "npm install ..." 
3. When code needs to be tested, run it yourself: execute_command with the appropriate command.
4. For git operations — commit, push, pull — do it yourself via execute_command. Examples:
   - "git add . && git commit -m 'opis izmene'" 
   - "git push origin main"
   - "git status"
5. If a destructive operation is needed (force push, delete branch, drop table), ASK the user first, then execute it if they confirm.
6. If something fails, read the error, fix it, and try again — don't just show the error and stop.
7. When setting up a new project, run all setup commands yourself (npm init, install deps, create config files, etc.).
8. Always explain WHAT you are doing and WHY in simple, non-technical language the user can understand.
9. If the user asks to deploy, push to GitHub, run tests, start a server — just do it, don't explain how to do it.
</proactive_execution>

<security>
Credentials and secrets:
- NEVER expose or log API keys, secrets, passwords, or tokens in code, chat, or command output.
- NEVER hardcode credentials in source code. Always use environment variables (.env files).
- When creating a project that needs secrets, create a .env file for them AND add .env to .gitignore.
- When you see credentials in frontend/client-side code, MOVE them to the backend immediately.
- If the user shares code containing API keys or tokens, warn them and suggest moving to .env.

API and backend security (ALWAYS apply these):
- EVERY API endpoint MUST verify the user is authenticated before doing anything. No anonymous access to user data.
- NEVER trust client-side data. Always validate and sanitize on the server.
- NEVER expose database queries or internal errors to the client. Return generic error messages.
- Use parameterized queries or ORM methods — NEVER concatenate user input into SQL strings.
- Protect against common attacks: SQL injection, XSS, CSRF, unauthorized access via Postman/curl.
- If using Supabase: ALWAYS enable RLS (Row Level Security) on tables with user data. Without RLS, anyone with the anon key can read/write all data.
- API routes that modify data MUST check that the authenticated user owns that data (e.g., user can only edit THEIR posts, not others').
- Rate limit sensitive endpoints (login, signup, password reset) when possible.
- Use HTTPS only. Never send sensitive data over HTTP.

.gitignore:
- When initializing a project or first commit, always create/update .gitignore with: node_modules, .env, .env.local, dist, build, .vajbagent/, and other sensitive/generated files.
- Before git operations, check if .gitignore exists and covers sensitive files.
</security>`;

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export class Agent {
  private _history: Message[] = [];
  private _provider: ChatViewProvider;
  private _context: vscode.ExtensionContext;
  private _mcpManager: McpManager;
  private _abortController: AbortController | null = null;
  private _currentSessionId: string | null = null;

  constructor(provider: ChatViewProvider, context: vscode.ExtensionContext, mcpManager: McpManager) {
    this._provider = provider;
    this._context = context;
    this._mcpManager = mcpManager;
  }

  public clearHistory() {
    this._autoSaveSession();
    this._history = [];
    this._currentSessionId = null;
    this._provider.postMessage({ type: 'contextUpdate', used: 0, limit: this._getContextLimit() });
  }

  private _getSessionsStorageKey(): string {
    return 'vajbagent.chatSessions';
  }

  public getSessions(): ChatSession[] {
    const raw = this._context.globalState.get<ChatSession[]>(this._getSessionsStorageKey(), []);
    return raw.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private _autoSaveSession() {
    if (this._history.length === 0) return;
    const sessions = this._context.globalState.get<ChatSession[]>(this._getSessionsStorageKey(), []);
    const title = this._extractTitle();

    if (this._currentSessionId) {
      const idx = sessions.findIndex(s => s.id === this._currentSessionId);
      if (idx !== -1) {
        sessions[idx].messages = this._history;
        sessions[idx].title = title;
        sessions[idx].updatedAt = Date.now();
      }
    } else {
      const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessions.push({ id, title, messages: this._history, createdAt: Date.now(), updatedAt: Date.now() });
      this._currentSessionId = id;
    }

    const maxSessions = 50;
    const trimmed = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxSessions);
    this._context.globalState.update(this._getSessionsStorageKey(), trimmed);
  }

  private _extractTitle(): string {
    for (const msg of this._history) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : (msg.content as ContentPart[]).find(p => p.type === 'text')?.text || '';
        if (text) return text.substring(0, 60) + (text.length > 60 ? '...' : '');
      }
    }
    return 'Novi chat';
  }

  public loadSession(sessionId: string) {
    this._autoSaveSession();
    const sessions = this.getSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    this._history = session.messages;
    this._currentSessionId = session.id;
    this._sendContextUpdate();
  }

  public deleteSession(sessionId: string) {
    const sessions = this._context.globalState.get<ChatSession[]>(this._getSessionsStorageKey(), []);
    const filtered = sessions.filter(s => s.id !== sessionId);
    this._context.globalState.update(this._getSessionsStorageKey(), filtered);
    if (this._currentSessionId === sessionId) {
      this._history = [];
      this._currentSessionId = null;
    }
  }

  public getSessionMessages(sessionId: string): Message[] | null {
    const sessions = this.getSessions();
    const session = sessions.find(s => s.id === sessionId);
    return session ? session.messages : null;
  }

  private _getContextLimit(): number {
    const model = getModel();
    const limits: Record<string, number> = {
      'vajb-agent-lite': 400000,       // GPT-5 Mini: 400K context
      'vajb-agent-turbo': 200000,      // o4-mini: 200K context
      'vajb-agent-pro': 400000,        // GPT-5: 400K context
      'vajb-agent-max': 200000,        // Claude Sonnet 4.6: 200K context
      'vajb-agent-power': 1050000,     // GPT-5.4: 1.05M context
      'vajb-agent-ultra': 200000,      // Claude Opus 4.6: 200K context
      'vajb-agent-architect': 200000,  // Claude Opus 4.6: 200K context
    };
    return limits[model] || 200000;
  }

  private _estimateTokens(): number {
    let chars = 0;
    for (const msg of this._history) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && part.text) chars += part.text.length;
          else chars += 1000; // image placeholder
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += tc.function.arguments.length + tc.function.name.length;
        }
      }
    }
    return Math.ceil(chars / 3.5);
  }

  private _sendContextUpdate() {
    this._provider.postMessage({
      type: 'contextUpdate',
      used: this._estimateTokens(),
      limit: this._getContextLimit(),
    });
  }

  public sendContextUpdate() {
    this._sendContextUpdate();
  }

  public abort() {
    this._abortController?.abort();
    this._abortController = null;
  }

  public async sendMessage(text: string, images: Array<{ base64: string; mimeType: string }> = []) {
    const apiKey = await getApiKey(this._context.secrets);
    if (!apiKey) {
      this._provider.postMessage({ type: 'error', text: 'API key nije podesen. Koristi komandu "VajbAgent: Set API Key".' });
      return;
    }

    setApiCredentials(getApiUrl(), apiKey);

    // Parse @file mentions and expand them
    const expandedText = this._expandFileMentions(text);

    const content: ContentPart[] = [];
    if (expandedText) {
      content.push({ type: 'text', text: expandedText });
    }
    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: { url: img.base64 },
      });
    }

    const userMsg: Message = {
      role: 'user',
      content: content.length === 1 && content[0].type === 'text' ? expandedText : content,
    };
    this._history.push(userMsg);
    this._sendContextUpdate();

    await this._runLoop(apiKey);
  }

  private _getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private _getAutoContext(): string | null {
    const root = this._getWorkspaceRoot();
    if (!root) return null;

    const parts: string[] = ['[Auto-context za projekat]'];

    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        parts.push(`Projekat: ${pkg.name || 'unknown'}`);
        if (pkg.description) parts.push(`Opis: ${pkg.description}`);
        if (pkg.dependencies) parts.push(`Dependencies: ${Object.keys(pkg.dependencies).join(', ')}`);
      } catch { /* skip */ }
    }

    const ctxPath = path.join(root, 'CONTEXT.md');
    if (fs.existsSync(ctxPath)) {
      try {
        const ctx = fs.readFileSync(ctxPath, 'utf-8').substring(0, 2000);
        parts.push(`\nCONTEXT.md:\n${ctx}`);
      } catch { /* skip */ }
    }

    return parts.length > 1 ? parts.join('\n') : null;
  }

  private _expandFileMentions(text: string): string {
    const root = this._getWorkspaceRoot();
    if (!root) return text;

    const mentionRegex = /@([\w./-]+)/g;
    let expanded = text;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(text)) !== null) {
      const filePath = match[1];
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);

      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        try {
          const content = fs.readFileSync(absPath, 'utf-8').substring(0, 5000);
          const suffix = content.length >= 5000 ? '\n... (truncated)' : '';
          expanded = expanded.replace(
            `@${filePath}`,
            `@${filePath}\n\`\`\`\n${content}${suffix}\n\`\`\``
          );
        } catch { /* skip unreadable */ }
      }
    }

    return expanded;
  }

  private async _runLoop(apiKey: string) {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const messages = this._buildMessages();

      this._abortController = new AbortController();

      let assistantContent = '';
      let toolCalls: ToolCall[] = [];

      try {
        const result = await this._streamRequest(apiKey, messages);
        assistantContent = result.content;
        toolCalls = result.toolCalls;
      } catch (err: unknown) {
        if ((err as Error).name === 'AbortError') {
          this._provider.postMessage({ type: 'streamEnd' });
          return;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errWithMeta = err as Error & { code?: string; dashboardUrl?: string };
        if (errWithMeta.code === 'insufficient_credits' && errWithMeta.dashboardUrl) {
          this._provider.postMessage({
            type: 'creditsError',
            text: errorMsg,
            dashboardUrl: errWithMeta.dashboardUrl,
          });
        } else {
          this._provider.postMessage({ type: 'error', text: errorMsg });
        }
        return;
      }

      const assistantMsg: Message = { role: 'assistant', content: assistantContent };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      this._history.push(assistantMsg);

      this._sendContextUpdate();

      if (toolCalls.length === 0) {
        if (assistantContent) {
          this._provider.postMessage({ type: 'streamEnd' });
        }
        this._autoSaveSession();
        return;
      }

      // Had tool calls — close text stream if it was open
      if (assistantContent) {
        this._provider.postMessage({ type: 'streamEnd' });
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        this._provider.postMessage({
          type: 'toolCall',
          id: tc.id,
          name: tc.function.name,
          args: JSON.stringify(args, null, 2),
          status: 'running...',
        });

        let result: ToolCallResult;
        try {
          if (this._mcpManager.isMcpTool(tc.function.name)) {
            const output = await this._mcpManager.callTool(tc.function.name, args);
            result = { success: true, output };
          } else {
            result = await executeTool(tc.function.name, args);
          }
        } catch (err: unknown) {
          result = { success: false, output: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }

        this._provider.postMessage({
          type: 'toolResult',
          id: tc.id,
          status: result.success ? 'done' : 'error',
          result: result.output.substring(0, 3000),
        });

        this._history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.output.substring(0, 15000),
        });
      }

      // Next iteration will stream the model's response after tool results
      // streamStart will be sent from _streamRequest when text actually arrives
    }

    this._provider.postMessage({
      type: 'error',
      text: `Dostignut limit od ${MAX_ITERATIONS} tool poziva. Pokusaj ponovo sa manjim zahtevom.`,
    });
  }

  private _buildMessages(): Message[] {
    let systemPrompt = SYSTEM_PROMPT;
    const autoCtx = this._getAutoContext();
    if (autoCtx) {
      systemPrompt += '\n\n' + autoCtx;
    }
    const contextMd = this._readContextMemory();
    if (contextMd) {
      systemPrompt += '\n\n<project_memory>\nThe following is the project memory from .vajbagent/CONTEXT.md:\n\n' + contextMd + '\n</project_memory>';
    }
    return [
      { role: 'system', content: systemPrompt },
      ...this._history,
    ];
  }

  private _readContextMemory(): string | null {
    const root = this._getWorkspaceRoot();
    if (!root) return null;
    const ctxPath = path.join(root, '.vajbagent', 'CONTEXT.md');
    try {
      if (fs.existsSync(ctxPath)) {
        const content = fs.readFileSync(ctxPath, 'utf-8').trim();
        if (content.length > 0 && content.length < 10000) {
          return content;
        }
      }
    } catch { /* ignore read errors */ }
    return null;
  }

  private async _streamRequest(
    apiKey: string,
    messages: Message[]
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const apiUrl = getApiUrl();
    const model = getModel();

    const mcpToolDefs = this._mcpManager.getToolDefinitions();
    const allTools = [...TOOL_DEFINITIONS, ...mcpToolDefs];

    const body = JSON.stringify({
      model,
      messages,
      tools: allTools,
      stream: true,
    });

    return new Promise((resolve, reject) => {
      const url = new URL(`${apiUrl}/v1/chat/completions`);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => {
              let msg = `API error ${res.statusCode}`;
              let code: string | undefined;
              let dashboardUrl: string | undefined;
              try {
                const parsed = JSON.parse(body);
                msg = parsed.error?.message || parsed.message || msg;
                code = parsed.error?.code;
                dashboardUrl = parsed.error?.dashboard_url;
              } catch { /* use default */ }
              const err = new Error(msg) as Error & { code?: string; dashboardUrl?: string };
              if (res.statusCode === 402 && code === 'insufficient_credits' && dashboardUrl) {
                err.code = code;
                err.dashboardUrl = dashboardUrl;
              }
              reject(err);
            });
            return;
          }

          let content = '';
          const toolCallsMap: Map<number, ToolCall> = new Map();
          let buffer = '';
          let streamStartSent = false;

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const data = trimmed.slice(6);
              if (data === '[DONE]') continue;

              let parsed: StreamChunk;
              try {
                parsed = JSON.parse(data);
              } catch { continue; }

              const choice = parsed.choices?.[0];
              if (!choice?.delta) continue;

              if (choice.delta.content) {
                if (!streamStartSent) {
                  this._provider.postMessage({ type: 'streamStart' });
                  streamStartSent = true;
                }
                content += choice.delta.content;
                this._provider.postMessage({
                  type: 'streamDelta',
                  text: choice.delta.content,
                });
              }

              if (choice.delta.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  if (!toolCallsMap.has(tc.index)) {
                    toolCallsMap.set(tc.index, {
                      id: tc.id || '',
                      type: 'function',
                      function: { name: '', arguments: '' },
                    });
                  }
                  const existing = toolCallsMap.get(tc.index)!;
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.function.name += tc.function.name;
                  if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                }
              }
            }
          });

          res.on('end', () => {
            const toolCalls = Array.from(toolCallsMap.values());
            resolve({ content, toolCalls });
          });

          res.on('error', reject);
        }
      );

      req.on('error', reject);

      if (this._abortController) {
        this._abortController.signal.addEventListener('abort', () => {
          req.destroy();
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      }

      req.write(body);
      req.end();
    });
  }
}
