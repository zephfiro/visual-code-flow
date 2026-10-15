import type {
  AnalysisRequest,
  CallResolution,
  Cancellation,
  SourceSpan
} from '@visual-code-flow/shared';
import { classFileCandidates, relativeProjectPath, type ComposerMap } from './composer.js';
import {
  checkCancellation,
  PhpAnalysisError,
  PhpDocumentCache,
  type PhpDocument
} from './document.js';
import { phpCallDependencies, phpCallReference, phpClasses, resolvePhpCall } from './symbols.js';

export interface PhpFileHost {
  /** Must report links as links instead of silently following them. */
  stat(uri: string): Promise<'file' | 'directory' | 'symlink' | 'missing'>;
  /** Return the editor buffer when open, otherwise a disk snapshot. */
  read(uri: string): Promise<AnalysisRequest | undefined>;
}
export interface PhpCallResolver {
  resolve(
    document: PhpDocument,
    source: SourceSpan,
    cancellation?: Cancellation
  ): Promise<CallResolution>;
}
export interface PhpProjectLimits {
  readonly maxDocuments: number;
  readonly maxSourceLength: number;
  readonly maxDependencyRounds: number;
}
const DEFAULTS: PhpProjectLimits = {
  maxDocuments: 96,
  maxSourceLength: 4_000_000,
  maxDependencyRounds: 32
};

/**
 * Per-Composer-project, bounded, on-demand symbol index. Paths come exclusively
 * from validated metadata. No filesystem scanning, bootstrap or PHP execution.
 */
export class PhpProjectIndex implements PhpCallResolver {
  private generation = 0;
  readonly limits: PhpProjectLimits;
  private readonly documents = new PhpDocumentCache();

  constructor(
    readonly map: ComposerMap,
    private readonly host: PhpFileHost,
    limits: Partial<PhpProjectLimits> = {}
  ) {
    this.limits = Object.freeze({ ...DEFAULTS, ...limits });
    for (const [key, value] of Object.entries(this.limits)) {
      const cap = key === 'maxSourceLength' ? 8_000_000 : key === 'maxDocuments' ? 256 : 64;
      if (!Number.isSafeInteger(value) || value < 1 || value > cap)
        throw new RangeError('Invalid PHP project indexing limit.');
    }
  }

  invalidate(uri?: string): void {
    this.generation++;
    if (uri) this.documents.invalidate(uri);
    else this.documents.clear();
  }

  async resolve(
    document: PhpDocument,
    source: SourceSpan,
    cancellation?: Cancellation
  ): Promise<CallResolution> {
    const generation = this.generation;
    const check = (): void => {
      checkCancellation(cancellation);
      if (this.generation !== generation) throw new PhpAnalysisError('cancelled');
    };
    check();
    const unresolved = (reason: CallResolution['reason']): CallResolution => ({
      callSite: source,
      targets: [],
      ...(reason ? { reason } : {})
    });
    if (
      this.map.incomplete ||
      relativeProjectPath(this.map.root, document.request.uri) === undefined
    )
      return unresolved('unsupported');
    const loaded = new Map<string, PhpDocument>([[document.request.uri, document]]);
    const attempted = new Set<string>([document.request.uri]);
    const checkedNames = new Set<string>();
    let sourceLength = document.request.text.length;
    let incomplete = sourceLength > this.limits.maxSourceLength;
    const safeDirectories = new Set<string>();

    const safePath = async (uri: string): Promise<boolean> => {
      const path = relativeProjectPath(this.map.root, uri);
      if (path === undefined) return false;
      const parts = path.split('/');
      let current = this.map.root;
      for (let i = 0; i <= parts.length; i++) {
        check();
        const final = i === parts.length;
        if (!final && safeDirectories.has(current)) {
          current += encodeURIComponent(parts[i]!) + (i === parts.length - 1 ? '' : '/');
          continue;
        }
        const kind = await this.host.stat(current);
        check();
        if (kind === 'missing') return false;
        if (kind !== (final ? 'file' : 'directory'))
          throw new PhpAnalysisError('unsupported-document');
        if (!final) {
          safeDirectories.add(current);
          current += encodeURIComponent(parts[i]!) + (i === parts.length - 1 ? '' : '/');
        }
      }
      return true;
    };

    const load = async (uri: string): Promise<void> => {
      if (attempted.has(uri)) return;
      attempted.add(uri);
      check();
      if (attempted.size > this.limits.maxDocuments) {
        incomplete = true;
        return;
      }
      try {
        if (!(await safePath(uri))) return;
        const request = await this.host.read(uri);
        check();
        if (!request || request.uri !== uri || request.languageId !== 'php') {
          incomplete = true;
          return;
        }
        sourceLength += request.text.length;
        if (sourceLength > this.limits.maxSourceLength) {
          incomplete = true;
          return;
        }
        loaded.set(uri, this.documents.get(request, cancellation));
      } catch (error) {
        check();
        if (error instanceof PhpAnalysisError && error.code === 'cancelled') throw error;
        // Errors may contain paths or source. Only an explicit generic state is exposed.
        incomplete = true;
      }
    };

    for (const uri of this.map.files) await load(uri);
    let completed = false;
    for (let round = 0; round < this.limits.maxDependencyRounds; round++) {
      check();
      const names = phpCallDependencies(document, source, [...loaded.values()]).filter(
        (name) => !checkedNames.has(name)
      );
      if (!names.length) {
        completed = true;
        break;
      }
      for (const name of names) {
        checkedNames.add(name);
        for (const uri of classFileCandidates(this.map, name)) await load(uri);
      }
    }
    check();
    if (incomplete || !completed) return unresolved('unsupported');
    const documents = [...loaded.values()];
    const result = resolvePhpCall(document, source, documents);
    if (result.reason === 'not-found') {
      const reference = phpCallReference(document, source, documents);
      if (
        reference.kind === 'method' &&
        !phpClasses(documents).some((item) =>
          reference.names.some((name) => item.name.toLowerCase() === name.toLowerCase())
        )
      )
        return unresolved('external');
    }
    return result;
  }
}
