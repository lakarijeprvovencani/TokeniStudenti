import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { getAutoApprove } from './settings';

export interface ToolCallResult {
  success: boolean;
  output: string;
}

type ApprovalCallback = (accepted: boolean) => void;
let _postMessage: ((msg: unknown) => void) | null = null;
let _pendingDiffResolve: ApprovalCallback | null = null;
let _pendingCommandResolve: ApprovalCallback | null = null;

export function setPostMessage(fn: (msg: unknown) => void) {
  _postMessage = fn;
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
    default:
      return { success: false, output: `Unknown tool: ${name}` };
  }
}

function resolveWorkspacePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return filePath;
  return path.join(folders[0].uri.fsPath, filePath);
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
      fs.writeFileSync(filePath, newContent, 'utf-8');
      return { success: true, output: `File written: ${filePath}` };
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
      fs.writeFileSync(filePath, newContent, 'utf-8');
      return { success: true, output: `File updated: ${filePath}` };
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
            const globRegex = new RegExp('^' + fileGlob.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
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

async function toolExecuteCommand(args: Record<string, unknown>): Promise<ToolCallResult> {
  const command = args.command as string;
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders?.[0]?.uri.fsPath || process.cwd();

  const accepted = await requestCommandApproval(command);
  if (!accepted) {
    return { success: false, output: 'User rejected the command.' };
  }

  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const output = [
        stdout ? `stdout:\n${stdout}` : '',
        stderr ? `stderr:\n${stderr}` : '',
        error && error.killed ? 'Command timed out after 30s' : '',
        error && !error.killed ? `exit code: ${error.code}` : '',
      ].filter(Boolean).join('\n');

      resolve({
        success: !error,
        output: output || '(no output)',
      });
    });
  });
}

// ── fetch_url ──
async function toolFetchUrl(args: Record<string, unknown>): Promise<ToolCallResult> {
  const url = args.url as string;
  const method = (args.method as string) || 'GET';
  const customHeaders = (args.headers as Record<string, string>) || {};
  const body = args.body as string | undefined;

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
