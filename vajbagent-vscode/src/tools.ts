import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { getAutoApprove } from './settings';
import https from 'https';
import http from 'http';

export interface ToolCallResult {
  success: boolean;
  output: string;
}

export interface FileCheckpoint {
  filePath: string;
  originalContent: string;
  timestamp: number;
}

type ApprovalCallback = (accepted: boolean) => void;
let _postMessage: ((msg: unknown) => void) | null = null;
let _pendingDiffResolve: ApprovalCallback | null = null;
let _pendingCommandResolve: ApprovalCallback | null = null;
let _apiCredentials: { apiUrl: string; apiKey: string } | null = null;
const _checkpoints: Map<string, FileCheckpoint> = new Map();

let _vajbTerminal: vscode.Terminal | null = null;
let _vajbWriteEmitter: vscode.EventEmitter<string> | null = null;
let _vajbTerminalReady = false;
let _vajbWriteBuffer: string[] = [];

function _vajbWrite(text: string) {
  if (_vajbTerminalReady && _vajbWriteEmitter) {
    _vajbWriteEmitter.fire(text);
  } else {
    _vajbWriteBuffer.push(text);
  }
}

function getOrCreateTerminal(): (text: string) => void {
  if (_vajbTerminal && !_vajbTerminal.exitStatus) {
    return _vajbWrite;
  }

  _vajbTerminalReady = false;
  _vajbWriteBuffer = [];

  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number | void>();

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      _vajbTerminalReady = true;
      for (const buffered of _vajbWriteBuffer) {
        writeEmitter.fire(buffered);
      }
      _vajbWriteBuffer = [];
    },
    close: () => {
      _vajbTerminal = null;
      _vajbWriteEmitter = null;
      _vajbTerminalReady = false;
      _vajbWriteBuffer = [];
    },
  };

  _vajbTerminal = vscode.window.createTerminal({ name: 'VajbAgent', pty });
  _vajbWriteEmitter = writeEmitter;

  return _vajbWrite;
}

export function getCheckpoints(): FileCheckpoint[] {
  return Array.from(_checkpoints.values()).sort((a, b) => a.timestamp - b.timestamp);
}

export function revertCheckpoint(filePath: string): boolean {
  const cp = _checkpoints.get(filePath);
  if (!cp) return false;
  try {
    if (cp.originalContent === '') {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(filePath, cp.originalContent, 'utf-8');
    }
    _checkpoints.delete(filePath);
    return true;
  } catch { return false; }
}

export function revertAllCheckpoints(): number {
  let count = 0;
  for (const [fp] of _checkpoints) {
    if (revertCheckpoint(fp)) count++;
  }
  return count;
}

export function clearCheckpoints() {
  _checkpoints.clear();
}

function saveCheckpoint(filePath: string) {
  if (_checkpoints.has(filePath)) return;
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  _checkpoints.set(filePath, { filePath, originalContent: original, timestamp: Date.now() });
  if (_postMessage) {
    const files = Array.from(_checkpoints.keys()).map(f => {
      const parts = f.replace(/\\/g, '/').split('/');
      return { full: f, short: parts.slice(-2).join('/') };
    });
    _postMessage({ type: 'checkpointSaved', count: _checkpoints.size, files });
  }
}

export function setPostMessage(fn: (msg: unknown) => void) {
  _postMessage = fn;
}

export function setApiCredentials(apiUrl: string, apiKey: string) {
  _apiCredentials = { apiUrl, apiKey };
}

export function handleDiffResponse(accepted: boolean) {
  if (_pendingDiffResolve) {
    _pendingDiffResolve(accepted);
    _pendingDiffResolve = null;
  }
}

export function handleCommandResponse(accepted: boolean) {
  if (_pendingCommandResolve) {
    _pendingCommandResolve(accepted);
    _pendingCommandResolve = null;
  }
}

function shouldAutoApprove(toolName: string): boolean {
  const settings = getAutoApprove();
  switch (toolName) {
    case 'write_file': return settings.writeFile;
    case 'replace_in_file': return settings.replaceInFile;
    case 'execute_command': return settings.executeCommand;
    default: return false;
  }
}

function requestDiffApproval(
  toolName: string,
  filePath: string,
  oldContent: string,
  newContent: string
): Promise<boolean> {
  if (shouldAutoApprove(toolName)) {
    if (_postMessage) {
      _postMessage({
        type: 'autoApproved',
        filePath: path.basename(filePath),
        toolName,
      });
    }
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    _pendingDiffResolve = resolve;
    if (_postMessage) {
      _postMessage({
        type: 'diffPreview',
        filePath: path.basename(filePath),
        fullPath: filePath,
        oldContent,
        newContent,
      });
    } else {
      resolve(true);
    }
  });
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          start_line: { type: 'integer', description: 'Start line (1-based, optional)' },
          end_line: { type: 'integer', description: 'End line (1-based, optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file. User will see a diff preview and must approve.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          content: { type: 'string', description: 'The full file content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'replace_in_file',
      description: 'Replace a specific section of a file. User will see a diff preview and must approve.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          old_text: { type: 'string', description: 'The exact text to find and replace' },
          new_text: { type: 'string', description: 'The replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List files and directories. Respects .gitignore.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
          recursive: { type: 'boolean', description: 'List recursively (default true)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for a regex pattern across files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search in' },
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          file_glob: { type: 'string', description: 'Optional glob to filter files (e.g. "*.ts")' },
        },
        required: ['path', 'pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_command',
      description: 'Execute a shell command in the workspace. Returns stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description: 'Fetch content from a URL. Returns the response body as text (HTML, JSON, etc). Useful for reading documentation, APIs, or web pages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default GET)', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs' },
          body: { type: 'string', description: 'Optional request body (for POST/PUT)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the internet for current information. Use for latest docs, library versions, error messages, APIs, news, or anything that may have changed after your training. Returns a summary answer and top search results with URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: { type: 'integer', description: 'Max number of results (1-10, default 5)' },
        },
        required: ['query'],
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  switch (name) {
    case 'read_file':
      return toolReadFile(args);
    case 'write_file':
      return toolWriteFile(args);
    case 'replace_in_file':
      return toolReplaceInFile(args);
    case 'list_files':
      return toolListFiles(args);
    case 'search_files':
      return toolSearchFiles(args);
    case 'execute_command':
      return toolExecuteCommand(args);
    case 'fetch_url':
      return toolFetchUrl(args);
    case 'web_search':
      return toolWebSearch(args);
    default:
      return { success: false, output: `Unknown tool: ${name}` };
  }
}

async function getFileDiagnostics(filePath: string): Promise<string> {
  const uri = vscode.Uri.file(filePath);
  await new Promise(r => setTimeout(r, 600));
  const diags = vscode.languages.getDiagnostics(uri);
  const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
  if (errors.length === 0) return '';
  const lines = errors.slice(0, 8).map(d => `  Line ${d.range.start.line + 1}: ${d.message}`);
  return `\n⚠ ${errors.length} error(s) detected after writing:\n${lines.join('\n')}`;
}

function resolveWorkspacePath(filePath: string): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return path.isAbsolute(filePath) ? filePath : filePath;
  }
  const root = folders[0].uri.fsPath;
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const normalized = path.resolve(resolved);
  if (!normalized.startsWith(root + path.sep) && normalized !== root) {
    throw new Error(`Access denied: path "${filePath}" is outside the workspace.`);
  }
  return normalized;
}

// ── read_file ──
async function toolReadFile(args: Record<string, unknown>): Promise<ToolCallResult> {
  const filePath = resolveWorkspacePath(args.path as string);
  const startLine = args.start_line as number | undefined;
  const endLine = args.end_line as number | undefined;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    let lines = content.split('\n');

    const start = Math.max(1, startLine || 1);
    const end = Math.min(lines.length, endLine || lines.length);
    lines = lines.slice(start - 1, end);

    const numbered = lines.map((line, i) => `${start + i}|${line}`).join('\n');
    return { success: true, output: numbered };
  } catch (err: unknown) {
    return { success: false, output: `Error reading ${filePath}: ${(err as Error).message}` };
  }
}

// ── write_file (inline diff preview) ──
async function toolWriteFile(args: Record<string, unknown>): Promise<ToolCallResult> {
  const filePath = resolveWorkspacePath(args.path as string);
  const newContent = args.content as string;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const oldContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    const accepted = await requestDiffApproval('write_file', filePath, oldContent, newContent);

    if (accepted) {
      saveCheckpoint(filePath);
      fs.writeFileSync(filePath, newContent, 'utf-8');
      const diag = await getFileDiagnostics(filePath);
      return { success: true, output: `File written: ${filePath}${diag}` };
    } else {
      return { success: false, output: 'User rejected the change.' };
    }
  } catch (err: unknown) {
    return { success: false, output: `Error writing ${filePath}: ${(err as Error).message}` };
  }
}

// ── replace_in_file (inline diff preview) ──
async function toolReplaceInFile(args: Record<string, unknown>): Promise<ToolCallResult> {
  const filePath = resolveWorkspacePath(args.path as string);
  const oldText = args.old_text as string;
  const newText = args.new_text as string;

  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldText)) {
      return { success: false, output: `Text not found in ${filePath}. Make sure old_text matches exactly.` };
    }

    const newContent = content.replace(oldText, newText);
    const accepted = await requestDiffApproval('replace_in_file', filePath, content, newContent);

    if (accepted) {
      saveCheckpoint(filePath);
      fs.writeFileSync(filePath, newContent, 'utf-8');
      const diag = await getFileDiagnostics(filePath);
      return { success: true, output: `File updated: ${filePath}${diag}` };
    } else {
      return { success: false, output: 'User rejected the change.' };
    }
  } catch (err: unknown) {
    return { success: false, output: `Error editing ${filePath}: ${(err as Error).message}` };
  }
}

// ── list_files ──
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.vscode', '__pycache__', '.next',
  'dist', 'build', '.cache', 'coverage', '.turbo',
]);

async function toolListFiles(args: Record<string, unknown>): Promise<ToolCallResult> {
  const dirPath = resolveWorkspacePath(args.path as string);
  const recursive = args.recursive !== false;

  try {
    if (!fs.existsSync(dirPath)) {
      return { success: false, output: `Directory not found: ${dirPath}` };
    }

    const results: string[] = [];
    const maxFiles = 500;

    function walk(dir: string, depth: number) {
      if (results.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxFiles) return;
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

        const rel = path.relative(dirPath, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          results.push(rel + '/');
          if (recursive && depth < 10) walk(path.join(dir, entry.name), depth + 1);
        } else {
          results.push(rel);
        }
      }
    }

    walk(dirPath, 0);

    if (results.length === 0) {
      return { success: true, output: '(empty directory)' };
    }
    const suffix = results.length >= maxFiles ? `\n... (truncated at ${maxFiles} entries)` : '';
    return { success: true, output: results.join('\n') + suffix };
  } catch (err: unknown) {
    return { success: false, output: `Error listing ${dirPath}: ${(err as Error).message}` };
  }
}

// ── search_files ──
async function toolSearchFiles(args: Record<string, unknown>): Promise<ToolCallResult> {
  const dirPath = resolveWorkspacePath(args.path as string);
  const pattern = args.pattern as string;
  const fileGlob = args.file_glob as string | undefined;

  try {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch {
      return { success: false, output: `Invalid regex: ${pattern}` };
    }

    if (!fs.existsSync(dirPath)) {
      return { success: false, output: `Directory not found: ${dirPath}` };
    }

    const results: string[] = [];
    const maxResults = 100;

    function searchDir(dir: string) {
      if (results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (IGNORE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;

        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          searchDir(full);
        } else {
          if (fileGlob) {
            const globRegex = new RegExp('^' + fileGlob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            if (!globRegex.test(entry.name)) continue;
          }

          try {
            const content = fs.readFileSync(full, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0;
              if (regex.test(lines[i])) {
                const rel = path.relative(dirPath, full);
                results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= maxResults) return;
              }
            }
          } catch {
            // skip binary or unreadable files
          }
        }
      }
    }

    searchDir(dirPath);

    if (results.length === 0) {
      return { success: true, output: `No matches found for pattern: ${pattern}` };
    }
    const suffix = results.length >= maxResults ? `\n... (truncated at ${maxResults} results)` : '';
    return { success: true, output: results.join('\n') + suffix };
  } catch (err: unknown) {
    return { success: false, output: `Error searching: ${(err as Error).message}` };
  }
}

// ── execute_command ──
function requestCommandApproval(command: string): Promise<boolean> {
  if (shouldAutoApprove('execute_command')) {
    if (_postMessage) {
      _postMessage({ type: 'autoApproved', filePath: command, toolName: 'execute_command' });
    }
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    _pendingCommandResolve = resolve;
    if (_postMessage) {
      _postMessage({ type: 'commandPreview', command });
    } else {
      resolve(true);
    }
  });
}

let _lastCommandOutput = '';
export function getLastCommandOutput(): string { return _lastCommandOutput; }

async function toolExecuteCommand(args: Record<string, unknown>): Promise<ToolCallResult> {
  const command = args.command as string;
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath || process.cwd();

  const accepted = await requestCommandApproval(command);
  if (!accepted) {
    return { success: false, output: 'User rejected the command.' };
  }

  const isLikelyServer = /\b(node|nodemon|npm\s+start|npm\s+run\s+(dev|start|serve)|python.*app|flask|uvicorn|php\s+-S|ruby.*server|cargo\s+run)\b/i.test(command);
  const SERVER_READY_TIMEOUT = 8000;
  const NORMAL_TIMEOUT = 120000;

  const termWrite = getOrCreateTerminal();
  _vajbTerminal?.show(false);
  termWrite(`\r\n\x1b[90m${'─'.repeat(50)}\x1b[0m\r\n`);
  termWrite(`\x1b[1;33m❯ ${command}\x1b[0m\r\n`);
  termWrite(`\x1b[90m${cwd}\x1b[0m\r\n\r\n`);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;

    const proc = exec(command, { cwd, timeout: NORMAL_TIMEOUT, maxBuffer: 2 * 1024 * 1024 });

    const finishEarly = (msg: string) => {
      if (done) return;
      done = true;
      _lastCommandOutput = msg.substring(0, 5000);
      termWrite(`\r\n\x1b[1;32m[Server running in background]\x1b[0m\r\n`);
      resolve({ success: true, output: msg });
    };

    const serverPatterns = /listening|server.*running|started.*on|http:\/\/localhost|ready on|serving|0\.0\.0\.0:|127\.0\.0\.1:/i;

    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      termWrite(chunk.replace(/\r?\n/g, '\r\n'));
      if (isLikelyServer && serverPatterns.test(stdout)) {
        finishEarly(`stdout:\n${stdout.trim()}\n\n(Server is running — command continues in background)`);
      }
    });

    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      termWrite(`\x1b[31m${chunk.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
      if (isLikelyServer && serverPatterns.test(stderr)) {
        finishEarly(`stderr:\n${stderr.trim()}\n\n(Server is running — command continues in background)`);
      }
    });

    if (isLikelyServer) {
      setTimeout(() => {
        if (!done) {
          const parts: string[] = [];
          if (stdout) parts.push(`stdout:\n${stdout.trim()}`);
          if (stderr) parts.push(`stderr:\n${stderr.trim()}`);
          parts.push('(Server process started — running in background)');
          finishEarly(parts.join('\n'));
        }
      }, SERVER_READY_TIMEOUT);
    }

    proc.on('close', (code) => {
      if (done) return;
      done = true;
      const parts: string[] = [];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      if (code !== 0 && code !== null) parts.push(`exit code: ${code}`);
      const output = parts.length > 0 ? parts.join('\n') : '(no output)';
      const failed = code !== 0 && code !== null;

      _lastCommandOutput = output.substring(0, 5000);

      termWrite(`\r\n\x1b[1;${failed ? '31' : '32'}m[Exit: ${code ?? 0}]\x1b[0m\r\n`);

      if (failed && _postMessage) {
        _postMessage({ type: 'terminalError', command, output: output.substring(0, 2000) });
      }

      resolve({ success: !failed, output });
    });

    proc.on('error', (err) => {
      if (done) return;
      done = true;
      const output = `Error: ${err.message}`;
      _lastCommandOutput = output;
      termWrite(`\r\n\x1b[1;31m${err.message}\x1b[0m\r\n`);
      resolve({ success: false, output });
    });
  });
}

// ── fetch_url ──
async function toolFetchUrl(args: Record<string, unknown>, redirectCount = 0): Promise<ToolCallResult> {
  const url = args.url as string;
  const method = (args.method as string) || 'GET';
  const customHeaders = (args.headers as Record<string, string>) || {};
  const body = args.body as string | undefined;

  if (redirectCount > 5) {
    return { success: false, output: 'Too many redirects (>5)' };
  }

  try {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? await import('https') : await import('http');

    return new Promise((resolve) => {
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          'User-Agent': 'VajbAgent/1.0',
          'Accept': 'text/html,application/json,text/plain,*/*',
          ...customHeaders,
        },
        timeout: 15000,
      };

      const req = transport.request(options, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const newUrl = new URL(res.headers.location, url).href;
          res.resume();
          resolve(toolFetchUrl({ ...args, url: newUrl }, redirectCount + 1));
          return;
        }

        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          const maxLen = 30000;
          const truncated = data.length > maxLen ? data.substring(0, maxLen) + '\n... (truncated)' : data;
          resolve({
            success: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400,
            output: `HTTP ${res.statusCode}\n\n${truncated}`,
          });
        });
      });

      req.on('error', (err: Error) => {
        resolve({ success: false, output: `Fetch error: ${err.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, output: 'Request timed out after 15s' });
      });

      if (body && (method === 'POST' || method === 'PUT')) {
        req.write(body);
      }
      req.end();
    });
  } catch (err: unknown) {
    return { success: false, output: `Invalid URL or fetch error: ${(err as Error).message}` };
  }
}

// ── web_search ──
async function toolWebSearch(args: Record<string, unknown>): Promise<ToolCallResult> {
  const query = args.query as string;
  const maxResults = args.max_results as number | undefined;

  if (!query || query.trim().length < 2) {
    return { success: false, output: 'Search query is required (min 2 characters).' };
  }

  if (!_apiCredentials) {
    return { success: false, output: 'API credentials not configured for web search.' };
  }

  const { apiUrl, apiKey } = _apiCredentials;

  try {
    const body = JSON.stringify({
      query: query.trim(),
      max_results: maxResults || 5,
      include_answer: true,
    });

    const url = new URL(`${apiUrl}/v1/web-search`);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const result = await new Promise<string>((resolve, reject) => {
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
          timeout: 20000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              try {
                const err = JSON.parse(data);
                reject(new Error(err.error?.message || `HTTP ${res.statusCode}`));
              } catch {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
              return;
            }
            resolve(data);
          });
        }
      );

      req.on('error', (err: Error) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Search request timed out')); });
      req.write(body);
      req.end();
    });

    const parsed = JSON.parse(result);
    const lines: string[] = [];

    lines.push(`Search: "${parsed.query}"`);
    lines.push('');

    if (parsed.answer) {
      lines.push('## Answer');
      lines.push(parsed.answer);
      lines.push('');
    }

    if (parsed.results && parsed.results.length > 0) {
      lines.push(`## Results (${parsed.results.length})`);
      lines.push('');
      for (const r of parsed.results) {
        lines.push(`### ${r.title}`);
        lines.push(`URL: ${r.url}`);
        if (r.content) {
          lines.push(r.content);
        }
        lines.push('');
      }
    }

    return { success: true, output: lines.join('\n') };
  } catch (err: unknown) {
    return { success: false, output: `Web search error: ${(err as Error).message}` };
  }
}
