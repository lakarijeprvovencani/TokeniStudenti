import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getModel, setModel, getApiKey, setApiKey, getApiUrl, setApiUrl, promptForApiKey, MODEL_INFO, getAutoApprove, setAutoApprove, AutoApproveSettings } from './settings';
import { Agent } from './agent';
import { setPostMessage, handleDiffResponse, handleCommandResponse, clearCheckpoints, getCheckpoints, revertAllCheckpoints, revertCheckpoint } from './tools';
import { McpManager, McpServerConfig } from './mcp';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vajbagent.chatView';
  private _view?: vscode.WebviewView;
  private _context: vscode.ExtensionContext;
  private _agent: Agent;
  private _mcpManager: McpManager;

  constructor(context: vscode.ExtensionContext, mcpManager: McpManager) {
    this._context = context;
    this._mcpManager = mcpManager;
    this._agent = new Agent(this, context, mcpManager);
    setPostMessage((msg) => this.postMessage(msg));

    mcpManager.onToolsChanged(() => {
      this._sendMcpStatus();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      undefined,
      this._context.subscriptions
    );
  }

  public async newSession() {
    this._agent.abort();
    this._agent.clearHistory();
    clearCheckpoints();
    const keyOnNew = await getApiKey(this._context.secrets);
    this._view?.webview.postMessage({ type: 'newSession', hasApiKey: !!keyOnNew });
  }

  public stopGeneration() {
    this._agent.abort();
    this._view?.webview.postMessage({ type: 'generationStopped' });
  }

  private _sendMcpStatus() {
    const status = this._mcpManager.getStatus();
    const totalTools = status.reduce((s, c) => s + c.toolCount, 0);
    this._view?.webview.postMessage({ type: 'mcpStatus', servers: status, totalTools });
  }

  private async _restartMcp() {
    this._view?.webview.postMessage({ type: 'mcpStatus', servers: [], totalTools: 0, loading: true });
    this._mcpManager.stopAll();
    try {
      await this._mcpManager.startFromConfig();
    } catch (err) {
      console.error('[MCP] Restart failed:', (err as Error).message);
    }
    this._sendMcpStatus();
  }

  public postMessage(message: unknown) {
    this._view?.webview.postMessage(message);
  }

  public dispose() {
    this._agent.dispose();
  }

  public async sendMessageFromCommand(text: string) {
    if (this._view) {
      this._view.show?.(true);
    }
    this._view?.webview.postMessage({ type: 'commandMessage', text });
    await this._agent.sendMessage(text);
  }

  private async _handleMessage(message: { type: string; [key: string]: unknown }) {
    switch (message.type) {
      case 'ready': {
        const existingKey = await getApiKey(this._context.secrets);
        const mcpStatus = this._mcpManager.getStatus();
        const mcpTotalTools = mcpStatus.reduce((s, c) => s + c.toolCount, 0);
        let userName: string | undefined;
        let freeTier = true;
        if (existingKey) {
          try {
            const resp = await fetch(`${getApiUrl()}/me`, { headers: { 'Authorization': `Bearer ${existingKey}` } });
            if (resp.ok) {
              const data = await resp.json() as { name?: string; free_tier?: boolean };
              userName = data.name;
              freeTier = data.free_tier ?? true;
            }
          } catch { /* ignore network errors */ }
        }
        this._view?.webview.postMessage({
          type: 'init',
          model: getModel(),
          models: MODEL_INFO,
          autoApprove: getAutoApprove(),
          apiUrl: getApiUrl(),
          hasApiKey: !!existingKey,
          userName,
          freeTier,
          mcpServers: mcpStatus,
          mcpTotalTools,
        });
        this._agent.sendContextUpdate();

        const lastSession = this._agent.getSessions()[0];
        if (lastSession && this._agent.getHistory().length === 0) {
          this._agent.loadSession(lastSession.id);
          const msgs = this._agent.getSessionMessages(lastSession.id);
          if (msgs) {
            this._view?.webview.postMessage({ type: 'sessionLoaded', messages: msgs });
          }
        }
        break;
      }
      case 'setModel':
        await setModel(message.model as string);
        this._agent.sendContextUpdate();
        break;
      case 'getApiKey': {
        let key = await getApiKey(this._context.secrets);
        if (!key) {
          key = await promptForApiKey(this._context.secrets);
        }
        this._view?.webview.postMessage({ type: 'apiKey', key: key || null });
        break;
      }
      case 'sendMessage': {
        const text = (message.text as string) || '';
        const images = (message.images as Array<{ base64: string; mimeType: string }>) || [];
        const skill = (message.skill as string) || null;
        await this._agent.sendMessage(text, images, skill);
        break;
      }
      case 'stopGeneration':
        this._agent.abort();
        this._view?.webview.postMessage({ type: 'generationStopped' });
        break;
      case 'newSession': {
        this._agent.abort();
        this._agent.clearHistory();
        const keyOnNew = await getApiKey(this._context.secrets);
        this._view?.webview.postMessage({ type: 'newSession', hasApiKey: !!keyOnNew });
        break;
      }
      case 'openUrl': {
        const url = message.url as string;
        if (url) vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'diffResponse':
        handleDiffResponse(message.accepted as boolean);
        if (message.accepted && message.fullPath) {
          const fp = message.fullPath as string;
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const abs = root && !path.isAbsolute(fp) ? path.join(root, fp) : fp;
          vscode.workspace.openTextDocument(abs).then(
            doc => vscode.window.showTextDocument(doc, { preview: false }),
            () => { /* file may not exist yet */ }
          );
        }
        break;
      case 'commandResponse':
        handleCommandResponse(message.accepted as boolean);
        break;
      case 'setApiKey': {
        const newKey = message.key as string;
        await setApiKey(this._context.secrets, newKey);
        if (newKey) {
          try {
            const resp = await fetch(`${getApiUrl()}/me`, { headers: { 'Authorization': `Bearer ${newKey}` } });
            if (resp.ok) {
              const data = await resp.json() as { name?: string; free_tier?: boolean };
              this._view?.webview.postMessage({ type: 'userInfo', name: data.name, freeTier: data.free_tier ?? true });
            }
          } catch { /* ignore */ }
        }
        break;
      }
      case 'getFileList': {
        const files = this._agent.getFileList();
        this._view?.webview.postMessage({ type: 'fileList', files });
        break;
      }
      case 'attachFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Dodaj fajl',
        });
        if (uris && uris.length > 0) {
          for (const uri of uris) {
            const fname = path.basename(uri.fsPath);
            const ext = (fname.split('.').pop() || '').toLowerCase();
            if (ext === 'pdf') {
              const { execSync } = require('child_process');
              let hasPdftotext = false;
              try { execSync('which pdftotext', { timeout: 3000 }); hasPdftotext = true; } catch { /* */ }
              if (hasPdftotext) {
                try {
                  const text = execSync(`pdftotext "${uri.fsPath}" -`, { timeout: 15000, encoding: 'utf-8' });
                  const maxLen = 15000;
                  const truncated = text.length > maxLen ? text.substring(0, maxLen) + '\n... (skraceno, ' + text.length + ' karaktera ukupno)' : text;
                  this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: truncated, ext: 'txt' });
                } catch {
                  this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: '[Greska pri citanju PDF-a]', ext: 'txt' });
                }
              } else {
                this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: '[PDF podrska zahteva pdftotext. Instaliraj: brew install poppler]', ext: 'txt' });
              }
            } else if (['png','jpg','jpeg','gif','webp','bmp','ico','svg'].includes(ext)) {
              try {
                const raw = fs.readFileSync(uri.fsPath);
                const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
                const mime = mimeTypes[ext] || 'image/png';
                const b64 = `data:${mime};base64,${raw.toString('base64')}`;
                this._view?.webview.postMessage({ type: 'imageAttached', name: fname, base64: b64, mimeType: mime });
              } catch {
                this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: '[Greska pri citanju slike]', ext: 'txt' });
              }
            } else {
              try {
                const content = fs.readFileSync(uri.fsPath, 'utf-8');
                const maxLen = 15000;
                const truncated = content.length > maxLen ? content.substring(0, maxLen) + '\n... (skraceno, ' + content.length + ' karaktera ukupno)' : content;
                this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: truncated, ext });
              } catch {
                this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: '[Nije moguce procitati fajl — mozda je binarni format]', ext: 'txt' });
              }
            }
          }
        }
        break;
      }
      case 'dropFileUris': {
        const uris = (message.uris as string[]) || [];
        for (const rawUri of uris) {
          try {
            let fsPath = rawUri;
            if (rawUri.startsWith('file://')) {
              fsPath = decodeURIComponent(new URL(rawUri).pathname);
            }
            const fname = path.basename(fsPath);
            const ext = (fname.split('.').pop() || '').toLowerCase();
            if (['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext)) {
              const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
              const mime = mimeTypes[ext] || 'image/png';
              const raw = fs.readFileSync(fsPath);
              const b64 = `data:${mime};base64,${raw.toString('base64')}`;
              this._view?.webview.postMessage({ type: 'imageAttached', name: fname, base64: b64, mimeType: mime });
            } else {
              const content = fs.readFileSync(fsPath, 'utf-8');
              const maxLen = 15000;
              const truncated = content.length > maxLen ? content.substring(0, maxLen) + '\n... (skraceno, ' + content.length + ' karaktera ukupno)' : content;
              this._view?.webview.postMessage({ type: 'fileAttached', name: fname, content: truncated, ext });
            }
          } catch { /* skip unreadable */ }
        }
        break;
      }
      case 'dropImageUris': {
        const uris = (message.uris as string[]) || [];
        const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
        for (const rawUri of uris) {
          try {
            let fsPath = rawUri;
            if (rawUri.startsWith('file://')) {
              fsPath = decodeURIComponent(new URL(rawUri).pathname);
            }
            const ext = (fsPath.split('.').pop() || '').toLowerCase();
            const mime = mimeTypes[ext] || 'image/png';
            const raw = fs.readFileSync(fsPath);
            const b64 = `data:${mime};base64,${raw.toString('base64')}`;
            this._view?.webview.postMessage({ type: 'imageAttached', name: path.basename(fsPath), base64: b64, mimeType: mime });
          } catch { /* skip unreadable */ }
        }
        break;
      }
      case 'parsePdf': {
        const base64Data = (message.base64 as string || '').replace(/^data:[^;]+;base64,/, '');
        const fileName = message.name as string || 'document.pdf';
        const os = await import('os');
        const tmpPath = require('path').join(os.tmpdir(), 'vajb_' + Date.now() + '.pdf');
        try {
          require('fs').writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));
          const { exec } = require('child_process');
          exec(`pdftotext "${tmpPath}" -`, { timeout: 15000 }, (err: Error | null, stdout: string) => {
            try { require('fs').unlinkSync(tmpPath); } catch { /* */ }
            if (err) {
              this._view?.webview.postMessage({ type: 'pdfParsed', name: fileName, content: '', error: 'Za citanje PDF-a potreban je pdftotext.\nmacOS: brew install poppler\nLinux: sudo apt install poppler-utils' });
            } else {
              this._view?.webview.postMessage({ type: 'pdfParsed', name: fileName, content: stdout.substring(0, 10000), pages: 0 });
            }
          });
        } catch (err: unknown) {
          try { require('fs').unlinkSync(tmpPath); } catch { /* */ }
          this._view?.webview.postMessage({ type: 'pdfParsed', name: fileName, content: '', error: err instanceof Error ? err.message : 'PDF parsing failed' });
        }
        break;
      }
      case 'setApiUrl':
        await setApiUrl(message.url as string);
        break;
      case 'setAutoApprove':
        await setAutoApprove(
          message.key as keyof AutoApproveSettings,
          message.value as boolean
        );
        break;
      case 'getHistory': {
        const sessions = this._agent.getSessions().map(s => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
        }));
        this._view?.webview.postMessage({ type: 'historyList', sessions });
        break;
      }
      case 'loadSession': {
        const sessionId = message.sessionId as string;
        this._agent.loadSession(sessionId);
        const msgs = this._agent.getSessionMessages(sessionId);
        if (msgs) {
          this._view?.webview.postMessage({ type: 'sessionLoaded', messages: msgs });
        }
        break;
      }
      case 'deleteSession': {
        const wasActive = this._agent.deleteSession(message.sessionId as string);
        const updatedSessions = this._agent.getSessions().map(s => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
        }));
        this._view?.webview.postMessage({ type: 'historyList', sessions: updatedSessions });
        if (wasActive) {
          this._view?.webview.postMessage({ type: 'newSession' });
        }
        break;
      }
      case 'getMcpStatus':
        this._sendMcpStatus();
        break;
      case 'restartMcp':
        await this._restartMcp();
        break;
      case 'openMcpSettings': {
        const configPath = McpManager.createConfigTemplate();
        if (configPath) {
          const doc = await vscode.workspace.openTextDocument(configPath);
          await vscode.window.showTextDocument(doc);
        } else {
          vscode.window.showWarningMessage('Otvori folder u editoru da bi konfigurisao MCP servere.');
        }
        break;
      }
      case 'getRulesStatus': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (root) {
          const fs = require('fs');
          const path = require('path');
          const candidates = ['.vajbagentrules', '.vajbagent/rules.md'];
          let found: string | null = null;
          for (const name of candidates) {
            if (fs.existsSync(path.join(root, name))) { found = name; break; }
          }
          this._view?.webview.postMessage({ type: 'rulesStatus', exists: !!found, file: found || '.vajbagentrules' });
        }
        break;
      }
      case 'openRules': {
        const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootDir) {
          vscode.window.showWarningMessage('Otvori folder u editoru da bi koristio pravila.');
          break;
        }
        const fs = require('fs');
        const path = require('path');
        const rulesCandidates = ['.vajbagentrules', '.vajbagent/rules.md'];
        let rulesFile: string = path.join(rootDir, '.vajbagentrules');
        for (const name of rulesCandidates) {
          const p = path.join(rootDir, name);
          if (fs.existsSync(p)) { rulesFile = p; break; }
        }
        if (!fs.existsSync(rulesFile)) {
          fs.writeFileSync(rulesFile, '# Pravila za VajbAgent\n# Linije koje pocinju sa # su komentari i agent ih NE cita.\n# Pisi pravila BEZ # na pocetku — agent ce ih pratiti u svakom odgovoru.\n#\n# Primeri (obrisi # ispred onog sto zelis da aktiviras):\n# Koristi TypeScript strict mode\n# Pisi komentare na srpskom\n# Koristi pnpm umesto npm\n# Svi API odgovori moraju imati error handling\n# Koristi Tailwind CSS za stilizaciju\n\n', 'utf-8');
        }
        const rulesDoc = await vscode.workspace.openTextDocument(rulesFile);
        await vscode.window.showTextDocument(rulesDoc);
        break;
      }
      case 'revertAll': {
        const cps = getCheckpoints();
        if (cps.length === 0) {
          this._view?.webview.postMessage({ type: 'revertResult', count: 0, msg: 'Nema promena za vracanje.' });
          break;
        }
        const count = revertAllCheckpoints();
        this._view?.webview.postMessage({ type: 'revertResult', count, msg: `Vraceno ${count} fajl(ova) na originale.` });
        break;
      }
      case 'revertFile': {
        const fp = message.filePath as string;
        if (!fp) break;
        const ok = revertCheckpoint(fp);
        const remaining = getCheckpoints();
        this._view?.webview.postMessage({
          type: 'fileReverted',
          filePath: fp,
          success: ok,
          remaining: remaining.length,
        });
        if (remaining.length === 0) {
          this._view?.webview.postMessage({ type: 'checkpointSaved', count: 0 });
        } else {
          this._view?.webview.postMessage({ type: 'checkpointSaved', count: remaining.length });
        }
        break;
      }
      case 'applyCode': {
        const code = message.code as string;
        if (!code) break;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.edit(editBuilder => {
            if (editor.selection.isEmpty) {
              editBuilder.insert(editor.selection.active, code);
            } else {
              editBuilder.replace(editor.selection, code);
            }
          });
        } else {
          vscode.workspace.openTextDocument({ content: code }).then(doc => {
            vscode.window.showTextDocument(doc);
          });
        }
        break;
      }
      case 'openFile': {
        const filePath = message.path as string;
        if (!filePath) break;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) break;
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(fullPath);
          await vscode.window.showTextDocument(doc);
        } catch {
          // File not found at direct path — search workspace
          const basename = path.basename(filePath);
          const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 5);
          if (found.length > 0) {
            const doc = await vscode.workspace.openTextDocument(found[0]);
            await vscode.window.showTextDocument(doc);
          } else {
            vscode.window.showWarningMessage(`Fajl nije pronadjen: ${filePath}`);
          }
        }
        break;
      }
      case 'openFolder': {
        const folderPath = message.path as string;
        if (!folderPath) break;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) break;
        const fullFolderPath = path.isAbsolute(folderPath) ? folderPath : path.join(root, folderPath);
        const uri = vscode.Uri.file(fullFolderPath);
        await vscode.commands.executeCommand('revealInExplorer', uri);
        break;
      }
    }
  }

  private _getHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(this._context.extensionPath, 'media', 'chat.html');
    let html = fs.readFileSync(htmlPath, 'utf-8');
    const nonce = getNonce();
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'vajb-logo.png')
    );
    html = html.replace(/{{nonce}}/g, nonce);
    html = html.replace(/{{cspSource}}/g, webview.cspSource);
    html = html.replace(/{{logoUri}}/g, logoUri.toString());
    return html;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
