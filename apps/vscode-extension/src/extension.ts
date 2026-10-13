import * as vscode from 'vscode';
import { TypeScriptLanguageAdapter } from '@visual-code-flow/analyzer-typescript';

export const OPEN_FLOW_COMMAND = 'visualCodeFlow.openFlow';

const adapter = new TypeScriptLanguageAdapter();

export function activate(context: vscode.ExtensionContext): void {
  const openFlow = vscode.commands.registerCommand(OPEN_FLOW_COMMAND, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.window.showInformationMessage('Open a source file to explore its flow.');
      return;
    }

    const document = editor.document;
    if (!adapter.supportedLanguages.includes(document.languageId)) {
      await vscode.window.showWarningMessage(
        'Visual Code Flow currently supports TypeScript and JavaScript files.'
      );
      return;
    }

    const selected = adapter.findFunction(
      {
        uri: document.uri.toString(),
        text: document.getText(),
        documentVersion: document.version,
        languageId: document.languageId
      },
      {
        line: editor.selection.active.line,
        character: editor.selection.active.character
      }
    );

    if (!selected) {
      await vscode.window.showInformationMessage('Place your cursor inside a function.');
      return;
    }

    await vscode.window.showInformationMessage(
      `Selected function: ${selected.name} (line ${selected.location.start.line + 1})`
    );
  });

  context.subscriptions.push(openFlow);
}

export function deactivate(): void {
  // Disposables are registered with ExtensionContext.
}
