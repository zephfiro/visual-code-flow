import * as vscode from 'vscode';

export const OPEN_FLOW_COMMAND = 'visualCodeFlow.openFlow';

export function activate(context: vscode.ExtensionContext): void {
  const openFlow = vscode.commands.registerCommand(OPEN_FLOW_COMMAND, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage('Open a source file to explore its flow.');
      return;
    }

    await vscode.window.showInformationMessage(
      'Visual Code Flow is ready. Function discovery and graph rendering are coming next.'
    );
  });

  context.subscriptions.push(openFlow);
}

export function deactivate(): void {
  // VS Code disposes registered subscriptions automatically.
}
