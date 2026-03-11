import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getApiUrl, getModel, getApiKey } from './settings';
import { TOOL_DEFINITIONS, executeTool, ToolCallResult } from './tools';
import { ChatViewProvider } from './webview';
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
- Web info: fetch_url
</tool_usage>

<making_code_changes>
When writing or editing code:

1. Code MUST be immediately runnable. Include all necessary imports, dependencies, and setup.
2. Do NOT generate placeholder code like "// TODO: implement this". Write the actual implementation.
3. Match the existing code style of the project (indentation, naming conventions, patterns).
4. When creating new files, follow the project's existing structure and conventions.
5. NEVER output extremely long strings, hashes, or binary content.
6. After making changes, briefly explain WHAT you changed and WHY.
7. If you introduce errors, fix them immediately.
</making_code_changes>

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
- If a library/API has changed since your training, use fetch_url to check current docs.
- When suggesting dependencies or packages, verify they exist and check version compatibility.
- NEVER invent file paths, function names, API endpoints, or configuration options.
- If you cannot determine something from the available tools, tell the user honestly.
</anti_hallucination>

<security>
- NEVER expose or log API keys, secrets, passwords, or tokens.
- NEVER hardcode credentials in source code.
- When you see .env files, warn the user not to commit them.
- Suggest .gitignore entries for sensitive files when relevant.
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
  private _abortController: AbortController | null = null;
  private _currentSessionId: string | null = null;

  constructor(provider: ChatViewProvider, context: vscode.ExtensionContext) {
    this._provider = provider;
    this._context = context;
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
      'vajb-agent-lite': 128000,
      'vajb-agent-turbo': 128000,
      'vajb-agent-pro': 128000,
      'vajb-agent-max': 200000,
      'vajb-agent-power': 128000,
      'vajb-agent-ultra': 200000,
      'vajb-agent-architect': 200000,
    };
    return limits[model] || 128000;
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
        this._provider.postMessage({ type: 'error', text: errorMsg });
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
          result = await executeTool(tc.function.name, args);
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
    return [
      { role: 'system', content: systemPrompt },
      ...this._history,
    ];
  }

  private async _streamRequest(
    apiKey: string,
    messages: Message[]
  ): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const apiUrl = getApiUrl();
    const model = getModel();

    const body = JSON.stringify({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
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
              try {
                const parsed = JSON.parse(body);
                msg = parsed.error?.message || parsed.message || msg;
              } catch { /* use default */ }
              reject(new Error(msg));
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
