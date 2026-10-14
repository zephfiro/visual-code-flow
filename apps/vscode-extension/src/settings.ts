import * as vscode from 'vscode';

export interface FlowSettings {
  readonly autoRefresh: boolean;
  readonly refreshDebounceMs: number;
  readonly maxExpansionDepth: number;
  readonly layoutDirection: 'TB' | 'LR';
}

export function readFlowSettings(): FlowSettings {
  const config = vscode.workspace.getConfiguration('visualCodeFlow');
  return {
    autoRefresh: config.get<boolean>('autoRefresh', true),
    refreshDebounceMs: config.get<number>('refreshDebounceMs', 400),
    maxExpansionDepth: config.get<number>('maxExpansionDepth', 3),
    layoutDirection: config.get<'TB' | 'LR'>('layoutDirection', 'TB')
  };
}
