export { PhpLanguageAdapter } from './adapter.js';
export { PhpAnalysisError, PhpDocument, PhpDocumentCache, checkCancellation } from './document.js';
export type { PhpErrorCode, PhpFunctionRecord, PhpParserLimits } from './document.js';
export { PhpSource } from './source.js';
export { asNode, childrenOf, nameOf, nodeList, CLASS_KINDS, FUNCTION_KINDS } from './ast.js';
export type { PhpNode } from './ast.js';
export {
  parseComposerMap,
  classFileCandidates,
  projectRootUri,
  projectFileUri,
  relativeProjectPath
} from './composer.js';
export type { ComposerMap, ComposerMapping } from './composer.js';
export { PhpProjectIndex } from './project.js';
export type { PhpFileHost, PhpCallResolver, PhpProjectLimits } from './project.js';
export {
  namespaceContainer,
  namespaceOf,
  resolvePhpName,
  phpClasses,
  findPhpCall,
  phpCalleePosition,
  phpCallReference,
  phpCallDependencies,
  phpClassDependencies,
  resolvePhpMethodDefinition,
  resolvePhpCall
} from './symbols.js';
export type { PhpClassRecord, PhpCallReference } from './symbols.js';

export { extractLaravelRoutes, LARAVEL_ROUTE_CONTEXT } from './laravel-routes.js';
export type {
  LaravelRoute,
  LaravelRouteHandler,
  LaravelRouteContext,
  LaravelRouteExtraction,
  LaravelRouteInclude
} from './laravel-routes.js';
export {
  laravelClass,
  laravelPath,
  laravelChain,
  laravelArgument,
  laravelString,
  laravelStrings,
  laravelMap,
  laravelList
} from './laravel-syntax.js';
export { indexLaravelRoutes } from './laravel-project.js';
export type { LaravelRouteSnapshot } from './laravel-project.js';
