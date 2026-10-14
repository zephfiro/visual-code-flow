import * as vscode from 'vscode';
import { TypeScriptLanguageAdapter } from '@visual-code-flow/analyzer-typescript';
import type { AnalysisRequest, FunctionDescriptor } from '@visual-code-flow/shared';
import type { SourceLocation } from '@visual-code-flow/flow-core';

export interface ResolvedFunction {
  readonly request: AnalysisRequest;
  readonly symbol: FunctionDescriptor;
}

function snapshot(document: vscode.TextDocument): AnalysisRequest {
  return {
    uri: document.uri.toString(),
    text: document.getText(),
    languageId: document.languageId,
    documentVersion: document.version
  };
}

/** Prefer the language server's real definition resolution for imports and methods. */
export async function resolveCalledFunction(
  adapter: TypeScriptLanguageAdapter,
  source: SourceLocation
): Promise<ResolvedFunction | undefined> {
  const caller = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri));
  const request = snapshot(caller);
  const callee = adapter.findCallTargetPosition(request, source);
  if (!callee) return undefined;

  const locations = await vscode.commands.executeCommand<
    readonly (vscode.Location | vscode.LocationLink)[] | undefined
  >(
    'vscode.executeDefinitionProvider',
    caller.uri,
    new vscode.Position(callee.line, callee.character)
  );

  let destination: { uri: vscode.Uri; position: vscode.Position } | undefined;
  if (locations && locations.length > 1) return undefined;
  const location = locations?.[0];
  if (location) {
    destination =
      'targetUri' in location
        ? { uri: location.targetUri, position: (location.targetSelectionRange ?? location.targetRange).start }
        : { uri: location.uri, position: location.range.start };
  } else {
    const fallback = await adapter.resolveCall(request, source);
    if (fallback.targets.length !== 1) return undefined;
    const target = fallback.targets[0]!;
    destination = {
      uri: vscode.Uri.parse(target.definition.uri),
      position: new vscode.Position(
        target.definition.start.line,
        target.definition.start.character
      )
    };
  }

  const document = await vscode.workspace.openTextDocument(destination.uri);
  if (!adapter.supportedLanguages.includes(document.languageId)) return undefined;
  const targetRequest = snapshot(document);
  const position = {
    line: destination.position.line,
    character: destination.position.character
  };
  const symbol =
    adapter.findFunctionDefinition(targetRequest, position) ??
    adapter.findFunction(targetRequest, position);
  return symbol ? { request: targetRequest, symbol } : undefined;
}
