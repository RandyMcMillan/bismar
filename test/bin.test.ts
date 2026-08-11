import { deepStrictEqual, rejects } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { test as it } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { runCli } = await import('../src/bismar.ts');

const capture = async (fn: () => Promise<void>) => {
  const prev = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = prev;
  }
  return out;
};

it('package build marks the bismar bin executable', () => {
  deepStrictEqual(/chmod \+x bismar\.js/.test(pkg.scripts.build), true);
  deepStrictEqual(pkg.bin, { bismar: 'bismar.js' });
});

it('package exports name the supported subpaths and nothing else', () => {
  // Every root .js ships, so before this map any module was importable and none was
  // promised. The map is the promise: these subpaths have a downstream consumer
  // (@paulmillr/jsbt) and break with a version bump, the rest are bismar's business.
  deepStrictEqual(Object.keys(pkg.exports).sort(), [
    '.',
    './env.js',
    './package.json',
    './public.js',
    './refs.js',
    './size.js',
  ]);
  deepStrictEqual(pkg.exports['.'], `./${pkg.main}`);
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key === '.' || key === './package.json') continue;
    // Self-mapped, so the published path and the source module stay one name; tsc
    // emits the sibling .d.ts that types the subpath.
    deepStrictEqual(target, key, key);
    deepStrictEqual(existsSync(`src/${key.slice(2, -3)}.ts`), true, key);
  }
  // Withheld on purpose: fs-modify is the filesystem-mutation boundary, and the rest are
  // CLI-shaped modules with no callers outside this package.
  for (const internal of ['./bismar.js', './diff.js', './fs-modify.js', './interactive.js'])
    deepStrictEqual(internal in pkg.exports, false, internal);
});

it('bismar --help documents the single command, every flag and its alias', async () => {
  const out = await capture(() => runCli(['--help'], { tty: false }));
  deepStrictEqual(/^usage:\n  bismar \[<selector>\]/.test(out), true, out);
  for (const flag of ['--bundle', '--size', '--minify', '--list', '--diff', '--clear'])
    deepStrictEqual(out.includes(flag), true, `${flag}\n${out}`);
  for (const alias of ['-b,', '-s,', '-m,', '-l,', '-d,'])
    deepStrictEqual(out.includes(alias), true, `${alias}\n${out}`);
  // No subcommands and no other binaries: positionals are always selectors.
  deepStrictEqual(/bismar (bundle|size) |jsbt-check|<command>/.test(out), false, out);
  // Combined shorts and the namespace table are documented too.
  deepStrictEqual(out.includes('short flags combine: bismar -bm == bismar -b -m'), true, out);
  deepStrictEqual(out.includes('namespaces (long aliases like npm: crate: work too):'), true, out);
  deepStrictEqual(out.includes('rs:   crates.io   gh:   github'), true, out);
});

it('bismar refuses unknown selector namespaces with the full listing', async () => {
  await rejects(
    () => runCli(['foo:bar'], { tty: false }),
    /unknown namespace: foo:; use one of:\nnpm: \(or js:\)\njsr:/
  );
});

it('bare bismar off a terminal errs with the mode hints', async () => {
  // On a terminal a bare bismar opens the navigator (the default mode); piped,
  // it cannot — the error points at the flags that do produce pipe output.
  await rejects(
    () => runCli([], { tty: false }),
    /interactive mode needs a terminal; add -b to bundle or -s for shipped sizes/
  );
});

it('bismar rejects unknown options and cross-mode flag combos', async () => {
  await rejects(
    () => runCli(['--nope'], { tty: false }),
    /unknown option: --nope; run bismar --help/
  );
  await rejects(() => runCli(['size', '--keep'], { tty: false }), /unknown option: --keep/);
  await rejects(
    () => runCli(['--size', '--minify'], { tty: false }),
    /--minify shapes the emitted bundle; use -bms or drop -m/
  );
  // Deleted flags read as unknown options, not silent no-ops.
  await rejects(() => runCli(['--checksum'], { tty: false }), /unknown option: --checksum/);
  await rejects(() => runCli(['-c'], { tty: false }), /unknown option: -c/);
  await rejects(() => runCli(['--size-sorted'], { tty: false }), /unknown option: --size-sorted/);
  await rejects(
    () => runCli(['-b', '--list'], { tty: false }),
    /--list replaces the bundle output; drop --bundle/
  );
  // Interactive is the default mode, not a flag; several selectors need -b.
  await rejects(() => runCli(['a', 'b'], { tty: true }), /at most one package selector/);
  // The retired flag spellings must not silently no-op.
  await rejects(() => runCli(['-i'], { tty: true }), /unknown option: -i/);
  await rejects(() => runCli(['--interactive'], { tty: true }), /unknown option: --interactive/);
  await rejects(() => runCli(['--input=./x.js'], { tty: true }), /--input is retired/);
});
