import * as vscode from 'vscode';
import { ChatViewProvider } from './webview';
import { promptForApiKey } from './settings';
import { McpManager } from './mcp';
import { revertAllCheckpoints, getCheckpoints, clearCheckpoints } from './tools';

let mcpManager: McpManager | null = null;

export function getMcpManager(): McpManager | null {
  return mcpManager;
}

export function activate(context: vscode.ExtensionContext) {
  mcpManager = new McpManager();

  const provider = new ChatViewProvider(context, mcpManager);
  chatProvider = provider;

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

  context.subscriptions.push(
    vscode.commands.registerCommand('vajbagent.stopGeneration', () => {
      provider.stopGeneration();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vajbagent.explainSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.document.getText(editor.selection);
      if (!sel.trim()) {
        vscode.window.showWarningMessage('Selektuj kod koji zelis da objasnim.');
        return;
      }
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || '';
      const lang = editor.document.languageId || '';
      const text = `Objasni mi ovaj kod iz fajla \`${fileName}\`:\n\n\`\`\`${lang}\n${sel}\n\`\`\``;
      provider.sendMessageFromCommand(text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vajbagent.refactorSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.document.getText(editor.selection);
      if (!sel.trim()) {
        vscode.window.showWarningMessage('Selektuj kod koji zelis da refaktorisem.');
        return;
      }
      const fileName = editor.document.fileName.split(/[\\/]/).pop() || '';
      const lang = editor.document.languageId || '';
      const text = `Refaktorisi i poboljsaj ovaj kod iz fajla \`${fileName}\`. Objasni sta si promenio i zasto:\n\n\`\`\`${lang}\n${sel}\n\`\`\``;
      provider.sendMessageFromCommand(text);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vajbagent.revertAll', async () => {
      const cps = getCheckpoints();
      if (cps.length === 0) {
        vscode.window.showInformationMessage('Nema promena za vracanje.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Vratiti ${cps.length} fajl(ova) na originale pre izmena agenta?`,
        { modal: true },
        'Da, vrati sve'
      );
      if (choice === 'Da, vrati sve') {
        const count = revertAllCheckpoints();
        vscode.window.showInformationMessage(`Vraceno ${count} fajl(ova) na originale.`);
        provider.postMessage({ type: 'checkpointSaved', count: 0 });
      }
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

let chatProvider: ChatViewProvider | null = null;

export function deactivate() {
  chatProvider?.dispose();
  chatProvider = null;
  mcpManager?.stopAll();
  mcpManager = null;
}
