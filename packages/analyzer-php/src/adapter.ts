import { PhpStatementExtractor } from './statements.js';
import type {
  AnalysisRequest,
  AnalysisResult,
  CallResolution,
  Cancellation,
  FunctionDescriptor,
  LanguageAdapter,
  SourceSpan,
  TextPosition
} from '@visual-code-flow/shared';
import {
  PhpAnalysisError,
  PhpDocumentCache,
  checkCancellation,
  type PhpDocument,
  type PhpParserLimits
} from './document.js';

export class PhpLanguageAdapter implements LanguageAdapter {
  readonly supportedLanguages = Object.freeze(['php']);
  readonly documents: PhpDocumentCache;

  constructor(limits: Partial<PhpParserLimits> = {}) {
    this.documents = new PhpDocumentCache(limits);
  }

  parseDocument(request: AnalysisRequest, cancellation?: Cancellation): PhpDocument {
    return this.documents.get(request, cancellation);
  }

  findFunction(request: AnalysisRequest, position: TextPosition): FunctionDescriptor | undefined {
    const document = this.parseDocument(request);
    const offset = document.source.offsetAt(position);
    if (offset === undefined) return undefined;
    return document.functions
      .filter((fn) => offset >= fn.start && offset < fn.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.descriptor;
  }

  findFunctionDefinition(
    request: AnalysisRequest,
    position: TextPosition
  ): FunctionDescriptor | undefined {
    const document = this.parseDocument(request);
    const offset = document.source.offsetAt(position);
    if (offset === undefined) return undefined;
    return document.functions.find((fn) => {
      const start = document.source.offsetAt(fn.definition.start)!;
      const end = document.source.offsetAt(fn.definition.end)!;
      // Anonymous unbound closures are identified only by their declaration start.
      return start === fn.start && end === fn.end
        ? offset === start
        : offset >= start && offset < end;
    })?.descriptor;
  }

  async analyzeFunction(
    request: AnalysisRequest,
    symbol: FunctionDescriptor,
    cancellation?: Cancellation
  ): Promise<AnalysisResult> {
    const document = this.parseDocument(request, cancellation);
    const fn = document.functions.find((item) => item.descriptor.symbolId === symbol.symbolId);
    if (!fn || symbol.location.uri !== request.uri) throw new PhpAnalysisError('stale-symbol');
    checkCancellation(cancellation);
    return new PhpStatementExtractor(document, fn, cancellation).analyze();
  }

  async resolveCall(
    _request: AnalysisRequest,
    callSite: SourceSpan,
    cancellation?: Cancellation
  ): Promise<CallResolution> {
    checkCancellation(cancellation);
    return { callSite, targets: [], reason: 'unsupported' };
  }
}
