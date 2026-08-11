/**
The measurement engine: packs a package, module, export, npm ref, or lone file
into single-file IIFE bundles via esbuild — fully in-memory — and reports
min+gzip sizes (`runSize`) or selectable ids (`--list`). Never touches
test/build and never installs the target project; the only filesystem writes are
npm ref installs (`refs.ts`) and, when a caller supplies no `outDir`, allocating
and removing the bismar temp dir those installs live in (`fs-modify.ts`).
@module
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { walkFiles } from './diff.ts';
import {
  color,
  csvEnabled,
  csvRow,
  paint,
  progressDone,
  progressUpdate,
  stdoutColor,
} from './env.ts';
import { rmTempDir, tempDir } from './fs-modify.ts';
import {
  bad,
  err,
  explicitPath,
  firstModule,
  fmtBytes,
  type IdLeaf,
  ident,
  importLine,
  jsPath,
  SRC_EXT,
  kb,
  listLines,
  loadModuleApi,
  normalizeOnlyPath,
  ONLY_EXT,
  paintId,
  type Pkg,
  publicSpec,
  readPkg,
  slug,
  sorted,
} from './public.ts';
import {
  asRef,
  explicitRef,
  type ExternalRef,
  installedRef,
  noPkgErr,
  npmHintOf,
  parseNpmRef,
  realSpec,
  refDb,
  type RefDbMod,
  type RefDbSizes,
  refRename,
  saveRefDb,
  soleIndexOf,
} from './refs.ts';
import { jsHitStats } from './registries.ts';

export type BuildLike = (opts: {
  absWorkingDir?: string;
  bundle: true;
  entryPoints?: string[];
  external?: string[];
  format: 'esm' | 'iife';
  globalName?: string;
  logLevel: 'silent';
  metafile: true;
  minify?: boolean;
  outdir?: string;
  packages?: 'external';
  platform?: 'node';
  plugins?: {
    name: string;
    setup: (hooks: {
      onLoad: (
        opts: { filter: RegExp },
        cb: (args: { path: string }) => { contents: string; loader: 'js' } | undefined
      ) => void;
    }) => void;
  }[];
  stdin?: { contents: string; resolveDir: string; sourcefile: string };
  write: false;
}) => Promise<{
  metafile?: { outputs: Record<string, { entryPoint?: string; exports?: string[] }> };
  outputFiles?: { contents: Uint8Array }[];
  warnings?: { location?: { file: string } | null; text: string }[];
}>;
export type Ctx = { cwd: string; outDir: string; pkg: Pkg; pkgDir: string; pkgFile: string };
export type Mod = {
  dir: string;
  exports: string[];
  file: string;
  key: string;
  module: string;
  spec: string;
};
type Item = {
  absSource?: string;
  // Pinned-ref rows only: machine cache dir plus the unbranded row key its measured
  // sizes live under in that dir's bismar.db.json.
  cacheDir?: string;
  cacheKey?: string;
  dir: string;
  export: string;
  global: string;
  module: string;
  out: string;
  resolveDir?: string;
  // Set when a bare name fell back to a root-module export: on failure the error lists
  // the package's modules, since the name may have meant either a module or an export.
  rootModules?: string[];
  source: string;
};
export type Built = Item & { min: Uint8Array; plain: Uint8Array };
const decoder = new TextDecoder();
const ALL = 'all';
export const camel = (s: string): string =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part))
    .join('');
export const resolveCtx = (cwd: string | undefined, outDir: string): Ctx => {
  const base = resolve(cwd ?? process.cwd());
  if (!isAbsolute(outDir)) err(`expected absolute out dir: ${outDir}`);
  const pkgFile = join(base, 'package.json');
  return { cwd: base, outDir, pkg: readPkg(pkgFile), pkgDir: base, pkgFile };
};
// npm-first from anywhere: without a local package.json, selectors that read as
// registry names run against a synthetic empty package instead of failing.
export const noPkgCtx = (cwd: string, outDir: string): Ctx => ({
  cwd,
  outDir,
  pkg: { exports: {}, name: '', self: false, types: '', version: '' },
  pkgDir: cwd,
  pkgFile: join(cwd, 'package.json'),
});
// esbuild is a real dependency of bismar; resolve it next to bismar itself, never the
// target repo. A miss means a broken bismar install, not a target-repo problem.
// The version keys cached measurements: sizes are only comparable within one esbuild.
export type EsbuildApi = { build: BuildLike; version: string };
export const loadEsbuild = (): EsbuildApi => {
  try {
    const mod = loadModuleApi<{ build?: BuildLike; version?: unknown }>(
      fileURLToPath(import.meta.url),
      'esbuild',
      'esbuild.build',
      ['build']
    );
    return {
      build: mod.build as BuildLike,
      version: typeof mod.version === 'string' ? mod.version : '',
    };
  } catch {
    return err('missing esbuild near bismar; reinstall bismar');
  }
};
const isPkgAll = (item: Pick<Item, 'dir' | 'out'>) => !item.dir && item.out === ALL;
const itemId = (pkg: Pkg, item: Pick<Item, 'dir' | 'export' | 'module' | 'out'>): string =>
  isPkgAll(item) ? pkg.name : `${item.module}/${item.export || ALL}`;
// The `_tree_shaking_` prefix marks files as bismar-owned so sweeps of in-repo out dirs
// (jsbt-check) can never delete user files. `bismar -bs` writes into its own temp dir,
// so it drops the prefix for readable bundle names.
const outPath = (pkg: Pkg, item: Pick<Item, 'dir' | 'out'>, ext: string, prefix = ''): string =>
  isPkgAll(item) ? `${prefix}${slug(pkg.name)}.${ext}` : `${item.dir}/${prefix}${item.out}.${ext}`;
const relSpec = (file: string) => (file.startsWith('.') ? file : `./${file}`);
const exportSpec = (pkg: Pkg, key: string, file: string) =>
  pkg.self ? publicSpec(pkg, key) : relSpec(file);
// `sub/index.js` reads better as `sub` — but a root-level `./index.js` key has no
// parent dir to borrow, so it stays `index` instead of degenerating into `.`.
const parentName = (path: string): string => {
  const parent = basename(dirname(path));
  return parent && parent !== '.' && parent !== '..' ? parent : 'index';
};
// An `index` basename borrows its parent dir: the exports key for display labels,
// the real file for out dirs (they only differ on extensionless legacy mains).
const moduleName = (key: string, indexParent: string): string => {
  if (key === '.') return 'index';
  const base = basename(key, extname(key));
  return base === 'index' ? parentName(indexParent) : base;
};
// `existsSync` alone would accept a directory (e.g. `./beta/` next to `beta.js`).
export const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile();
// A bare selector can only mean a file when it carries a JS extension — on the
// path head (`src/util.js`) or the whole selector (`src/util.js/twice`).
const BARE_FILE = new RegExp(`${SRC_EXT}(/|$)`);
// Export names come from esbuild's metafile: bundle the module entry with all bare
// imports left external and read the flattened export list. Star re-exports of local
// files resolve during bundling; external and CJS entries yield no names, matching the
// old TypeScript-parser behavior (CJS entries defeat static export enumeration).
const bundleExports = async (build: BuildLike, file: string): Promise<string[]> => {
  try {
    const res = await build({
      bundle: true,
      entryPoints: [file],
      format: 'esm',
      logLevel: 'silent',
      metafile: true,
      outdir: '.',
      packages: 'external',
      platform: 'node',
      write: false,
    });
    const out = Object.values(res.metafile?.outputs ?? {}).find((entry) => entry.entryPoint);
    // `_underscore`-prefixed exports are internal by convention (covers `__esModule` too).
    return (out?.exports ?? [])
      .filter((name) => name && name !== 'default' && !name.startsWith('_'))
      .sort();
  } catch {
    // Unparseable or unresolvable entries surface later, when (and if) they're measured.
    return [];
  }
};
export const fillExports = async (build: BuildLike, mods: Mod[]): Promise<void> => {
  let done = 0;
  const lists = await Promise.all(
    mods.map(async (mod) => {
      const list = await bundleExports(build, mod.file);
      progressUpdate(`reading exports ${++done}/${mods.length}`);
      return list;
    })
  );
  mods.forEach((mod, i) => {
    mod.exports = lists[i] ?? [];
  });
};
export const readModules = (ctx: Ctx): Mod[] => {
  const res: Mod[] = [];
  // Alias keys (`./bind` + `./bind.js`, dotenv/classnames) and per-condition variants
  // (react-dom's `./server` family) share a label; the first exports-map entry wins.
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(ctx.pkg.exports)) {
    // Wildcard subpath patterns (`./_types/*`) name no concrete file; skip them.
    if (key.includes('*')) continue;
    // `_underscore`-prefixed subpath exports are internal by convention, like export names.
    if (key !== '.' && basename(key, extname(key)).startsWith('_')) continue;
    let file = jsPath(value);
    // Legacy mains may be extensionless (`"main": "./index"`, ms); resolve node-style.
    if (!file && typeof value === 'string' && !extname(value))
      for (const tail of ['.js', '.mjs', '.cjs', '/index.js', '/index.mjs', '/index.cjs'])
        if (isFile(resolve(ctx.pkgDir, value + tail))) {
          file = value + tail;
          break;
        }
    if (!file) continue;
    const abs = resolve(ctx.pkgDir, file);
    // Published exports maps can point at files absent from the tarball (ramda's
    // ./dist); measure the modules that exist instead of dying on the broken one.
    if (!isFile(abs)) continue;
    const module = moduleName(key, key);
    if (seen.has(module)) continue;
    seen.add(module);
    res.push({
      dir: moduleName(key, file),
      exports: [],
      file: abs,
      key,
      module,
      spec: exportSpec(ctx.pkg, key, file),
    });
  }
  return res;
};
const fullSource = (mods: Mod[], spec: (mod: Mod) => string): string => {
  // Exports-map keys like `./actions` and `./celo/actions` share a basename; uniquify
  // the namespace aliases so the package-wide bundle stays valid ESM.
  const seen = new Map<string, number>();
  const lines = mods.map((mod) => {
    const base = camel(mod.dir) || 'mod';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return `export * as ${count ? `${base}_${count}` : base} from '${spec(mod)}';`;
  });
  return lines.join('\n') || 'export {};';
};
const exportSource = (spec: string, name: string) =>
  name === 'default' ? `export { default } from '${spec}';` : `export { ${name} } from '${spec}';`;
// Absolute-path spec (forward slashes): resolvable from any resolveDir, used when a
// selection bundle mixes local exports with external npm refs.
const fwdSlash = (path: string): string => path.split('\\').join('/');
const absSpec = (mod: Mod): string => fwdSlash(mod.file);
export const inputCtx = (
  cwd: string | undefined,
  outArg: string | undefined,
  input: string
): Ctx => {
  const base = resolve(cwd ?? process.cwd());
  const file = resolve(base, input);
  if (!isFile(file)) err(`missing input file: ${bad(input)}`);
  if (!outArg || !isAbsolute(outArg)) throw new Error('expected absolute out dir for --input');
  const name = slug(basename(file, extname(file))) || 'input';
  const pkg: Pkg = { exports: {}, name, self: false, types: '', version: '' };
  return {
    cwd: base,
    outDir: outArg,
    pkg,
    pkgDir: dirname(file),
    pkgFile: join(base, 'package.json'),
  };
};
export const inputMods = (ctx: Ctx, input: string): Mod[] => {
  const file = resolve(ctx.cwd, input);
  return [
    {
      dir: ctx.pkg.name,
      exports: [],
      file,
      key: '.',
      module: ctx.pkg.name,
      spec: relSpec(fwdSlash(relative(ctx.cwd, file))),
    },
  ];
};
// Re-export under unique per-pick aliases: two picks exporting the same name (e.g.
// sha256 from two packages) would otherwise collide inside the combined bundle.
const selReexport = (src: string, index: number): string =>
  src
    .split('\n')
    .map((line) =>
      line
        .replace(/^export \* as (\w+) from/, `export * as sel${index}_$1 from`)
        .replace(/^export \* from/, `export * as sel${index} from`)
        .replace(
          /^export \{ (\w+) \} from/,
          (_, name) => `export { ${name} as sel${index}_${name} } from`
        )
    )
    .join('\n');
const selection = (picked: Item[], resolveDir?: string): Item => ({
  // With external refs in the mix, one resolveDir cannot serve every relative spec, so
  // the combined bundle uses absolute specs (and real-name deep paths) throughout.
  dir: 'selection',
  export: ALL,
  // Content-derived name: hashing the picked selector ids keeps the emitted global
  // independent of the working directory (versionless refs hash as their pinned form).
  global: `bundle_${createHash('sha256')
    .update(picked.map((item) => `${item.module}/${item.export}`).join(' '))
    .digest('hex')
    .slice(0, 8)}`,
  module: 'selection',
  out: ALL,
  resolveDir,
  source: picked
    .map((item, index) =>
      selReexport(resolveDir ? (item.absSource ?? item.source) : item.source, index)
    )
    .join('\n'),
});
const exportItem = (pkg: Pkg, mod: Mod, name: string): Item => ({
  absSource: exportSource(absSpec(mod), name),
  dir: mod.dir,
  export: name,
  global: camel(`${pkg.name}-${mod.module}-${name}`),
  module: mod.module,
  out: name,
  source: exportSource(mod.spec, name),
});
// Filesystem selector rows: the file (or one of its exports) as a standalone
// item — absolute-path sources bundle from any resolveDir, so file picks mix
// freely with modules and refs in one selection. The module column keeps the
// selector's own spelling, copy-pasteable like every other row id.
const fileItem = (spell: string, file: string, exportName: string): Item => {
  const abs = fwdSlash(file);
  const base = slug(spell);
  const source = exportName ? exportSource(abs, exportName) : `export * from '${abs}';`;
  return {
    absSource: source,
    dir: base,
    export: exportName || ALL,
    global: camel(exportName ? `${base}-${exportName}` : base),
    module: spell,
    out: exportName || ALL,
    source,
  };
};
const cases = (pkg: Pkg, mods: Mod[], pkgRow = true): Item[] => {
  const res: Item[] = [];
  if (pkgRow)
    res.push({
      absSource: fullSource(mods, absSpec),
      dir: '',
      export: '',
      global: camel(pkg.name),
      module: pkg.name,
      out: ALL,
      source: fullSource(mods, (mod) => mod.spec),
    });
  for (const mod of mods) {
    // A single-export module's ALL bundle duplicates that export's bundle; skip it.
    if (mod.exports.length !== 1)
      res.push({
        absSource: `export * from '${absSpec(mod)}';`,
        dir: mod.dir,
        export: ALL,
        global: camel(`${pkg.name}-${mod.module}`),
        module: mod.module,
        out: ALL,
        source: `export * from '${mod.spec}';`,
      });
    for (const name of mod.exports) res.push(exportItem(pkg, mod, name));
  }
  return res;
};
const bundle = async (
  build: BuildLike,
  source: string,
  globalName: string,
  cwd: string,
  minify: boolean,
  note: (text: string) => void
) => {
  // Runtime-provided node builtins cost zero shipped bytes; leave them external.
  const external = [...builtinModules, 'node:*'];
  // esbuild resolves files through symlinks, so a symlinked anchor (macOS's
  // /var/folders tmpdir) would turn every path comment into a `../..` walk.
  const workDir = realpathSync(cwd);
  // Dependency files esbuild proved broken by a same-file const reassignment
  // (deppack@old's `shims = shims.concat(…)`) — a hard error with no log
  // override. Retries reload them with const demoted to var: measurement never
  // executes the code, and the demotion is byte-neutral once minified.
  const varPatch = new Set<string>();
  // The entry is named after globalName; esbuild may display it resolveDir-relative.
  const entry = `${globalName}.js`;
  const atEntry = (file: string | undefined) =>
    file === entry || (file ?? '').endsWith(`/${entry}`);
  let platform: 'node' | undefined;
  let res: Awaited<ReturnType<BuildLike>>;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await build({
        // Path comments in unminified output render relative to the working dir;
        // anchoring it at the resolve root keeps them short (`node_modules/x/y.js`)
        // instead of `../../..` walks into the machine temp dir.
        absWorkingDir: workDir,
        bundle: true,
        external,
        format: 'iife',
        globalName,
        logLevel: 'silent',
        metafile: true,
        minify,
        platform,
        plugins: varPatch.size
          ? [
              {
                name: 'bismar-const-to-var',
                setup: (hooks) => {
                  hooks.onLoad({ filter: /\.[cm]?js$/ }, (args) =>
                    varPatch.has(args.path)
                      ? {
                          contents: readFileSync(args.path, 'utf8').replace(/\bconst\b/g, 'var'),
                          loader: 'js',
                        }
                      : undefined
                  );
                },
              },
            ]
          : undefined,
        stdin: {
          contents: source,
          resolveDir: workDir,
          sourcefile: `${globalName}.js`,
        },
        write: false,
      });
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      // Undeclared optional imports (preact's compat/server pulls preact-render-to-string)
      // are absent by design after a plain install; treat bare unresolvable packages as
      // external so the rest of the package still measures.
      const bare = [...(error as Error).message.matchAll(/Could not resolve "([^"']+)"/g)]
        .map((match) => match[1])
        .filter((spec) => spec && !/^[./#]/.test(spec) && !external.includes(spec));
      // Relative paths stay fatal in the measured package's own files (likely a
      // real typo) but go external inside dependencies: dead conditional requires
      // there — express/connect's `require('./lib-cov/x')` coverage split — name
      // paths that never shipped, and the dep's remaining bytes still count.
      const raised = (
        error as { errors?: { location?: { file?: string } | null; text?: string }[] }
      ).errors;
      const depRelative = (raised ?? [])
        .filter((one) => (one.location?.file ?? '').includes('node_modules/'))
        .map((one) => /Could not resolve "([^"']+)"/.exec(one.text ?? '')?.[1])
        .filter((spec): spec is string => !!spec && /^\./.test(spec) && !external.includes(spec));
      const missing = [...bare, ...depRelative];
      // Same dependency-only scope as depRelative: the measured package's own
      // files keep the honest error.
      const constFiles = (raised ?? [])
        .filter((one) => / because it is a constant$/.test(one.text ?? ''))
        .map((one) => one.location?.file)
        .filter(
          (file): file is string =>
            !!file && file.includes('node_modules/') && !varPatch.has(resolve(workDir, file))
        );
      if (missing.length || constFiles.length) {
        for (const spec of new Set(missing)) {
          // The run-wide note sink dedupes the repeats: every bundle touching the same
          // import rediscovers it (preact's compat/server appears in the package row
          // plus each server row), and the concurrent minified twin rediscovers it too.
          note(`note: treating unresolvable import ${spec} as external`);
          external.push(spec);
        }
        for (const file of new Set(constFiles)) {
          note(`note: demoting const to var in ${file} (reassigns a constant)`);
          varPatch.add(resolve(workDir, file));
        }
        continue;
      }
      // Node-only dependency graphs can need node conditions: execa's unicorn-magic
      // exports toPath only under `node`; concurrently default-imports rxjs, which only
      // interops via its CJS build. Failures in our generated entry retry too: export
      // enumeration runs under node conditions, so a browser-condition file (preact's
      // compat/server.browser.js) can lack exports the listing promised — but retry
      // silently, since the name may equally be a typo, which fails again under node
      // and reports friendly without a confusing note above it.
      if (!platform && /No matching export/.test((error as Error).message)) {
        platform = 'node';
        const failed = (error as { errors?: { location?: { file?: string } | null }[] }).errors;
        const depOnly = !!failed?.length && failed.every((one) => !atEntry(one.location?.file));
        if (depOnly) note('note: retrying with node conditions (conditional exports)');
        continue;
      }
      throw error;
    }
  }
  // CommonJS targets defeat esbuild's static export validation: a bogus name builds
  // "successfully" as a permanently-undefined property read. esbuild still warns when it
  // can prove the target has no exports at all; scoped to our generated entry, that
  // warning IS a missing export (the entry only re-exports), so fail like ESM would.
  const dead = res.warnings?.find(
    (warning) =>
      atEntry(warning.location?.file) && warning.text.includes('will always be undefined')
  );
  if (dead) err(`No matching export: ${dead.text}`);
  const maybeOutFiles = res.outputFiles;
  if (!maybeOutFiles?.length) err(`missing esbuild output for ${globalName}`);
  const outFiles = maybeOutFiles as { contents: Uint8Array }[];
  const out = outFiles[0];
  if (!out) err(`missing esbuild output for ${globalName}`);
  return out.contents;
};
// Measurement runs a few bundles at once; esbuild already spreads one build across
// cores, so a small pool captures the win without oversubscribing the machine.
export const BUILD_POOL: number = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
// Bounded concurrency: jobs start pool-wide while callers consume results in order.
const makeLimit = (max: number): (<T>(job: () => Promise<T>) => Promise<T>) => {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    while (active >= max)
      await new Promise<void>((res) => {
        waiters.push(res);
      });
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
};
// Bundling is fully in-memory; nothing is ever written for measurement.
const buildCase = async (
  ctx: Ctx,
  build: BuildLike,
  item: Item,
  note: (text: string) => void
): Promise<Built> => {
  const resolveDir = item.resolveDir ?? ctx.cwd;
  const [plain, min] = await Promise.all([
    bundle(build, item.source, item.global, resolveDir, false, note),
    bundle(build, item.source, item.global, resolveDir, true, note),
  ]);
  return { ...item, min, plain };
};
// `module`/`export` are the internal ids; `label`/`moduleLabel` are the selector
// spellings the same row is addressed by (`sha2.js/sha256` and `sha2.js`). Both labels
// ride along rather than being derived downstream: recovering one from the other means
// reproducing `lineLabel`'s file-flavoring and `all`-collapsing rules in every consumer.
// `gzBytes` is level 9 — the number the table prints, so a budget compared against it
// matches what `bismar -bs` reports without the comparer re-gzipping.
export type RowData = {
  export: string;
  gzBytes: number;
  label: string;
  loc: number;
  minBytes: number;
  module: string;
  moduleLabel: string;
  // The unminified bundle's bytes: what `-dbs` (no -m) compares.
  plainBytes: number;
};
const rowData = (item: Item, out: Built, modFile: Map<string, string>): RowData => {
  const gz = gzipSync(out.min, { level: 9 });
  return {
    export: item.export,
    gzBytes: gz.length,
    label: lineLabel(modFile, item.module, item.export),
    loc: decoder.decode(out.plain).split('\n').length,
    minBytes: out.min.length,
    module: item.module,
    moduleLabel: moduleLabel(modFile, item.module),
    plainBytes: out.plain.length,
  };
};
// The whole-module row carries no export token at all: bare `sha3.js` (or the bare
// package name) means "the module itself"; only real exports get a `/name` suffix.
// A big bundle that gzip barely shrinks is dominated by high-entropy content (precomputed
// tables, embedded constants) rather than code; flag it. Small bundles always compress
// poorly because of gzip's fixed overhead, so they are exempt.
const DATA_HEAVY_TAG = 'data-heavy';
const dataHeavy = (data: RowData): boolean =>
  data.minBytes > 2048 && data.gzBytes / data.minBytes > 0.6;
const exportLabel = (name: string): string => (name === ALL ? '' : name);
// One spelling for the measured triple, shared by size lines and interactive rows.
export const sizeTail = (loc: number, minBytes: number, gzBytes: number): string =>
  `${loc} LOC, ${kb(minBytes)}kb min, ${kb(gzBytes)}kb gzip`;
// Table-less human mode (bismar -bs on a TTY): one line per bundle, e.g.
// `ml-kem.js/ml_kem1024 - 120 LOC, 5.61kb, 3.30kb`
const LINE_LABEL_MAX = 40;
// Wrap an installed ref (refs.ts owns the install/locate details) into a measurement Ctx.
export const refContext = (
  outDir: string,
  ref: ExternalRef
): { label: string; refCtx: Ctx; refDir: string } => {
  const { label, pkg, pkgDir, pkgFile, refDir } = installedRef(outDir, ref);
  return { label, refCtx: { cwd: refDir, outDir, pkg, pkgDir, pkgFile }, refDir };
};
const unknownErr = (
  what: string,
  offender: string,
  ids: string[],
  leaf: IdLeaf = 'module',
  use: string = 'use one of:'
): never =>
  err(
    `${what}: ${bad(offender)}; ${
      ids.length ? `${use}\n${listLines(ids, leaf)}` : 'use --list to see modules and exports'
    }`
  );
// The file-flavored module part of a label (`sha2.js`), which is also the whole-module
// row's own label: an export row and its module row differ only by the `/name` suffix.
const moduleLabel = (modFile: Map<string, string>, module: string): string =>
  modFile.get(module) || module;
const lineLabel = (modFile: Map<string, string>, module: string, exp: string): string => {
  const mod = moduleLabel(modFile, module);
  return exp && exp !== ALL ? `${mod}/${exp}` : mod;
};
const sizeLine = (data: RowData, width: number, on: boolean): string => {
  const plain = data.label;
  // The combined multi-selector row is bismar-made, not a selectable module: pink, not yellow.
  const painted =
    data.module === 'selection'
      ? paint(plain, color.pink, on)
      : paintId(plain, on, exportLabel(data.export) ? 'export' : 'module');
  // Pad by the uncolored width so colored labels still line up.
  const label = painted + ' '.repeat(Math.max(0, width - plain.length));
  const tag = dataHeavy(data) ? ` ${paint(DATA_HEAVY_TAG, color.dim, on)}` : '';
  // The measured triple dims like every other size tail (-s rows, -ds stats).
  return `${label} ${paint(sizeTail(data.loc, data.minBytes, data.gzBytes), color.dim, on)}${tag}`;
};
// Headerless machine rows, each value tagged with its unit: sort/awk still
// parse the leading digits, and a row stays self-describing after filtering.
// Column order: module, export, loc, minified bytes, gzipped bytes.
const csvCells = (data: RowData) => [
  data.module,
  exportLabel(data.export),
  `${data.loc}loc`,
  `${data.minBytes}b`,
  `${data.gzBytes}b`,
];
// Display file for a module: the real export file basename (`ml-kem.js`), or the
// exports-map key basename when the key is the user-visible spelling.
export const fileBase = (mod: Pick<Mod, 'file' | 'key'>): string =>
  basename(mod.key === '.' ? mod.file : mod.key);
const modFileMap = (mods: Mod[]): Map<string, string> =>
  new Map(mods.map((mod) => [mod.module, fileBase(mod)]));
// Shape measured modules into the ref db's record rows (refs.ts `RefDbMod`).
export const toDbModules = (mods: Mod[]): RefDbMod[] =>
  mods.map((mod) => ({ exports: mod.exports, file: fileBase(mod), module: mod.module }));
// Merge cached exports into freshly read modules; true means every module was covered
// (so enumeration can be skipped entirely).
export const applyDbExports = (refDir: string, refMods: Mod[]): boolean => {
  const known = refDb(refDir).modules;
  if (!known) return false;
  const byName = new Map(known.map((mod) => [mod.module, mod]));
  let all = true;
  for (const mod of refMods) {
    const hit = byName.get(mod.module);
    if (hit) mod.exports = hit.exports;
    else all = false;
  }
  return all;
};
// `--list`: print importable module/export paths without bundling — each line in
// import-statement syntax (`{abool} from '@noble/hashes/utils.js'`); optional args
// filter by module, and package refs list the external package the same way.
const runList = async (
  ctx: Ctx,
  mods: Mod[],
  items: Item[],
  only: string[],
  input: string,
  loadBuild: () => BuildLike
): Promise<void> => {
  const wanted = new Set<string>();
  const refs = new Map<string, ExternalRef>();
  const localNames = new Set(mods.map((mod) => mod.module));
  // Import statements are stdout payload: a pipe gets them plain, even while
  // stderr keeps its terminal.
  const on = stdoutColor();
  for (const bare of only) {
    // `.` and the package's own name mean the local package itself: no filter.
    if (bare === '.' || bare === ctx.pkg.name) continue;
    if (explicitRef(bare)) {
      const ref = parseNpmRef(asRef(bare));
      if (!refs.has(ref.label)) refs.set(ref.label, ref);
    } else wanted.add(firstModule(ctx.pkg.name, bare));
  }
  // Import statements name no version, so a lone ref lists under its bare name;
  // the same package entered at two versions keeps the pinned labels to tell the
  // listings apart.
  const bareCount = new Map<string, number>();
  for (const ref of refs.values()) bareCount.set(ref.bare, (bareCount.get(ref.bare) ?? 0) + 1);
  if (wanted.size || !refs.size) {
    // A filter that matches nothing is a typo, not an empty package; never go silent.
    const missing = [...wanted].filter((want) => !localNames.has(want));
    if (missing.length)
      unknownErr(
        'unknown module',
        missing.map((want) => `"${want}"`).join(', '),
        sorted(localNames),
        'module'
      );
    // Local paths spell what a consumer imports: the exports-map key under the
    // package name (`.` is the package itself). A sole input file lists as the
    // file path — its synthesized package name is not importable.
    const keyOf = new Map(mods.map((mod) => [mod.module, mod.key]));
    const subOf = (module: string): string => {
      const key = keyOf.get(module) ?? '';
      return key === '.' ? '' : key.replace(/^\.\//, '');
    };
    const lines = items
      .filter((item) => item.export && item.export !== ALL)
      .filter((item) => !wanted.size || wanted.has(item.module))
      .map((item) =>
        input
          ? importLine(item.export, '', relSpec(input), on)
          : importLine(item.export, ctx.pkg.name, subOf(item.module), on)
      );
    if (lines.length) {
      progressDone();
      console.log(lines.join('\n'));
    }
  }
  for (const ref of refs.values()) {
    const { label, refCtx, refDir } = refContext(ctx.outDir, ref);
    const want = ref.path ? firstModule(refCtx.pkg.name, ref.path) : '';
    let refMods = refDb(refDir).modules;
    if (!refMods) {
      const raw = readModules(refCtx);
      await fillExports(loadBuild(), raw);
      refMods = toDbModules(raw);
      // Only pinned installs live outside the run dir and outlast it; cache there.
      if (!refDir.startsWith(ctx.outDir)) saveRefDb(refDir, { modules: refMods });
    }
    const sole = soleIndexOf(refMods);
    // Errors keep selector spelling — their listings are things to type back in.
    const fileId = refRename(label, sole);
    const modId = (mod: RefDbMod): string => fileId(mod.module, mod.file);
    if (want && !refMods.some((mod) => mod.module === want))
      unknownErr('unknown module', want, sorted(refMods.map(modId)));
    const base = (bareCount.get(ref.bare) ?? 0) > 1 ? label : `${ref.jsr ? 'jsr:' : ''}${ref.bare}`;
    const subOf = (mod: RefDbMod): string => (sole && mod.module === 'index' ? '' : mod.file);
    const lines = refMods
      .filter((mod) => !want || mod.module === want)
      // CJS entries defeat export enumeration; at least surface the module itself.
      .flatMap((mod) =>
        mod.exports.length
          ? mod.exports.map((name) => importLine(name, base, subOf(mod), on))
          : [importLine('', base, subOf(mod), on)]
      );
    if (lines.length) {
      progressDone();
      console.log(lines.join('\n'));
    }
  }
  progressDone();
};
export type SizeOpts = {
  // Resolved pinned refs may supply their machine cache directly (bundle-size
  // diff resolves both sides before measurement, rather than parsing refs here).
  cacheDir?: string;
  cwd?: string;
  input?: string;
  listOnly?: boolean;
  // Selectors are local-by-contract (jsbt-check sizeLimits): never fall back to npm, and
  // never take file semantics. This suppresses the fallback; it does not reject a foreign
  // selector up front — `foreignSelector` (refs.ts) is the pure check for that.
  localOnly?: boolean;
  // Fires with the bundle bytes themselves. Wanting a *number* is not a reason to reach
  // for this: sizes live on RowData, and forcing a build to get them defeats the ref cache.
  onBuilt?: (
    bundle: Built,
    meta: { id: string; label: string; moduleLabel: string; name: string }
  ) => void;
  // Diagnostic notes (unresolvable imports, node-condition retries), deduped per run;
  // default is stderr. Interactive mode overrides it: a stray stderr line would
  // scroll the alternate screen.
  onNote?: (text: string) => void;
  // Fires per measured row, cached or built; unlike onBuilt it never forces a build.
  onRow?: (data: RowData) => void;
  only?: string[];
  // Scratch space for ref installs and esbuild work dirs. Omit it and a bismar temp dir
  // is allocated for the call and removed when it returns; pass one to share it across
  // several calls (the CLI and the navigator both keep a session-wide dir).
  outDir?: string;
  silent?: boolean;
  single?: boolean;
};
// The measurement engine proper: every path below reads `opts.outDir` as a given.
// Allocating it is `runSize`'s job, so the engine has one less optional to thread.
const runSizeIn = async (opts: SizeOpts & { outDir: string }): Promise<void> => {
  let only = [...(opts.only ?? [])];
  const baseDir = resolve(opts.cwd ?? process.cwd());
  let input = opts.input;
  // Filesystem selectors: `./x`, `../x`, and absolute paths always mean the
  // filesystem (missing files fail loudly); a bare path takes file semantics
  // only when it carries a JS extension, exists, and names no public module —
  // the published surface outranks the disk that happens to sit behind it. An
  // optional trailing segment picks one export: `./src/util.js/twice`.
  type FileSel = { exportName: string; file: string; spell: string };
  // Split `path/to/file.js[/exportName]`: the whole selector as a file first,
  // else the last segment as an export of the file before it.
  const splitFileSel = (raw: string): FileSel | undefined => {
    if (isFile(resolve(baseDir, raw)))
      return { exportName: '', file: resolve(baseDir, raw), spell: raw };
    const slash = raw.lastIndexOf('/');
    if (slash > 0) {
      const head = raw.slice(0, slash);
      const tail = raw.slice(slash + 1);
      if (tail && isFile(resolve(baseDir, head)))
        return { exportName: tail, file: resolve(baseDir, head), spell: head };
    }
    return undefined;
  };
  const fileSelOf = (raw: string, localNames?: Set<string>, pkgName = ''): FileSel | undefined => {
    if (opts.localOnly) return undefined;
    if (explicitPath(raw)) {
      const sel = splitFileSel(raw);
      if (!sel) err(`missing input file: ${bad(raw)}`);
      return sel;
    }
    if (!BARE_FILE.test(raw) || explicitRef(raw)) return undefined;
    if (localNames?.has(firstModule(pkgName, raw))) return undefined;
    return splitFileSel(raw);
  };
  // Non-throwing classifier for the pre-context checks below.
  const fileish = (raw: string): boolean =>
    !opts.localOnly && (explicitPath(raw) || BARE_FILE.test(raw)) && !!splitFileSel(raw);
  // A sole file selector without an export part browses like --input did: the
  // file is the package, with per-export rows. Export picks use the picker.
  const soleFileSel = (localNames?: Set<string>, pkgName = ''): FileSel | undefined => {
    if (input || only.length !== 1) return undefined;
    const sel = fileSelOf(only[0], localNames, pkgName);
    return sel && !sel.exportName ? sel : undefined;
  };
  const hasPkg = existsSync(join(baseDir, 'package.json'));
  // Without a package.json there are no public modules to defer to.
  if (!hasPkg) {
    const sole = soleFileSel();
    if (sole) {
      input = sole.spell;
      only = [];
    }
  }
  // Registry names need their prefix: a bare leftover in a
  // package-less directory can only be a mistake — say where to go.
  if (!input && !hasPkg && only.length) {
    const stray = only.find((raw) => !explicitRef(raw) && !fileish(raw));
    if (stray !== undefined) noPkgErr(stray, baseDir);
  }
  // Prefix-explicit refs and file picks work from anywhere: without a local
  // package.json they run against a synthetic empty package instead of failing.
  const noLocal = !input && !opts.localOnly && !!only.length && !hasPkg;
  let ctx: Ctx = input
    ? inputCtx(opts.cwd, opts.outDir, input)
    : noLocal
      ? noPkgCtx(baseDir, opts.outDir)
      : resolveCtx(opts.cwd, opts.outDir);
  let es: EsbuildApi | undefined;
  // Never touches test/build and never installs the project: everything happens in a
  // fresh bismar temp dir; deps resolve near the project (node_modules chain) or globally.
  const loadBuild = (): BuildLike => (es ??= loadEsbuild()).build;
  const buildVersion = (): string => (es ??= loadEsbuild()).version;
  if (!opts.listOnly) loadBuild();
  let mods = input ? inputMods(ctx, input) : noLocal ? [] : readModules(ctx);
  const localNames = new Set(mods.map((mod) => mod.module));
  const npmish = (raw: string): boolean => !opts.localOnly && explicitRef(raw);
  // Implicit npm fallbacks keep the local escape route visible on a registry miss.
  const localHint = (error: unknown, implicit: boolean): never => {
    const msg = (error as Error).message;
    if (implicit && localNames.size && msg.startsWith('package not found'))
      err(`${msg}\nor use one of local modules:\n${listLines(sorted(localNames), 'module')}`);
    throw error as Error;
  };
  // File-flavored display labels for ref rows (`qr@0.6.0/dom.js`), matching local rows.
  const refFiles = new Map<string, string>();
  // A bare --input run measures just the file; no package-wide row exists to add.
  let pkgRow = !input;
  // A sole file selector converts to input semantics here, before the browse
  // pre-pass runs. Explicit ./ paths convert even when a public module shares
  // the name — `./` always means the filesystem.
  {
    const sole = soleFileSel(localNames, ctx.pkg.name);
    if (sole) {
      input = sole.spell;
      ctx = inputCtx(opts.cwd, opts.outDir, input);
      mods = inputMods(ctx, input);
      only = [];
      pkgRow = false;
    }
  }
  // Browse mode over a pinned ref: rows cache under this machine dir; the label is
  // stripped off branded module names so keys stay stable across selector spellings.
  let browseCache: { dir: string; full: boolean; label: string } | undefined;
  // Unbranded cache key for one row; the package row is `./all` however it's spelled.
  const rowKey = (module: string, exp: string): string => (exp ? `${module}/${exp}` : `./${ALL}`);
  const stripLabel = (module: string, label: string): string =>
    module === label
      ? '.'
      : module.startsWith(`${label}/`)
        ? module.slice(label.length + 1)
        : module;
  let prefilled = false;
  // Whole-package ref browse closes its table with unpacked/packed sizes: the
  // installed tree is exactly the shipped files, and the tarball bytes resolve
  // in the background while the builds run (quiet on failure — garnish only).
  let pkgSizes: { packed: Promise<number | undefined>; pkgDir: string } | undefined;
  // A single bare package selector is browse mode: expand to the same full table a
  // no-arg run prints inside that package. A single module selector (no export part)
  // browses the same way at module granularity: the module's bundle plus one row per
  // export. Multi-selector runs stay comparison mode (one total row per selector);
  // bundle/check callers keep single-artifact semantics.
  if (only.length === 1 && !opts.listOnly && !opts.single && !opts.silent && !input) {
    const sole = only[0];
    if (sole === '.' || sole === ctx.pkg.name) only = [];
    else if (npmish(sole)) {
      const ref = parseNpmRef(asRef(sole));
      // A path with two or more segments names an export: comparison mode, no expansion.
      const soleModule = ref.path.split('/').filter(Boolean).length === 1;
      if (!ref.path || soleModule) {
        const { label, refCtx, refDir } = ((): ReturnType<typeof refContext> => {
          try {
            return refContext(ctx.outDir, ref);
          } catch (error) {
            return localHint(error, !explicitRef(sole));
          }
        })();
        const refMods = readModules(refCtx);
        const pinnedRef = !refDir.startsWith(ctx.outDir);
        if (pinnedRef) prefilled = applyDbExports(refDir, refMods);
        for (const mod of refMods) mod.spec = realSpec(ref, mod.spec, refCtx.pkg.name);
        if (!ref.path) {
          mods = refMods;
          // The package row shows the pinned label; specs above already use the real name.
          ctx = { ...refCtx, pkg: { ...refCtx.pkg, name: label } };
          only = [];
          if (pinnedRef) browseCache = { dir: refDir, full: true, label };
          pkgSizes = {
            packed: jsHitStats(ref.jsr ? 'jsr:' : 'npm:', {
              desc: '',
              name: ref.bare,
              version: refCtx.pkg.version ?? '',
            })
              .then((stats) => stats?.tgzBytes)
              .catch(() => undefined),
            pkgDir: refCtx.pkgDir,
          };
        } else {
          // A single segment may also name a root-module export (`qr/encodeQR`); only
          // real modules browse — the picker handles everything else.
          const want = firstModule(refCtx.pkg.name, ref.path);
          const mod = refMods.find((entry) => entry.module === want);
          if (mod) {
            // Rows brand with the pinned label so ids stay copy-pasteable.
            const renamed = `${label}/${mod.module}`;
            refFiles.set(renamed, `${label}/${fileBase(mod)}`);
            mods = [{ ...mod, module: renamed }];
            // The lone module may still need enumeration even when others don't.
            prefilled = prefilled || !!mod.exports.length;
            ctx = { ...refCtx, pkg: { ...refCtx.pkg, name: label } };
            only = [];
            pkgRow = false;
            if (pinnedRef) browseCache = { dir: refDir, full: false, label };
          }
        }
      }
    } else {
      const path = normalizeOnlyPath(ctx.pkg.name, sole);
      if (!path.includes('/')) {
        const mod = mods.find((entry) => entry.module === path.replace(ONLY_EXT, ''));
        if (mod) {
          mods = [mod];
          only = [];
          pkgRow = false;
        }
      }
    }
  }
  // Export enumeration (an extra esbuild metafile pass) only runs for full tables and
  // listings; explicit selectors skip it entirely (faster startup) and let esbuild
  // validate names while bundling.
  const refOnly = !!only.length && only.every(npmish);
  // Zero modules would silently measure an empty entry (a ~400-byte interop shim) and
  // list nothing; whatever shape caused it, an error beats a meaningless number.
  if (!mods.length && !noLocal) err(`no importable JS modules found in ${ctx.pkg.name}`);
  if ((input || (opts.listOnly && !refOnly) || !only.length) && !prefilled) {
    await fillExports(loadBuild(), mods);
    // Freshly enumerated full-package browse over a pinned ref: cache it for
    // `--list` and the next browse. Single-module browse knows too little to write.
    if (browseCache?.full) saveRefDb(browseCache.dir, { modules: toDbModules(mods) });
  }
  let items = cases(ctx.pkg, mods, pkgRow);
  if (browseCache) {
    const { dir, label } = browseCache;
    items = items.map((item) => ({
      ...item,
      cacheDir: dir,
      cacheKey: rowKey(stripLabel(item.module, label), item.export),
    }));
  } else if (opts.cacheDir) {
    items = items.map((item) => ({
      ...item,
      cacheDir: opts.cacheDir,
      cacheKey: rowKey(item.module, item.export),
    }));
  }
  if (opts.listOnly) return runList(ctx, mods, items, only, input ?? '', loadBuild);
  // Enumerates a module's export ids on demand (error paths only; extra metafile pass).
  const exportIds = async (mod: Mod): Promise<string[]> => {
    const names = mod.exports.length ? mod.exports : await bundleExports(loadBuild(), mod.file);
    return names.map((name) => `${mod.module}/${name}`);
  };
  // Ref modules by branded name, so build failures list ref exports as friendly errors.
  const extMods = new Map<string, Mod>();
  if (only.length) {
    type Picker = (raw: string, path: string) => Promise<Item>;
    type PickerOpts = {
      brand: (item: Item) => Item;
      items: Item[];
      // Local names came straight from the command line; quote them in errors.
      local?: boolean;
      // Selector-form module label for error messages: refs get their npm: prefix back.
      modLabel?: (module: string) => string;
      mods: Mod[];
      pkg: Pkg;
      rootExportFallback: boolean;
    };
    const makePicker = ({
      brand,
      items: pkgItems,
      local = false,
      modLabel = (module) => module,
      mods: pkgMods,
      pkg,
      rootExportFallback,
    }: PickerOpts): Picker => {
      const rows = pkgItems.filter((item) => item.export);
      const byId = new Map(rows.map((item) => [`${item.module}/${item.export}`, item]));
      const modsByName = new Map(pkgMods.map((mod) => [mod.module, mod]));
      return async (raw, rawPath) => {
        // `.` and the package's own name select the whole package (its total row).
        if (!rawPath || rawPath === '.' || rawPath === pkg.name) {
          const row =
            pkgItems.find((item) => !item.export) || err(`no bundles found in ${bad(raw)}`);
          return brand(row);
        }
        const path = normalizeOnlyPath(pkg.name, rawPath);
        const direct = byId.get(path);
        if (direct) return brand(direct);
        const slash = path.indexOf('/');
        const seg = slash < 0 ? path : path.slice(0, slash);
        let modName = seg.replace(ONLY_EXT, '');
        // An explicit `.js`/`.ts` extension names a module; never retry it as an export.
        const hadExt = seg !== modName;
        // Mistyped extensions (`secp256k1.t2`) survive the ONLY_EXT strip and would
        // otherwise be treated as export names or unknown modules; catch them early.
        const extTypo = modName.replace(/\.\w+$/, '');
        if (!modsByName.has(modName) && extTypo !== modName && modsByName.has(extTypo)) {
          const rest = slash < 0 ? '' : `/${path.slice(slash + 1)}`;
          return err(`unknown module: ${bad(modName)}; did you mean ${modLabel(extTypo)}${rest}?`);
        }
        // A bare module name selects the whole module (its ALL bundle); on single-root
        // external packages it falls back to an export of the root module.
        let name = slash < 0 ? ALL : path.slice(slash + 1);
        let fellBack = false;
        if (
          slash < 0 &&
          rootExportFallback &&
          !hadExt &&
          !modsByName.has(modName) &&
          modsByName.has('index')
        ) {
          name = path;
          modName = 'index';
          fellBack = true;
        }
        const mod = modsByName.get(modName);
        if (!mod) {
          const ids = sorted(modsByName.keys()).map(modLabel);
          return unknownErr('unknown module', local ? `"${modName}"` : modName, ids);
        }
        const known = byId.get(`${mod.module}/${name}`);
        if (known) return brand(known);
        if (mod.exports.length || name === ALL)
          return unknownErr(
            `${modLabel(mod.module)} has no export`,
            name,
            await exportIds({ ...mod, module: modLabel(mod.module) }),
            'export'
          );
        // The name is spliced into `export { name } from ...`, so it must be an identifier;
        // catching it here beats a cryptic esbuild parse error against the generated file.
        if (!ident(name)) {
          const fixed = name.replace(/-/g, '_');
          const hint = ident(fixed) ? `; did you mean ${mod.module}/${fixed}?` : '';
          return err(`invalid export name: ${bad(name)} (exports are JS identifiers)${hint}`);
        }
        // Fast mode skipped export enumeration; esbuild validates the name during bundling.
        return brand({
          ...exportItem(pkg, mod, name),
          // Failed fallbacks report unknown-module style: the raw name may have meant either.
          rootModules: fellBack ? sorted(modsByName.keys()).map(modLabel) : undefined,
        });
      };
    };
    const localPick = makePicker({
      brand: (item) => item,
      items,
      local: true,
      mods,
      pkg: ctx.pkg,
      rootExportFallback: false,
    });
    const refPickers = new Map<string, Picker>();
    const refPicker = (ref: ExternalRef): Picker => {
      const cached = refPickers.get(ref.label);
      if (cached) return cached;
      const { label, refCtx, refDir } = refContext(ctx.outDir, ref);
      const refMods = readModules(refCtx);
      const soleIdx = soleIndexOf(refMods);
      const rename = refRename(label, soleIdx, refCtx.pkg.name);
      // File-flavored ids collapse by the same sole-index rule, but never by pkg name.
      const fileId = refRename(label, soleIdx);
      for (const mod of refMods) {
        mod.spec = realSpec(ref, mod.spec, refCtx.pkg.name);
        const renamed = rename(mod.module);
        extMods.set(renamed, { ...mod, module: renamed });
        refFiles.set(renamed, fileId(mod.module, fileBase(mod)));
      }
      // Absolute-path sources bundle identically from any resolveDir, which the combined
      // selection row relies on when it mixes refs and local exports.
      // The cache key is computed before branding, so every selector spelling of one
      // version shares the machine-cached measurement.
      const pinnedDir = refDir.startsWith(ctx.outDir) ? undefined : refDir;
      const brand = (item: Item): Item => ({
        ...item,
        absSource: item.absSource,
        cacheDir: pinnedDir,
        cacheKey: rowKey(item.module, item.export),
        dir: `${slug(ref.label)}${item.dir ? `/${item.dir}` : ''}`,
        module: rename(item.module),
        resolveDir: refDir,
        source: item.absSource ?? item.source,
      });
      // Items stay unbranded for id lookups; the brand applies to whatever gets picked.
      const picker = makePicker({
        brand,
        items: cases(refCtx.pkg, refMods, true),
        modLabel: rename,
        mods: refMods,
        pkg: refCtx.pkg,
        rootExportFallback: true,
      });
      refPickers.set(ref.label, picker);
      return picker;
    };
    let hasRefs = false;
    const picked: Item[] = [];
    for (const bare of only) {
      // Filesystem picks (`./util.js`, `src/util.js`, `./src/util.js/twice`)
      // are full citizens: they compose with modules and refs in one selection.
      const fsel = fileSelOf(bare, localNames, ctx.pkg.name);
      if (fsel) {
        if (fsel.exportName && !ident(fsel.exportName))
          err(`invalid export name: ${bad(fsel.exportName)} (exports are JS identifiers)`);
        picked.push(fileItem(fsel.spell, fsel.file, fsel.exportName));
        continue;
      }
      if (!npmish(bare)) {
        try {
          picked.push(await localPick(bare, bare));
        } catch (error) {
          // Bare names never reach npm now; point registry-shaped ones there.
          const hint = npmHintOf(bare);
          if (hint) err(`${(error as Error).message}\nor ${hint} for the registry package`);
          throw error;
        }
        continue;
      }
      hasRefs = true;
      // Re-parse per selector: two selectors may share a ref but name different paths.
      const parsed = parseNpmRef(asRef(bare));
      try {
        picked.push(await refPicker(parsed)(bare, parsed.path));
      } catch (error) {
        localHint(error, !explicitRef(bare));
      }
    }
    // Multiple picks also get a combined ALL bundle: their cost when imported together.
    items =
      picked.length > 1 ? [selection(picked, hasRefs ? ctx.cwd : undefined), ...picked] : picked;
  }
  // Bundle emission (`bismar -b`) emits one artifact: the first item is
  // always the widest bundle —
  // package row, selection row, the --input file's ALL row, or the single pick.
  if (opts.single) items = items.slice(0, 1);
  // `-bs` always shows its table — only opts.silent mutes it; non-interactive
  // environments (LLM agents, pipes, CI logs) get CSV instead of a table.
  const show = !opts.silent;
  const csv = csvEnabled();
  const colorOn = stdoutColor();
  // Human mode renders plain lines; non-interactive environments (LLM agents, pipes,
  // CI logs) get CSV. Module names show the real export file (`ml-kem.js`), matching
  // accepted selector spellings.
  const modFile = modFileMap(mods);
  for (const [name, file] of refFiles) modFile.set(name, file);
  // Rare overlong labels overflow on their own instead of inflating everyone's padding.
  const labelWidth = Math.min(
    LINE_LABEL_MAX,
    Math.max(...items.map((item) => lineLabel(modFile, item.module, item.export).length))
  );
  const results: RowData[] = [];
  // Pinned-ref rows read the machine cache and may skip esbuild entirely; only
  // callers that need bundle bytes (onBuilt) force a real build. One db read per
  // ref dir per run, not per row.
  const sizesByDir = new Map<string, RefDbSizes | undefined>();
  const cachedRow = (item: Item): RowData | undefined => {
    if (!item.cacheDir || !item.cacheKey || opts.onBuilt) return undefined;
    if (!sizesByDir.has(item.cacheDir)) sizesByDir.set(item.cacheDir, refDb(item.cacheDir).sizes);
    const sizes = sizesByDir.get(item.cacheDir);
    if (!sizes || sizes.esbuild !== buildVersion()) return undefined;
    const hit = sizes.rows[item.cacheKey];
    // Three-element rows predate plainBytes; treat them as misses so a stale
    // cache rebuilds instead of reporting an undefined size.
    if (!hit || hit.length < 4) return undefined;
    return {
      export: item.export,
      gzBytes: hit[2],
      label: lineLabel(modFile, item.module, item.export),
      loc: hit[0],
      minBytes: hit[1],
      module: item.module,
      moduleLabel: moduleLabel(modFile, item.module),
      plainBytes: hit[3],
    };
  };
  // Builds run BUILD_POOL-wide while results are consumed — printed, cached,
  // reported — strictly in input order.
  const limit = makeLimit(BUILD_POOL);
  const dirty = new Map<string, Record<string, [number, number, number, number]>>();
  // Run-wide note sink: dedupes repeats before they reach stderr (or the caller).
  const noted = new Set<string>();
  const note = (text: string): void => {
    if (noted.has(text)) return;
    noted.add(text);
    // Notes and the progress line share stderr; clear the line so they never merge.
    progressDone();
    (opts.onNote ?? console.error)(text);
  };
  const cachedRows = items.map((item) => cachedRow(item));
  const toBuild = cachedRows.filter((row) => !row).length;
  let built = 0;
  const jobs = items.map((item, i) => {
    const cached = cachedRows[i];
    const run = cached
      ? undefined
      : limit(() => buildCase(ctx, loadBuild(), item, note)).then((out) => {
          progressUpdate(`bundling ${++built}/${toBuild}`);
          return out;
        });
    // An early item's failure aborts the run; later in-flight rejections are moot.
    run?.catch(() => {});
    return { cached, item, run };
  });
  try {
    for (const job of jobs) {
      const item = job.item;
      let data = job.cached;
      if (job.run) {
        const out = await job.run.catch(async (error) => {
          // Esbuild messages reference temp work files by long relative paths; strip them
          // so the remaining raw errors point at the package's own files only.
          const msg = (error as Error).message
            .replaceAll(`${relative(process.cwd(), ctx.outDir)}/`, '')
            .replaceAll(`${ctx.outDir}/`, '');
          const mod = /No matching export/.test(msg)
            ? (mods.find((entry) => entry.module === item.module) ?? extMods.get(item.module))
            : undefined;
          if (mod) {
            const ids = await exportIds(mod);
            // A bare name that fell back to an export-less root was likely a module typo.
            if (!ids.length && item.rootModules)
              return unknownErr('unknown module or export', item.export, item.rootModules);
            return unknownErr(`${mod.module} has no export`, item.export, ids, 'export');
          }
          return err(`bundling ${itemId(ctx.pkg, item)} failed: ${msg}`);
        });
        opts.onBuilt?.(out, {
          id: itemId(ctx.pkg, item),
          // Selector-spelling label (`index.js`, `sha2.js/sha256`), as accepted by `only`,
          // and the module part alone — the same pair `RowData` carries.
          label: lineLabel(modFile, item.module, item.export),
          moduleLabel: moduleLabel(modFile, item.module),
          name: outPath(ctx.pkg, item, 'js'),
        });
        if (show || opts.onRow || item.cacheDir) data = rowData(item, out, modFile);
        if (data && item.cacheDir && item.cacheKey) {
          const rows = dirty.get(item.cacheDir) ?? {};
          rows[item.cacheKey] = [data.loc, data.minBytes, data.gzBytes, data.plainBytes];
          dirty.set(item.cacheDir, rows);
        }
      }
      if (data) {
        opts.onRow?.(data);
        if (show) results.push(data);
      }
    }
  } finally {
    // One write per ref dir, even when a later row aborted the run.
    for (const [dir, rows] of dirty) {
      const prev = refDb(dir).sizes;
      const keep = prev && prev.esbuild === buildVersion() ? prev.rows : {};
      saveRefDb(dir, { sizes: { esbuild: buildVersion(), rows: { ...keep, ...rows } } });
    }
    // The line must be gone before whatever comes next: table, bundle, or error.
    progressDone();
  }
  if (show && results.length) {
    for (const data of results) {
      if (csv) console.log(csvRow(csvCells(data)));
      else console.log(sizeLine(data, labelWidth, colorOn));
    }
    // CSV stays rows-only: the footer is a human summary, not another record.
    if (!csv && pkgSizes) {
      const unpacked = [...walkFiles(pkgSizes.pkgDir).values()].reduce((sum, b) => sum + b, 0);
      const packed = await pkgSizes.packed;
      const tail = packed ? ` · ${fmtBytes(packed)} packed` : '';
      // Same grammar as the -s footer: unpacked · packed · count.
      const count = ` · ${results.length} bundle${results.length === 1 ? '' : 's'}`;
      console.log(
        `\n${paint(`${fmtBytes(unpacked)} unpacked${tail}${count}`, color.dim, colorOn)}`
      );
    }
  }
};
export const runSize = async (opts: SizeOpts): Promise<void> => {
  // A caller-supplied dir is the caller's to clean, and sharing one across calls is why
  // the option exists (the CLI and the navigator both do). Only a dir we allocated is
  // ours to remove — unpinned ref installs land under it, so that removal is the point.
  if (opts.outDir) return runSizeIn({ ...opts, outDir: opts.outDir });
  const owned = tempDir('size');
  try {
    await runSizeIn({ ...opts, outDir: owned });
  } finally {
    rmTempDir(owned);
  }
};
// Collect the existing measurement engine's rows without printing them. Diff
// modes use this wrapper so enumeration, bundling, gzip, and pinned-ref caching
// remain one implementation. `single` narrows a multi-selector run to the combined
// bundle alone — the cost of importing those selectors together, measured once.
export const measureRows = async (
  opts: Pick<SizeOpts, 'cacheDir' | 'cwd' | 'localOnly' | 'onNote' | 'only' | 'outDir' | 'single'>
): Promise<RowData[]> => {
  const rows: RowData[] = [];
  await runSize({
    ...opts,
    onRow: (row) => rows.push(row),
    silent: true,
  });
  return rows;
};
// Build exactly one artifact — the widest bundle of the selection — and return it.
export const buildFirst = async (
  opts: Omit<SizeOpts, 'onBuilt' | 'onRow' | 'silent' | 'single'>
): Promise<Built | undefined> => {
  let built: Built | undefined;
  await runSize({
    ...opts,
    onBuilt: (out) => {
      built ??= out;
    },
    silent: true,
    single: true,
  });
  return built;
};
