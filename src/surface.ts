/**
Static listings (`--list`, `--size`) for non-JS registry refs, derived from the
extracted files and manifests alone — JSON reads, file layout, and line
regexes; package code is never parsed beyond that, and never executed.
`--list`: go/composer/pypi/gem print one import statement per line in their own
syntax; crate: and gh: have no statically derivable surface and fall back to
the shipped file listing, as does any package whose lister comes up empty.
`--size`: plain shipped-file sizes — no bundling, no minification, just bytes
on disk — closed by a total. Fetching delegates to registries.ts; everything
here is reads.
@module
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { walkFiles } from './diff.ts';
import { color, csvEnabled, csvRow, paint, wantColor } from './env.ts';
import { fmtBytes, kb, readJson, sorted } from './public.ts';
import { parseRegistryRef, registryContext } from './registries.ts';

const IDENT = /^[A-Za-z_]\w*$/;

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
const goSurface = (pkgDir: string, refName: string): string[] => {
  let mod = refName;
  try {
    const named = /^module\s+(\S+)/m.exec(readFileSync(join(pkgDir, 'go.mod'), 'utf8'));
    if (named) mod = named[1];
  } catch {
    // No go.mod (pre-modules archives): the ref name is the import path.
  }
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
  const lsDir = (base: string): string[] => {
    try {
      return readdirSync(join(pkgDir, base));
    } catch {
      return [];
    }
  };
  for (const base of ['', 'src'])
    for (const ent of lsDir(base)) {
      if (!/\.(dist|egg)-info$/.test(ent)) continue;
      try {
        for (const line of readFileSync(join(pkgDir, base, ent, 'top_level.txt'), 'utf8').split(
          '\n'
        ))
          if (IDENT.test(line.trim())) names.add(line.trim());
      } catch {
        // Metadata without top_level.txt: fall through to the layout scan.
      }
    }
  if (!names.size)
    for (const base of ['src', '']) {
      for (const ent of lsDir(base))
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

export const surfaceOf = (
  prefix: string,
  name: string,
  pkgDir: string,
  on: boolean = wantColor()
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
  const got = await registryContext(outDir, ref);
  return surfaceOf(ref.prefix, ref.name, got.pkgDir);
};

// `--size` rows for a registry extract: every shipped file with its byte size,
// path order. The human table closes with a total line; CSV stays rows-only,
// like every other machine listing (sums are one awk away).
const sizeEntries = (pkgDir: string): [string, number][] =>
  [...walkFiles(pkgDir).entries()].sort(([a], [b]) => a.localeCompare(b));
// Headerless like every machine listing; the unit tag keeps rows self-describing.
export const sizesCsv = (pkgDir: string): string[] =>
  sizeEntries(pkgDir).map(([path, bytes]) => csvRow([path, `${bytes}b`]));
export const sizesHuman = (
  pkgDir: string,
  on: boolean = wantColor(),
  archiveBytes?: number
): string[] => {
  const entries = sizeEntries(pkgDir);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  return [
    ...entries.map(
      ([path, bytes]) => paint(path, color.green, on) + paint(`  ${kb(bytes)}kb`, color.dim, on)
    ),
    '',
    `${entries.length} file${entries.length === 1 ? '' : 's'}, ${fmtBytes(total)}` +
      (archiveBytes ? `, ${fmtBytes(archiveBytes)} archive` : ''),
  ];
};
export const registrySizes = async (outDir: string, selector: string): Promise<string[]> => {
  const ref = parseRegistryRef(selector);
  const got = await registryContext(outDir, ref);
  return csvEnabled()
    ? sizesCsv(got.pkgDir)
    : sizesHuman(got.pkgDir, wantColor(), got.archiveBytes);
};
