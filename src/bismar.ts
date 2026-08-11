#!/usr/bin/env node
/**
 * One command, two outputs.
 * @module
 */
import {
  bundleStatCsv,
  bundleStatHuman,
  diffBundleRows,
  diffTarget,
  diffTrees,
  measuredSide,
  packLocalSide,
  packLocalSides,
  renderTextUnified,
  renderUnified,
  statCsv,
  statHuman,
  statNames,
} from './diff.ts';
import {
  color,
  csvEnabled,
  csvRow,
  paint,
  progressDone,
  progressUpdate,
  stdoutColor,
  wantColor,
} from './env.ts';
import { clearTempCaches, rmTempDir, tempDir } from './fs-modify.ts';
import { bad, err, explicitPath, fmtBytes, runSelf } from './public.ts';
import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  canonSelector,
  isRegistrySelector,
  parseRegistryRef,
  registryArchive,
} from './registries.ts';
import { buildFirst, measureRows, runSize } from './size.ts';
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
};
const usage = `usage:
  bismar [<selector>] [--bundle] [--size] [--minify] [--list]
  bismar --diff <a> <b>

opens the interactive package navigator by default; without a selector it asks
what to open — the current directory, or a registry search.

flags:
  -b, --bundle  emit a single-file IIFE bundle on stdout; non-JS refs emit
                the saved registry archive verbatim
  -m, --minify  emit the minified bundle (JS only)
  -s, --size    list shipped file sizes for every ecosystem; never bundles
      -bs       min+gzip bundle stats per export (JS); archive stat (non-JS)
  -l, --list    every public export as an import statement; non-JS refs list
                their import surface (rs:/gh: their files)
  -d, --diff    compare two packages recursively (refs, dirs, .tgz tarballs;
                a dir vs a package is npm-packed first): navigator on a
                terminal, unified diff piped; -ds file sizes, -dl names,
                -db bundle text, -dbs unminified bundle-size deltas, -dbms
                min+gzip ones (JS only; refs may pick one module/export:
                -db npm:qr@0.6.0/index)
      --clear   remove every bismar cache (ref installs, extracts, archives)

short flags combine: bismar -bm == bismar -b -m

namespaces (long aliases like npm: crate: work too):
  js:   npm         py:   pypi
  jsr:  jsr         php:  packagist
  rs:   crates.io   gh:   github
  rb:   rubygems    go:   go proxy

examples:
  bismar js:@noble/curves
  bismar rs:serde
  bismar js:@scure/base -b > scure-base.js
  bismar go:golang.org/x/time --list
  bismar -s js:preact
  bismar -bs js:preact | sort -t, -k5 -rn
  bismar -d js:qr@0.5.0 js:qr@0.6.0`;

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
  '-b': '--bundle',
  '-d': '--diff',
  '-l': '--list',
  '-m': '--minify',
  '-s': '--size',
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
    // (--clear is maintenance, not output — the only flag that doesn't).
    interactive: ![...flags].some((flag) => flag !== '--clear'),
    list: flags.has('--list'),
    minify: flags.has('--minify'),
    paths,
    size: flags.has('--size'),
  };
  // Cross-mode combos are contradictions, not no-ops; refuse instead of guessing.
  if (args.clear && argv.length > 1) err('--clear runs alone; drop other arguments');
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

// `tty` is injectable for tests; real runs read the ambient stdout.
type Opts = { cwd?: string; tty?: boolean };
const archiveName = (file: string, label: string): string => {
  const base = basename(file);
  return label.slice(label.indexOf(':') + 1).replace(/[/@]/g, '-') + base.slice(base.indexOf('.'));
};
const noBundle = (selector: string, hint: '-d' | '-ds'): never => {
  const ns = selector.slice(0, selector.indexOf(':'));
  const use = hint === '-ds' ? 'use -ds for shipped file sizes' : 'use -d to diff shipped files';
  return err(`${ns} refs have no JS to bundle: ${bad(selector)}; ${use}`);
};
const decoder = new TextDecoder();
const tarballSelector = /\.(?:tgz|tar\.gz)$/i;

export const runCli = async (argv: string[], opts: Opts = {}): Promise<void> => {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage);
  if (args.clear) {
    // Hidden maintenance hatch: wipe every bismar-* tmp cache and report.
    const { bytes, dirs } = clearTempCaches();
    return console.log(`removed ${dirs} cache dir${dirs === 1 ? '' : 's'}, ${fmtBytes(bytes)}`);
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
          return console.log(`no bundle size changes: ${a.label} and ${b.label} measure identical`);
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
          return console.log(`no bundle changes: ${a.label} and ${b.label} bundle identical`);
        const lines = renderTextUnified(
          decoder.decode(aBytes),
          decoder.decode(bBytes),
          a.label,
          b.label,
          stdoutColor(undefined, opts.tty)
        );
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
          err(`no shipped file matches /${sel} on either side; use -s to list files`);
        return console.log(`no differences: ${a.label} and ${b.label} ship identical files`);
      }
      // Same split as the base command: a terminal gets the navigator, a pipe
      // gets text — the unified diff, or with -s the changed-file stat rows,
      // or with -l just the changed file names.
      if (!args.size && !args.list && (opts.tty ?? !!process.stdout.isTTY)) {
        const { runDiff } = await import('./interactive.ts');
        return await runDiff(a, b, tree);
      }
      // Size stats already list every changed file, so -dls reads as -ds.
      const lines = args.size
        ? csvEnabled(undefined, opts.tty)
          ? statCsv(tree)
          : statHuman(tree, stdoutColor(undefined, opts.tty), a, b)
        : args.list
          ? statNames(tree, stdoutColor(undefined, opts.tty))
          : renderUnified(a.dir, b.dir, tree, stdoutColor(undefined, opts.tty));
      return console.log(lines.join('\n'));
    } finally {
      rmTempDir(tmp);
    }
  }
  if (args.interactive) {
    if (args.paths.length > 1)
      err('interactive mode takes at most one package selector; add -b to bundle several');
    if (!(opts.tty ?? !!process.stdout.isTTY))
      err('interactive mode needs a terminal; add -b to bundle or -s for shipped sizes');
    // Loaded on demand: normal runs never pay for the TUI or its syntax highlighter.
    const { runInteractive } = await import('./interactive.ts');
    // A bare `bismar` opens the launcher menu first: browse the current
    // directory, or search a registry by exact package name.
    return runInteractive(args.paths[0], { cwd: opts.cwd, menu: !args.paths.length });
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
                return csv
                  ? sizesCsv(side.dir)
                  : sizesHuman(side.dir, stdoutColor(undefined, opts.tty), side.archiveBytes);
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
        const got = await registryArchive(tmp, parseRegistryRef(sel));
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
      if (js.length || !args.paths.length) await runSize({ cwd: opts.cwd, only: js, outDir: tmp });
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
      const got = await registryArchive(tmp, parseRegistryRef(regSel));
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
  let statsFallback = false;
  if (opts.tty ?? !!process.stdout.isTTY) {
    // Terminals get the bundle's size stats instead of its bytes: the single stat
    // row builds exactly the bundle that was refused (plain+min, in memory), so
    // the fallback costs one gzip pass over erroring out. Still an error exit:
    // the requested output was never produced. The command echoes the run's own
    // flags and selectors, so it's copy-pasteable as typed.
    statsFallback = true;
    process.exitCode = 1;
    const cmd = ['bismar', '-b', ...(args.minify ? ['-m'] : []), ...args.paths].join(' ');
    const on = wantColor();
    console.error(
      paint('warn: refusing to output to the terminal, use redirect: ', color.gray, on) +
        paint(`${cmd} > out.js — or -bs for size stats`, color.white, on)
    );
  }
  // The temp dir only hosts npm ref installs; bundling and measurement are in-memory.
  const tmp = tempDir(statsFallback ? 'size' : 'bundle');
  try {
    if (statsFallback)
      return await runSize({
        cwd: opts.cwd,
        only: args.paths,
        outDir: tmp,
        // The fallback mirrors what bundling would have emitted: one artifact, one
        // row — never the full browse table, which would measure every export.
        single: statsFallback,
      });
    const bundle = await buildFirst({
      cwd: opts.cwd,
      only: args.paths,
      outDir: tmp,
    });
    if (!bundle) return err('no bundles found');
    process.stdout.write(args.minify ? bundle.min : bundle.plain);
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
