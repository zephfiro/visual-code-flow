import type { LanguageAdapterRegistry } from './adapter-registry.js';
import type {
  AnalysisRequest,
  Cancellation,
  FunctionDescriptor,
  LanguageAdapter,
  SourceSpan,
  TextPosition
} from './language-adapter.js';

export interface DefinitionLocation {
  readonly uri: string;
  readonly position: TextPosition;
}

export interface FunctionResolutionHost {
  readDocument(uri: string): Promise<AnalysisRequest>;
  findDefinitions?(
    request: AnalysisRequest,
    position: TextPosition
  ): Promise<readonly DefinitionLocation[]>;
}

export interface ResolvedFunction {
  readonly request: AnalysisRequest;
  readonly symbol: FunctionDescriptor;
  readonly adapter: LanguageAdapter;
}

function uniqueDefinitions(locations: readonly DefinitionLocation[]): DefinitionLocation[] {
  return [
    ...new Map(
      locations.map((location) => [
        `${location.uri}:${location.position.line}:${location.position.character}`,
        location
      ])
    ).values()
  ];
}

/** Resolve navigation evidence, not a claim about the runtime receiver. */
export async function resolveFunctionCall(
  registry: LanguageAdapterRegistry,
  source: SourceSpan,
  host: FunctionResolutionHost,
  cancellation?: Cancellation
): Promise<ResolvedFunction | undefined> {
  if (cancellation?.isCancellationRequested) return undefined;
  const request = await host.readDocument(source.uri);
  if (cancellation?.isCancellationRequested) return undefined;
  const callerAdapter = registry.get(request.languageId);
  if (!callerAdapter) return undefined;
  const callee = callerAdapter.findCallTargetPosition?.(request, source);
  let locations: readonly DefinitionLocation[] = [];
  if (callee && host.findDefinitions) {
    try {
      locations = uniqueDefinitions(await host.findDefinitions(request, callee));
    } catch {
      // Optional providers may fail or be unavailable; local resolution still works.
    }
  }
  if (cancellation?.isCancellationRequested || locations.length > 1) return undefined;
  let destination = locations[0];
  let fallbackSymbolId: string | undefined;
  if (!destination) {
    const fallback = await callerAdapter.resolveCall(request, source, cancellation);
    if (cancellation?.isCancellationRequested || fallback.reason || fallback.targets.length !== 1) {
      return undefined;
    }
    const target = fallback.targets[0]!;
    fallbackSymbolId = target.symbolId;
    destination = { uri: target.definition.uri, position: target.definition.start };
  }
  const targetRequest = await host.readDocument(destination.uri);
  if (cancellation?.isCancellationRequested) return undefined;
  const targetAdapter = registry.get(targetRequest.languageId);
  if (!targetAdapter) return undefined;
  let symbol = targetAdapter.findFunctionDefinition?.(targetRequest, destination.position);
  if (!symbol && (!targetAdapter.findFunctionDefinition || fallbackSymbolId !== undefined)) {
    const candidate = targetAdapter.findFunction(targetRequest, destination.position);
    if (candidate && (fallbackSymbolId === undefined || candidate.symbolId === fallbackSymbolId)) {
      symbol = candidate;
    }
  }
  return symbol ? { request: targetRequest, symbol, adapter: targetAdapter } : undefined;
}
