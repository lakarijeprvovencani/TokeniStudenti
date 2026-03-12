import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverName: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT = 60000;

let _outputChannel: vscode.OutputChannel | null = null;
function log(msg: string) {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('VajbAgent MCP');
  }
  const ts = new Date().toISOString().substring(11, 23);
  _outputChannel.appendLine(`[${ts}] ${msg}`);
  console.log(msg);
}

class McpConnection {
  private _process: ChildProcess | null = null;
  private _nextId = 1;
  private _pending = new Map<number, PendingRequest>();
  private _buffer = '';
  private _tools: McpTool[] = [];
  private _ready = false;
  private _serverName: string;
  private _config: McpServerConfig;

  constructor(serverName: string, config: McpServerConfig) {
    this._serverName = serverName;
    this._config = config;
  }

  get name() { return this._serverName; }
  get tools() { return this._tools; }
  get ready() { return this._ready; }

  async start(): Promise<void> {
    if (this._process) return;

    const env = {
      ...process.env,
      ...(this._config.env || {}),
    };

    this._process = spawn(this._config.command, this._config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: process.platform === 'win32',
    });

    log(`[MCP ${this._serverName}] spawning: ${this._config.command} ${(this._config.args || []).join(' ')}`);

    this._process.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      log(`[MCP ${this._serverName}] stdout: ${str.substring(0, 300)}`);
      this._onData(str);
    });

    this._process.stderr?.on('data', (chunk: Buffer) => {
      log(`[MCP ${this._serverName}] stderr: ${chunk.toString().trim()}`);
    });

    this._process.on('error', (err) => {
      log(`[MCP ${this._serverName}] process error: ${err.message}`);
      this._cleanup();
    });

    this._process.on('exit', (code) => {
      log(`[MCP ${this._serverName}] exited with code ${code}`);
      this._cleanup();
    });

    try {
      await this._initialize();
      await this._discoverTools();
      this._ready = true;
      log(`[MCP ${this._serverName}] ready, ${this._tools.length} tools`);
    } catch (err) {
      log(`[MCP ${this._serverName}] init failed: ${(err as Error).message}`);
      this.stop();
      throw err;
    }
  }

  stop() {
    if (this._process) {
      try { this._process.kill(); } catch { /* already dead */ }
      this._process = null;
    }
    this._cleanup();
  }

  private _cleanup() {
    this._ready = false;
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this._pending.clear();
  }

  private _onData(data: string) {
    this._buffer += data;

    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id != null && this._pending.has(msg.id)) {
          const pending = this._pending.get(msg.id)!;
          this._pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // not JSON or notification, ignore
      }
    }
  }

  private _send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this._process?.stdin?.writable) {
        return reject(new Error('MCP process not running'));
      }

      const id = this._nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined && { params }),
      };

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT);

      this._pending.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(request) + '\n';
      this._process.stdin.write(payload);
    });
  }

  private _notify(method: string, params?: Record<string, unknown>): void {
    if (!this._process?.stdin?.writable) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    };

    this._process.stdin.write(JSON.stringify(notification) + '\n');
  }

  private async _initialize(): Promise<void> {
    await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vajbagent', version: '0.3.0' },
    });

    this._notify('notifications/initialized');
  }

  private async _discoverTools(): Promise<void> {
    const result = await this._send('tools/list') as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    this._tools = (result?.tools || []).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverName: this._serverName,
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this._ready) throw new Error(`MCP server "${this._serverName}" is not ready`);

    const result = await this._send('tools/call', {
      name: toolName,
      arguments: args,
    }) as { content?: Array<{ type: string; text?: string }> };

    if (!result?.content) return '(empty result)';

    return result.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n') || '(empty result)';
  }
}

export class McpManager {
  private _connections = new Map<string, McpConnection>();
  private _onChanged: (() => void) | null = null;

  onToolsChanged(cb: () => void) {
    this._onChanged = cb;
  }

  async startServer(name: string, config: McpServerConfig): Promise<void> {
    if (this._connections.has(name)) {
      this._connections.get(name)!.stop();
    }

    const conn = new McpConnection(name, config);
    this._connections.set(name, conn);

    try {
      await conn.start();
      this._onChanged?.();
    } catch (err) {
      this._connections.delete(name);
      throw err;
    }
  }

  stopServer(name: string) {
    const conn = this._connections.get(name);
    if (conn) {
      conn.stop();
      this._connections.delete(name);
      this._onChanged?.();
    }
  }

  stopAll() {
    for (const [, conn] of this._connections) {
      conn.stop();
    }
    this._connections.clear();
  }

  getAllTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const [, conn] of this._connections) {
      if (conn.ready) {
        tools.push(...conn.tools);
      }
    }
    return tools;
  }

  getToolDefinitions(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.getAllTools().map(t => ({
      type: 'function' as const,
      function: {
        name: `mcp_${t.serverName}_${t.name}`,
        description: `[MCP: ${t.serverName}] ${t.description || t.name}`,
        parameters: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      },
    }));
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const match = prefixedName.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) throw new Error(`Invalid MCP tool name: ${prefixedName}`);

    const [, serverName, toolName] = match;
    const conn = this._connections.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" not found`);

    return conn.callTool(toolName, args);
  }

  isMcpTool(name: string): boolean {
    return name.startsWith('mcp_');
  }

  private _errors = new Map<string, string>();

  getStatus(): Array<{ name: string; ready: boolean; toolCount: number; error?: string }> {
    const status: Array<{ name: string; ready: boolean; toolCount: number; error?: string }> = [];
    for (const [name, conn] of this._connections) {
      status.push({ name, ready: conn.ready, toolCount: conn.tools.length });
    }
    for (const [name, error] of this._errors) {
      if (!this._connections.has(name)) {
        status.push({ name, ready: false, toolCount: 0, error });
      }
    }
    return status;
  }

  async startFromConfig(): Promise<void> {
    const { servers, parseError } = McpManager.readConfigFile();
    this._errors.clear();

    if (parseError) {
      log(`[MCP] Config parse error: ${parseError}`);
      this._errors.set('_config', `mcp.json greska: ${parseError}`);
      this._onChanged?.();
      return;
    }

    if (Object.keys(servers).length === 0) {
      log('[MCP] No servers configured in mcp.json');
    }

    for (const [name, serverConfig] of Object.entries(servers)) {
      if (serverConfig.disabled) {
        log(`[MCP] Skipping disabled server: ${name}`);
        continue;
      }
      if (!serverConfig.command) {
        log(`[MCP] Skipping server with no command: ${name}`);
        continue;
      }

      try {
        await this.startServer(name, serverConfig);
      } catch (err) {
        const msg = (err as Error).message;
        log(`[MCP] Failed to start "${name}": ${msg}`);
        this._errors.set(name, msg);
      }
    }

    this._onChanged?.();
  }

  static getConfigPath(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    return path.join(root, '.vajbagent', 'mcp.json');
  }

  static readConfigFile(): { servers: Record<string, McpServerConfig>; parseError?: string } {
    const configPath = McpManager.getConfigPath();
    if (!configPath || !fs.existsSync(configPath)) return { servers: {} };

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.mcpServers) {
        return { servers: parsed.mcpServers as Record<string, McpServerConfig> };
      }
      return { servers: parsed as Record<string, McpServerConfig> };
    } catch (err) {
      const msg = (err as Error).message;
      log(`[MCP] Failed to parse mcp.json: ${msg}`);
      return { servers: {}, parseError: msg };
    }
  }

  static createConfigTemplate(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;

    const dir = path.join(root, '.vajbagent');
    const configPath = path.join(dir, 'mcp.json');

    if (fs.existsSync(configPath)) return configPath;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const template = {
      mcpServers: {
        "example-filesystem": {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"],
          disabled: true
        }
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(template, null, 2), 'utf-8');
    return configPath;
  }
}
