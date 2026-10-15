import * as vscode from 'vscode';
import {
  resolveFunctionCall,
  type AnalysisRequest,
  type Cancellation,
  type LanguageAdapterRegistry,
  type ResolvedFunction
} from '@visual-code-flow/shared';
import type { SourceLocation } from '@visual-code-flow/flow-core';

export type { ResolvedFunction } from '@visual-code-flow/shared';

function snapshot(document: vscode.TextDocument): AnalysisRequest {
  return {
    uri: document.uri.toString(),
    text: document.getText(),
    languageId: document.languageId,
    documentVersion: document.version
  };
}

/** Adapt the editor's optional definition providers to the language-neutral resolver. */
export async function resolveCalledFunction(
  registry: LanguageAdapterRegistry,
  source: SourceLocation,
  cancellation?: Cancellation
): Promise<ResolvedFunction | undefined> {
  return resolveFunctionCall(
    registry,
    source,
    {
      readDocument: async (uri) =>
        snapshot(await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))),
      findDefinitions: async (request, position) => {
        const locations = await vscode.commands.executeCommand<
          readonly (vscode.Location | vscode.LocationLink)[] | undefined
        >(
          'vscode.executeDefinitionProvider',
          vscode.Uri.parse(request.uri),
          new vscode.Position(position.line, position.character)
        );
        return (locations ?? []).map((location) => {
          if ('targetUri' in location) {
            const start = (location.targetSelectionRange ?? location.targetRange).start;
            return {
              uri: location.targetUri.toString(),
              position: { line: start.line, character: start.character }
            };
          }
          const start = location.range.start;
          return {
            uri: location.uri.toString(),
            position: { line: start.line, character: start.character }
          };
        });
      }
    },
    cancellation
  );
}
