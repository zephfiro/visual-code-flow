import { useMemo, useState } from 'react';
import {
  defaultFlowDetail,
  presentFlowGraph,
  type FlowDetail,
  type FlowGraph
} from '@visual-code-flow/flow-core';

/** View-only preferences: switching detail never rewrites the host graph or its source IDs. */
export function useFlowPresentation() {
  const [graph, setGraph] = useState<FlowGraph | undefined>();
  const [preferences, setPreferences] = useState<Partial<Record<FlowDetail, FlowDetail>>>({});
  const defaultDetail = graph ? defaultFlowDetail(graph) : 'detailed';
  const detail = preferences[defaultDetail] ?? defaultDetail;
  const setDetail = (next: FlowDetail): void => {
    setPreferences((current) => ({ ...current, [defaultDetail]: next }));
  };
  const presentation = useMemo(
    () => (graph ? presentFlowGraph(graph, detail) : undefined),
    [graph, detail]
  );
  return { graph, setGraph, detail, setDetail, presentation };
}
