import { asNode, nameOf, nodeList, type PhpNode } from './ast.js';
import type { PhpDocument } from './document.js';
import { projectFileUri, relativeProjectPath } from './composer.js';
import { resolvePhpName } from './symbols.js';

export interface LaravelCallStep {
  readonly name: string;
  readonly node: PhpNode;
  readonly arguments: readonly PhpNode[];
}
export interface LaravelCallChain {
  readonly receiver: PhpNode;
  readonly steps: readonly LaravelCallStep[];
}

/** A literal PHP string only. Interpolation, constants and expressions are not evaluated. */
export function laravelString(value: unknown): string | undefined {
  const node = asNode(value);
  return node?.kind === 'string' && typeof node.value === 'string' ? node.value : undefined;
}

export function laravelList(value: unknown): readonly PhpNode[] | undefined {
  const node = asNode(value);
  if (node?.kind !== 'array') return undefined;
  const entries = nodeList(node.items);
  if (
    entries.some(
      (entry, i) =>
        entry.kind !== 'entry' ||
        entry.unpack === true ||
        entry.byRef === true ||
        (entry.key != null &&
          !(asNode(entry.key)?.kind === 'number' && String(asNode(entry.key)?.value) === String(i)))
    )
  )
    return undefined;
  const values = entries.map((entry) => asNode(entry.value));
  return values.every((entry) => entry !== undefined) ? values : undefined;
}

export function laravelMap(value: unknown): ReadonlyMap<string, PhpNode> | undefined {
  const node = asNode(value);
  if (node?.kind !== 'array') return undefined;
  const result = new Map<string, PhpNode>();
  for (const entry of nodeList(node.items)) {
    const key = laravelString(entry.key);
    const item = asNode(entry.value);
    if (
      entry.kind !== 'entry' ||
      entry.unpack === true ||
      entry.byRef === true ||
      key === undefined ||
      !item ||
      result.has(key)
    )
      return undefined;
    result.set(key, item);
  }
  return result;
}

export function laravelStrings(value: unknown): readonly string[] | undefined {
  const scalar = laravelString(value);
  if (scalar !== undefined) return [scalar];
  const entries = laravelList(value);
  if (!entries) return undefined;
  const strings = entries.map(laravelString);
  return strings.every((entry) => entry !== undefined) ? strings : undefined;
}

export function laravelClass(document: PhpDocument, value: unknown): string | undefined {
  const node = asNode(value);
  if (
    node?.kind !== 'staticlookup' ||
    asNode(node.what)?.kind !== 'name' ||
    nameOf(node.offset)?.toLowerCase() !== 'class'
  )
    return undefined;
  const names = resolvePhpName(document, node, node.what);
  return names.length === 1 ? names[0] : undefined;
}

/** Flatten only syntactically direct static/fluent calls, never variable receivers. */
export function laravelChain(value: unknown): LaravelCallChain | undefined {
  let node = asNode(value);
  const steps: LaravelCallStep[] = [];
  while (node?.kind === 'call' && steps.length < 64) {
    const lookup = asNode(node.what);
    const method = asNode(lookup?.offset);
    if (
      !lookup ||
      !['propertylookup', 'staticlookup'].includes(lookup.kind) ||
      method?.kind !== 'identifier' ||
      typeof method.name !== 'string'
    )
      return undefined;
    const args = nodeList(node.arguments);
    if (args.some((arg) => ['variadic', 'variadicplaceholder'].includes(arg.kind)))
      return undefined;
    steps.unshift({ name: method.name, node, arguments: args });
    const receiver = asNode(lookup.what);
    if (lookup.kind === 'staticlookup') return receiver ? { receiver, steps } : undefined;
    node = receiver;
  }
  return undefined;
}

export function laravelArgument(
  step: LaravelCallStep,
  index: number,
  ...names: readonly string[]
): PhpNode | undefined {
  const named = step.arguments.find(
    (node) => node.kind === 'namedargument' && names.includes(String(node.name))
  );
  if (named) return asNode(named.value);
  const positional = step.arguments[index];
  return positional?.kind === 'namedargument' ? undefined : positional;
}

export function laravelFrameworkReceiver(
  document: PhpDocument,
  chain: LaravelCallChain,
  expected: string,
  alias?: string
): 'exact' | 'conventional' | undefined {
  if (chain.receiver.kind !== 'name') return undefined;
  const names = resolvePhpName(document, chain.receiver, chain.receiver);
  if (names.length !== 1) return undefined;
  if (names[0]!.toLowerCase() === expected.toLowerCase()) return 'exact';
  if (
    alias &&
    names[0] === alias &&
    !document.nodes.some(
      (node) =>
        ['class', 'trait', 'interface', 'enum'].includes(node.kind) &&
        nameOf(node.name)?.toLowerCase() === alias.toLowerCase()
    )
  )
    return 'conventional';
  return undefined;
}

/** Resolve a small, documented path-expression grammar as data, inside one Composer root. */
export function laravelPath(
  document: PhpDocument,
  value: unknown,
  root: string
): string | undefined {
  const relative = relativeProjectPath(root, document.request.uri);
  if (relative === undefined) return undefined;
  type PathValue = { text: string; anchored: boolean };
  const evaluate = (input: unknown, depth = 0): PathValue | undefined => {
    if (depth > 24) return undefined;
    const node = asNode(input);
    const literal = laravelString(node);
    if (literal !== undefined) return { text: literal, anchored: false };
    if (node?.kind === 'magic' && node.value === '__DIR__')
      return { text: '/' + relative.split('/').slice(0, -1).join('/'), anchored: true };
    if (node?.kind === 'bin' && node.type === '.') {
      const left = evaluate(node.left, depth + 1);
      const right = evaluate(node.right, depth + 1);
      if (!left || !right || right.anchored) return undefined;
      return { text: left.text + right.text, anchored: left.anchored };
    }
    if (node?.kind === 'call' && asNode(node.what)?.kind === 'name') {
      const names = resolvePhpName(document, node, node.what, 'function');
      const name = nameOf(node.what)?.replace(/^\\/, '');
      // Namespaced fallbacks can be overridden. Only a definite global name is accepted.
      if (!name || names.length !== 1 || names[0] !== name) return undefined;
      if (document.functions.some((fn) => fn.descriptor.name === name)) return undefined;
      const args = nodeList(node.arguments);
      if (args.length !== 1) return undefined;
      if (name === 'base_path') {
        const path = laravelString(args[0]);
        return path !== undefined && !path.startsWith('/')
          ? { text: '/' + path, anchored: true }
          : undefined;
      }
      if (name === 'dirname') {
        const path = evaluate(args[0], depth + 1);
        if (!path?.anchored || path.text === '/') return undefined;
        const at = path.text.lastIndexOf('/');
        return { text: path.text.slice(0, at) || '/', anchored: true };
      }
    }
    return undefined;
  };
  const valuePath = evaluate(value);
  if (
    !valuePath ||
    (!valuePath.anchored && valuePath.text.startsWith('/')) ||
    /[:?#%\\]/.test(valuePath.text) ||
    [...valuePath.text].some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  const parts: string[] = [];
  for (const part of valuePath.text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const uri = projectFileUri(root, parts.join('/'));
  return uri?.toLowerCase().endsWith('.php') && !uri.toLowerCase().endsWith('.blade.php')
    ? uri
    : undefined;
}
