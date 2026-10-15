import type { AnalysisRequest, Cancellation } from '@visual-code-flow/shared';
import { nodeList } from './ast.js';
import { PhpAnalysisError, PhpDocumentCache, checkCancellation } from './document.js';
import {
  classFileCandidates,
  projectFileUri,
  relativeProjectPath,
  type ComposerMap
} from './composer.js';
import type { PhpFileHost } from './project.js';
import {
  extractLaravelRoutes,
  LARAVEL_ROUTE_CONTEXT,
  type LaravelRoute,
  type LaravelRouteContext
} from './laravel-routes.js';
import { laravelClass, laravelList } from './laravel-syntax.js';

export interface LaravelRouteSnapshot {
  readonly routes: readonly LaravelRoute[];
  readonly documents: readonly AnalysisRequest[];
  readonly diagnostics: readonly string[];
}

/** Bounded traversal of literal declarations, never PHP bootstrap or a route:list process. */
export async function indexLaravelRoutes(
  map: ComposerMap,
  host: PhpFileHost,
  conventionalFiles: readonly string[] = [],
  cancellation?: Cancellation
): Promise<LaravelRouteSnapshot> {
  if (!map.laravel)
    return {
      routes: [],
      documents: [],
      diagnostics: ['This Composer project does not declare laravel/framework.']
    };
  const cache = new PhpDocumentCache();
  const documents = new Map<string, AnalysisRequest>();
  const diagnostics = new Set<string>();
  const routes: LaravelRoute[] = [];
  type Entry = {
    uri: string;
    context: LaravelRouteContext;
    providers?: boolean;
    optional?: boolean;
  };
  const queue: Entry[] = [];
  const seen = new Set<string>();
  let sourceLength = 0;
  const warn = (message: string): void => {
    if (diagnostics.size < 32) diagnostics.add(message);
  };
  const enqueue = (entry: Entry): void => {
    if (queue.length >= 128) warn('Route include queue limit reached.');
    else queue.push(entry);
  };
  for (const path of ['bootstrap/app.php', 'bootstrap/providers.php']) {
    enqueue({
      optional: true,
      uri: projectFileUri(map.root, path)!,
      context: LARAVEL_ROUTE_CONTEXT,
      ...(path.endsWith('providers.php') ? { providers: true } : {})
    });
  }
  const safeRead = async (uri: string, optional = false): Promise<AnalysisRequest | undefined> => {
    const path = relativeProjectPath(map.root, uri);
    if (path === undefined || (documents.size >= 64 && !documents.has(uri))) {
      warn('A route source is outside the project or exceeds the document limit.');
      return undefined;
    }
    const parts = path.split('/');
    let current = map.root;
    for (let i = 0; i <= parts.length; i++) {
      checkCancellation(cancellation);
      const kind = await host.stat(current);
      checkCancellation(cancellation);
      if (kind === 'missing') {
        if (!optional) warn('A declared route/provider source is missing.');
        return undefined;
      }
      if (kind !== (i === parts.length ? 'file' : 'directory')) {
        warn('A route source is not a readable regular file inside this project.');
        return undefined;
      }
      if (i < parts.length)
        current += encodeURIComponent(parts[i]!) + (i === parts.length - 1 ? '' : '/');
    }
    const cached = documents.get(uri);
    if (cached) return cached;
    const request = await host.read(uri);
    checkCancellation(cancellation);
    if (!request || request.uri !== uri || request.languageId !== 'php') {
      warn('A route source could not be read.');
      return undefined;
    }
    sourceLength += request.text.length;
    if (sourceLength > 2_000_000) {
      warn('Route source size limit reached. Results are incomplete.');
      return undefined;
    }
    documents.set(uri, request);
    return request;
  };
  let processed = 0;
  const drain = async (): Promise<void> => {
    while (queue.length && processed < 128 && routes.length < 1000) {
      checkCancellation(cancellation);
      const entry = queue.shift()!;
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      processed++;
      try {
        const request = await safeRead(entry.uri, entry.optional);
        if (!request) continue;
        const document = cache.get(request, cancellation);
        if (entry.providers) {
          const statements = nodeList(document.ast.children).filter(
            (node) => node.kind !== 'usegroup'
          );
          const returned = statements.find((node) => node.kind === 'return');
          const providers = laravelList(returned?.expr);
          if (!providers || statements.some((node) => !['return', 'declare'].includes(node.kind)))
            warn('Provider registration is dynamic or partial.');
          if ((providers?.length ?? 0) > 64) warn('Provider reference limit reached.');
          for (const provider of (providers ?? []).slice(0, 64)) {
            const name = laravelClass(document, provider);
            if (!name) {
              warn('A provider reference is dynamic.');
              continue;
            }
            for (const uri of classFileCandidates(map, name))
              enqueue({ uri, context: entry.context });
          }
          continue;
        }
        const result = extractLaravelRoutes(document, map.root, entry.context, cancellation);
        for (const message of result.diagnostics) warn(message);
        for (const route of result.routes) {
          if (routes.length >= 1000) break;
          routes.push({ ...route, id: `${route.id}:context:${seen.size}` });
        }
        for (const include of result.includes) {
          if (queue.length >= 128) {
            warn('Route include queue limit reached.');
            break;
          }
          enqueue({ uri: include.uri, context: include.context });
        }
      } catch (error) {
        checkCancellation(cancellation);
        if (error instanceof PhpAnalysisError && error.code === 'cancelled') throw error;
        warn('A route source is unreadable, invalid or unsupported. Results are partial.');
      }
    }
    if (queue.length || routes.length >= 1000)
      warn('Route traversal limit reached. Results are incomplete.');
  };
  await drain();
  for (const uri of conventionalFiles.slice(0, 64)) {
    if (!documents.has(uri))
      enqueue({
        uri,
        context: {
          ...LARAVEL_ROUTE_CONTEXT,
          partial: true,
          diagnostics: ['Conventional route file; application registration is not confirmed.']
        }
      });
  }
  if (conventionalFiles.length > 64) warn('Conventional route file limit reached.');
  await drain();
  checkCancellation(cancellation);
  return { routes, documents: [...documents.values()], diagnostics: [...diagnostics] };
}
