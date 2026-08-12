/**
Static facts about a package, derived from its extracted files and manifests
alone — JSON reads, file layout, and line regexes; package code is never parsed
beyond that, and never executed.
`--list` (non-JS registry refs): go/composer/pypi/gem print one import statement
per line in their own syntax; crate:, gh:, and gitlab: have no statically derivable
surface and fall back to the shipped file listing, as does any package whose
lister comes up empty.
`--size`: plain shipped-file sizes — no bundling, no minification, just bytes
on disk — closed by a total.
`ghRepoOf`: the github repository a manifest advertises, for the navigator's `r`
jump — every ecosystem here plus package.json. Fetching delegates to
registries.ts; everything here is reads.
@module
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { scoped, walkFiles } from './diff.ts';
import { color, csvEnabled, csvRow, paint, stdoutColor } from './env.ts';
import { bad, err, fmtBytes, kb, readJson, sorted } from './public.ts';
import { parseRegistryRef, registryContext } from './registries.ts';

const IDENT = /^[A-Za-z_]\w*$/;
// A missing manifest or directory is the common case here, not an error: every
// lister asks for more spellings than any one package ships.
const readMaybe = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const lsDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// Go packages are directories: every dir with non-test .go files maps to an
// import path under the go.mod module (the ref name when go.mod is absent).
// `internal/`, `testdata/`, `vendor/`, and `_`/`.`-prefixed segments are
// unimportable or ignored by go tooling; `package main` dirs are binaries.
const goSkip = (rel: string): boolean =>
  rel
    .split('/')
    .some(
      (seg) =>
        seg === 'internal' ||
        seg === 'testdata' ||
        seg === 'vendor' ||
        seg.startsWith('.') ||
        seg.startsWith('_')
    );
// No go.mod (pre-modules archives): the ref name is the import path.
const goModule = (pkgDir: string, refName: string): string =>
  /^module\s+(\S+)/m.exec(readMaybe(join(pkgDir, 'go.mod')))?.[1] ?? refName;
const goSurface = (pkgDir: string, refName: string): string[] => {
  const mod = goModule(pkgDir, refName);
  const byDir = new Map<string, string[]>();
  for (const file of walkFiles(pkgDir).keys()) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const dir = dirname(file);
    const rel = dir === '.' ? '' : dir;
    if (goSkip(rel)) continue;
    const files = byDir.get(rel) ?? [];
    files.push(file);
    byDir.set(rel, files);
  }
  const paths: string[] = [];
  for (const [rel, files] of byDir)
    for (const file of files) {
      const pkg = /^package\s+([A-Za-z_]\w*)/m.exec(readFileSync(join(pkgDir, file), 'utf8'))?.[1];
      if (!pkg) continue;
      if (pkg !== 'main') paths.push(rel ? `${mod}/${rel}` : mod);
      break;
    }
  return sorted(paths);
};

// PSR-4 is a mechanical file→class mapping: namespace prefix + relative path
// with `/`→`\` and `.php` stripped. Only identifier-shaped segments qualify —
// anything else is not autoloadable under PSR-4 anyway.
const composerSurface = (pkgDir: string): string[] => {
  let psr4: Record<string, unknown>;
  try {
    const manifest = readJson<{ autoload?: { 'psr-4'?: Record<string, unknown> } }>(
      join(pkgDir, 'composer.json')
    );
    psr4 = manifest.autoload?.['psr-4'] ?? {};
  } catch {
    return [];
  }
  const classes: string[] = [];
  for (const [ns, target] of Object.entries(psr4)) {
    const dirs = (Array.isArray(target) ? target : [target]).filter(
      (dir): dir is string => typeof dir === 'string'
    );
    for (const dir of dirs) {
      const root = join(pkgDir, dir);
      if (!existsSync(root)) continue;
      for (const file of walkFiles(root).keys()) {
        if (!file.endsWith('.php')) continue;
        const parts = file.slice(0, -4).split('/');
        if (parts.every((part) => IDENT.test(part))) classes.push(ns + parts.join('\\'));
      }
    }
  }
  return sorted(classes);
};

// Wheels and sdist egg-info name their top-level modules outright (src-layout
// sdists keep the egg-info under src/); without that metadata, top-level
// packages are the dirs holding an __init__.py — under src/ when that layout
// exists (its whole point is separating importable code), at the root
// otherwise, minus the conventional non-import trees that also carry
// __init__.py in the wild.
const PY_SKIP = new Set(['doc', 'docs', 'example', 'examples', 'test', 'testing', 'tests']);
const pypiSurface = (pkgDir: string): string[] => {
  const names = new Set<string>();
  for (const base of ['', 'src'])
    for (const ent of lsDir(join(pkgDir, base))) {
      if (!/\.(dist|egg)-info$/.test(ent)) continue;
      // Metadata without top_level.txt reads empty: the layout scan takes over.
      for (const line of readMaybe(join(pkgDir, base, ent, 'top_level.txt')).split('\n'))
        if (IDENT.test(line.trim())) names.add(line.trim());
    }
  if (!names.size)
    for (const base of ['src', '']) {
      for (const ent of lsDir(join(pkgDir, base)))
        if (!PY_SKIP.has(ent) && existsSync(join(pkgDir, base, ent, '__init__.py'))) names.add(ent);
      if (names.size) break;
    }
  return sorted(names);
};

// The lib/ convention is the gem require surface: lib/rails/all.rb answers to
// `require 'rails/all'`. require_paths beyond lib/ live in the gemspec, which
// is Ruby code and stays unread.
const gemSurface = (pkgDir: string): string[] => {
  const lib = join(pkgDir, 'lib');
  if (!existsSync(lib)) return [];
  return sorted(
    [...walkFiles(lib).keys()]
      .filter((file) => file.endsWith('.rb'))
      .map((file) => file.slice(0, -3))
  );
};

// The navigator's `r` target. repository spellings seen in the wild:
// "github:u/r", bare "u/r" shorthand (package.json only), "git+https://….git",
// "git://…", monorepo urls with /tree/… tails, and bare "github.com/u/r".
const GH_REPO = /(?:^github:|github\.com[/:])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#].*)?$/;
const ghRepoOfUrl = (url: string): string => {
  const hit = GH_REPO.exec(url.trim());
  return hit ? `${hit[1]}/${hit[2]}` : '';
};
// Manifests advertise several urls (homepage, docs, issues, source); the first
// one that reads as a github repository wins, and a package that names none
// simply offers no jump.
const firstGhRepo = (urls: string[]): string => {
  for (const url of urls) {
    const repo = ghRepoOfUrl(url);
    if (repo) return repo;
  }
  return '';
};
const strings = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((hit) => hit[1]);
// `key = "value"` lines: the toml/cfg shape of every url a manifest declares
// ([package] in Cargo.toml, [project.urls] in pyproject, [metadata] in
// setup.cfg). Array items — git dependencies pinned to a url — never match.
const CONF_URL = /^\s*[\w.\- ]+\s*=\s*["']?([\w+.-]+:\/\/[^"'\s]+)/gm;
const jsRepo = (pkgDir: string): string => {
  let raw: unknown;
  try {
    raw = readJson<{ repository?: unknown }>(join(pkgDir, 'package.json')).repository;
  } catch {
    // No manifest or an unparseable one: nothing advertised.
    return '';
  }
  const url =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && typeof (raw as { url?: unknown }).url === 'string'
        ? (raw as { url: string }).url
        : '';
  // The bare `u/r` shorthand is npm's alone; elsewhere only real urls count.
  return ghRepoOfUrl(url) || (/^[\w.-]+\/[\w.-]+$/.test(url) ? url : '');
};
const crateRepo = (pkgDir: string): string =>
  firstGhRepo(strings(readMaybe(join(pkgDir, 'Cargo.toml')), CONF_URL));
const composerRepo = (pkgDir: string): string => {
  try {
    const manifest = readJson<{ homepage?: unknown; support?: { source?: unknown } }>(
      join(pkgDir, 'composer.json')
    );
    return firstGhRepo(
      [manifest.support?.source, manifest.homepage].filter(
        (url): url is string => typeof url === 'string'
      )
    );
  } catch {
    return '';
  }
};
// Go modules need no manifest field: github-hosted import paths name the
// repository outright, `/v2` major-version suffix and all.
const goRepo = (pkgDir: string, refName: string): string => ghRepoOfUrl(goModule(pkgDir, refName));
// Core metadata is RFC822 — `Home-page: <url>` and `Project-URL: <label>, <url>`
// — in PKG-INFO (sdists), METADATA (wheels), or the egg-info beside them;
// sdists built without it still declare their urls in pyproject/setup.cfg.
const PY_URL = /^(?:Home-page|Project-URL):\s*(?:[^,\n]*,\s*)?(\S+)$/gm;
const pypiRepo = (pkgDir: string): string => {
  const metas = [readMaybe(join(pkgDir, 'PKG-INFO'))];
  for (const base of ['', 'src'])
    for (const ent of lsDir(join(pkgDir, base))) {
      if (!/\.(dist|egg)-info$/.test(ent)) continue;
      metas.push(
        readMaybe(join(pkgDir, base, ent, 'METADATA')),
        readMaybe(join(pkgDir, base, ent, 'PKG-INFO'))
      );
    }
  return (
    firstGhRepo(metas.flatMap((text) => strings(text, PY_URL))) ||
    firstGhRepo(
      ['pyproject.toml', 'setup.cfg'].flatMap((file) =>
        strings(readMaybe(join(pkgDir, file)), CONF_URL)
      )
    )
  );
};
// Gemspecs are Ruby and stay unparsed: the github url quoted in a `homepage` or
// `source_code_uri` assignment is picked out of the text, nothing else is read.
const GEM_URL = /["']([\w+.-]+:\/\/[^"'\s]*github\.com[^"'\s]*)["']/g;
const gemRepo = (pkgDir: string): string =>
  firstGhRepo(
    lsDir(pkgDir)
      .filter((ent) => ent.endsWith('.gemspec'))
      .flatMap((ent) => strings(readMaybe(join(pkgDir, ent)), GEM_URL))
  );
const REPO_OF: Record<string, (pkgDir: string, refName: string) => string> = {
  'composer:': composerRepo,
  'crate:': crateRepo,
  'gem:': gemRepo,
  'go:': goRepo,
  'pypi:': pypiRepo,
};
/** A package's advertised github repo (`owner/name`) and the ecosystem that named it. */
export type GhRepo = { eco: string; repo: string };
const NO_REPO: GhRepo = { eco: '', repo: '' };
export const ghRepoOf = (pkgDir: string, prefix: string = '', refName: string = ''): GhRepo => {
  // gh:/gitlab: extracts are the repository already; there is nowhere to jump.
  if (prefix === 'gh:' || prefix === 'gitlab:') return NO_REPO;
  const known = REPO_OF[prefix];
  if (known) {
    const repo = known(pkgDir, refName);
    return repo ? { eco: prefix.slice(0, -1), repo } : NO_REPO;
  }
  // Prefixless: a JS package or a plain directory of unknown ecosystem, so
  // every manifest gets a look — package.json first, it being the likeliest.
  // Whichever answers names the ecosystem (a rust checkout browsed as plain
  // files is a crate, not an npm package).
  for (const [name, lookup] of [['npm', jsRepo] as const, ...Object.entries(REPO_OF)]) {
    const repo = lookup(pkgDir, refName);
    if (repo) return { eco: name.endsWith(':') ? name.slice(0, -1) : name, repo };
  }
  return NO_REPO;
};

export const surfaceOf = (
  prefix: string,
  name: string,
  pkgDir: string,
  on: boolean = stdoutColor()
): string[] => {
  const wrap = (lines: string[], render: (token: string) => string): string[] =>
    lines.map((token) => render(paint(token, color.cyan, on)));
  const lines =
    prefix === 'go:'
      ? wrap(goSurface(pkgDir, name), (token) => `import "${token}"`)
      : prefix === 'composer:'
        ? wrap(composerSurface(pkgDir), (token) => `use ${token};`)
        : prefix === 'pypi:'
          ? wrap(pypiSurface(pkgDir), (token) => `import ${token}`)
          : prefix === 'gem:'
            ? wrap(gemSurface(pkgDir), (token) => `require '${token}'`)
            : [];
  return lines.length ? lines : sorted(walkFiles(pkgDir).keys());
};

export const registrySurface = async (outDir: string, selector: string): Promise<string[]> => {
  const ref = parseRegistryRef(selector);
  // The import surface is a whole-package fact; a `/path` tail belongs to the
  // file modes (flagless deep link / cat, -s scope).
  if (ref.path) err(`the import surface lists whole packages; drop /${bad(ref.path)}`);
  const got = await registryContext(outDir, ref);
  return surfaceOf(ref.prefix, ref.name, got.pkgDir);
};

// `--size` rows for a registry extract: every shipped file with its byte size,
// path order. The human table closes with a total line; CSV stays rows-only,
// like every other machine listing (sums are one awk away). A `/path` ref tail
// scopes the rows by diff's rule (the file, or a directory's subtree) — and a
// scope matching nothing is a typo'd path, not an empty package; never go silent.
const sizeEntries = (pkgDir: string, sel?: string): [string, number][] => {
  const files = scoped(walkFiles(pkgDir), sel);
  if (sel && !files.size) err(`no shipped file matches /${bad(sel)}; drop the tail to list files`);
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
};
const sizeCsv = (entries: [string, number][]): string[] =>
  entries.map(([path, bytes]) => csvRow([path, `${bytes}b`]));
// The navigator's files-view palette (interactive.ts): directories cyan,
// files unpainted. Rows here are whole relative paths, so the dir prefix
// takes the cyan. No red entry-point pop — a flat listing has no cursor to
// guide toward it.
const paintPath = (path: string, on: boolean): string => {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  return (dir && paint(dir, color.cyan, on)) + path.slice(slash + 1);
};
const sizeHuman = (entries: [string, number][], on: boolean, archiveBytes?: number): string[] => {
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  return [
    ...entries.map(
      ([path, bytes]) => paintPath(path, on) + paint(`  ${kb(bytes)}kb`, color.dim, on)
    ),
    '',
    // Dim like every other summary footer, worded like the -bs one: unpacked ·
    // packed · count.
    paint(
      `${fmtBytes(total)} unpacked` +
        (archiveBytes ? ` · ${fmtBytes(archiveBytes)} packed` : '') +
        ` · ${entries.length} file${entries.length === 1 ? '' : 's'}`,
      color.dim,
      on
    ),
  ];
};
// Headerless like every machine listing; the unit tag keeps rows self-describing.
export const sizesCsv = (pkgDir: string, sel?: string): string[] =>
  sizeCsv(sizeEntries(pkgDir, sel));
export const sizesHuman = (
  pkgDir: string,
  on: boolean = stdoutColor(),
  archiveBytes?: number,
  sel?: string
): string[] => sizeHuman(sizeEntries(pkgDir, sel), on, archiveBytes);
// Degenerate shipped tree for `-s ./input.js`: keep the same row and footer
// grammar without staging a read-only input in a temp directory.
export const fileSizesCsv = (file: string): string[] =>
  sizeCsv([[basename(file), statSync(file).size]]);
export const fileSizesHuman = (file: string, on: boolean = stdoutColor()): string[] =>
  sizeHuman([[basename(file), statSync(file).size]], on);
export const registrySizes = async (outDir: string, selector: string): Promise<string[]> => {
  const ref = parseRegistryRef(selector);
  const got = await registryContext(outDir, ref);
  return csvEnabled()
    ? sizesCsv(got.pkgDir)
    : sizesHuman(got.pkgDir, stdoutColor(), got.archiveBytes);
};
