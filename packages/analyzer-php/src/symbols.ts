import type { CallResolution, CallTarget, SourceSpan, TextPosition } from '@visual-code-flow/shared';
import { asNode, nameOf, nodeList, CLASS_KINDS, FUNCTION_KINDS, type PhpNode } from './ast.js';
import type { PhpDocument, PhpFunctionRecord } from './document.js';

export interface PhpClassRecord {
  readonly name: string;
  readonly node: PhpNode;
  readonly document: PhpDocument;
}
export interface PhpCallReference {
  readonly kind: 'function' | 'method' | 'direct' | 'dynamic';
  readonly names: readonly string[];
  readonly method?: string;
  readonly direct?: PhpFunctionRecord;
  readonly staticCall?: boolean;
  readonly evidence: string;
}
const normalized = (name: string): string => name.replace(/^\\/, '').toLowerCase();
const BUILTINS = new Set(['int', 'float', 'string', 'bool', 'array', 'object', 'callable', 'iterable', 'mixed', 'void', 'never', 'null', 'false', 'true']);

export function namespaceContainer(document: PhpDocument, node: PhpNode): PhpNode {
  for (let current: PhpNode | undefined = node; current; current = document.parentOf(current)) {
    if (current.kind === 'namespace') return current;
  }
  return document.ast;
}
export function namespaceOf(document: PhpDocument, node: PhpNode): string {
  const scope = namespaceContainer(document, node);
  return scope.kind === 'namespace' ? (nameOf(scope.name) ?? '') : '';
}

/** Imports belong to a namespace block, never to a project-wide alias table. */
export function resolvePhpName(
  document: PhpDocument,
  node: PhpNode,
  value: unknown,
  kind: 'class' | 'function' = 'class'
): readonly string[] {
  const raw = nameOf(value);
  if (!raw) return [];
  const name = raw.replace(/^\\/, '');
  if (raw.startsWith('\\') || asNode(value)?.resolution === 'fqn') return [name];
  const namespace = namespaceOf(document, node);
  if (name.toLowerCase().startsWith('namespace\\')) {
    const suffix = name.slice(10);
    return [namespace ? `${namespace}\\${suffix}` : suffix];
  }
  const parts = name.split('\\');
  const wanted = kind === 'function' && parts.length === 1 ? 'function' : 'class';
  const scope = namespaceContainer(document, node);
  for (const group of nodeList(scope.children).filter((item) => item.kind === 'usegroup')) {
    for (const item of nodeList(group.items)) {
      const importKind = item.type ?? group.type ?? 'class';
      if (importKind !== wanted) continue;
      const itemName = nameOf(item.name);
      if (!itemName) continue;
      const prefix = nameOf(group.name);
      const full = `${prefix ? prefix.replace(/\\$/, '') + '\\' : ''}${itemName}`.replace(/^\\/, '');
      const alias = nameOf(item.alias) ?? full.split('\\').at(-1)!;
      if (alias.toLowerCase() === parts[0]!.toLowerCase()) return [[full, ...parts.slice(1)].join('\\')];
    }
  }
  const qualified = namespace ? `${namespace}\\${name}` : name;
  return kind === 'function' && parts.length === 1 && namespace ? [qualified, name] : [qualified];
}

export function phpClasses(documents: readonly PhpDocument[]): readonly PhpClassRecord[] {
  return documents.flatMap((document) => document.nodes.flatMap((node) => {
    if (!CLASS_KINDS.has(node.kind) || !nameOf(node.name)) return [];
    const namespace = namespaceOf(document, node);
    return [{ name: `${namespace ? namespace + '\\' : ''}${nameOf(node.name)!}`, node, document }];
  }));
}

function conditionalDeclaration(document: PhpDocument, node: PhpNode): boolean {
  let parent = document.parentOf(node);
  while (parent) {
    if (!['namespace', 'program'].includes(parent.kind)) return true;
    parent = document.parentOf(parent);
  }
  return false;
}

export function findPhpCall(document: PhpDocument, source: SourceSpan): PhpNode | undefined {
  if (source.uri !== document.request.uri) return undefined;
  const start = document.source.offsetAt(source.start);
  const end = document.source.offsetAt(source.end);
  if (start === undefined || end === undefined) return undefined;
  return document.nodes.find((node) => {
    if (!['call', 'new'].includes(node.kind)) return false;
    const [a, b] = document.source.offsets(node);
    return a === start && b === end;
  });
}
export function phpCalleePosition(document: PhpDocument, source: SourceSpan): TextPosition | undefined {
  const node = findPhpCall(document, source);
  const what = asNode(node?.what);
  if (!node || !what) return undefined;
  const name = ['propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(what.kind)
    ? asNode(what.offset)
    : what;
  return name && ['name', 'identifier', 'selfreference', 'parentreference', 'staticreference'].includes(name.kind)
    ? document.source.span(name).start
    : undefined;
}
function enclosingFunction(document: PhpDocument, node: PhpNode): PhpFunctionRecord | undefined {
  const [start, end] = document.source.offsets(node);
  return document.functions.filter((fn) => fn.start <= start && fn.end >= end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}
function specialClass(document: PhpDocument, node: PhpNode, value: unknown, fn?: PhpFunctionRecord): readonly string[] {
  const type = asNode(value);
  const name = nameOf(value)?.toLowerCase();
  if (type && !['name', 'identifier', 'typereference', 'selfreference', 'parentreference', 'staticreference'].includes(type.kind)) return [];
  if (type?.kind === 'staticreference' || name === 'static') return [];
  if (type?.kind === 'selfreference' || name === 'self') return fn?.ownerName ? [fn.ownerName] : [];
  if (type?.kind === 'parentreference' || name === 'parent') {
    return fn?.owner ? resolvePhpName(document, fn.owner, fn.owner.extends) : [];
  }
  if (type && !['name', 'identifier', 'typereference'].includes(type.kind)) return [];
  return resolvePhpName(document, node, value);
}
function typeNames(document: PhpDocument, node: PhpNode, value: unknown, fn?: PhpFunctionRecord): readonly string[] {
  const type = asNode(value);
  if (type && ['uniontype', 'intersectiontype'].includes(type.kind)) return nodeList(type.types).flatMap((part) => typeNames(document, node, part, fn));
  const name = nameOf(value);
  if (name && BUILTINS.has(name.toLowerCase())) return [];
  return specialClass(document, node, value, fn);
}
function propertyTypes(record: PhpClassRecord, property: string, records: readonly PhpClassRecord[], visited = new Set<string>(), accessOwner = record.name): readonly string[] {
  if (visited.has(normalized(record.name))) return [];
  visited.add(normalized(record.name));
  for (const member of nodeList(record.node.body)) {
    if (member.kind === 'propertystatement') {
      for (const item of nodeList(member.properties)) {
        if (nameOf(item.name) === property) {
          if (member.isStatic === true || (member.visibility === 'private' && normalized(record.name) !== normalized(accessOwner))) return [];
          return typeNames(record.document, item, item.type ?? member.type);
        }
      }
    }
    if (member.kind === 'method' && nameOf(member.name)?.toLowerCase() === '__construct') {
      const parameter = nodeList(member.arguments).find((item) => nameOf(item.name) === property && typeof item.flags === 'number' && item.flags > 0);
      if (parameter) {
        if (parameter.flags === 4 && normalized(record.name) !== normalized(accessOwner)) return [];
        return typeNames(record.document, parameter, parameter.type);
      }
    }
  }
  const parentName = resolvePhpName(record.document, record.node, record.node.extends)[0];
  const parents = records.filter((item) => normalized(item.name) === normalized(parentName ?? ''));
  return parents.length === 1 ? propertyTypes(parents[0]!, property, records, visited, accessOwner) : [];
}

function hasThis(document: PhpDocument, fn: PhpFunctionRecord | undefined): boolean {
  if (!fn?.ownerName) return false;
  for (let current: PhpFunctionRecord | undefined = fn; current; current = document.functions.find((item) => item.descriptor.symbolId === current?.enclosingSymbolId)) {
    if (current.node.isStatic === true) return false;
  }
  return true;
}

function reboundBefore(document: PhpDocument, fn: PhpFunctionRecord, variable: string, call: PhpNode): boolean {
  const offset = document.source.offsets(call)[0];
  for (const node of document.nodes) {
    if (node.kind !== 'variable' || node.name !== variable) continue;
    const start = document.source.offsets(node)[0];
    if (start < fn.start || start >= offset) continue;
    let child = node;
    for (let parent = document.parentOf(child); parent; parent = document.parentOf(child)) {
      if (FUNCTION_KINDS.has(parent.kind)) break;
      if ((parent.kind === 'assign' || parent.kind === 'assignref') && parent.left === child) return true;
      if (['pre', 'post', 'unset', 'global', 'staticvariable'].includes(parent.kind)) return true;
      if (parent.kind === 'foreach' && (parent.value === child || parent.key === child)) return true;
      if (parent.kind === 'call' && nodeList(parent.arguments).includes(child)) return true;
      child = parent;
    }
  }
  return false;
}
function isSubclass(name: string, ancestor: string, records: readonly PhpClassRecord[], seen = new Set<string>()): boolean {
  if (normalized(name) === normalized(ancestor)) return true;
  if (seen.has(normalized(name)) || seen.size >= 32) return false;
  seen.add(normalized(name));
  const matches = records.filter((record) => normalized(record.name) === normalized(name));
  if (matches.length !== 1) return false;
  const record = matches[0]!;
  const parent = resolvePhpName(record.document, record.node, record.node.extends)[0];
  return !!parent && isSubclass(parent, ancestor, records, seen);
}

/** Literal constructor and declared-type evidence is navigation, not a runtime trace. */
export function phpCallReference(document: PhpDocument, source: SourceSpan, documents: readonly PhpDocument[] = [document]): PhpCallReference {
  const node = findPhpCall(document, source);
  const dynamic: PhpCallReference = { kind: 'dynamic', names: [], evidence: 'Dynamic or unsupported PHP call target.' };
  if (!node || nodeList(node.arguments).some((arg) => arg.kind === 'variadicplaceholder')) return dynamic;
  const fn = enclosingFunction(document, node);
  const what = asNode(node.what);
  if (!what) return dynamic;
  if (node.kind === 'new') {
    const names = specialClass(document, node, what, fn);
    return names.length ? { kind: 'method', names, method: '__construct', evidence: 'Explicit construction; navigates to its declared constructor.' } : dynamic;
  }
  if (['closure', 'arrowfunc'].includes(what.kind)) {
    const direct = document.functions.find((item) => item.node === what);
    return direct ? { kind: 'direct', names: [], direct, evidence: 'Directly invoked closure.' } : dynamic;
  }
  if (['name', 'identifier'].includes(what.kind)) return { kind: 'function', names: resolvePhpName(document, node, what, 'function'), evidence: 'Statically named function declaration.' };
  if (!['propertylookup', 'nullsafepropertylookup', 'staticlookup'].includes(what.kind)) return dynamic;
  const methodNode = asNode(what.offset);
  const method = methodNode?.kind === 'identifier' ? nameOf(methodNode) : undefined;
  const receiver = asNode(what.what);
  if (!method || !receiver) return dynamic;
  let names: readonly string[] = [];
  let evidence = 'Declared receiver type; runtime overrides are not established.';
  const staticCall = what.kind === 'staticlookup';
  if (staticCall) {
    names = specialClass(document, node, receiver, fn);
    evidence = 'Statically named method declaration; not a runtime execution trace.';
  } else if (receiver.kind === 'new') {
    names = specialClass(document, receiver, receiver.what, fn);
    evidence = 'Method of an explicitly constructed class.';
  } else if (receiver.kind === 'variable' && typeof receiver.name === 'string') {
    if (receiver.name === 'this') {
      if (fn?.ownerName && hasThis(document, fn)) names = [fn.ownerName];
    } else {
      const parameter = nodeList(fn?.node.arguments).find((item) => nameOf(item.name) === receiver.name);
      if (parameter && fn && !reboundBefore(document, fn, receiver.name, node)) names = typeNames(document, parameter, parameter.type, fn);
    }
  } else if (receiver.kind === 'propertylookup' && asNode(receiver.what)?.kind === 'variable' && asNode(receiver.what)?.name === 'this' && fn?.ownerName && hasThis(document, fn)) {
    const property = asNode(receiver.offset);
    const records = phpClasses(documents);
    const owners = records.filter((item) => normalized(item.name) === normalized(fn.ownerName!));
    if (property?.kind === 'identifier' && nameOf(property) && owners.length === 1) names = propertyTypes(owners[0]!, nameOf(property)!, records);
  }
  return names.length ? { kind: 'method', names: [...new Set(names)], method, staticCall, evidence } : dynamic;
}

export function phpClassDependencies(record: PhpClassRecord): readonly string[] {
  return [
    ...resolvePhpName(record.document, record.node, record.node.extends),
    ...nodeList(record.node.body).filter((node) => node.kind === 'traituse').flatMap((use) => nodeList(use.traits).flatMap((trait) => resolvePhpName(record.document, use, trait)))
  ];
}
export function phpCallDependencies(document: PhpDocument, source: SourceSpan, documents: readonly PhpDocument[]): readonly string[] {
  const reference = phpCallReference(document, source, documents);
  const call = findPhpCall(document, source);
  const fn = call ? enclosingFunction(document, call) : undefined;
  return [...new Set([
    ...(reference.kind === 'method' ? reference.names : []),
    ...(fn?.ownerName ? [fn.ownerName] : []),
    ...phpClasses(documents).flatMap(phpClassDependencies)
  ])];
}

interface MethodResult { readonly functions: readonly PhpFunctionRecord[]; readonly unsafe: boolean; }
function findMethod(record: PhpClassRecord, method: string, records: readonly PhpClassRecord[], visited: ReadonlySet<string> = new Set()): MethodResult {
  const key = normalized(record.name);
  if (visited.has(key) || visited.size > 32 || conditionalDeclaration(record.document, record.node)) return { functions: [], unsafe: true };
  const seen = new Set([...visited, key]);
  const functions = record.document.functions.filter((fn) => fn.owner === record.node && fn.node.kind === 'method' && nameOf(fn.node.name)?.toLowerCase() === method.toLowerCase());
  if (functions.length) return { functions, unsafe: false };
  // An abstract override blocks an inherited concrete implementation.
  if (nodeList(record.node.body).some((node) => node.kind === 'method' && nameOf(node.name)?.toLowerCase() === method.toLowerCase())) return { functions: [], unsafe: true };
  const uses = nodeList(record.node.body).filter((node) => node.kind === 'traituse');
  if (uses.some((use) => nodeList(use.adaptations).length > 0)) return { functions: [], unsafe: true };
  const traits: PhpFunctionRecord[] = [];
  for (const use of uses) {
    for (const trait of nodeList(use.traits)) {
      const name = resolvePhpName(record.document, use, trait)[0];
      const matches = records.filter((item) => normalized(item.name) === normalized(name ?? ''));
      if (matches.length !== 1) return { functions: [], unsafe: true };
      const result = findMethod(matches[0]!, method, records, seen);
      if (result.unsafe) return result;
      traits.push(...result.functions);
    }
  }
  if (traits.length) return { functions: traits, unsafe: false };
  const parent = resolvePhpName(record.document, record.node, record.node.extends)[0];
  if (!parent) return { functions: [], unsafe: false };
  const matches = records.filter((item) => normalized(item.name) === normalized(parent));
  return matches.length === 1 ? findMethod(matches[0]!, method, records, seen) : { functions: [], unsafe: true };
}

/** Resolve source definitions. Interfaces, duplicate declarations and magic stay explicit. */
export function resolvePhpCall(document: PhpDocument, source: SourceSpan, documents: readonly PhpDocument[] = [document]): CallResolution {
  const reference = phpCallReference(document, source, documents);
  const unresolved = (reason: CallResolution['reason']): CallResolution => ({ callSite: source, targets: [], ...(reason ? { reason } : {}) });
  let functions: readonly PhpFunctionRecord[] = [];
  if (reference.kind === 'dynamic') return unresolved('dynamic');
  if (reference.kind === 'direct') functions = reference.direct ? [reference.direct] : [];
  if (reference.kind === 'function') {
    for (const name of reference.names) {
      const found = documents.flatMap((item) => item.functions.filter((fn) => fn.node.kind === 'function' && normalized(fn.descriptor.name) === normalized(name)));
      if (!found.length) continue;
      if (found.some((fn) => {
        const owner = documents.find((item) => item.request.uri === fn.descriptor.location.uri)!;
        return conditionalDeclaration(owner, fn.node);
      })) return unresolved('dynamic');
      functions = found;
      break;
    }
  }
  if (reference.kind === 'method') {
    if (reference.names.length !== 1) return unresolved('ambiguous');
    const records = phpClasses(documents);
    const matches = records.filter((item) => normalized(item.name) === normalized(reference.names[0]!));
    if (!matches.length) return unresolved('not-found');
    if (matches.length !== 1) return unresolved('ambiguous');
    if (matches[0]!.node.kind === 'interface') return unresolved('unsupported');
    const result = findMethod(matches[0]!, reference.method!, records);
    if (result.unsafe) return unresolved('unsupported');
    functions = result.functions;
    if (!functions.length) {
      const magic = findMethod(matches[0]!, reference.staticCall ? '__callStatic' : '__call', records);
      if (magic.functions.length) return unresolved('dynamic');
    }
    if (reference.staticCall && functions.some((fn) => fn.node.isStatic !== true)) {
      const call = findPhpCall(document, source)!;
      const current = enclosingFunction(document, call);
      const receiver = asNode(asNode(call.what)?.what);
      if (!current || current.node.isStatic === true || !['selfreference', 'parentreference'].includes(receiver?.kind ?? '')) return unresolved('unsupported');
    }
  }
  if (!functions.length) return unresolved('not-found');
  const unique = [...new Map(functions.map((fn) => [fn.descriptor.symbolId, fn])).values()];
  if (unique.length !== 1) return unresolved('ambiguous');
  const fn = unique[0]!;
  if (fn.node.kind === 'method' && ['private', 'protected'].includes(String(fn.node.visibility))) {
    const call = findPhpCall(document, source)!;
    const current = enclosingFunction(document, call);
    const ownerName = fn.ownerName;
    if (!current?.ownerName || !ownerName || fn.owner?.kind === 'trait') return unresolved('unsupported');
    if (fn.node.visibility === 'private' ? normalized(current.ownerName) !== normalized(ownerName) : !isSubclass(current.ownerName, ownerName, phpClasses(documents))) return unresolved('unsupported');
  }
  const target: CallTarget = { symbolId: fn.descriptor.symbolId, definition: fn.definition, evidence: reference.evidence };
  return { callSite: source, targets: [target] };
}
