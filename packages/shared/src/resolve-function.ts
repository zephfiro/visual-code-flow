import type { LanguageAdapterRegistry } from './adapter-registry.js';
import type {
  AnalysisRequest,
  CallResolution,
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
  /** Conservative adapters can veto ambiguous/dynamic targets before optional providers run. */
  readonly preferAdapter?: boolean;
  reportUnresolved?(reason: NonNullable<CallResolution['reason']>): void;
}

export interface ResolvedFunction {
  readonly request: AnalysisRequest;
  readonly symbol: FunctionDescriptor;
  readonly adapter: LanguageAdapter;
  readonly evidence?: string;
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
  const cancelled = (): boolean => cancellation?.isCancellationRequested === true;
  const unresolved = (reason: NonNullable<CallResolution['reason']>): undefined => {
    if (!cancelled()) host.reportUnresolved?.(reason);
    return undefined;
  };
  if (cancelled()) return undefined;
  const request = await host.readDocument(source.uri);
  if (cancelled() || request.uri !== source.uri) return undefined;
  const callerAdapter = registry.get(request.languageId);
  if (!callerAdapter) return unresolved('unsupported');
  let fallback: CallResolution | undefined;
  if (host.preferAdapter) {
    fallback = await callerAdapter.resolveCall(request, source, cancellation);
    if (cancelled()) return undefined;
    if (fallback.reason && !['not-found', 'external'].includes(fallback.reason))
      return unresolved(fallback.reason);
    if (fallback.targets.length > 1) return unresolved('ambiguous');
  }
  let destination: DefinitionLocation | undefined;
  let fallbackSymbolId: string | undefined;
  let evidence: string | undefined;
  const chooseFallback = (): boolean => {
    if (!fallback || fallback.reason || fallback.targets.length !== 1) return false;
    const target = fallback.targets[0]!;
    fallbackSymbolId = target.symbolId;
    evidence = target.evidence;
    destination = { uri: target.definition.uri, position: target.definition.start };
    return true;
  };
  if (!chooseFallback()) {
    const callee = callerAdapter.findCallTargetPosition?.(request, source);
    let locations: readonly DefinitionLocation[] = [];
    if (callee && host.findDefinitions) {
      try {
        const supplied = await host.findDefinitions(request, callee);
        if (supplied.length > 32) return unresolved('unsupported');
        locations = uniqueDefinitions(supplied);
      } catch {
        // Optional providers may fail or be unavailable; local resolution still works.
      }
    }
    if (cancelled()) return undefined;
    if (locations.length > 1) return unresolved('ambiguous');
    destination = locations[0];
    if (destination)
      evidence = 'Definition-provider source declaration; runtime dispatch is not established.';
    else {
      fallback ??= await callerAdapter.resolveCall(request, source, cancellation);
      if (cancelled()) return undefined;
      if (!chooseFallback())
        return unresolved(
          fallback.reason ?? (fallback.targets.length > 1 ? 'ambiguous' : 'not-found')
        );
    }
  }
  if (!destination || cancelled()) return undefined;
  if (
    !Number.isSafeInteger(destination.position.line) ||
    !Number.isSafeInteger(destination.position.character) ||
    destination.position.line < 0 ||
    destination.position.character < 0
  )
    return unresolved('unsupported');
  const targetRequest = await host.readDocument(destination.uri);
  if (cancelled() || targetRequest.uri !== destination.uri) return undefined;
  const targetAdapter = registry.get(targetRequest.languageId);
  if (!targetAdapter) return unresolved('unsupported');
  let symbol = targetAdapter.findFunctionDefinition?.(targetRequest, destination.position);
  if (!symbol && (!targetAdapter.findFunctionDefinition || fallbackSymbolId !== undefined)) {
    const candidate = targetAdapter.findFunction(targetRequest, destination.position);
    if (candidate && (fallbackSymbolId === undefined || candidate.symbolId === fallbackSymbolId))
      symbol = candidate;
  }
  if (fallbackSymbolId !== undefined && symbol?.symbolId !== fallbackSymbolId)
    return unresolved('not-found');
  return symbol
    ? { request: targetRequest, symbol, adapter: targetAdapter, ...(evidence ? { evidence } : {}) }
    : unresolved('unsupported');
}
