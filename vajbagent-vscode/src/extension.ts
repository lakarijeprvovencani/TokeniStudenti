import * as vscode from 'vscode';
import { ChatViewProvider } from './webview';
import { promptForApiKey } from './settings';
import { McpManager } from './mcp';

let mcpManager: McpManager | null = null;

export function getMcpManager(): McpManager | null {
  return mcpManager;
}

export function activate(context: vscode.ExtensionContext) {
  mcpManager = new McpManager();

  const provider = new ChatViewProvider(context, mcpManager);

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

  mcpManager.startFromConfig().catch(err => {
    console.error('[MCP] Auto-start failed:', err.message);
  });

  const mcpConfigGlob = new vscode.RelativePattern(
    vscode.workspace.workspaceFolders?.[0] || '',
    '.vajbagent/mcp.json'
  );
  const mcpWatcher = vscode.workspace.createFileSystemWatcher(mcpConfigGlob);
  const reloadMcp = () => {
    mcpManager?.stopAll();
    mcpManager?.startFromConfig().catch(err => {
      console.error('[MCP] Restart after config change failed:', err.message);
    });
  };
  mcpWatcher.onDidChange(reloadMcp);
  mcpWatcher.onDidCreate(reloadMcp);
  mcpWatcher.onDidDelete(reloadMcp);
  context.subscriptions.push(mcpWatcher);
}

export function deactivate() {
  mcpManager?.stopAll();
  mcpManager = null;
}
