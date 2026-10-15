export type {
  AnalysisRequest,
  AnalysisResult,
  CallResolution,
  CallTarget,
  Cancellation,
  FunctionDescriptor,
  LanguageAdapter,
  SourceSpan,
  StatementDescriptor,
  StatementKind,
  TextPosition
} from './language-adapter.js';
export { LanguageAdapterRegistry } from './adapter-registry.js';
export { resolveFunctionCall } from './resolve-function.js';
export type {
  DefinitionLocation,
  FunctionResolutionHost,
  ResolvedFunction
} from './resolve-function.js';
