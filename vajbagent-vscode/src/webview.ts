import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getModel, setModel, getApiKey, setApiKey, getApiUrl, setApiUrl, promptForApiKey, MODEL_INFO, getAutoApprove, setAutoApprove, AutoApproveSettings } from './settings';
import { Agent } from './agent';
import { setPostMessage, handleDiffResponse, handleCommandResponse } from './tools';
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

  public newSession() {
    this._agent.abort();
    this._agent.clearHistory();
    this._view?.webview.postMessage({ type: 'newSession' });
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
        this._view?.webview.postMessage({
          type: 'init',
          model: getModel(),
          models: MODEL_INFO,
          autoApprove: getAutoApprove(),
          apiUrl: getApiUrl(),
          hasApiKey: !!existingKey,
          mcpServers: mcpStatus,
          mcpTotalTools,
        });
        this._agent.sendContextUpdate();
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
        await this._agent.sendMessage(text, images);
        break;
      }
      case 'stopGeneration':
        this._agent.abort();
        break;
      case 'newSession':
        this._agent.abort();
        this._agent.clearHistory();
        this._view?.webview.postMessage({ type: 'newSession' });
        break;
      case 'diffResponse':
        handleDiffResponse(message.accepted as boolean);
        if (message.accepted && message.fullPath) {
          const fp = message.fullPath as string;
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const abs = root && !path.isAbsolute(fp) ? path.join(root, fp) : fp;
          try {
            vscode.workspace.openTextDocument(abs).then(doc => {
              vscode.window.showTextDocument(doc, { preview: false });
            });
          } catch { /* file may not exist yet until tool finishes */ }
        }
        break;
      case 'commandResponse':
        handleCommandResponse(message.accepted as boolean);
        break;
      case 'setApiKey':
        await setApiKey(this._context.secrets, message.key as string);
        break;
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
        this._agent.deleteSession(message.sessionId as string);
        const updatedSessions = this._agent.getSessions().map(s => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
        }));
        this._view?.webview.postMessage({ type: 'historyList', sessions: updatedSessions });
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
          vscode.window.showWarningMessage(`Fajl nije pronadjen: ${filePath}`);
        }
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
