import type { Cancellation, SourceSpan } from '@visual-code-flow/shared';
import { asNode, childrenOf, nameOf, nodeList, FUNCTION_KINDS, type PhpNode } from './ast.js';
import { checkCancellation, type PhpDocument } from './document.js';
import { resolvePhpName } from './symbols.js';
import {
  laravelArgument,
  laravelChain,
  laravelClass,
  laravelFrameworkReceiver,
  laravelList,
  laravelMap,
  laravelPath,
  laravelString,
  laravelStrings,
  type LaravelCallStep
} from './laravel-syntax.js';

export interface LaravelRouteContext {
  readonly prefix: string | undefined;
  readonly namePrefix: string | undefined;
  readonly middleware: readonly string[];
  readonly withoutMiddleware: readonly string[];
  readonly controller: string | undefined;
  readonly handlerContextUnknown: boolean;
  readonly namespace: string | undefined;
  readonly domain: string | undefined;
  readonly partial: boolean;
  readonly diagnostics: readonly string[];
}
export type LaravelRouteHandler =
  | { readonly kind: 'closure'; readonly definition: SourceSpan }
  | { readonly kind: 'controller'; readonly className: string; readonly method: string }
  | { readonly kind: 'unresolved'; readonly reason: 'dynamic' | 'unsupported' };
export interface LaravelRoute {
  readonly id: string;
  readonly source: SourceSpan;
  readonly methods: readonly string[];
  readonly path: string | undefined;
  readonly name: string | undefined;
  readonly middleware: readonly string[];
  readonly withoutMiddleware: readonly string[];
  readonly domain: string | undefined;
  readonly handler: LaravelRouteHandler;
  readonly partial: boolean;
  readonly diagnostics: readonly string[];
}
export interface LaravelRouteInclude {
  readonly uri: string;
  readonly source: SourceSpan;
  readonly context: LaravelRouteContext;
}
export interface LaravelRouteExtraction {
  readonly routes: readonly LaravelRoute[];
  readonly includes: readonly LaravelRouteInclude[];
  readonly diagnostics: readonly string[];
  readonly partial: boolean;
}
export const LARAVEL_ROUTE_CONTEXT: LaravelRouteContext = Object.freeze({
  prefix: '',
  namePrefix: '',
  middleware: [],
  withoutMiddleware: [],
  controller: undefined,
  handlerContextUnknown: false,
  namespace: undefined,
  domain: undefined,
  partial: false,
  diagnostics: []
});
const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'QUERY'];
const HTTP = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'query']);
const RESOURCES = [
  ['index', ['GET', 'HEAD'], ''],
  ['create', ['GET', 'HEAD'], '/create'],
  ['store', ['POST'], ''],
  ['show', ['GET', 'HEAD'], '/{parameter}'],
  ['edit', ['GET', 'HEAD'], '/{parameter}/edit'],
  ['update', ['PUT', 'PATCH'], '/{parameter}'],
  ['destroy', ['DELETE'], '/{parameter}']
] as const;
const ROUTE_FACADE = 'Illuminate\\Support\\Facades\\Route';
const APPLICATION = 'Illuminate\\Foundation\\Application';
const PROVIDERS = [
  'Illuminate\\Support\\ServiceProvider',
  'Illuminate\\Foundation\\Support\\Providers\\RouteServiceProvider'
];
const joinPath = (a: string, b: string): string =>
  '/' + [a.replace(/^\/+|\/+$/g, ''), b.replace(/^\/+|\/+$/g, '')].filter(Boolean).join('/');
const note = (context: LaravelRouteContext, message: string): LaravelRouteContext => ({
  ...context,
  partial: true,
  diagnostics: [...new Set([...context.diagnostics, message])].slice(0, 24)
});

/** Declarative references only. A registered route is not a controller execution edge. */
export function extractLaravelRoutes(
  document: PhpDocument,
  root: string,
  initial: Partial<LaravelRouteContext> = {},
  cancellation?: Cancellation
): LaravelRouteExtraction {
  return new LaravelRouteExtractor(document, root, cancellation).extract({
    ...LARAVEL_ROUTE_CONTEXT,
    ...initial
  });
}

class LaravelRouteExtractor {
  private readonly routes: LaravelRoute[] = [];
  private readonly includes: LaravelRouteInclude[] = [];
  private readonly diagnostics = new Set<string>();
  private visited = 0;

  constructor(
    private readonly document: PhpDocument,
    private readonly root: string,
    private readonly cancellation?: Cancellation
  ) {}

  extract(context: LaravelRouteContext): LaravelRouteExtraction {
    this.walk(this.document.ast, context);
    return {
      routes: this.routes,
      includes: this.includes,
      diagnostics: [...this.diagnostics],
      partial: this.diagnostics.size > 0 || this.routes.some((route) => route.partial)
    };
  }

  private warn(message: string): void {
    if (this.diagnostics.size < 32) this.diagnostics.add(message);
  }

  private include(value: unknown, source: PhpNode, context: LaravelRouteContext): void {
    const uri = laravelPath(this.document, value, this.root);
    if (!uri || this.includes.length >= 64) {
      this.warn('A route file path is dynamic, unsupported or exceeds the file limit.');
      return;
    }
    this.includes.push({
      uri,
      source: this.document.source.span(source),
      context:
        laravelString(value) !== undefined
          ? note(context, 'A relative route file path assumes the Composer root working directory.')
          : context
    });
  }

  private apply(context: LaravelRouteContext, key: string, value: unknown): LaravelRouteContext {
    const text = laravelString(value);
    if (key === 'prefix')
      return text !== undefined && context.prefix !== undefined
        ? { ...context, prefix: joinPath(context.prefix, text) }
        : note({ ...context, prefix: undefined }, 'A route prefix is dynamic.');
    if (key === 'name' || key === 'as')
      return text !== undefined && context.namePrefix !== undefined
        ? { ...context, namePrefix: context.namePrefix + text }
        : note({ ...context, namePrefix: undefined }, 'A route name prefix is dynamic.');
    if (key === 'middleware' || key === 'withoutMiddleware') {
      const nodes = laravelList(value);
      const strings = nodes
        ? nodes.map((node) => laravelString(node) ?? laravelClass(this.document, node))
        : [laravelString(value) ?? laravelClass(this.document, value)];
      return strings.every((item) => item !== undefined)
        ? { ...context, [key]: [...context[key], ...strings] }
        : note(context, 'Some declared middleware is dynamic.');
    }
    if (key === 'controller') {
      const controller = laravelClass(this.document, value) ?? text;
      return controller
        ? { ...context, controller }
        : note(
            { ...context, controller: undefined, handlerContextUnknown: true },
            'A route controller is dynamic.'
          );
    }
    if (key === 'namespace' && text !== undefined) {
      const namespace =
        context.namespace && !text.startsWith('\\')
          ? context.namespace.replace(/^\\+|\\+$/g, '') + '\\' + text.replace(/^\\+|\\+$/g, '')
          : text.replace(/^\\+|\\+$/g, '');
      return { ...context, namespace };
    }
    if (key === 'namespace' || key === 'domain')
      return text !== undefined
        ? { ...context, [key]: text }
        : note(
            {
              ...context,
              [key]: undefined,
              handlerContextUnknown: context.handlerContextUnknown || key === 'namespace'
            },
            `A route ${key} is dynamic.`
          );
    if (key === 'where') return context; // Constraints do not change a declared URI template.
    return note(
      { ...context, prefix: undefined, namePrefix: undefined, handlerContextUnknown: true },
      'A route/group modifier is outside the static metadata grammar.'
    );
  }

  private namespacedController(name: string, context: LaravelRouteContext): string {
    return name.startsWith('\\')
      ? name.slice(1)
      : context.namespace && !name.startsWith(context.namespace)
        ? context.namespace + '\\' + name
        : name;
  }

  private handler(value: unknown, context: LaravelRouteContext): LaravelRouteHandler {
    const node = asNode(value);
    if (node && ['closure', 'arrowfunc'].includes(node.kind)) {
      const fn = this.document.functions.find((item) => item.node === node);
      if (fn) return { kind: 'closure', definition: fn.definition };
    }
    const values = laravelList(value);
    if (values?.length === 2) {
      const className = laravelClass(this.document, values[0]) ?? laravelString(values[0]);
      const method = laravelString(values[1]);
      if (className && method) return { kind: 'controller', className, method };
    }
    if (context.handlerContextUnknown) return { kind: 'unresolved', reason: 'dynamic' };
    const constant = laravelClass(this.document, value);
    if (constant)
      return {
        kind: 'controller',
        className: this.namespacedController(constant, context),
        method: '__invoke'
      };
    const text = laravelString(value);
    if (text) {
      if (context.controller && !text.includes('@') && !text.includes('\\'))
        return {
          kind: 'controller',
          className: this.namespacedController(context.controller, context),
          method: text
        };
      const parts = text.split('@');
      if (parts.length <= 2) {
        const name = parts[0]!;
        const className = name.startsWith('\\')
          ? name.slice(1)
          : context.namespace && !name.startsWith(context.namespace)
            ? context.namespace.replace(/\\$/, '') + '\\' + name
            : name;
        return { kind: 'controller', className, method: parts[1] ?? '__invoke' };
      }
    }
    return { kind: 'unresolved', reason: 'dynamic' };
  }

  private add(
    node: PhpNode,
    methods: readonly string[],
    path: string | undefined,
    name: string | undefined,
    handler: LaravelRouteHandler,
    context: LaravelRouteContext
  ): void {
    if (this.routes.length >= 1000) {
      this.warn('The route entry limit was reached. Results are incomplete.');
      return;
    }
    const problems = [...context.diagnostics];
    if (path === undefined) problems.push('The complete declared URI is not statically known.');
    if (!methods.length) problems.push('The HTTP methods are dynamic or unsupported.');
    if (handler.kind === 'unresolved') problems.push('The route handler is not statically known.');
    this.routes.push({
      id: `${this.document.request.uri}#route:${this.document.source.offsets(node)[0]}:${this.routes.length}`,
      source: this.document.source.span(node),
      methods:
        methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : methods,
      path,
      name,
      middleware: context.middleware,
      withoutMiddleware: context.withoutMiddleware,
      domain: context.domain,
      handler,
      partial: context.partial || problems.length > 0,
      diagnostics: [...new Set(problems)]
    });
  }

  private resource(
    action: LaravelCallStep,
    after: readonly LaravelCallStep[],
    context: LaravelRouteContext
  ): void {
    const resource = laravelString(laravelArgument(action, 0, 'name'));
    const controller =
      laravelClass(this.document, laravelArgument(action, 1, 'controller')) ??
      laravelString(laravelArgument(action, 1, 'controller'));
    const rawOptions = laravelArgument(action, 2, 'options');
    const options = rawOptions ? laravelMap(rawOptions) : new Map<string, PhpNode>();
    let current = options
      ? context
      : note(
          { ...context, handlerContextUnknown: true, prefix: undefined, namePrefix: undefined },
          'Resource options are dynamic.'
        );
    const selections = new Map(options ?? []);
    for (const step of after) {
      if (['only', 'except', 'names', 'parameters'].includes(step.name)) {
        const value = laravelArgument(step, 0, step.name);
        if (value) selections.set(step.name, value);
        else current = note(current, 'A resource option is missing or dynamic.');
      } else if (['middleware', 'withoutMiddleware'].includes(step.name)) {
        current = this.apply(current, step.name, laravelArgument(step, 0, 'middleware'));
      } else {
        current = note(
          current,
          'A resource modifier is unsupported; URI/name metadata is partial.'
        );
        current = {
          ...current,
          prefix: undefined,
          namePrefix: undefined,
          handlerContextUnknown: true
        };
      }
    }
    if (
      options &&
      [...options.keys()].some((key) => !['only', 'except', 'names', 'parameters'].includes(key))
    ) {
      current = note(current, 'A resource option is unsupported; URI/name metadata is partial.');
      current = {
        ...current,
        prefix: undefined,
        namePrefix: undefined,
        handlerContextUnknown: true
      };
    }
    const only = selections.has('only') ? laravelStrings(selections.get('only')) : undefined;
    const except = selections.has('except') ? laravelStrings(selections.get('except')) : undefined;
    const names = selections.has('names') ? laravelMap(selections.get('names')) : undefined;
    const parameters = selections.has('parameters')
      ? laravelMap(selections.get('parameters'))
      : undefined;
    if ((selections.has('only') && !only) || (selections.has('except') && !except))
      current = note(current, 'Resource action selection is dynamic; entries are candidates.');
    const simpleResource = resource !== undefined && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(resource);
    for (const [method, methods, suffix] of RESOURCES) {
      if (action.name === 'apiResource' && ['create', 'edit'].includes(method)) continue;
      if (only && !only.includes(method)) continue;
      if (except?.includes(method)) continue;
      let routeContext = current;
      let path: string | undefined;
      const parameter = resource ? laravelString(parameters?.get(resource)) : undefined;
      if (simpleResource && current.prefix !== undefined) {
        if (!suffix.includes('{parameter}')) path = joinPath(current.prefix, resource + suffix);
        else if (parameter && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parameter))
          path = joinPath(
            current.prefix,
            resource + suffix.replace('{parameter}', `{${parameter}}`)
          );
        else
          routeContext = note(
            routeContext,
            'Resource parameter inflection is not inferred; use literal parameters() for an exact URI.'
          );
      }
      let name =
        current.namePrefix !== undefined && resource
          ? current.namePrefix + (laravelString(names?.get(method)) ?? `${resource}.${method}`)
          : undefined;
      if (
        selections.has('names') &&
        (!names || (names.has(method) && laravelString(names.get(method)) === undefined))
      ) {
        name = undefined;
        routeContext = note(routeContext, 'Resource names are dynamic or unsupported.');
      }
      this.add(
        action.node,
        methods,
        path,
        name,
        controller && !current.handlerContextUnknown
          ? {
              kind: 'controller',
              className: this.namespacedController(controller, current),
              method
            }
          : { kind: 'unresolved', reason: 'dynamic' },
        routeContext
      );
    }
  }

  private routing(steps: readonly LaravelCallStep[], context: LaravelRouteContext): void {
    const configure = steps[0];
    if (configure?.name !== 'configure') return;
    for (const step of steps.filter((item) => item.name === 'withRouting')) {
      const named = new Map(
        step.arguments
          .filter((arg) => arg.kind === 'namedargument')
          .map((arg) => [String(arg.name), asNode(arg.value)])
      );
      if (step.arguments.some((arg) => arg.kind !== 'namedargument'))
        this.warn('Positional withRouting arguments are not indexed.');
      const using = named.get('using');
      if (using && !(using.kind === 'nullkeyword')) {
        if (['closure', 'arrowfunc'].includes(using.kind)) this.walk(asNode(using.body), context);
        else
          this.warn('A custom routing callback is dynamic; default route files are not assumed.');
      } else {
        for (const key of ['web', 'api']) {
          const value = named.get(key);
          if (!value || value.kind === 'nullkeyword') continue;
          const values = laravelList(value) ?? [value];
          const prefix =
            key === 'api'
              ? named.has('apiPrefix')
                ? laravelString(named.get('apiPrefix'))
                : 'api'
              : '';
          const next = {
            ...context,
            prefix:
              prefix !== undefined && context.prefix !== undefined
                ? joinPath(context.prefix, prefix)
                : undefined,
            middleware: [...context.middleware, key]
          };
          for (const entry of values) this.include(entry, step.node, next);
        }
      }
      const then = named.get('then');
      if (then && ['closure', 'arrowfunc'].includes(then.kind))
        this.walk(asNode(then.body), context);
      else if (then && then.kind !== 'nullkeyword')
        this.warn('An additional routing callback is dynamic.');
    }
  }

  private expression(
    node: PhpNode | undefined,
    context: LaravelRouteContext,
    provider = false
  ): void {
    if (!node) return;
    if (node.kind === 'assign') {
      this.expression(asNode(node.right), context, provider);
      return;
    }
    if (node.kind === 'include') {
      this.include(node.target, node, context);
      return;
    }
    const chain = laravelChain(node);
    if (!chain) {
      // RouteServiceProvider::routes registers a callback; unrelated closures remain opaque.
      const lookup = asNode(node.what);
      if (
        provider &&
        node.kind === 'call' &&
        lookup?.kind === 'propertylookup' &&
        asNode(lookup.what)?.kind === 'variable' &&
        asNode(lookup.what)?.name === 'this' &&
        nameOf(lookup.offset) === 'routes'
      ) {
        const callback = nodeList(node.arguments)[0];
        if (callback && ['closure', 'arrowfunc'].includes(callback.kind))
          this.walk(asNode(callback.body), context, provider);
        else this.warn('A provider routing callback is dynamic.');
      }
      return;
    }
    if (laravelFrameworkReceiver(this.document, chain, APPLICATION)) {
      this.routing(chain.steps, context);
      return;
    }
    const receiver = laravelFrameworkReceiver(this.document, chain, ROUTE_FACADE, 'Route');
    if (!receiver) return;
    let current =
      receiver === 'conventional'
        ? note(
            context,
            'The global Route facade alias is assumed by convention, not resolved from runtime configuration.'
          )
        : context;
    const actionIndex = chain.steps.findIndex(
      (step) =>
        HTTP.has(step.name) ||
        ['any', 'match', 'group', 'resource', 'apiResource'].includes(step.name)
    );
    if (actionIndex < 0) {
      this.warn('A Route call is outside the static routing grammar.');
      return;
    }
    for (const step of chain.steps.slice(0, actionIndex))
      current = this.apply(current, step.name, laravelArgument(step, 0, step.name, 'value'));
    const action = chain.steps[actionIndex]!;
    const after = chain.steps.slice(actionIndex + 1);
    if (action.name === 'group') {
      const attributes = laravelArgument(action, 0, 'attributes');
      let callback = attributes;
      if (action.arguments.length >= 2 || action.arguments.some((arg) => arg.name === 'routes')) {
        const map = laravelMap(attributes);
        if (map) for (const [key, value] of map) current = this.apply(current, key, value);
        else
          current = note(
            { ...current, prefix: undefined, namePrefix: undefined, handlerContextUnknown: true },
            'Group attributes are dynamic.'
          );
        callback = laravelArgument(action, 1, 'routes');
      }
      if (after.length) current = note(current, 'Modifiers after group() are not modeled.');
      if (callback && ['closure', 'arrowfunc'].includes(callback.kind))
        this.walk(asNode(callback.body), current, provider);
      else this.include(callback, action.node, current);
      return;
    }
    if (['resource', 'apiResource'].includes(action.name)) {
      this.resource(action, after, current);
      return;
    }
    const methods =
      action.name === 'any'
        ? ALL_METHODS
        : action.name === 'match'
          ? (laravelStrings(laravelArgument(action, 0, 'methods')) ?? []).map((method) =>
              method.toUpperCase()
            )
          : action.name === 'get'
            ? ['GET', 'HEAD']
            : [action.name.toUpperCase()];
    const offset = action.name === 'match' ? 1 : 0;
    const path = laravelString(laravelArgument(action, offset, 'uri'));
    let name = current.namePrefix || undefined;
    let nameKnown = current.namePrefix !== undefined;
    let handlerUnknown = false;
    let exactPath =
      path !== undefined && current.prefix !== undefined
        ? joinPath(current.prefix, path)
        : undefined;
    for (const step of after) {
      if (step.name === 'name') {
        const suffix = laravelString(laravelArgument(step, 0, 'name'));
        nameKnown = nameKnown && suffix !== undefined;
        name = nameKnown ? (name ?? '') + suffix : undefined;
        if (suffix === undefined) current = note(current, 'The route name is dynamic.');
      } else if (['middleware', 'withoutMiddleware', 'domain'].includes(step.name))
        current = this.apply(current, step.name, laravelArgument(step, 0, step.name));
      else if (
        step.name.startsWith('where') ||
        ['defaults', 'scopeBindings', 'withoutScopedBindings', 'withTrashed', 'missing'].includes(
          step.name
        )
      ) {
        // Binding/constraint metadata does not turn into execution or alter the handler reference.
      } else {
        current = note(
          current,
          'A route modifier may change metadata; the complete URI is not inferred.'
        );
        exactPath = undefined;
        handlerUnknown = true;
        name = undefined;
        nameKnown = false;
      }
    }
    this.add(
      action.node,
      methods,
      exactPath,
      name,
      handlerUnknown
        ? { kind: 'unresolved', reason: 'unsupported' }
        : this.handler(laravelArgument(action, offset + 1, 'action'), current),
      current
    );
  }

  private walk(node: PhpNode | undefined, context: LaravelRouteContext, provider = false): void {
    if (!node) return;
    checkCancellation(this.cancellation);
    if (++this.visited > 40_000) {
      this.warn('The routing traversal limit was reached.');
      return;
    }
    if (['program', 'namespace', 'block'].includes(node.kind)) {
      for (const child of nodeList(node.children)) {
        this.walk(child, context, provider);
        if (['return', 'throw', 'halt'].includes(child.kind)) break;
      }
    } else if (node.kind === 'class') {
      const parents = resolvePhpName(this.document, node, node.extends);
      if (!parents.some((name) => PROVIDERS.includes(name))) return;
      for (const method of nodeList(node.body)) {
        if (method.kind === 'method' && nameOf(method.name) === 'boot')
          this.walk(asNode(method.body), context, true);
      }
    } else if (FUNCTION_KINDS.has(node.kind)) {
      // A named function or handler/callback declaration is not proof of registration.
    } else if (node.kind === 'expressionstatement') {
      this.expression(asNode(node.expression), context, provider);
    } else if (node.kind === 'return') {
      this.expression(asNode(node.expr), context, provider);
    } else if (['call', 'include', 'assign'].includes(node.kind)) {
      this.expression(node, context, provider);
    } else if (
      ['if', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'try', 'catch'].includes(node.kind)
    ) {
      const conditional = note(
        context,
        'Registration is conditional or repeated; activation/order is not established.'
      );
      for (const child of childrenOf(node)) this.walk(child, conditional, provider);
    }
  }
}
