import * as vscode from 'vscode';
import { ChatViewProvider } from './webview';
import { promptForApiKey } from './settings';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('vajbagent.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vajbagent.newSession', () => {
      provider.newSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vajbagent.setApiKey', () => {
      promptForApiKey(context.secrets);
    })
  );
}

export function deactivate() {}
