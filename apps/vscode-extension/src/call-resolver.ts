import * as vscode from 'vscode';
import {
  resolveFunctionCall,
  type Cancellation,
  type AnalysisRequest,
  type TextPosition,
  type CallResolution,
  type DefinitionLocation,
  type LanguageAdapterRegistry,
  type ResolvedFunction
} from '@visual-code-flow/shared';
import type { SourceLocation } from '@visual-code-flow/flow-core';
import { documentSnapshot, type PhpWorkspace } from './php-workspace.js';

export type { ResolvedFunction };

export async function resolveCalledFunction(
  adapters: LanguageAdapterRegistry,
  source: SourceLocation,
  cancellation?: Cancellation,
  php?: PhpWorkspace,
  report?: (reason: NonNullable<CallResolution['reason']>) => void
): Promise<ResolvedFunction | undefined> {
  const caller = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri));
  const isPhp = caller.languageId === 'php';
  const useProvider =
    !isPhp ||
    vscode.workspace
      .getConfiguration('visualCodeFlow.php', caller.uri)
      .get<boolean>('useDefinitionProvider', false);
  return resolveFunctionCall(
    adapters,
    source,
    {
      preferAdapter: isPhp,
      ...(report ? { reportUnresolved: report } : {}),
      readDocument: async (uri) => {
        if (isPhp && uri !== source.uri) {
          if (!php) throw new Error('PHP workspace resolution is unavailable.');
          return php.readPhp(uri);
        }
        return documentSnapshot(await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)));
      },
      ...(useProvider
        ? {
            findDefinitions: async (
              request: AnalysisRequest,
              position: TextPosition
            ): Promise<readonly DefinitionLocation[]> => {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const locations = await Promise.race([
                  vscode.commands.executeCommand<
                    readonly (vscode.Location | vscode.LocationLink)[] | undefined
                  >(
                    'vscode.executeDefinitionProvider',
                    vscode.Uri.parse(request.uri),
                    new vscode.Position(position.line, position.character)
                  ),
                  new Promise<undefined>((resolve) => {
                    timer = setTimeout(() => resolve(undefined), 2000);
                  })
                ]);
                return (locations ?? []).map((location) =>
                  'targetUri' in location
                    ? {
                        uri: location.targetUri.toString(),
                        position: (location.targetSelectionRange ?? location.targetRange).start
                      }
                    : { uri: location.uri.toString(), position: location.range.start }
                );
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          }
        : {})
    },
    cancellation
  );
}
