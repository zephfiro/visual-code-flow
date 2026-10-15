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
  | 'selection'
  | 'try'
  | 'exit'
  | 'call'
  | 'return'
  | 'throw'
  | 'break'
  | 'continue'
  | 'unsupported';

export type ConditionDescriptor =
  | {
      readonly kind: 'test';
      readonly id: string;
      readonly label: string;
      readonly location: SourceSpan;
      readonly evaluation?: readonly StatementDescriptor[];
      readonly constant?: boolean;
      readonly mayThrow?: boolean;
    }
  | {
      readonly kind: 'and' | 'or';
      readonly left: ConditionDescriptor;
      readonly right: ConditionDescriptor;
    }
  | { readonly kind: 'not'; readonly operand: ConditionDescriptor }
  | {
      readonly kind: 'choice';
      readonly test: ConditionDescriptor;
      readonly whenTrue: ConditionDescriptor;
      readonly whenFalse: ConditionDescriptor;
    };

export interface SelectionArm {
  readonly id: string;
  readonly label: string;
  readonly location: SourceSpan;
  readonly tests: readonly ConditionDescriptor[];
  readonly body: readonly StatementDescriptor[];
  readonly isDefault?: boolean;
}

export interface CatchDescriptor {
  readonly id: string;
  readonly label: string;
  readonly location: SourceSpan;
  readonly body: readonly StatementDescriptor[];
  readonly catchesAll?: boolean;
}

export interface StatementReference {
  readonly id: string;
  readonly label: string;
  readonly location: SourceSpan;
  readonly reason: string;
}

export interface StatementDescriptor {
  readonly id: string;
  readonly kind: StatementKind;
  readonly label: string;
  readonly location: SourceSpan;
  readonly children?: readonly StatementDescriptor[];
  readonly alternate?: readonly StatementDescriptor[];
  readonly condition?: ConditionDescriptor;
  readonly initialization?: readonly StatementDescriptor[];
  readonly update?: readonly StatementDescriptor[];
  readonly loopMode?: 'pretest' | 'posttest';
  readonly jumpLevel?: number;
  readonly mayThrow?: boolean;
  readonly terminal?: boolean;
  readonly selection?: {
    readonly arms: readonly SelectionArm[];
    readonly fallthrough: boolean;
    readonly breakable: boolean;
    readonly countForContinue: boolean;
    readonly unmatched: 'normal' | 'throw';
  };
  readonly handlers?: readonly CatchDescriptor[];
  readonly finalizer?: {
    readonly location: SourceSpan;
    readonly statements: readonly StatementDescriptor[];
  };
  readonly references?: readonly StatementReference[];
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
  /** Optional precise callee location for an editor definition provider. */
  findCallTargetPosition?(request: AnalysisRequest, callSite: SourceSpan): TextPosition | undefined;
  /** Optional declaration lookup when providers point outside a function body. */
  findFunctionDefinition?(
    request: AnalysisRequest,
    position: TextPosition
  ): FunctionDescriptor | undefined;
  analyzeFunction(
    request: AnalysisRequest,
    symbol: FunctionDescriptor,
    cancellation?: Cancellation
  ): Promise<AnalysisResult>;
  resolveCall(
    request: AnalysisRequest,
    callSite: SourceSpan,
    cancellation?: Cancellation
  ): Promise<CallResolution>;
}
