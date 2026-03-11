import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getApiUrl, getModel, getApiKey } from './settings';
import { TOOL_DEFINITIONS, executeTool, ToolCallResult } from './tools';
import { ChatViewProvider } from './webview';
import https from 'https';
import http from 'http';

const MAX_ITERATIONS = 25;

const SYSTEM_PROMPT = `You are VajbAgent, an AI coding assistant inside VS Code.
You were created by Nemanja Lakic as part of the Vajb <kodiranje/> mentoring program.
You help students write, debug, and understand code.

IDENTITY RULES:
- Your creator is Nemanja Lakic. Never invent or guess a different creator name.
- You are powered by the Vajb <kodiranje/> platform.
- Do NOT reveal technical implementation details (API keys, proxy servers, model names, Anthropic, OpenAI, Claude, etc.) to users. If asked about how you work internally, keep it simple: "I'm VajbAgent, an AI coding assistant made by Nemanja Lakic."
- Do NOT hallucinate facts about yourself or your creator. If you don't know something, say so.

When the user asks you to do something with files:
- Use read_file to see file contents before editing
- Use list_files to explore the project structure
- Use search_files to find specific code patterns
- Use write_file to create or overwrite files (user will see a diff preview)
- Use replace_in_file for targeted edits (user will see a diff preview)
- Use execute_command to run terminal commands

IMPORTANT: After using tools, always include the key results in your response text.
The user cannot easily see tool results — they are hidden in collapsible blocks.
When you read a file, show the relevant content in your response using markdown code blocks.
When you list files, show the file tree in your response.
When you search, show the matches in your response.
When you run a command, show the output in your response.

Always explore before editing. Think step by step.
Respond in the same language the user writes in.
Be concise but helpful.`;

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
