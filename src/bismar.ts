#!/usr/bin/env node
/**
 * One command, two outputs.
 * @module
 */
import {
  diffPair,
  diffTarget,
  diffTrees,
  renderUnified,
  statCsv,
  statHuman,
  statNames,
} from './diff.ts';
import { color, csvEnabled, paint, progressDone, progressUpdate, wantColor } from './env.ts';
import { clearTempCaches, rmTempDir, tempDir } from './fs-modify.ts';
import { bad, err, fmtBytes, runSelf } from './public.ts';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  canonSelector,
  isRegistrySelector,
  parseRegistryRef,
  registryArchive,
} from './registries.ts';
import { buildFirst, runSize } from './size.ts';
import { registrySizes, registrySurface } from './surface.ts';

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
  bismar --diff <a> <b>   (or: --diff <pkg> <v1> <v2>)

opens the interactive package navigator by default; without a selector it asks
what to open — the current directory, or a registry search.

flags:
  -b, --bundle  emit a single-file IIFE bundle on stdout; non-JS refs emit
                the saved registry archive verbatim
  -m, --minify  emit the minified bundle (JS only)
  -s, --size    min+gzip stats per export; non-JS refs list shipped file sizes
  -l, --list    every public export as an import statement; non-JS refs list
                their import surface (crate:/gh: their files)
  -d, --diff    compare two packages recursively: navigator on a terminal,
                unified diff piped; -ds adds size deltas, -dl names only
      --clear   remove every bismar cache (ref installs, extracts, archives)

short flags combine: bismar -bm == bismar -b -m

namespaces:
  npm: (or js:)  jsr:  crate: (or rust: rs: cargo:)  gem: (or ruby: rb:)
  pypi: (or python: py:)  composer: (or php:)  gh: (or github:)  go: (or golang:)

examples:
  bismar npm:@noble/curves
  bismar crate:serde
  bismar npm:@scure/base -b > scure-base.js
  bismar go:golang.org/x/time --list
  bismar -s npm:preact | sort -t, -k5 -rn
  bismar -d npm:qr 0.5.0 0.6.0`;

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
  if (args.bundle && (args.size || args.list))
    err(`${args.size ? '--size' : '--list'} replaces the bundle output; drop --bundle`);
  if (args.size && args.minify) err('--minify shapes the emitted bundle; drop --size');
  if (args.diff) {
    // --diff compares file trees; the bundle-shaping flags have nothing to shape.
    const off = args.bundle ? '--bundle' : args.minify ? '--minify' : '';
    if (off) err(`${off} shapes the bundle output, not a diff; drop ${off} or --diff`);
    if (args.paths.length !== 2 && args.paths.length !== 3)
      err(
        '--diff takes two packages, or a package and two versions: bismar -d <a> <b> or bismar -d <pkg> <v1> <v2>'
      );
  }
  // crate:/gem:/pypi: refs have no JS to bundle or minify. Diff browses their
  // files, --list prints their static import surface, --size their shipped
  // file sizes, and -b emits the saved registry archive verbatim.
  const reg = args.paths.find(isRegistrySelector);
  if (reg && !args.interactive && !args.diff && !args.list && !args.size) {
    if (args.minify)
      err(
        `${reg.slice(0, reg.indexOf(':'))} refs have no JS to minify: ${bad(reg)}; drop --minify`
      );
    if (args.bundle && args.paths.length > 1)
      err(`registry archives emit one at a time: bismar -b ${reg} > out`);
  }
  return args;
};

// `tty` is injectable for tests; real runs read the ambient stdout.
type Opts = { cwd?: string; tty?: boolean };

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
    const [aSel, bSel] = diffPair(args.paths);
    // The temp dir hosts installs/extracts of unpinned refs; pinned ones come
    // from the machine cache, same as browse mode.
    const tmp = tempDir('diff');
    try {
      const a = await diffTarget(tmp, aSel, cwd);
      const b = await diffTarget(tmp, bSel, cwd);
      const tree = diffTrees(a.dir, b.dir);
      progressDone();
      if (!tree.entries.length)
        return console.log(`no differences: ${a.label} and ${b.label} ship identical files`);
      // Same split as the base command: a terminal gets the navigator, a pipe
      // gets text — the unified diff, or with -s the changed-file stat rows,
      // or with -l just the changed file names.
      if (!args.size && !args.list && (opts.tty ?? !!process.stdout.isTTY)) {
        const { runDiff } = await import('./interactive.ts');
        return await runDiff(a, b, tree);
      }
      // Size stats already list every changed file, so -dls reads as -ds.
      const lines = args.size
        ? csvEnabled()
          ? statCsv(tree)
          : statHuman(tree, wantColor())
        : args.list
          ? statNames(tree, wantColor())
          : renderUnified(a.dir, b.dir, tree, wantColor());
      return console.log(lines.join('\n'));
    } finally {
      rmTempDir(tmp);
    }
  }
  if (args.interactive) {
    if (args.paths.length > 1)
      err('interactive mode takes at most one package selector; add -b to bundle several');
    if (!(opts.tty ?? !!process.stdout.isTTY))
      err('interactive mode needs a terminal; add -b to bundle or -s for size stats');
    // Loaded on demand: normal runs never pay for the TUI or its syntax highlighter.
    const { runInteractive } = await import('./interactive.ts');
    // A bare `bismar` opens the launcher menu first: browse the current
    // directory, or search a registry by exact package name.
    return runInteractive(args.paths[0], { cwd: opts.cwd, menu: !args.paths.length });
  }
  const bundling = !args.size && !args.list;
  // A registry ref under -b emits the saved archive verbatim — byte-identical
  // to the registry's, so the output is checksummable against its digests. A
  // terminal refuses the bytes with a redirect hint, like JS bundles.
  const regSel = bundling ? args.paths.find(isRegistrySelector) : undefined;
  if (regSel) {
    const tmp = tempDir('bundle');
    try {
      const got = await registryArchive(tmp, parseRegistryRef(regSel));
      progressDone();
      if (opts.tty ?? !!process.stdout.isTTY) {
        process.exitCode = 1;
        const base = basename(got.file);
        const name =
          got.label.slice(got.label.indexOf(':') + 1).replace(/[/@]/g, '-') +
          base.slice(base.indexOf('.'));
        const on = wantColor();
        console.error(
          paint(
            'warn: refusing to output the archive to the terminal, use redirect: ',
            color.gray,
            on
          ) + paint(`bismar -b ${regSel} > ${name}`, color.white, on)
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
  if (bundling && (opts.tty ?? !!process.stdout.isTTY)) {
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
        paint(`${cmd} > out.js`, color.white, on)
    );
  }
  const size = args.size || statsFallback;
  // The temp dir only hosts npm ref installs; bundling and measurement are in-memory.
  const tmp = tempDir(size ? 'size' : 'bundle');
  try {
    // Registry refs print their static listings here — --size: shipped file
    // sizes with a total; --list: each ecosystem's import surface (crate:/gh:
    // fall back to the file listing). Remaining JS selectors continue through
    // the usual enumeration below.
    let only = args.paths;
    if (args.list || args.size) {
      const regs = args.paths.filter(isRegistrySelector);
      for (const sel of regs) {
        const lines = args.size ? await registrySizes(tmp, sel) : await registrySurface(tmp, sel);
        progressDone();
        console.log(lines.join('\n'));
      }
      only = args.paths.filter((sel) => !isRegistrySelector(sel));
      if (regs.length && !only.length) return;
    }
    if (size)
      return await runSize({
        cwd: opts.cwd,
        listOnly: args.list,
        only,
        outDir: tmp,
        // The fallback mirrors what bundling would have emitted: one artifact, one
        // row — never the full browse table, which would measure every export.
        single: statsFallback,
      });
    const bundle = await buildFirst({
      cwd: opts.cwd,
      listOnly: args.list,
      only,
      outDir: tmp,
    });
    if (args.list) return;
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
