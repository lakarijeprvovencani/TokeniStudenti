import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getModel, setModel, getApiKey, promptForApiKey, MODEL_INFO, getAutoApprove, setAutoApprove, AutoApproveSettings } from './settings';
import { Agent } from './agent';
import { setPostMessage, handleDiffResponse, handleCommandResponse } from './tools';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vajbagent.chatView';
  private _view?: vscode.WebviewView;
  private _context: vscode.ExtensionContext;
  private _agent: Agent;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._agent = new Agent(this, context);
    setPostMessage((msg) => this.postMessage(msg));
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

  public postMessage(message: unknown) {
    this._view?.webview.postMessage(message);
  }

  private async _handleMessage(message: { type: string; [key: string]: unknown }) {
    switch (message.type) {
      case 'ready':
        this._view?.webview.postMessage({
          type: 'init',
          model: getModel(),
          models: MODEL_INFO,
          autoApprove: getAutoApprove(),
        });
        break;
      case 'setModel':
        await setModel(message.model as string);
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
        break;
      case 'commandResponse':
        handleCommandResponse(message.accepted as boolean);
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
