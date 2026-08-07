/**
Shared helpers: tiny utilities, selector painting, package.json reading, and
public-entry listing. The package's main entry; exports are public API with
downstream consumers (@paulmillr/jsbt) — some have no callers inside bismar
itself. Pure reads only; nothing here writes.
@module
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { color, paint, progressDone, wantColor } from './env.ts';

declare const __BISMAR_BUNDLE__: boolean | undefined;
export type PkgTarget = { cwd: string; pkgFile: string };
export const err = (msg: string): never => {
  throw new Error(msg);
};
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const ident = (name: string): boolean => !!name.length && IDENT.test(name);
export const kb = (bytes: number): string => (bytes / 1024).toFixed(2);
export const fmtBytes = (bytes: number): string =>
  bytes < 1048576 ? `${kb(bytes)}kb` : `${(bytes / 1048576).toFixed(2)}mb`;
export const readText = (file: string): string => readFileSync(file, 'utf8');
export const readJson = <T>(file: string): T => JSON.parse(readText(file)) as T;
export const relName = (cwd: string, file: string): string => relative(cwd, file) || basename(file);
const bundled = (): boolean => typeof __BISMAR_BUNDLE__ !== 'undefined' && __BISMAR_BUNDLE__;
export const runSelf = (metaUrl: string, fn: (argv: string[]) => Promise<void>): void => {
  const entry = process.argv[1];
  const self = fileURLToPath(metaUrl);
  if (bundled() || !entry || realpathSync(resolve(entry)) !== realpathSync(self)) return;
  void (async () => {
    try {
      await fn(process.argv.slice(2));
    } catch (error) {
      // A shown progress line would otherwise prefix the error on the same row.
      progressDone();
      console.error((error as Error).message);
      process.exitCode = 1;
    }
  })();
};
export const loadNear = <T>(
  pkgFile: string,
  name: string,
  api: string,
  check: (mod: T) => boolean
): T => {
  const req = createRequire(pkgFile);
  const raw = (() => {
    try {
      return req(name) as T | { default?: T };
    } catch {
      throw new Error(`missing ${name} near ${pkgFile}; run npm install in the target repo first`);
    }
  })();
  const mod = raw && typeof raw === 'object' && 'default' in raw && raw.default ? raw.default : raw;
  if (!check(mod as T)) throw new Error(`expected ${api} near ${pkgFile}`);
  return mod as T;
};
const hasFns = (mod: unknown, keys: readonly string[]): boolean =>
  !!mod &&
  typeof mod === 'object' &&
  keys.every((key) => typeof (mod as Record<string, unknown>)[key] === 'function');
export const loadModuleApi = <T>(
  pkgFile: string,
  name: string,
  api: string,
  keys: readonly string[]
): T => loadNear<T>(pkgFile, name, api, (mod) => hasFns(mod, keys));

// Error-message grammar: `<problem>: <offender>; <hint>` — the offending user input is
// painted red, and listings of valid choices are one selector per line via listLines.
export const bad = (text: string): string => paint(text, color.red, wantColor());
// Selector painting: package part (npm ref label or scoped package name) yellow,
// module cyan, export green; slashes stay uncolored. One rule for --list output,
// error listings, and human-mode size lines.
// `leaf` marks what the final segment is: single-file packages put exports right
// after the package (`npm:pkg/Point`), which position alone cannot distinguish
// from a module. Default 'auto' infers: two+ segments after the package = export.
export type IdLeaf = 'auto' | 'export' | 'module';
// Any `word:` head is a registry prefix — colons appear nowhere else in ids, so
// painting needs no copy of the registry table (registries.ts validates names).
const REF_PREFIX = /^[a-z]+:/;
export const paintId = (id: string, on: boolean = wantColor(), leaf: IdLeaf = 'auto'): string => {
  if (!on) return id;
  const pre = REF_PREFIX.exec(id)?.[0] ?? '';
  const segs = id.slice(pre.length).split('/');
  const scoped = segs[0].startsWith('@') && segs.length > 1;
  // An npm: prefix always names a package first; bare ids only when name@version-like.
  // Multi-segment registry names (composer vendor/name, github owner/repo, go
  // module paths) stay package-colored through their version-bearing segment.
  const verAt = scoped ? -1 : segs.findIndex((seg) => seg.includes('@'));
  const pkgCount = scoped ? 2 : pre ? Math.max(1, verAt + 1) : segs[0].includes('@') ? 1 : 0;
  const parts: string[] = [];
  if (pkgCount) parts.push(paint(segs.slice(0, pkgCount).join('/'), color.yellow));
  const rest = segs.slice(pkgCount);
  const exportLeaf = leaf === 'export' || (leaf === 'auto' && rest.length > 1);
  for (const [idx, seg] of rest.entries())
    parts.push(paint(seg, exportLeaf && idx === rest.length - 1 ? color.green : color.cyan));
  return pre + parts.join('/');
};
export const listLines = (ids: Iterable<string>, leaf: IdLeaf = 'auto'): string =>
  [...ids].map((id) => paintId(id, wantColor(), leaf)).join('\n');
// `--list` speaks import syntax: each line is the statement a consumer would write —
// `{sha256} from '@noble/hashes/sha2.js'`. Same palette as paintId: package yellow,
// subpath segments cyan, export green, slashes/braces/quotes uncolored. A registry
// prefix (`jsr:`) stays unpainted; an exportless (CJS) module prints the bare quoted
// path, a side-effect import.
export const importLine = (
  name: string,
  pkg: string,
  sub: string,
  on: boolean = wantColor()
): string => {
  const pre = REF_PREFIX.exec(pkg)?.[0] ?? '';
  const segs = sub ? sub.split('/').map((seg) => paint(seg, color.cyan, on)) : [];
  const path = [pkg ? pre + paint(pkg.slice(pre.length), color.yellow, on) : '', ...segs]
    .filter(Boolean)
    .join('/');
  return name ? `{${paint(name, color.green, on)}} from '${path}'` : `'${path}'`;
};
export const sorted = (items: Iterable<string>): string[] => [...items].sort();
// Selector parsing, the input half of the same grammar: selectors accept what users
// actually see — `sha3/sha3_384`, `sha3.js/sha3_384`, `sha3.ts/...`, `./sha3.js/...`,
// or `@scope/pkg/sha3.js/...` all mean module `sha3`.
// One spelling of the JS-extension grammar; size.ts builds its bare-file
// classifier from the same source so the two can never drift.
export const SRC_EXT: string = String.raw`\.[cm]?[jt]s`;
export const ONLY_EXT: RegExp = new RegExp(`(?:${SRC_EXT})$`);
// The filesystem class of the selector grammar: `./`, `../`, and absolute paths
// always mean the disk — never a module or registry name.
export const explicitPath = (raw: string): boolean =>
  raw.startsWith('./') || raw.startsWith('../') || isAbsolute(raw);
export const normalizeOnlyPath = (pkgName: string, raw: string): string => {
  // Slash slips are harmless: `index/` means the module, `index//add` means `index/add`.
  let path = raw.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (path.startsWith(`${pkgName}/`)) path = path.slice(pkgName.length + 1).replace(/^\.\//, '');
  const parts = path.split('/');
  if (parts.length > 1) parts[parts.length - 2] = parts[parts.length - 2].replace(ONLY_EXT, '');
  return parts.join('/');
};
export const firstModule = (pkgName: string, path: string): string =>
  normalizeOnlyPath(pkgName, path).split('/')[0].replace(ONLY_EXT, '');
export const guardChild = (cwd: string, file: string, label: string): void => {
  const rel = relative(cwd, file);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`refusing unsafe ${label} path ${file}; expected a child path of ${cwd}`);
};
export const pkgTarget = (pkgArg: string, cwd: string = process.cwd()): PkgTarget => {
  const base = resolve(cwd);
  const pkgFile = resolve(base, pkgArg);
  guardChild(base, pkgFile, 'package');
  return { cwd: base, pkgFile };
};
type RawPkg = {
  exports?: unknown;
  main?: unknown;
  module?: unknown;
  name?: unknown;
  types?: unknown;
  version?: unknown;
};
export type Pkg = {
  exports: Record<string, unknown>;
  name: string;
  self: boolean;
  types: string;
  version: string;
};
export type PublicCtx = { cwd: string; pkg: Pkg; pkgFile: string };
export type PublicEntry = { jsRel: string; key: string; spec: string; value: unknown };
export type PublicMod = { dtsFile: string; jsFile: string; key: string; spec: string };
export type PublicRow<T extends object = {}> = PublicMod & { file: string } & T;

export const readPkg = (pkgFile: string): Pkg => {
  const raw = ((): RawPkg => {
    try {
      return readJson<RawPkg>(pkgFile);
    } catch (error) {
      // Raw ENOENT/SyntaxError leaks read poorly; say what is wrong and where.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return err(`missing package.json in ${dirname(pkgFile)}`);
      return err(`invalid package.json in ${pkgFile}: ${(error as Error).message}`);
    }
  })();
  if (typeof raw.name !== 'string' || !raw.name) err(`missing name in ${pkgFile}`);
  let exports = raw.exports;
  let self = true;
  // `exports: "./index.js"` is valid sugar for `{".": "./index.js"}`.
  if (typeof exports === 'string') exports = { '.': exports };
  // An exports object with no `.`-prefixed keys is a conditions object for the root
  // (e.g. chalk's `{types, default}`); wrap it so consumers see a subpath map.
  if (
    exports &&
    typeof exports === 'object' &&
    !Object.keys(exports).some((k) => k.startsWith('.'))
  )
    exports = { '.': exports };
  if (!exports || typeof exports !== 'object') {
    const entry =
      typeof raw.module === 'string' ? raw.module : typeof raw.main === 'string' ? raw.main : '';
    if (entry) exports = { '.': entry };
    // No entry fields at all: node's legacy resolution defaults to ./index.js (express).
    else if (existsSync(resolve(dirname(pkgFile), 'index.js'))) exports = { '.': './index.js' };
    else err(`missing exports or main/module entry in ${pkgFile}`);
    self = false;
  }
  return {
    exports: exports as Record<string, unknown>,
    name: raw.name as string,
    self,
    types: typeof raw.types === 'string' ? raw.types : '',
    version: typeof raw.version === 'string' ? raw.version : '',
  };
};
// Exported helpers need explicit annotations for isolated declaration emit.
export const publicCtx = (pkgArg: string, cwd: string = process.cwd()): PublicCtx => {
  const { pkgFile } = pkgTarget(pkgArg, cwd);
  const root = dirname(pkgFile);
  return { cwd: root, pkg: readPkg(pkgFile), pkgFile };
};
const EXPORT_KEYS = ['default', 'import', 'node', 'require'];
export const exportPath = (
  value: unknown,
  leaf: (path: string) => string,
  types = false
): string => {
  if (typeof value === 'string') return leaf(value);
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  const typed = obj.types;
  if (types && typeof typed === 'string') return typed;
  for (const key of EXPORT_KEYS) {
    const res = exportPath(obj[key], leaf, types);
    if (res) return res;
  }
  for (const entry of Object.values(obj)) {
    const res = exportPath(entry, leaf, types);
    if (res) return res;
  }
  return '';
};
const JS_EXT = /\.[cm]?js$/;
export const jsPath = (value: unknown): string =>
  exportPath(value, (path) => (JS_EXT.test(path) ? path : ''));
export const dtsPath = (value: unknown): string =>
  exportPath(
    value,
    (path) => {
      if (/\.d\.[cm]?ts$/.test(path)) return path;
      return JS_EXT.test(path) ? path.replace(JS_EXT, '.d.ts') : '';
    },
    true
  );
export const publicSpec = (pkg: Pkg, key: string): string =>
  key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`;
export const publicEntries = (ctx: PublicCtx): PublicEntry[] =>
  Object.entries(ctx.pkg.exports)
    .flatMap(([key, value]) => {
      if (!key.startsWith('.')) return [];
      const jsRel = jsPath(value);
      return jsRel ? [{ jsRel, key, spec: publicSpec(ctx.pkg, key), value }] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key));
export const listModules = (ctx: PublicCtx): PublicMod[] => {
  const mods: PublicMod[] = [];
  for (const { jsRel, key, spec, value } of publicEntries(ctx)) {
    const dtsRel =
      key === '.' && ctx.pkg.types
        ? ctx.pkg.types
        : dtsPath(value) || jsRel.replace(JS_EXT, '.d.ts');
    const jsFile = resolve(ctx.cwd, jsRel);
    const dtsFile = resolve(ctx.cwd, dtsRel);
    if (!existsSync(jsFile)) err(`missing public JS entry ${jsRel} for ${key} in ${ctx.pkgFile}`);
    if (!existsSync(dtsFile))
      err(`missing public declaration file ${dtsRel} for ${key} in ${ctx.pkgFile}`);
    mods.push({ dtsFile, jsFile, key, spec });
  }
  if (!mods.length) err(`no public modules found in ${ctx.pkgFile}`);
  return mods;
};
export const publicRows = async <T extends object>(
  ctx: PublicCtx,
  probe: (mod: PublicMod) => Promise<T> | T
): Promise<PublicRow<T>[]> => {
  const rows: PublicRow<T>[] = [];
  for (const mod of listModules(ctx)) {
    rows.push({
      ...mod,
      file: relName(ctx.cwd, mod.jsFile),
      ...(await probe(mod)),
    } as PublicRow<T>);
  }
  return rows;
};
export const slug = (s: string): string =>
  s
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
