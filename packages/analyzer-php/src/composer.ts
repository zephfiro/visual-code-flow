/** Composer metadata is data only; autoloaders and Composer scripts are never run. */
export interface ComposerMapping {
  readonly prefix: string;
  readonly directory: string;
}
export interface ComposerMap {
  readonly root: string;
  readonly mappings: readonly ComposerMapping[];
  readonly files: readonly string[];
  readonly laravel: boolean;
  readonly incomplete: boolean;
  readonly diagnostics: readonly string[];
}
const RECORD = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const IDENTIFIER = /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_\u0080-\uffff]*$/;

export function projectRootUri(uri: string): string {
  const url = new URL(uri);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('A PHP project root must be an unadorned directory URI.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.toString();
}

/** Reject traversal, absolute paths, encoded separators and generated/private trees. */
export function projectFileUri(root: string, relative: string): string | undefined {
  if (
    /^[\\/]|[:?#%]/.test(relative) ||
    relative.includes('\\') ||
    [...relative].some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  const parts = relative.split('/').filter((part) => part !== '' && part !== '.');
  if (
    parts.some(
      (part) => part === '..' || ['.git', 'node_modules', 'vendor'].includes(part.toLowerCase())
    ) ||
    parts[0]?.toLowerCase() === 'storage' ||
    (parts[0]?.toLowerCase() === 'bootstrap' && parts[1]?.toLowerCase() === 'cache') ||
    parts.some((part) => part.toLowerCase() === '.env' || part.toLowerCase().startsWith('.env.'))
  )
    return undefined;
  try {
    const base = projectRootUri(root);
    const url = new URL(parts.map(encodeURIComponent).join('/'), base);
    return url.toString().startsWith(base) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function relativeProjectPath(root: string, uri: string): string | undefined {
  try {
    const base = projectRootUri(root);
    const url = new URL(uri);
    if (url.search || url.hash || !url.toString().startsWith(base)) return undefined;
    const encoded = url.toString().slice(base.length);
    const parts = encoded.split('/').map(decodeURIComponent);
    if (parts.some((part) => part.includes('/') || part.includes('\\'))) return undefined;
    const relative = parts.join('/');
    return projectFileUri(base, relative) === url.toString() ? relative : undefined;
  } catch {
    return undefined;
  }
}

export function parseComposerMap(root: string, text: string, includeDev = true): ComposerMap {
  const base = projectRootUri(root);
  const diagnostics: string[] = [];
  const mappings: ComposerMapping[] = [];
  const files = new Set<string>();
  let incomplete = false;
  let data: Record<string, unknown> | undefined;
  try {
    if (text.length > 256_000) throw new Error('limit');
    data = RECORD(JSON.parse(text));
  } catch {
    // Neither JSON parse errors nor source snippets leave this boundary.
  }
  if (!data) {
    return {
      root: base,
      mappings,
      files: [],
      laravel: false,
      incomplete: true,
      diagnostics: ['Invalid Composer metadata.']
    };
  }
  for (const section of [data.autoload, ...(includeDev ? [data['autoload-dev']] : [])]) {
    const autoload = RECORD(section);
    if (section === undefined) continue;
    if (!autoload) {
      incomplete = true;
      diagnostics.push('Invalid Composer autoload section.');
      continue;
    }
    if (autoload['psr-0'] || autoload.classmap) {
      incomplete = true;
      diagnostics.push('PSR-0 and classmap autoload are not indexed.');
    }
    const psr4 = RECORD(autoload['psr-4']);
    if (autoload['psr-4'] !== undefined && !psr4) {
      incomplete = true;
      diagnostics.push('Invalid Composer PSR-4 map.');
    }
    if (autoload.files !== undefined && !Array.isArray(autoload.files)) {
      incomplete = true;
      diagnostics.push('Invalid Composer files list.');
    }
    for (const [prefix, value] of Object.entries(psr4 ?? {})) {
      if (
        prefix &&
        (!prefix.endsWith('\\') ||
          !prefix
            .slice(0, -1)
            .split('\\')
            .every((part) => IDENTIFIER.test(part)))
      ) {
        incomplete = true;
        diagnostics.push('Invalid PSR-4 namespace prefix.');
        continue;
      }
      for (const path of Array.isArray(value) ? value : [value]) {
        const directory = typeof path === 'string' ? projectFileUri(base, path) : undefined;
        if (!directory || mappings.length >= 256) {
          incomplete = true;
          diagnostics.push('A Composer mapping is outside the supported path or size policy.');
          continue;
        }
        mappings.push({ prefix, directory: projectRootUri(directory) });
      }
    }
    if (Array.isArray(autoload.files)) {
      for (const path of autoload.files) {
        const uri = typeof path === 'string' ? projectFileUri(base, path) : undefined;
        if (
          uri &&
          uri.toLowerCase().endsWith('.php') &&
          !uri.toLowerCase().endsWith('.blade.php') &&
          files.size < 64
        )
          files.add(uri);
        else {
          incomplete = true;
          diagnostics.push('A Composer files entry is unsupported or exceeds the indexing limit.');
        }
      }
    }
  }
  const dependencies = [RECORD(data.require), RECORD(data['require-dev'])];
  return {
    root: base,
    mappings: mappings.sort((a, b) => b.prefix.length - a.prefix.length),
    files: [...files],
    incomplete,
    laravel: dependencies.some((entry) => typeof entry?.['laravel/framework'] === 'string'),
    diagnostics: [...new Set(diagnostics)]
  };
}

/** All literal candidates are returned; duplicate source declarations stay ambiguous. */
export function classFileCandidates(map: ComposerMap, qualifiedName: string): readonly string[] {
  const name = qualifiedName.replace(/^\\/, '');
  if (!name || !name.split('\\').every((part) => IDENTIFIER.test(part))) return [];
  const result = new Set<string>();
  for (const mapping of map.mappings) {
    if (!name.startsWith(mapping.prefix)) continue;
    const suffix = name.slice(mapping.prefix.length).replace(/\\/g, '/') + '.php';
    const uri = projectFileUri(mapping.directory, suffix);
    if (uri && relativeProjectPath(map.root, uri) !== undefined) result.add(uri);
  }
  return [...result];
}
