export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

export interface SourceSpan {
  readonly uri: string;
  readonly start: TextPosition;
  readonly end: TextPosition;
}

export interface FunctionDescriptor {
  readonly symbolId: string;
  readonly name: string;
  readonly location: SourceSpan;
  readonly body: SourceSpan;
  readonly languageId: string;
}

export type StatementKind =
  | 'sequence'
  | 'branch'
  | 'loop'
  | 'call'
  | 'return'
  | 'throw'
  | 'break'
  | 'continue'
  | 'unsupported';

export interface StatementDescriptor {
  readonly id: string;
  readonly kind: StatementKind;
  readonly label: string;
  readonly location: SourceSpan;
  readonly children?: readonly StatementDescriptor[];
  readonly alternate?: readonly StatementDescriptor[];
}

export interface CallTarget {
  readonly symbolId: string;
  readonly definition: SourceSpan;
}

export interface CallResolution {
  readonly callSite: SourceSpan;
  readonly targets: readonly CallTarget[];
  readonly reason?: 'dynamic' | 'ambiguous' | 'not-found' | 'unsupported';
}

export interface AnalysisRequest {
  readonly uri: string;
  readonly text: string;
  readonly languageId: string;
  readonly documentVersion: number;
}

export interface Cancellation {
  readonly isCancellationRequested: boolean;
}

export interface AnalysisResult {
  readonly function: FunctionDescriptor;
  readonly statements: readonly StatementDescriptor[];
  readonly diagnostics: readonly string[];
}

export interface LanguageAdapter {
  readonly supportedLanguages: readonly string[];
  findFunction(request: AnalysisRequest, position: TextPosition): FunctionDescriptor | undefined;
  analyzeFunction(
    request: AnalysisRequest,
    symbol: FunctionDescriptor,
    cancellation?: Cancellation,
  ): Promise<AnalysisResult>;
  resolveCall(
    request: AnalysisRequest,
    callSite: SourceSpan,
    cancellation?: Cancellation,
  ): Promise<CallResolution>;
}
