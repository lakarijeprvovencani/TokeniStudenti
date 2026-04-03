import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile, execSync } from 'child_process';
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
const _redoData: Map<string, string> = new Map(); // stores agent's version after undo

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
    // Save current (agent's) content for redo before reverting
    if (fs.existsSync(filePath)) {
      _redoData.set(filePath, fs.readFileSync(filePath, 'utf-8'));
    } else {
      _redoData.set(filePath, '');
    }
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

export function redoAllCheckpoints(): number {
  let count = 0;
  for (const [filePath, content] of _redoData) {
    try {
      if (content === '') {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
      }
      count++;
    } catch { /* skip */ }
  }
  _redoData.clear();
  return count;
}

export function hasRedoData(): boolean {
  return _redoData.size > 0;
}

export function clearRedoData() {
  _redoData.clear();
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
        type: 'autoApprovedDiff',
        filePath: path.basename(filePath),
        fullPath: filePath,
        toolName,
        oldContent,
        newContent,
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
      description: 'Create or overwrite a file. REPLACES the entire file — content must be COMPLETE (every line, every function). Never use placeholder comments like "// rest of code" — they delete real code. User sees diff preview.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          content: { type: 'string', description: 'The COMPLETE file content. Must contain every line — omitted code is permanently deleted.' },
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
      description: 'Execute a shell command in the workspace. Returns stdout and stderr. Use this to run code, start servers, install packages, check logs (tail, cat), run tests, and verify changes.',
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
  {
    type: 'function' as const,
    function: {
      name: 'download_file',
      description: 'Download a binary file (image, PDF, font, etc.) from a URL and save it to disk. Verifies the download is valid — checks file size, MIME type, and detects error pages. ALWAYS use this instead of execute_command+curl for downloading files. Returns honest success/failure with file size and type.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Direct URL to the file to download' },
          path: { type: 'string', description: 'Workspace-relative or absolute path to save the file' },
          expected_type: {
            type: 'string',
            description: 'Expected file type prefix for verification',
            enum: ['image', 'application/pdf', 'font', 'any'],
          },
        },
        required: ['url', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_images',
      description: 'Search Unsplash for high-quality, free-to-use stock images. Returns direct image URLs with photographer credits. Use this when the user needs topic-specific images for websites, apps, or designs (e.g. dental clinic, restaurant, fitness, real estate). Then use download_file to save each image locally.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query in English (e.g. "dental clinic smiling woman", "modern restaurant interior", "fitness gym workout")' },
          count: { type: 'integer', description: 'Number of images to return (1-10, default 5)' },
          orientation: { type: 'string', description: 'Image orientation', enum: ['landscape', 'portrait', 'squarish'] },
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
    case 'download_file':
      return toolDownloadFile(args);
    case 'search_images':
      return toolSearchImages(args);
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
    throw new Error('Nema otvorenog foldera u VS Code-u. Otvori folder (File → Open Folder) pa probaj ponovo.');
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
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

async function toolReadFile(args: Record<string, unknown>): Promise<ToolCallResult> {
  const filePath = resolveWorkspacePath(args.path as string);
  const startLine = args.start_line as number | undefined;
  const endLine = args.end_line as number | undefined;
  const ext = path.extname(filePath).toLowerCase();

  try {
    // Image files: return as base64 for visual inspection
    if (IMAGE_EXTS.has(ext) && !startLine && !endLine) {
      const buf = fs.readFileSync(filePath);
      const sizeKB = Math.round(buf.length / 1024);
      if (sizeKB > 2048) {
        return { success: true, output: `Image file: ${path.basename(filePath)} (${sizeKB}KB) — too large to display inline. File exists at: ${filePath}` };
      }
      const base64 = buf.toString('base64');
      const mime = IMAGE_MIME[ext] || 'image/png';
      const result: ToolCallResult & { imageData?: { mime: string; base64: string } } = {
        success: true,
        output: `Image file: ${path.basename(filePath)} (${sizeKB}KB). Visual content attached below.`,
      };
      result.imageData = { mime, base64 };
      return result;
    }

    const stat = fs.statSync(filePath);
    if (stat.size > 5 * 1024 * 1024) {
      return { success: false, output: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.` };
    }

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
  if (!args.path || typeof args.path !== 'string') {
    return { success: false, output: 'Error: write_file requires a "path" parameter (string). The model sent empty or missing arguments — this usually means the file content was too large for a single tool call. Try writing the file in smaller parts or use execute_command with heredoc.' };
  }
  const filePath = resolveWorkspacePath(args.path as string);
  const newContent = (args.content as string) ?? '';

  if (typeof newContent !== 'string') {
    return { success: false, output: 'Error: content must be a string.' };
  }

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
  if (!args.path || typeof args.path !== 'string') {
    return { success: false, output: 'Error: replace_in_file requires a "path" parameter (string). The model sent empty or missing arguments.' };
  }
  const filePath = resolveWorkspacePath(args.path as string);
  const oldText = args.old_text as string;
  const newText = args.new_text as string;

  if (!oldText || typeof oldText !== 'string') {
    return { success: false, output: 'Error: old_text is required and must be a non-empty string.' };
  }
  if (typeof newText !== 'string') {
    return { success: false, output: 'Error: new_text must be a string.' };
  }
  if (oldText === newText) {
    return { success: true, output: 'No changes needed: old_text and new_text are identical.' };
  }

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
        const VISIBLE_DOTFILES = new Set(['.env.example', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc', '.prettierrc.js', '.prettierrc.json', '.babelrc', '.editorconfig', '.dockerignore', '.gitignore', '.npmrc', '.nvmrc', '.github', '.vscode']);
        if (entry.name.startsWith('.') && !VISIBLE_DOTFILES.has(entry.name)) continue;

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
  if (!args.command || typeof args.command !== 'string') {
    return { success: false, output: 'Error: execute_command requires a "command" parameter (string). The model sent empty or missing arguments.' };
  }
  const command = args.command as string;
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath || process.cwd();

  const accepted = await requestCommandApproval(command);
  if (!accepted) {
    return { success: false, output: 'User rejected the command.' };
  }

  const isLikelyServer = /\b(node|nodemon|npm\s+start|npm\s+run\s+(dev|start|serve)|npx\s+(vite|next|nuxt|remix|astro|serve)|vite\b|next\s+dev|python.*http\.server|python.*app|flask|uvicorn|php\s+-S|ruby.*server|cargo\s+run)\b/i.test(command);
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

    const proc = exec(command, { cwd, timeout: NORMAL_TIMEOUT, maxBuffer: 10 * 1024 * 1024 });

    const finishEarly = (msg: string) => {
      if (done) return;
      done = true;
      _lastCommandOutput = msg.substring(0, 5000);
      termWrite(`\r\n\x1b[1;32m[Server running in background]\x1b[0m\r\n`);
      if (_postMessage) {
        const lastLines = msg.trim().split('\n').slice(-6).join('\n');
        _postMessage({ type: 'commandDone', command, exitCode: 0, failed: false, output: lastLines.substring(0, 1000) });
      }
      resolve({ success: true, output: msg });
    };

    const serverPatterns = /listening|server.*running|started.*on|http:\/\/localhost|ready on|serving!?|0\.0\.0\.0:|127\.0\.0\.1:|Serving\s+HTTP/i;

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

      if (_postMessage) {
        const lastLines = (stdout || stderr || '').trim().split('\n').slice(-8).join('\n');
        _postMessage({ type: 'commandDone', command, exitCode: code ?? 0, failed, output: lastLines.substring(0, 1000) });
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
    if (!['https:', 'http:'].includes(urlObj.protocol)) {
      return { success: false, output: 'Only HTTP/HTTPS URLs are allowed.' };
    }
    // Block private/internal network requests (SSRF protection)
    const hostname = urlObj.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
        hostname === '0.0.0.0' || hostname.endsWith('.local') ||
        hostname === '169.254.169.254' || hostname === 'metadata.google.internal' ||
        /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) {
      return { success: false, output: 'Access to private/internal network addresses is not allowed.' };
    }
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? await import('https') : await import('http');

    return new Promise((resolve) => {
      const options: Record<string, unknown> = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          'User-Agent': 'VajbAgent/1.0',
          'Accept': 'text/html,application/json,text/plain,*/*',
          ...customHeaders,
        },
      };
      // TLS certificate verification stays enabled for security

      const req = transport.request(options, (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const newUrl = new URL(res.headers.location, url).href;
          res.resume();
          resolve(toolFetchUrl({ ...args, url: newUrl }, redirectCount + 1));
          return;
        }

        let data = '';
        const MAX_RESPONSE = 500000; // 500KB safety limit
        res.on('data', (chunk: Buffer) => {
          if (data.length < MAX_RESPONSE) data += chunk.toString();
        });
        res.on('end', () => {
          const maxLen = 30000;
          const truncated = data.length > maxLen ? data.substring(0, maxLen) + '\n... (truncated)' : data;
          resolve({
            success: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400,
            output: `HTTP ${res.statusCode}\n\n${truncated}`,
          });
        });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ success: false, output: 'Request timed out after 15s' });
      });

      req.on('error', (err: Error) => {
        resolve({ success: false, output: `Fetch error: ${err.message}` });
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

    const output = lines.join('\n');
    const maxOutput = 5000;
    return { success: true, output: output.length > maxOutput ? output.substring(0, maxOutput) + '\n... (truncated)' : output };
  } catch (err: unknown) {
    return { success: false, output: `Web search error: ${(err as Error).message}` };
  }
}

// ── download_file ──
async function toolDownloadFile(args: Record<string, unknown>): Promise<ToolCallResult> {
  const url = args.url as string;
  const filePath = resolveWorkspacePath(args.path as string);
  const expectedType = (args.expected_type as string) || 'any';

  if (!url || !url.startsWith('http')) {
    return { success: false, output: 'Invalid URL. Must start with http:// or https://' };
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(filePath)) {
    saveCheckpoint(filePath);
  }

  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-L', '-f', '-s', '-A', 'Mozilla/5.0 VajbAgent/1.0', '-o', filePath,
       '--connect-timeout', '10', '--max-time', '30', '--max-redirs', '5', url],
      { timeout: 35000 },
      (error) => {
        if (error) {
          if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch { /* */ }
          }
          const hint = /exit code: 22/i.test(error.message) || error.message.includes('22')
            ? ' (HTTP 4xx/5xx — the URL returned an error)'
            : '';
          resolve({
            success: false,
            output: `Download FAILED from: ${url}\nError: ${error.message}${hint}\nThe URL may be invalid, the service may be down, or the file does not exist.`,
          });
          return;
        }

        if (!fs.existsSync(filePath)) {
          resolve({ success: false, output: `Download FAILED: file was not created.\nURL: ${url}` });
          return;
        }

        const stats = fs.statSync(filePath);
        const sizeKB = (stats.size / 1024).toFixed(1);

        if (stats.size < 1024) {
          try {
            const head = fs.readFileSync(filePath, 'utf-8').substring(0, 500);
            if (/<html|<!doctype|application error|404|403|error/i.test(head)) {
              fs.unlinkSync(filePath);
              resolve({
                success: false,
                output: `Download FAILED: URL returned an HTML error page (${stats.size} bytes) instead of a real file.\nURL: ${url}\nContent: ${head.substring(0, 200)}\nThis means the URL is wrong or the service is down.`,
              });
              return;
            }
          } catch { /* binary file under 1KB — unusual but possible */ }
        }

        let mimeType = 'unknown';
        try {
          mimeType = require('child_process').execFileSync('file', ['--mime-type', '-b', filePath], { timeout: 5000, encoding: 'utf-8' }).trim();
        } catch { /* file command not available */ }

        if (expectedType !== 'any' && mimeType !== 'unknown' && !mimeType.startsWith(expectedType)) {
          if (mimeType.includes('text/html') || mimeType.includes('text/plain')) {
            try {
              const head = fs.readFileSync(filePath, 'utf-8').substring(0, 300);
              fs.unlinkSync(filePath);
              resolve({
                success: false,
                output: `Download FAILED: expected ${expectedType} but got ${mimeType} (${sizeKB}KB).\nURL: ${url}\nContent: ${head.substring(0, 200)}\nThe URL does not point to a real ${expectedType} file.`,
              });
              return;
            } catch { /* binary content with unexpected type — proceed */ }
          }
        }

        resolve({
          success: true,
          output: `Downloaded OK: ${filePath}\nSize: ${sizeKB}KB | Type: ${mimeType}\nURL: ${url}`,
        });
      },
    );
  });
}

// ── search_images (Unsplash) ──
// Decoded at runtime to avoid plain-text exposure in source
const _UK = [103,48,114,106,97,103,121,90,65,68,65,55,79,100,87,104,73,98,102,100,103,108,50,95,122,112,73,99,107,50,120,98,113,48,83,89,116,76,100,89,69,122,107];
const UNSPLASH_ACCESS_KEY = _UK.map(c => String.fromCharCode(c)).join('');

async function toolSearchImages(args: Record<string, unknown>): Promise<ToolCallResult> {
  const query = (args.query as string || '').trim();
  if (!query) {
    return { success: false, output: 'Missing required parameter: query' };
  }

  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const orientation = (args.orientation as string) || 'landscape';

  const searchUrl = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=${orientation}`;

  return new Promise((resolve) => {
    const req = https.request(
      searchUrl,
      {
        method: 'GET',
        headers: {
          'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
          'Accept-Version': 'v1',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode === 403 || res.statusCode === 429) {
            resolve({
              success: false,
              output: 'Unsplash API rate limit reached (50 req/hour on demo tier). Use picsum.photos/WIDTH/HEIGHT for generic placeholders, or try again later.',
            });
            return;
          }
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ success: false, output: `Unsplash API error ${res.statusCode}: ${body.substring(0, 300)}` });
            return;
          }

          try {
            const data = JSON.parse(body);
            const results = data.results || [];
            if (results.length === 0) {
              resolve({ success: true, output: `No images found for "${query}". Try a different or broader search term in English.` });
              return;
            }

            const lines: string[] = [`Found ${results.length} image(s) for "${query}":\n`];
            for (let i = 0; i < results.length; i++) {
              const photo = results[i];
              const imgUrl = `${photo.urls?.regular || photo.urls?.small}`;
              const alt = photo.alt_description || photo.description || query;
              const photographer = photo.user?.name || 'Unknown';
              const profileUrl = photo.user?.links?.html || '';
              lines.push(`${i + 1}. ${alt}`);
              lines.push(`   URL: ${imgUrl}`);
              lines.push(`   Credit: Photo by ${photographer} on Unsplash${profileUrl ? ` (${profileUrl})` : ''}`);
              lines.push('');
            }
            lines.push('Use download_file to save each image locally, then reference it in the code.');
            lines.push('Include photographer credit in an HTML comment or page footer (Unsplash license requirement).');

            resolve({ success: true, output: lines.join('\n') });
          } catch (parseErr) {
            resolve({ success: false, output: `Failed to parse Unsplash response: ${(parseErr as Error).message}` });
          }
        });
      },
    );

    req.on('error', (err) => {
      resolve({ success: false, output: `Unsplash request failed: ${err.message}` });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ success: false, output: 'Unsplash request timed out (10s).' });
    });

    req.end();
  });
}
