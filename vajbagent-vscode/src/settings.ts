import * as vscode from 'vscode';

const SECRET_KEY = 'vajbagent.apiKey';

export const MODEL_INFO: Record<string, { label: string; description: string }> = {
  'vajb-agent-lite': { label: 'Lite', description: 'GPT-5 Mini — najjeftiniji' },
  'vajb-agent-turbo': { label: 'Turbo', description: 'o4-mini — brz reasoning' },
  'vajb-agent-pro': { label: 'Pro', description: 'GPT-5 — jak generalist' },
  'vajb-agent-max': { label: 'Max', description: 'Claude Sonnet 4.6 — balansiran' },
  'vajb-agent-power': { label: 'Power', description: 'GPT-5.4 — najjaci GPT' },
  'vajb-agent-ultra': { label: 'Ultra', description: 'Claude Opus 4.6 — premium' },
  'vajb-agent-architect': { label: 'Architect', description: 'Claude Opus + architect prompt' },
};

export function getApiUrl(): string {
  return vscode.workspace.getConfiguration('vajbagent').get<string>('apiUrl', 'https://vajbagent.com');
}

export function setApiUrl(url: string): Thenable<void> {
  return vscode.workspace.getConfiguration('vajbagent').update('apiUrl', url, vscode.ConfigurationTarget.Global);
}

export function getModel(): string {
  return vscode.workspace.getConfiguration('vajbagent').get<string>('model', 'vajb-agent-lite');
}

export function setModel(model: string): Thenable<void> {
  return vscode.workspace.getConfiguration('vajbagent').update('model', model, vscode.ConfigurationTarget.Global);
}

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(SECRET_KEY);
}

export async function setApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
  if (key) {
    await secrets.store(SECRET_KEY, key);
  } else {
    await secrets.delete(SECRET_KEY);
  }
}

export interface AutoApproveSettings {
  writeFile: boolean;
  replaceInFile: boolean;
  executeCommand: boolean;
}

export function getAutoApprove(): AutoApproveSettings {
  const cfg = vscode.workspace.getConfiguration('vajbagent.autoApprove');
  return {
    writeFile: cfg.get<boolean>('writeFile', false),
    replaceInFile: cfg.get<boolean>('replaceInFile', false),
    executeCommand: cfg.get<boolean>('executeCommand', false),
  };
}

export function setAutoApprove(key: keyof AutoApproveSettings, value: boolean): Thenable<void> {
  return vscode.workspace.getConfiguration('vajbagent.autoApprove').update(key, value, vscode.ConfigurationTarget.Global);
}

export async function promptForApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    prompt: 'Unesi VajbAgent API key',
    placeHolder: 'vajb_xxxxxxxxxxxxxxxx',
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await setApiKey(secrets, key);
    vscode.window.showInformationMessage('VajbAgent API key sacuvan!');
  }
  return key;
}
