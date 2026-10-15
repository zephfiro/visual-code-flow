export const FLOW_SCHEMA_VERSION = 2 as const;

export type FlowNodeKind =
  | 'entry'
  | 'exit'
  | 'condition'
  | 'operation'
  | 'call'
  | 'loop'
  | 'return'
  | 'throw'
  | 'merge'
  | 'unsupported';

export type FlowEdgeKind =
  'normal' | 'true' | 'false' | 'loop-back' | 'break' | 'continue' | 'exception' | 'reference';

export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface SourceLocation {
  readonly uri: string;
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface FlowNode {
  readonly id: string;
  readonly kind: FlowNodeKind;
  readonly label: string;
  readonly source?: SourceLocation;
  readonly expandable: boolean;
  readonly targetSymbolId?: string;
  readonly parentNodeId?: string;
}

export interface FlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: FlowEdgeKind;
  readonly label?: string;
}

export interface FlowDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly source?: SourceLocation;
}

export interface FlowGraph {
  readonly schemaVersion: typeof FLOW_SCHEMA_VERSION;
  readonly rootSymbolId: string;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly diagnostics: readonly FlowDiagnostic[];
}
