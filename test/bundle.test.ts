import { deepStrictEqual, rejects, throws } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as should } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';
import { __TEST as FS_TEST, promoteTemp } from '../src/fs-modify.ts';
import { parseArgs, runCli } from '../src/bismar.ts';

const FIXTURE = resolve('test/vectors/plain');

const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  const prevWrite = process.stdout.write;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  process.stdout.write = ((chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return { ok: true, stderr, stdout };
  } catch (error) {
    stderr += `${(error as Error).message}\n`;
    return { ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
    process.stdout.write = prevWrite;
  }
};

should('bundle parses flags and rejects removed ones', () => {
  const args = parseArgs(['--minify', 'index/add']);
  deepStrictEqual(args, {
    bundle: false,
    clear: false,
    diff: false,
    help: false,
    interactive: false,
    list: false,
    minify: true,
    paths: ['index/add'],
    size: false,
  });
  // Short aliases resolve to the same canonical flags as the long spellings.
  deepStrictEqual(parseArgs(['-m', 'index/add']), args);
  deepStrictEqual(parseArgs(['-s']), parseArgs(['--size']));
  deepStrictEqual(parseArgs(['-l']), parseArgs(['--list']));
  deepStrictEqual(parseArgs(['-b']), parseArgs(['--bundle']));
  // No flags at all means the interactive navigator; any output flag opts out.
  deepStrictEqual(parseArgs(['preact']).interactive, true);
  deepStrictEqual(parseArgs(['preact', '-b']).interactive, false);
  // Retired flag spellings must not silently no-op.
  throws(() => parseArgs(['--input=./x.js']), /--input is retired.*bismar -b \.\/input\.js/);
  throws(() => parseArgs(['-i']), /unknown option: -i/);
  throws(() => parseArgs(['--interactive']), /unknown option: --interactive/);
  throws(() => parseArgs(['--project=pkg']), /unknown option: --project=/);
  throws(() => parseArgs(['--stats']), /unknown option: --stats/);
  throws(() => parseArgs(['--dir=test/build']), /unknown option: --dir=/);
  throws(() => parseArgs(['--no-prefix']), /unknown option: --no-prefix/);
  // The old flag names died in the renames; they must not silently no-op.
  throws(() => parseArgs(['--sort']), /unknown option: --sort/);
  throws(() => parseArgs(['--list-sorted']), /unknown option: --list-sorted/);
  // Deleted flags read as unknown options too.
  throws(() => parseArgs(['--size-sorted']), /unknown option: --size-sorted/);
  throws(() => parseArgs(['--checksum']), /unknown option: --checksum/);
  throws(() => parseArgs(['-c']), /unknown option: -c/);
});

should('bundle combines short flags into artifact and report modes', () => {
  deepStrictEqual(parseArgs(['-bm']), parseArgs(['-b', '-m']));
  deepStrictEqual(
    parseArgs(['-bm', 'index/add']),
    parseArgs(['--bundle', '--minify', 'index/add'])
  );
  // -s modifies the bundle into a measurement report, and -m is redundant there.
  deepStrictEqual(parseArgs(['-bs']), parseArgs(['-b', '-s']));
  deepStrictEqual(parseArgs(['-bms']), parseArgs(['-b', '-m', '-s']));
  throws(() => parseArgs(['-sm']), /--minify shapes the emitted bundle; use -bms or drop -m/);
  throws(() => parseArgs(['-bl']), /--list replaces the bundle output; drop --bundle/);
  throws(() => parseArgs(['-bsl']), /--list replaces the bundle output; drop --bundle/);
  // …and a cluster with any unknown letter is one unknown option, whole.
  throws(() => parseArgs(['-bx']), /unknown option: -bx/);
  throws(() => parseArgs(['-ib']), /unknown option: -ib/);
});

should('bundle treats any colon head as a namespace and lists the known ones', () => {
  const msg = (() => {
    try {
      parseArgs(['foo:bar']);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  })();
  deepStrictEqual(/^unknown namespace: foo:; use one of:\n/.test(msg), true, msg);
  // The listing groups alias spellings with their canonical prefix.
  for (const line of [
    'npm: (or js:)',
    'jsr:',
    'crate: (or cargo: rs: rust:)',
    'gem: (or rb: ruby:)',
    'pypi: (or py: python:)',
    'composer: (or php:)',
    'gh: (or github:)',
    'go: (or golang:)',
  ])
    deepStrictEqual(msg.includes(line), true, `${line}\n${msg}`);
  // js: is the alias spelling for npm refs; it expands before anything parses.
  deepStrictEqual(parseArgs(['js:preact', '-b']).paths, ['npm:preact']);
  deepStrictEqual(parseArgs(['-b', 'npm:preact']).paths, ['npm:preact']);
  // Explicit paths keep colons as filename bytes — ./ is the escape hatch —
  // and a colon after a slash is not a namespace head.
  deepStrictEqual(parseArgs(['-b', './a:b.js']).paths, ['./a:b.js']);
  deepStrictEqual(parseArgs(['-b', 'index/a:b']).paths, ['index/a:b']);
});

should('bundle prints size stats instead of bytes on a terminal', async () => {
  // The fallback measures exactly the bundle it refused (one row, not the browse
  // table); the stderr hint echoes the run's own arguments, copy-pasteable — and
  // the exit code still reports failure: the requested bundle was never produced.
  const prevExit = process.exitCode;
  const res = await capture(() => runCli(['-b', 'index/add'], { cwd: FIXTURE, tty: true }));
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(process.exitCode, 1);
  process.exitCode = prevExit;
  deepStrictEqual(
    /warn: refusing to output to the terminal, use redirect: bismar -b index\/add > out\.js/.test(
      res.stderr
    ),
    true,
    res.stderr
  );
  const rows = res.stdout.trim().split('\n');
  // Headerless machine rows, each value unit-tagged.
  deepStrictEqual(/^index,add,\d+loc,\d+b,\d+b$/.test(rows[0] ?? ''), true, res.stdout);
  // One row for the one refused artifact; and never the bundle bytes themselves.
  deepStrictEqual(rows.length, 1, res.stdout);
  deepStrictEqual(/var bismarTestPlainIndexAdd/.test(res.stdout), false, res.stdout);
  // --list prints short text, not bundle bytes: fine on a TTY.
  const listed = await capture(() => runCli(['--list', 'index/add'], { cwd: FIXTURE, tty: true }));
  deepStrictEqual(listed.ok, true, listed.stderr);
  deepStrictEqual(/\{add\} from/.test(listed.stdout), true, listed.stdout);
});

should('bundle writes the unminified bundle to stdout and nothing else', async () => {
  const res = await capture(() => runCli(['-b', 'index/add'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(res.stderr, '');
  deepStrictEqual(
    /var bismarTestPlainIndexAdd = /.test(res.stdout),
    true,
    res.stdout.slice(0, 200)
  );
  // Pure content: no stats, hashes, paths, or headers.
  deepStrictEqual(/LOC|gzip|sha256|module,export|bismar-bundle-/.test(res.stdout), false);
});

should('bundle --minify emits the minified variant of the same artifact', async () => {
  const min = await capture(() => runCli(['--minify', 'index/add'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(min.ok, true, min.stderr);
  deepStrictEqual(
    /var bismarTestPlainIndexAdd=\(/.test(min.stdout),
    true,
    min.stdout.slice(0, 120)
  );
  const plain = await capture(() => runCli(['-b', 'index/add'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(plain.stdout !== min.stdout, true);
  deepStrictEqual(min.stdout.length < plain.stdout.length, true);
});

should('-bs measures bundles and accepts redundant -m byte-for-byte', async () => {
  const size = await capture(() => runCli(['-bs', 'index/add'], { cwd: FIXTURE, tty: false }));
  const min = await capture(() => runCli(['-bms', 'index/add'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(size.ok, true, size.stderr);
  deepStrictEqual(min.ok, true, min.stderr);
  deepStrictEqual(min.stdout, size.stdout);
  deepStrictEqual(/^index,add,\d+loc,\d+b,\d+b\n$/.test(size.stdout), true, size.stdout);
});

should('bundle defaults to the whole package and supports --list', async () => {
  const res = await capture(() => runCli(['-b'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(/var bismarTestPlain = /.test(res.stdout), true, res.stdout.slice(0, 200));
  const list = await capture(() => runCli(['--list'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(list.ok, true, list.stderr);
  deepStrictEqual(/^\{add\} from '@bismar-test\/plain'$/m.test(list.stdout), true, list.stdout);
  deepStrictEqual(/var /.test(list.stdout), false, list.stdout);
  await rejects(() => runCli(['-b', 'index/nope'], { cwd: FIXTURE, tty: false }), /has no export/);
});

should('bundle treats a sole existing JS file selector as --input', async () => {
  // No package.json anywhere near: the file itself becomes the package…
  const dir = mkdtempSync(join(tmpdir(), 'bismar-filesel-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'util.js'), 'export const twice = (n) => n * 2;\n');
    const res = await capture(() => runCli(['-b', 'src/util.js'], { cwd: dir, tty: false }));
    deepStrictEqual(res.ok, true, res.stderr);
    deepStrictEqual(/twice/.test(res.stdout), true, res.stdout.slice(0, 200));
    // …and matches the explicit ./ spelling byte for byte.
    const explicit = await capture(() => runCli(['-b', './src/util.js'], { cwd: dir, tty: false }));
    deepStrictEqual(res.stdout, explicit.stdout);
    // The size table works the same way and enumerates the file's exports.
    const size = await capture(() => runCli(['-bs', 'src/util.js'], { cwd: dir, tty: false }));
    deepStrictEqual(size.ok, true, size.stderr);
    deepStrictEqual(/twice/.test(size.stdout), true, size.stdout);
    // Bare -s never loads the bundle engine: a file is a one-row shipped tree.
    const shipped = await capture(() => runCli(['-s', './src/util.js'], { cwd: dir, tty: false }));
    deepStrictEqual(shipped.ok, true, shipped.stderr);
    deepStrictEqual(/^util\.js,\d+b\n$/.test(shipped.stdout), true, shipped.stdout);
    deepStrictEqual(/loc|gzip|twice/.test(shipped.stdout), false, shipped.stdout);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

should('file selectors defer to public modules and compose with them', async () => {
  // index.js exists on disk AND is the public module: module semantics win.
  const mod = await capture(() => runCli(['-b', 'index.js'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(mod.ok, true, mod.stderr);
  deepStrictEqual(/var bismarTestPlain/.test(mod.stdout), true, mod.stdout.slice(0, 120));
  // `./` always means the filesystem, even over a same-named public module.
  const forced = await capture(() => runCli(['-b', './index.js'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(forced.ok, true, forced.stderr);
  deepStrictEqual(/var bismarTestPlain/.test(forced.stdout), false, forced.stdout.slice(0, 120));
  // _priv.js is shipped but not public: the file fallback reaches it anyway.
  const priv = await capture(() => runCli(['-b', '_priv.js'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(priv.ok, true, priv.stderr);
  deepStrictEqual(/secret/.test(priv.stdout), true, priv.stdout.slice(0, 200));
  deepStrictEqual(/var bismarTestPlain/.test(priv.stdout), false, priv.stdout.slice(0, 120));
  // A trailing segment picks one export straight off the file…
  const one = await capture(() => runCli(['-b', './index.js/add'], { cwd: FIXTURE, tty: false }));
  deepStrictEqual(one.ok, true, one.stderr);
  deepStrictEqual(/var indexJsAdd = /.test(one.stdout), true, one.stdout.slice(0, 120));
  // …and files compose with modules in one combined selection bundle.
  const mix = await capture(() =>
    runCli(['-b', '_priv.js', 'index/add'], { cwd: FIXTURE, tty: false })
  );
  deepStrictEqual(mix.ok, true, mix.stderr);
  deepStrictEqual(/secret/.test(mix.stdout), true, mix.stdout.slice(0, 400));
  // Missing explicit paths fail as files, never as module guesses.
  await rejects(
    () => runCli(['-b', './nope.js'], { cwd: FIXTURE, tty: false }),
    /missing input file: \.\/nope\.js/
  );
});

should('bundle path comments stay ref-relative, never temp-dir walks', async () => {
  // @microsoft/tsdoc@0.16.0 is a repo devDependency, so the npm cache serves it offline.
  const res = await capture(() =>
    runCli(['-b', 'npm:@microsoft/tsdoc@0.16.0'], { cwd: FIXTURE, tty: false })
  );
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(/\/\/ node_modules\/@microsoft\/tsdoc\//.test(res.stdout), true);
  // No `// ../../..` comment lines pointing into the machine temp dir.
  deepStrictEqual(/^\s*\/\/ (\.\.\/)+/m.test(res.stdout), false, res.stdout.slice(0, 400));
});

should('fs-modify recognizes only bismar-owned temp dirs', () => {
  deepStrictEqual(FS_TEST.inBismarTmp(join(tmpdir(), 'bismar-bundle-test')), true);
  deepStrictEqual(FS_TEST.inBismarTmp(join(tmpdir(), 'other-dir')), false);
  deepStrictEqual(FS_TEST.inBismarTmp(join(FIXTURE, 'test', 'build')), false);
  deepStrictEqual(FS_TEST.inBismarTmp('relative/bismar-x'), false);
});

should('fs-modify creates cache dirs keeper-private (0700)', async (t) => {
  // Persistent caches (bismar-refs, bismar-esbuild-*) live at predictable
  // tmpdir paths on shared machines: every dir bismar makes must be 0700
  // rather than umask-default, all the way down the recursive mkdirs.
  if (process.platform === 'win32') return t.skip('posix modes');
  const { statSync } = await import('node:fs');
  const { tempDir, write, rmTempDir } = await import('../src/fs-modify.ts');
  const root = join(tmpdir(), 'bismar-permcheck');
  rmSync(root, { force: true, recursive: true });
  write(join(root, '.tags', 'entry.json'), '{}\n');
  try {
    for (const dir of [root, join(root, '.tags')])
      deepStrictEqual((statSync(dir).mode & 0o777).toString(8), '700', dir);
    // mkdtemp'd run dirs carry 0700 from mkdtemp(3) itself.
    const run = tempDir('check');
    deepStrictEqual((statSync(run).mode & 0o777).toString(8), '700', run);
    rmTempDir(run);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

should('fs-modify promotes run installs into the machine cache, bismar dirs only', () => {
  const from = join(tmpdir(), 'bismar-promote-test-from');
  const to = join(tmpdir(), 'bismar-promote-test-to');
  rmSync(from, { force: true, recursive: true });
  rmSync(to, { force: true, recursive: true });
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'marker.json'), '1\n');
  deepStrictEqual(promoteTemp(from, to), true);
  deepStrictEqual(existsSync(join(to, 'marker.json')), true);
  deepStrictEqual(existsSync(from), false);
  // A lost race (target already present) is a refusal, not an error.
  mkdirSync(from, { recursive: true });
  writeFileSync(join(from, 'marker.json'), '2\n');
  deepStrictEqual(promoteTemp(from, to), false);
  deepStrictEqual(existsSync(from), true);
  // Either end outside a bismar temp dir is a hard error.
  throws(() => promoteTemp(join(tmpdir(), 'other-dir'), to), /expected bismar temp path/);
  throws(() => promoteTemp(from, join(tmpdir(), 'other-dir')), /expected bismar temp path/);
  rmSync(from, { force: true, recursive: true });
  rmSync(to, { force: true, recursive: true });
});

should('bundle --clear wipes bismar tmp caches, reports stats, runs alone', async () => {
  // A private TMPDIR keeps the sweep away from the real machine caches; the
  // non-bismar neighbor must survive it.
  const scratch = mkdtempSync(join(tmpdir(), 'clear-fixture-'));
  mkdirSync(join(scratch, 'bismar-refs', 'x'), { recursive: true });
  writeFileSync(join(scratch, 'bismar-refs', 'x', 'pkg.json'), 'a'.repeat(2048));
  mkdirSync(join(scratch, 'bismar-esbuild-0281'), { recursive: true });
  mkdirSync(join(scratch, 'other-keep'), { recursive: true });
  const prev = process.env.TMPDIR;
  let res: Awaited<ReturnType<typeof capture>>;
  try {
    process.env.TMPDIR = scratch;
    res = await capture(() => runCli(['--clear'], {}));
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
  deepStrictEqual(res.ok, true, res.stderr);
  deepStrictEqual(/^removed 2 cache dirs, [\d.]+kb\n$/.test(res.stdout), true, res.stdout);
  deepStrictEqual(existsSync(join(scratch, 'bismar-refs')), false);
  deepStrictEqual(existsSync(join(scratch, 'bismar-esbuild-0281')), false);
  deepStrictEqual(existsSync(join(scratch, 'other-keep')), true);
  rmSync(scratch, { force: true, recursive: true });
  // Documented in usage, but it refuses company.
  const help = await capture(() => runCli(['--help'], {}));
  deepStrictEqual(/--clear {3}remove every bismar cache/.test(help.stdout), true, help.stdout);
  throws(() => parseArgs(['--clear', '--size']), /--clear runs alone/);
  throws(() => parseArgs(['--clear', 'index/add']), /--clear runs alone/);
  // --clean is the same hatch under its other, undocumented spelling.
  deepStrictEqual(parseArgs(['--clean']).clear, true);
  deepStrictEqual(/--clean/.test(help.stdout), false, help.stdout);
  throws(() => parseArgs(['--clean', '--size']), /--clear runs alone/);
});

should('fs-modify npm install prefers offline packages, skips audit/fund', () => {
  deepStrictEqual(FS_TEST.npmInstallArgs(), [
    'install',
    '--prefer-offline',
    '--ignore-scripts',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
  ]);
});
