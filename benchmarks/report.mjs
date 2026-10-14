import { performance } from 'node:perf_hooks';
import { TypeScriptLanguageAdapter } from '../packages/analyzer-typescript/dist/index.js';
import {
  buildControlFlowGraph,
  SourceMapIndex
} from '../packages/flow-core/dist/index.js';

const lines = ['function calculate(input: number): number {', '  let value = input;'];
for (let i = 0; i < 196; i += 1) {
  lines.push(`  value += ${i};`);
}
lines.push('  return value;', '}');
const request = {
  uri: 'file:///reference-benchmark.ts',
  text: lines.join('\n'),
  documentVersion: 1,
  languageId: 'typescript'
};
const adapter = new TypeScriptLanguageAdapter();

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}
const analysisMs = [];
let graph;
for (let run = 0; run < 15; run += 1) {
  const start = performance.now();
  const symbol = adapter.findFunction(request, { line: 20, character: 4 });
  if (!symbol) throw new Error('Benchmark symbol was not found');
  const analysis = await adapter.analyzeFunction(request, symbol);
  graph = buildControlFlowGraph(analysis);
  analysisMs.push(performance.now() - start);
}
const index = new SourceMapIndex(graph);
const highlightMs = [];
for (let run = 0; run < 100; run += 1) {
  const start = performance.now();
  index.findNode(request.uri, { line: 110, character: 4 });
  highlightMs.push(performance.now() - start);
}

const report = {
  environment: `Node ${process.version}, ${process.platform}, ${process.arch}`,
  fixtureLines: lines.length,
  graphNodes: graph.nodes.length,
  analysisP95Ms: Number(p95(analysisMs).toFixed(2)),
  sourceMappingP95Ms: Number(p95(highlightMs).toFixed(3)),
  targetAnalysisMs: 1000,
  targetSourceMappingMs: 100,
  note: 'Synthetic single-process benchmark; source mapping is not UI rendering latency.'
};
console.log(JSON.stringify(report, null, 2));
if (process.env.STRICT_PERF === '1') {
  if (report.analysisP95Ms > report.targetAnalysisMs) process.exitCode = 1;
  if (report.sourceMappingP95Ms > report.targetSourceMappingMs) process.exitCode = 1;
}
