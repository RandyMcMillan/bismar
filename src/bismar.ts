#!/usr/bin/env node
/**
 * One command, two outputs.
 * @module
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bundleStatCsv,
  bundleStatHuman,
  diffBundleRows,
  diffTarget,
  diffTrees,
  measuredSide,
  packLocalSide,
  packLocalSides,
  renderTextUnifiedHighlighted,
  renderUnifiedHighlighted,
  scoped,
  statCsv,
  statHuman,
  statNames,
  walkFiles,
} from './diff.ts';
import {
  color,
  csvEnabled,
  csvRow,
  paint,
  progressDone,
  progressUpdate,
  stdoutColor,
  terminalText,
  wantColor,
} from './env.ts';
import { clearTempCaches, rmTempDir, tempDir } from './fs-modify.ts';
import type { InteractiveIo } from './interactive.ts';
import { bad, err, explicitPath, fmtBytes, kb, readJson, readPkg, runSelf } from './public.ts';
import {
  asRef,
  explicitRef,
  type ExternalRef,
  installedRef,
  npmHintUse,
  parseNpmRef,
  PINNED,
} from './refs.ts';
import {
  canonSelector,
  isRegistrySelector,
  parseProfileRef,
  npmReleaseDate,
  parseRegistryRef,
  profileHits,
  registryArchive,
  registryContext,
  registryReleaseDate,
  resolveRegistryVersion,
} from './registries.ts';
import { buildFirst, type Built, measureRows, type RowData, runSize } from './size.ts';
import { fileSizesCsv, fileSizesHuman, registrySurface, sizesCsv, sizesHuman } from './surface.ts';

export type CliArgs = {
  bundle: boolean;
  clear: boolean;
  diff: boolean;
  help: boolean;
  interactive: boolean;
  list: boolean;
  minify: boolean;
  paths: string[];
  size: boolean;
  version: boolean;
};
const usage = `usage:
  bismar [<selector>] [--bundle] [--minify] [--size] [--list]
  bismar [-bms] [<selector>]
  bismar --diff <a> <b>
  bismar --version [<selector>]

flags:
  <no flag>     open interactive navigator
  -b, --bundle  emit a single-file bundle (JS) / archive (non-JS)
  -m, --minify  (JS only) emit the minified bundle
  -s, --size    list shipped file size stats
      -bs       (JS) bundle sizes
      -bsm      (JS) bundle sizes, minified+gzipped
  -d, --diff    interactive comparison between 2 selectors
      -ds       non-interactive size stats for all files
      -dbs      (JS) diff of bundle sizes
      -dbsm     (JS) diff of bundle sizes, minified+gzipped 
  -l, --list    list all public exports
  -v, --version bismar's version; with a selector, its resolved version
                and release date (gh:/gitlab: pin to a commit hash)
      --clear   clean-up bismar cache

selectors (package / ref / dir / archive):
  npm:qr, npm:qr@0.6, gem:sinatra, ../sinatra, ./qr.tar.bz2

namespaces ("short: long"; both versions work):
  js:   npm         py:   pypi
  jsr:  jsr         php:  packagist
  rs:   crate       gh:   github
  rb:   gem         go:   go proxy
  gitlab: gitlab

examples:
  bismar js:@noble/hashes           # vim-like pager
  bismar rs:serde
  bismar gem:sinatra/README.md
  bismar gh:@paulmillr              # user repos
  bismar gem:sinatra/lib/sinatra.rb > s.rb

  bismar -l npm:micro-ftch

  bismar -b js:qr > qr.js
  bismar -b cargo:serde > serde.cargo
  bismar -bm js:qr > qr.min.js

  bismar -s js:chokidar
  bismar -bs npm:micro-ftch
  bismar -bsm npm:micro-ftch

  bismar -d js:qr@0.5 js:qr@0.6
  bismar -ds npm:readdirp@{4,5}
  bismar -dbs npm:readdirp@{4,5}
  bismar -dbsm npm:readdirp@{4,5}

  # hint: non-terminal (non-TTY) emits DIFFERENT, machine-friendly output
  bismar -d npm:micro-ftch@{1.0,1.1} | head
  bismar -bsm npm:react | sort -t, -k4 -rn`;

// Short aliases resolve to the canonical long flag before anything looks at them.
// --clean is --clear's undocumented second spelling.
const FLAGS: Record<string, string> = {
  '--bundle': '--bundle',
  '--clean': '--clear',
  '--clear': '--clear',
  '--diff': '--diff',
  '--list': '--list',
  '--minify': '--minify',
  '--size': '--size',
  '--version': '--version',
  '-b': '--bundle',
  '-d': '--diff',
  '-l': '--list',
  '-m': '--minify',
  '-s': '--size',
  '-v': '--version',
};
export const parseArgs = (argv: string[]): CliArgs => {
  const flags = new Set<string>();
  const paths: string[] = [];
  const help = argv.includes('--help') || argv.includes('-h');
  if (!help)
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      const canon = FLAGS[arg];
      if (canon) {
        flags.add(canon);
        continue;
      }
      // Combined short flags: -bm reads as -b -m; every letter must be a known
      // short, else the whole cluster is one unknown option.
      if (/^-[a-zA-Z]{2,}$/.test(arg)) {
        const split = [...arg.slice(1)].map((ch) => FLAGS[`-${ch}`]);
        if (split.every((flag) => flag !== undefined)) {
          for (const flag of split) flags.add(flag);
          continue;
        }
      }
      // Retired: file paths are ordinary selectors now; must not silently no-op.
      if (arg === '--input' || arg.startsWith('--input='))
        err('--input is retired: pass the file as a selector, e.g. bismar -b ./input.js');
      if (arg.startsWith('-')) err(`unknown option: ${bad(arg)}; run bismar --help`);
      // `ns:` heads must name a known namespace; js: expands to npm: here.
      paths.push(canonSelector(arg));
    }
  const args: CliArgs = {
    bundle: flags.has('--bundle'),
    clear: flags.has('--clear'),
    diff: flags.has('--diff'),
    help,
    // Interactive is the default mode: any output-shaping flag opts out of it
    // (--clear is maintenance, not output — the only flag that doesn't). Like
    // -d, the flagless default is TTY-dual: piped, a ref `/path` tail emits
    // that shipped file's bytes instead of a TUI (see runCli).
    interactive: ![...flags].some((flag) => flag !== '--clear'),
    list: flags.has('--list'),
    minify: flags.has('--minify'),
    paths,
    size: flags.has('--size'),
    version: flags.has('--version'),
  };
  // Cross-mode combos are contradictions, not no-ops; refuse instead of guessing.
  if (args.clear && argv.length > 1) err('--clear runs alone; drop other arguments');
  if (args.version && (args.bundle || args.minify || args.size || args.list || args.diff))
    err('--version prints resolved versions alone; drop other flags');
  const reg = args.paths.find(isRegistrySelector);
  // Minification can only name a JS bundle, in every base/diff combination.
  if (reg && args.minify)
    err(`${reg.slice(0, reg.indexOf(':'))} refs have no JS to minify: ${bad(reg)}; drop --minify`);
  if (args.list && (args.bundle || args.minify))
    err('--list replaces the bundle output; drop --bundle');
  if (args.size && args.minify && !args.bundle)
    err(`--minify shapes the emitted bundle; use ${args.diff ? '-dbs' : '-bms'} or drop -m`);
  if (args.diff && args.paths.length !== 2)
    err('--diff takes exactly two packages: bismar -d <a> <b>');
  // crate:/gem:/pypi: refs have no JS to bundle or minify. Diff browses their
  // files, --list prints their static import surface, --size their shipped
  // file sizes, and -b emits the saved registry archive verbatim.
  if (reg && !args.diff && args.bundle && !args.size && args.paths.length > 1)
    err(`registry archives emit one at a time: bismar -b ${reg} > out`);
  return args;
};

// `tty` is injectable for tests; real runs read the ambient stdout. `io` rides
// through to every TUI/pager session the run may open, for headless tests.
type Opts = { cwd?: string; io?: InteractiveIo; tty?: boolean };
const archiveName = (file: string, label: string): string => {
  const base = basename(file);
  return label.slice(label.indexOf(':') + 1).replace(/[/@]/g, '-') + base.slice(base.indexOf('.'));
};
const noBundle = (selector: string, hint: '-d' | '-ds'): never => {
  const ns = selector.slice(0, selector.indexOf(':'));
  const use = hint === '-ds' ? 'use -ds for shipped file sizes' : 'use -d to diff shipped files';
  return err(`${ns} refs have no JS to bundle: ${bad(selector)}; ${use}`);
};
// bismar's own version. The compiled entry sits beside package.json (outDir is
// the repo root), the source entry one level below it — probe both, trusting
// only a manifest that names this package.
const selfVersion = (): string => {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const pkg = readJson<{ name?: unknown; version?: unknown }>(
        fileURLToPath(new URL(rel, import.meta.url))
      );
      if (pkg.name === 'bismar' && typeof pkg.version === 'string' && pkg.version)
        return pkg.version;
    } catch {
      // Not at this level; try the other.
    }
  }
  return err('cannot find the bismar package.json');
};
// `-v <selector>`: the concrete version the caches key on — an exact registry
// version, a resolved npm/jsr version, a gh:/gitlab: commit hash, or a local
// package.json's version — plus, when the registry says, its release date.
const selectorVersion = async (
  sel: string,
  cwd: string
): Promise<{ released: string; version: string }> => {
  if (isRegistrySelector(sel)) {
    const ref = parseRegistryRef(sel);
    if (ref.path) err(`versions name whole packages; drop /${bad(ref.path)}`);
    const version = await resolveRegistryVersion(ref);
    return { released: await registryReleaseDate(ref, version), version };
  }
  if (explicitRef(sel)) {
    const ref = parseNpmRef(asRef(sel));
    if (ref.path) err(`versions name whole packages; drop /${bad(ref.path)}`);
    let version = ref.version;
    if (!PINNED.test(version)) {
      // Floating specs resolve through the same cached install as every other
      // mode, so the answer matches what a follow-up -bs would measure.
      const tmp = tempDir('version');
      try {
        version = installedRef(tmp, ref, true).pkg.version;
        if (!version) err(`no version in ${ref.label}'s package.json`);
      } finally {
        rmTempDir(tmp);
      }
    }
    return { released: await npmReleaseDate(ref.bare, version, ref.jsr), version };
  }
  if (explicitPath(sel) || /^\.\.?$/.test(sel)) {
    const dir = resolve(cwd, sel);
    if (statSync(dir, { throwIfNoEntry: false })?.isFile())
      err(`${bad(sel)} is a file; point --version at a package directory`);
    const pkgFile = join(dir, 'package.json');
    const version = readPkg(pkgFile, true).version || err(`no version in ${pkgFile}`);
    // Local manifests carry no release timestamp; mtimes would only mislead.
    return { released: '', version };
  }
  const use = npmHintUse(sel);
  return err(`bare names never imply a registry: ${bad(sel)}${use ? `; ${use}` : ''}`);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The gray tail after a resolved version: releases under a day old read as an
// age (` from 22h ago`), older ones as the registry's calendar date, in UTC so
// output is machine-independent (` from 6 Aug 2026`). An unknown or garbled
// date prints nothing — the version alone is still the answer.
const releasedText = (iso: string): string => {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const age = Date.now() - at;
  const hour = 3_600_000;
  if (age >= 0 && age < 24 * hour) {
    const hours = Math.floor(age / hour);
    return ` from ${hours ? `${hours}h` : `${Math.max(1, Math.floor(age / 60_000))}m`} ago`;
  }
  const d = new Date(at);
  return ` from ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const decoder = new TextDecoder();
const tarballSelector = /\.(?:tgz|tar\.gz)$/i;
// Terminals never receive payload dumps: bundles and bundle diffs open in the
// pager at any size (pipes always get the raw text, ungated). Only syntax
// highlighting is capped — past this many bytes the pager shows plain text, so
// a multi-megabyte bundle opens without a highlight stall.
const HIGHLIGHT_MAX = 1024 * 1024;

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  if (args.clear) {
    // Hidden maintenance hatch: wipe every bismar-* tmp cache and report.
    const { bytes, dirs } = clearTempCaches();
    return console.log(`removed ${dirs} cache dir${dirs === 1 ? '' : 's'}, ${fmtBytes(bytes)}`);
  }
  if (args.version) {
    if (!args.paths.length) return console.log(selfVersion());
    progressUpdate('');
    const cwd = opts.cwd ?? process.cwd();
    const on = stdoutColor(undefined, opts.tty);
    for (const sel of args.paths) {
      const { released, version } = await selectorVersion(sel, cwd);
      progressDone();
      const when = releasedText(released);
      console.log(when ? version + paint(when, color.gray, on) : version);
    }
    return;
  }
  // Arm the startup progress line ('Loading…' after one silent second on a TTY);
  // installs, enumeration, and measurement refine its detail as they run.
  progressUpdate('');
  if (args.diff) {
    const cwd = opts.cwd ?? process.cwd();
    const [aSel, bSel] = args.paths;
    const bundleDiff = args.bundle || args.minify;
    const nonJs = [aSel, bSel].find(isRegistrySelector);
    if (bundleDiff && nonJs) noBundle(nonJs, args.size ? '-ds' : '-d');
    // The temp dir hosts installs/extracts of unpinned refs; pinned ones come
    // from the machine cache, same as browse mode.
    const tmp = tempDir('diff');
    try {
      const ta = await diffTarget(tmp, aSel, cwd, bundleDiff);
      const tb = await diffTarget(tmp, bSel, cwd, bundleDiff);
      // Bundle modes measure the pre-pack targets: measuredSide keeps every
      // side an installed context (deps resolvable), where the packed extract
      // below would drop declared deps as external on that side only.
      const [a, b] = bundleDiff
        ? [measuredSide(tmp, ta), measuredSide(tmp, tb)]
        : packLocalSides(tmp, ta, tb);
      if (bundleDiff && args.size) {
        const [aRows, bRows] = await Promise.all([
          measureRows({
            cacheDir: a.cacheDir,
            cwd: a.dir,
            only: a.sel ? [a.sel] : [],
            outDir: tmp,
          }),
          measureRows({
            cacheDir: b.cacheDir,
            cwd: b.dir,
            only: b.sel ? [b.sel] : [],
            outDir: tmp,
          }),
        ]);
        // -m splits the metric like the text modes: -dbs compares the plain
        // bundles' bytes, -dbms the min+gzip a consumer actually ships.
        const stat = diffBundleRows(aRows, bRows, args.minify ? 'gzBytes' : 'plainBytes');
        progressDone();
        if (!stat.entries.length)
          return console.log(
            `no bundle size changes: ${terminalText(a.label)} and ${terminalText(b.label)} measure identical`
          );
        const lines = csvEnabled(undefined, opts.tty)
          ? bundleStatCsv(stat)
          : bundleStatHuman(stat, stdoutColor(undefined, opts.tty));
        return console.log(lines.join('\n'));
      }
      if (bundleDiff) {
        const [aBundle, bBundle] = await Promise.all([
          buildFirst({ cacheDir: a.cacheDir, cwd: a.dir, only: a.sel ? [a.sel] : [], outDir: tmp }),
          buildFirst({ cacheDir: b.cacheDir, cwd: b.dir, only: b.sel ? [b.sel] : [], outDir: tmp }),
        ]);
        if (!aBundle || !bBundle) return err('no bundles found');
        const aBytes = args.minify ? aBundle.min : aBundle.plain;
        const bBytes = args.minify ? bBundle.min : bBundle.plain;
        progressDone();
        if (Buffer.from(aBytes).equals(Buffer.from(bBytes)))
          return console.log(
            `no bundle changes: ${terminalText(a.label)} and ${terminalText(b.label)} bundle identical`
          );
        const lines = await renderTextUnifiedHighlighted(
          decoder.decode(aBytes),
          decoder.decode(bBytes),
          a.label,
          b.label,
          stdoutColor(undefined, opts.tty)
        );
        // Same TTY duality as -d and -b: a terminal pages the rendered diff
        // (it can dwarf the bundles themselves), a pipe gets the text.
        if (opts.tty ?? !!process.stdout.isTTY) {
          const { runPager } = await import('./interactive.ts');
          return await runPager(`${a.label} → ${b.label}`, lines.join('\n'), {
            ansi: stdoutColor(undefined, opts.tty),
            io: opts.io,
          });
        }
        return console.log(lines.join('\n'));
      }
      // A tail on one side mirrors onto the other: a one-file scope against a
      // whole tree is never the comparison anyone means.
      const tree = diffTrees(a.dir, b.dir, a.sel ?? b.sel, b.sel ?? a.sel);
      progressDone();
      if (!tree.entries.length) {
        // A scoped diff that matched nothing on either side is a typo'd
        // path, not sameness; `same` counts scoped-but-unchanged files.
        const sel = a.sel ?? b.sel;
        if (sel && !tree.same)
          err(`no shipped file matches /${bad(sel)} on either side; use -s to list files`);
        return console.log(
          `no differences: ${terminalText(a.label)} and ${terminalText(b.label)} ship identical files`
        );
      }
      // Same split as the base command: a terminal gets the navigator, a pipe
      // gets text — the unified diff, or with -s the changed-file stat rows,
      // or with -l just the changed file names.
      if (!args.size && !args.list && (opts.tty ?? !!process.stdout.isTTY)) {
        const { runDiff } = await import('./interactive.ts');
        return await runDiff(a, b, tree, opts.io);
      }
      // Size stats already list every changed file, so -dls reads as -ds.
      const lines = args.size
        ? csvEnabled(undefined, opts.tty)
          ? statCsv(tree)
          : statHuman(tree, stdoutColor(undefined, opts.tty), a, b)
        : args.list
          ? statNames(tree, stdoutColor(undefined, opts.tty))
          : await renderUnifiedHighlighted(a.dir, b.dir, tree, stdoutColor(undefined, opts.tty));
      return console.log(lines.join('\n'));
    } finally {
      rmTempDir(tmp);
    }
  }
  if (args.interactive) {
    if (args.paths.length > 1)
      err('interactive mode takes at most one package selector; add -b to bundle several');
    const sel = args.paths[0];
    const tty = opts.tty ?? !!process.stdout.isTTY;
    // Profile refs (`gh:@visionmedia`, `npm:@noble`) list a person, org,
    // scope, or vendor: on a terminal the launcher opens directly on the
    // listing (enter opens a package, ← backs out to the menu); piped, the
    // rows print — a bounded line-per-package table.
    const prof = sel ? parseProfileRef(sel) : undefined;
    if (prof) {
      const hits = await profileHits(prof.prefix, prof.user);
      progressDone();
      if (!tty) {
        const csv = csvEnabled(undefined, opts.tty);
        for (const hit of hits)
          console.log(
            csv
              ? csvRow([hit.name, hit.version, hit.desc])
              : terminalText(
                  hit.name +
                    (hit.version ? `  ${hit.version}` : '') +
                    (hit.desc ? `  ${hit.desc}` : '')
                )
          );
        return;
      }
      const { runInteractive } = await import('./interactive.ts');
      return runInteractive(undefined, {
        cwd: opts.cwd,
        io: opts.io,
        profile: { hits, prefix: prof.prefix, user: prof.user },
      });
    }
    // The flagless command shares -d's dual nature: a terminal gets the
    // interactive rendering (the navigator, deep-linked by a `/path` tail), a
    // pipe gets bytes — a ref tail naming a shipped file emits it verbatim,
    // registry-cat style (`bismar npm:qr/LICENSE > lic.txt`). Directories and
    // misses have no byte stream; error with the listing spelling instead of
    // guessing. No size gate: pipes always get everything, like -b.
    if (!tty && sel) {
      const regRef = isRegistrySelector(sel) ? parseRegistryRef(sel) : undefined;
      const npmRef = !regRef && explicitRef(sel) ? parseNpmRef(asRef(sel)) : undefined;
      const path = regRef?.path || npmRef?.path || '';
      if (path) {
        const tmp = tempDir('bundle');
        try {
          // entryOptional: emitting a shipped file must not require a JS entry.
          const pkgDir = regRef
            ? (await registryContext(tmp, regRef)).pkgDir
            : installedRef(tmp, npmRef as ExternalRef, true).pkgDir;
          const files = scoped(walkFiles(pkgDir), path);
          if (!files.size) err(`no shipped file matches /${bad(path)}; use -s to list files`);
          if (!files.has(path)) err(`/${path} is a directory; use -s ${sel} to list its files`);
          progressDone();
          process.stdout.write(readFileSync(join(pkgDir, path)));
          return;
        } finally {
          rmTempDir(tmp);
        }
      }
    }
    if (!tty) err('interactive mode needs a terminal; add -b to bundle or -s for shipped sizes');
    // Loaded on demand: normal runs never pay for the TUI or its syntax highlighter.
    const { runInteractive } = await import('./interactive.ts');
    // A bare `bismar` opens the launcher menu first: browse the current
    // directory, or search a registry by exact package name.
    return runInteractive(sel, { cwd: opts.cwd, io: opts.io, menu: !args.paths.length });
  }

  // Bare -s is one operation in every ecosystem: list the exact tree that
  // ships. Local packages are npm-packed first; a lone file is a one-row tree.
  if (args.size && !args.bundle) {
    const tmp = tempDir('size');
    const cwd = opts.cwd ?? process.cwd();
    const selectors = args.paths.length ? args.paths : ['.'];
    const csv = csvEnabled(undefined, opts.tty);
    try {
      for (const [i, sel] of selectors.entries()) {
        const file = explicitPath(sel) ? resolve(cwd, sel) : '';
        const fileStat = file ? statSync(file, { throwIfNoEntry: false }) : undefined;
        const lines =
          fileStat?.isFile() && !tarballSelector.test(sel)
            ? csv
              ? fileSizesCsv(file)
              : fileSizesHuman(file, stdoutColor(undefined, opts.tty))
            : await (async (): Promise<string[]> => {
                const sideDir = join(tmp, `listing-${i}`);
                const side = packLocalSide(sideDir, await diffTarget(sideDir, sel, cwd));
                // A `/path` ref tail scopes the listing like it scopes a diff;
                // the packed-archive footer only describes the whole package,
                // so a scoped listing drops it and totals the scope alone.
                return csv
                  ? sizesCsv(side.dir, side.sel)
                  : sizesHuman(
                      side.dir,
                      stdoutColor(undefined, opts.tty),
                      side.sel ? undefined : side.archiveBytes,
                      side.sel
                    );
              })();
        progressDone();
        if (i && !csv) console.log('');
        console.log(lines.join('\n'));
      }
      return;
    } finally {
      rmTempDir(tmp);
    }
  }

  // Adding -s to -b asks about the artifact instead of emitting it. JS keeps
  // the established per-export measurement format; other registries report
  // the one archive that -b would write.
  if (args.bundle && args.size) {
    const tmp = tempDir('size');
    try {
      const js: string[] = [];
      for (const sel of args.paths) {
        if (!isRegistrySelector(sel)) {
          js.push(sel);
          continue;
        }
        const ref = parseRegistryRef(sel);
        if (ref.path)
          err(
            `registry archives emit whole packages; drop /${bad(ref.path)}, or drop the flags to open the file`
          );
        const got = await registryArchive(tmp, ref);
        const name = archiveName(got.file, got.label);
        const bytes = statSync(got.file).size;
        progressDone();
        console.log(
          csvEnabled(undefined, opts.tty)
            ? csvRow([name, `${bytes}b`])
            : paint(name, color.green, stdoutColor(undefined, opts.tty)) +
                paint(`  ${fmtBytes(bytes)}`, color.dim, stdoutColor(undefined, opts.tty))
        );
      }
      if (js.length || !args.paths.length)
        await runSize({ cwd: opts.cwd, minify: args.minify, only: js, outDir: tmp });
      return;
    } finally {
      rmTempDir(tmp);
    }
  }

  if (args.list) {
    const tmp = tempDir('bundle');
    try {
      const js: string[] = [];
      for (const sel of args.paths) {
        if (isRegistrySelector(sel)) {
          const lines = await registrySurface(tmp, sel);
          progressDone();
          console.log(lines.join('\n'));
        } else js.push(sel);
      }
      if (js.length || !args.paths.length)
        await runSize({ cwd: opts.cwd, listOnly: true, only: js, outDir: tmp });
      return;
    } finally {
      rmTempDir(tmp);
    }
  }

  // A registry ref under -b emits the saved archive verbatim — byte-identical
  // to the registry's, so the output is checksummable against its digests. A
  // terminal refuses the bytes with a redirect hint, like JS bundles.
  const regSel = args.paths.find(isRegistrySelector);
  if (regSel) {
    const tmp = tempDir('bundle');
    try {
      const regRef = parseRegistryRef(regSel);
      if (regRef.path)
        err(
          `registry archives emit whole packages; drop /${bad(regRef.path)}, or drop the flags to open the file`
        );
      const got = await registryArchive(tmp, regRef);
      progressDone();
      if (opts.tty ?? !!process.stdout.isTTY) {
        process.exitCode = 1;
        const name = archiveName(got.file, got.label);
        const on = wantColor();
        console.error(
          paint(
            'warn: refusing to output the archive to the terminal, use redirect: ',
            color.gray,
            on
          ) + paint(`bismar -b ${regSel} > ${name} — or -bs for size stats`, color.white, on)
        );
        // Like the JS fallback's stat row: the refused artifact and its size.
        console.log(
          paint(name, color.green, on) +
            paint(`  ${fmtBytes(statSync(got.file).size)}`, color.dim, on)
        );
        return;
      }
      process.stdout.write(readFileSync(got.file));
      return;
    } finally {
      rmTempDir(tmp);
    }
  }
  // The temp dir only hosts npm ref installs; bundling and measurement are in-memory.
  const tmp = tempDir('bundle');
  try {
    if (!(opts.tty ?? !!process.stdout.isTTY)) {
      const bundle = await buildFirst({
        cwd: opts.cwd,
        only: args.paths,
        outDir: tmp,
      });
      if (!bundle) return err('no bundles found');
      process.stdout.write(args.minify ? bundle.min : bundle.plain);
      return;
    }
    // Terminals: the bundle opens in the pager — any size, a successful exit;
    // built once, in memory, never rebuilt for the footer stats. Only syntax
    // highlighting is capped (HIGHLIGHT_MAX), so huge bundles open plain
    // instead of stalling. The footer answers "how do I save this": the run's
    // own flags and selectors as a redirect, copy-pasteable as typed.
    let built: Built | undefined;
    let row: RowData | undefined;
    await runSize({
      cwd: opts.cwd,
      minify: args.minify,
      onBuilt: (out) => {
        built ??= out;
      },
      onRow: (data) => {
        row ??= data;
      },
      only: args.paths,
      outDir: tmp,
      silent: true,
      // One artifact, one pager — never the full browse table, which would
      // measure every export.
      single: true,
    });
    if (!built || !row) return err('no bundles found');
    const bytes = args.minify ? built.min : built.plain;
    let text = decoder.decode(bytes);
    if (stdoutColor(undefined, opts.tty) && bytes.length <= HIGHLIGHT_MAX) {
      // Same highlighter as the navigator's file previews; a highlight failure
      // falls back to the plain text, never to an error.
      const { highlightText } = await import('./vendor/speed-highlight/terminal.js');
      text = await highlightText(text, 'js').catch(() => text);
    }
    const cmd = ['bismar', '-b', ...(args.minify ? ['-m'] : []), ...args.paths].join(' ');
    const { runPager } = await import('./interactive.ts');
    return await runPager(row.label, text, {
      ansi: stdoutColor(undefined, opts.tty) && bytes.length <= HIGHLIGHT_MAX,
      // No LOC here: the pager header already counts the lines.
      footer: `${kb(row.minBytes)}kb min, ${kb(row.gzBytes)}kb gzip · ${cmd} > out.js`,
      io: opts.io,
    });
  } finally {
    // Content goes to stdout; the temp work dir has nothing left to offer.
    rmTempDir(tmp);
  }
};

runSelf(import.meta.url, async (argv) => {
  // `bismar … | head` closes the pipe early; a truncated reader is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  await runCli(argv);
});
