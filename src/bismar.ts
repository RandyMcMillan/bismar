#!/usr/bin/env node
/**
 * One command, two outputs.
 * @module
 */
import { createHash } from 'node:crypto';
import { color, paint, progressUpdate, wantColor } from './env.ts';
import { clearTempCaches, rmTempDir, tempDir } from './fs-modify.ts';
import { bad, err, fmtBytes, runSelf } from './public.ts';
import { isRegistrySelector } from './registries.ts';
import { buildFirst, runSize } from './size.ts';

export type CliArgs = {
  bundle: boolean;
  checksum: boolean;
  clear: boolean;
  help: boolean;
  interactive: boolean;
  list: boolean;
  minify: boolean;
  paths: string[];
  size: boolean;
  sort: boolean;
};
const usage = `usage:
  bismar [<selector>] [--bundle] [--size] [--minify] [--checksum] [--list] [--size-sorted]

opens the interactive package navigator by default: browse files, modules and
exports like a filesystem. --bundle packs the selection into a single-file IIFE
bundle on stdout; --size prints min+gzip size stats of the same bundles.

flags:
  -b, --bundle       emit the single-file IIFE bundle on stdout
  -s, --size         print size stats instead of a bundle
  -m, --minify       emit the minified bundle
  -c, --checksum     print the bundle's sha256 hex instead of its bytes
  -l, --list         print every public export as an import statement, no bundling
      --size-sorted  size stats sorted: module bundles first, then exports, by gzip size

examples:
  bismar
  bismar @noble/curves
  bismar crate:serde
  bismar ruby:railties
  bismar python:requests
  bismar php:monolog/monolog
  bismar gh:paulmillr/qr
  bismar go:golang.org/x/time

  bismar @scure/base -b > scure-base.js
  bismar @scure/base --minify > sb.min.js
  bismar @scure/base --checksum

  bismar @scure/base --list
  bismar npm:micro-key-producer --size
  bismar jsr:@std/bytes --size-sorted
  bismar -s @noble/hashes/sha2.js/sha256

  bismar @scure/base @scure/bip39 -b > combined.js
  bismar @noble/hashes/{sha2.js,sha3.js} -b > shas.js
  bismar -s @noble/hashes/sha3.js npm:js-sha3

  bismar --size
  bismar -b > full.js
  bismar -b src/util.js > util.js
  bismar -b ./input.js > input.bundle.js`;

// Short aliases resolve to the canonical long flag before anything looks at them.
// --clear (and its --clean spelling) is deliberately absent from usage: a
// maintenance hatch, not a mode.
const FLAGS: Record<string, string> = {
  '--bundle': '--bundle',
  '--checksum': '--checksum',
  '--clean': '--clear',
  '--clear': '--clear',
  '--list': '--list',
  '--minify': '--minify',
  '--size': '--size',
  '--size-sorted': '--size-sorted',
  '-b': '--bundle',
  '-c': '--checksum',
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
      // Retired: file paths are ordinary selectors now; must not silently no-op.
      if (arg === '--input' || arg.startsWith('--input='))
        err('--input is retired: pass the file as a selector, e.g. bismar -b ./input.js');
      if (arg.startsWith('-')) err(`unknown option: ${bad(arg)}; run bismar --help`);
      paths.push(arg);
    }
  const args: CliArgs = {
    bundle: flags.has('--bundle'),
    checksum: flags.has('--checksum'),
    clear: flags.has('--clear'),
    help,
    // Interactive is the default mode: any output-shaping flag opts out of it
    // (--clear is maintenance, not output — the only flag that doesn't).
    interactive: ![...flags].some((flag) => flag !== '--clear'),
    list: flags.has('--list'),
    minify: flags.has('--minify'),
    paths,
    // --size-sorted is a sorted --size: it implies the mode instead of demanding it.
    size: flags.has('--size') || flags.has('--size-sorted'),
    sort: flags.has('--size-sorted'),
  };
  // Cross-mode combos are contradictions, not no-ops; refuse instead of guessing.
  if (args.clear && argv.length > 1) err('--clear runs alone; drop other arguments');
  if (args.bundle && (args.size || args.list))
    err(
      `${args.size ? (flags.has('--size') ? '--size' : '--size-sorted') : '--list'} replaces the bundle output; drop --bundle`
    );
  if (args.size && (args.minify || args.checksum))
    err(
      `${args.minify ? '--minify' : '--checksum'} shapes the emitted bundle; drop ${
        flags.has('--size') ? '--size' : '--size-sorted'
      }`
    );
  // crate:/gem:/pypi: refs are navigator-only: there is no JS to bundle or measure.
  const reg = args.paths.find(isRegistrySelector);
  if (reg && !args.interactive)
    err(`${reg.slice(0, reg.indexOf(':'))} refs browse only: ${bad(reg)}; run bismar ${reg}`);
  return args;
};

const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

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
  if (args.interactive) {
    if (args.paths.length > 1)
      err('interactive mode takes at most one package selector; add -b to bundle several');
    if (!(opts.tty ?? !!process.stdout.isTTY))
      err('interactive mode needs a terminal; add -b to bundle or -s for size stats');
    // Loaded on demand: normal runs never pay for the TUI or its syntax highlighter.
    const { runInteractive } = await import('./interactive.ts');
    return runInteractive(args.paths[0], { cwd: opts.cwd });
  }
  const bundling = !args.size && !args.list && !args.checksum;
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
    if (size)
      return await runSize({
        cwd: opts.cwd,
        listOnly: args.list,
        only: args.paths,
        outDir: tmp,
        // The fallback mirrors what bundling would have emitted: one artifact, one
        // row — never the full browse table, which would measure every export.
        single: statsFallback,
        sort: args.sort,
      });
    const bundle = await buildFirst({
      cwd: opts.cwd,
      listOnly: args.list,
      only: args.paths,
      outDir: tmp,
    });
    if (args.list) return;
    if (!bundle) return err('no bundles found');
    const buf = args.minify ? bundle.min : bundle.plain;
    if (args.checksum) console.log(sha256(buf));
    else process.stdout.write(buf);
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
