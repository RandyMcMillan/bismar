// Tests for `bismar -d`: recursive two-package diff — tree classification,
// Myers line diffs, unified/stat CLI output, and the diff navigator.
import { deepStrictEqual, match, ok, rejects } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test as it } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const {
  bundleStatCsv,
  bundleStatHuman,
  diffBundleRows,
  diffLines,
  diffTarget,
  diffTrees,
  fileDiffLines,
  hunksOf,
  measuredSide,
  packLocalSides,
  statHuman,
  statSummary,
} = await import('../src/diff.ts');
const { runCli } = await import('../src/bismar.ts');
const { runDiff } = await import('../src/interactive.ts');

// Two fixture trees with every classification: unchanged, modified (same and
// different sizes), removed, added, nested, binary, and the skip rules.
const base = mkdtempSync(join(tmpdir(), 'bismar-difftest-'));
after(() => rmSync(base, { force: true, recursive: true }));
const put = (rel: string, data: string | Uint8Array): void => {
  const file = join(base, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
};
put('a/same.txt', 'hello\n');
put('a/mod.txt', 'one\ntwo\nthree\n');
put('a/gone.txt', 'bye\n');
put('a/blob.bin', new Uint8Array([0, 1, 2]));
put('a/sub/deep.txt', 'deep\n');
put('a/node_modules/x.js', 'skip me\n');
put('a/.git/config', 'skip me\n');
put('b/same.txt', 'hello\n');
put('b/mod.txt', 'one\n2\nthree\n');
put('b/new.txt', 'fresh\n');
put('b/blob.bin', new Uint8Array([0, 9, 2]));
put('b/sub/deep.txt', 'deep\n');
try {
  // Symlinks must be skipped whole; creation can fail on exotic filesystems.
  symlinkSync(join(base, 'a/same.txt'), join(base, 'a/link.txt'));
} catch {}

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

it('diffLines yields minimal ops with common context intact', () => {
  deepStrictEqual(diffLines('a\nb\nc\n', 'a\nx\nc\n'), [
    { kind: ' ', text: 'a' },
    { kind: '-', text: 'b' },
    { kind: '+', text: 'x' },
    { kind: ' ', text: 'c' },
  ]);
  // Empty sides are pure additions/removals — no phantom empty line.
  deepStrictEqual(diffLines('', 'a\n'), [{ kind: '+', text: 'a' }]);
  deepStrictEqual(diffLines('a\n', ''), [{ kind: '-', text: 'a' }]);
  deepStrictEqual(diffLines('a\nb\n', 'a\nb\n'), [
    { kind: ' ', text: 'a' },
    { kind: ' ', text: 'b' },
  ]);
});

it('hunksOf groups changes with context and 1-based line numbers', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const ops = diffLines(lines.join('\n'), lines.map((l) => (l === 'l10' ? 'X' : l)).join('\n'));
  const hunks = hunksOf(ops);
  deepStrictEqual(hunks.length, 1);
  deepStrictEqual(
    { aLen: hunks[0].aLen, aStart: hunks[0].aStart, bLen: hunks[0].bLen, bStart: hunks[0].bStart },
    { aLen: 7, aStart: 8, bLen: 7, bStart: 8 }
  );
});

it('bundle stat rows join, sort, and render deterministic deltas', () => {
  const aRows = [
    { export: 'gone', gzBytes: 716, module: 'z', plainBytes: 2100 },
    { export: 'same', gzBytes: 409, module: 'a', plainBytes: 1200 },
    { export: 'changed', gzBytes: 512, module: 'a', plainBytes: 1500 },
  ];
  const bRows = [
    { export: 'new', gzBytes: 614, module: 'b', plainBytes: 1800 },
    { export: 'changed', gzBytes: 563, module: 'a', plainBytes: 1650 },
    { export: 'same', gzBytes: 409, module: 'a', plainBytes: 1200 },
  ];
  const stat = diffBundleRows(aRows, bRows);
  deepStrictEqual(
    stat.entries.map((entry) => `${entry.status} ${entry.module}/${entry.export}`),
    ['modified a/changed', 'added b/new', 'removed z/gone']
  );
  deepStrictEqual(stat.same, 1);
  deepStrictEqual(bundleStatCsv(stat), [
    'M,a,changed,512b,563b,+51b',
    'A,b,new,0b,614b,+614b',
    'D,z,gone,716b,0b,-716b',
  ]);
  // -ds's dress: A/M/D marks, modified rows pair a → b with the delta,
  // single-sided rows sign their whole size.
  const human = bundleStatHuman(stat, false).join('\n');
  match(human, /M a\/changed {2}0\.50 → 0\.55kb \(\+10%\) gzip/);
  match(human, /A b\/new {2}\+0\.60kb gzip/);
  match(human, /D z\/gone {2}-0\.70kb gzip/);
  match(
    bundleStatHuman(stat, false).at(-1)!,
    /3 exports changed: 1 added, 1 removed, 1 modified · 1 unchanged/
  );
  // The plain metric reports and compares plainBytes; rows carry no suffix.
  const plainStat = diffBundleRows(aRows, bRows, 'plainBytes');
  deepStrictEqual(bundleStatCsv(plainStat), [
    'M,a,changed,1500b,1650b,+150b',
    'A,b,new,0b,1800b,+1800b',
    'D,z,gone,2100b,0b,-2100b',
  ]);
  match(
    bundleStatHuman(plainStat, false).join('\n'),
    /M a\/changed {2}1\.46 → 1\.61kb \(\+10%\)$/m
  );
  // "Changed" follows the metric: equal gzip with differing plain bytes is a
  // modification under the plain metric and unchanged under gzip.
  const gzTie = diffBundleRows(
    [{ export: 'x', gzBytes: 100, module: 'm', plainBytes: 400 }],
    [{ export: 'x', gzBytes: 100, module: 'm', plainBytes: 410 }],
    'plainBytes'
  );
  deepStrictEqual([gzTie.entries.length, gzTie.same], [1, 0]);
});

it('diffTrees classifies files and skips dev trees and symlinks', () => {
  const tree = diffTrees(join(base, 'a'), join(base, 'b'));
  deepStrictEqual(
    tree.entries.map((entry) => `${entry.status} ${entry.path}`),
    ['modified blob.bin', 'removed gone.txt', 'modified mod.txt', 'added new.txt']
  );
  // same.txt and sub/deep.txt count as unchanged; skipped trees count nowhere.
  deepStrictEqual(tree.same, 2);
});

it('bismar -d prints a unified diff off a terminal', async () => {
  const out = await capture(() => runCli(['-d', './a', './b'], { cwd: base, tty: false }));
  match(out, /diff --bismar a\/mod\.txt b\/mod\.txt/);
  match(out, /--- a\/mod\.txt\n\+\+\+ b\/mod\.txt\n@@ -1,3 \+1,3 @@\n one\n-two\n\+2\n three/);
  // Added and removed files diff against /dev/null; small modified binaries
  // diff as xxd-style rows through the same hunk machinery.
  match(out, /--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+fresh/);
  match(out, /--- a\/gone\.txt\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-bye/);
  match(
    out,
    /--- a\/blob\.bin\n\+\+\+ b\/blob\.bin\n@@ -1,1 \+1,1 @@\n-00 01 02 +\|\.\.\.\|\n\+00 09 02 +\|\.\.\.\|/
  );
});

it('binary diffs hexdump small files and summarize big ones', () => {
  // Above the 64KB cap a dump would be noise; the one-liner gets the first
  // mismatch offset and an equal-at-offset percentage instead.
  const big = new Uint8Array(70000);
  const changed = big.slice();
  changed[7000] = 1;
  put('biga/huge.bin', big);
  put('bigb/huge.bin', changed);
  const entry = { aBytes: 70000, bBytes: 70000, path: 'huge.bin', status: 'modified' } as const;
  const lines = fileDiffLines(join(base, 'biga'), join(base, 'bigb'), entry, false);
  deepStrictEqual(lines, [
    'diff --bismar a/huge.bin b/huge.bin',
    'Binary files a/huge.bin and b/huge.bin differ (68.4 → 68.4kb)',
    'first change at byte 7000, 99% of bytes match',
  ]);
  // Added/removed binaries keep the bare one-liner: a hexdump against
  // /dev/null is noise and the summary would always read "byte 0, 0%".
  const gone = { aBytes: 70000, bBytes: 0, path: 'huge.bin', status: 'removed' } as const;
  deepStrictEqual(
    fileDiffLines(join(base, 'biga'), join(base, 'bigb'), gone, false)[1],
    'Binary files a/huge.bin and b/huge.bin differ (68.4 → 0.00kb)'
  );
});

it('bismar -ds prints stat rows: CSV piped, painted table for humans', async () => {
  const csv = await capture(() => runCli(['-ds', './a', './b'], { cwd: base, tty: false }));
  // Headerless rows, units tagged: status, path, a bytes, b bytes, signed delta.
  match(csv, /^M,blob\.bin,3b,3b,\+0b\n/);
  match(csv, /M,mod\.txt,14b,12b,-2b/);
  match(csv, /D,gone\.txt,4b,0b,-4b/);
  match(csv, /A,new\.txt,0b,6b,\+6b/);
  // The human table shares rows and adds a two-line summary: counts, then
  // whole-tree sizes in the same a → b (±delta) shape as the modified rows.
  const tree = diffTrees(join(base, 'a'), join(base, 'b'));
  const human = statHuman(tree, false);
  match(human.join('\n'), /M mod\.txt {2}0\.01 → 0\.01kb \(-14%\)/);
  match(
    human.join('\n'),
    /4 files changed: 1 added, 1 removed, 2 modified · 2 unchanged\n0\.03 → 0\.03kb \(~0%\) unpacked$/
  );
  // Registry sides carry packed archive bytes; both known appends the packed
  // tail, either missing (a local directory) leaves it off.
  const [a, b] = [
    { archiveBytes: 1024, dir: '', label: '' },
    { archiveBytes: 2048, dir: '', label: '' },
  ];
  match(statSummary(tree, a, b)[1], / unpacked · 1\.00 → 2\.00kb \(\+100%\) packed$/);
  match(statSummary(tree, { dir: '', label: '' }, b)[1], /^0\.03 → 0\.03kb \(~0%\) unpacked$/);
});

it('bismar -dl prints just the changed file names, even on a terminal', async () => {
  const want = 'M blob.bin\nD gone.txt\nM mod.txt\nA new.txt\n';
  const out = await capture(() => runCli(['-dl', './a', './b'], { cwd: base, tty: false }));
  deepStrictEqual(out, want);
  // Like -ds, -dl is an output mode: a tty prints the same list, no navigator.
  const tty = await capture(() => runCli(['-dl', './a', './b'], { cwd: base, tty: true }));
  deepStrictEqual(tty, want);
});

it('a piped diff stays plain while stderr keeps its terminal', async () => {
  // `bismar -d … | less`: stdout is the pipe the diff lands on, stderr stays on
  // the terminal for progress lines and warnings. Only stdout may decide the
  // color, or the pager renders raw escapes.
  // Force flags beat the tty check, so the ambient shell must not leak in:
  // macOS profiles commonly export CLICOLOR_FORCE/CLICOLOR, which would paint
  // the "plain" run. Pin every env var wantColor reads, not just NO_COLOR.
  const colorVars = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE', 'CLICOLOR'] as const;
  const saved = colorVars.map((name) => [name, process.env[name]] as const);
  const stderrTty = process.stderr.isTTY;
  for (const name of colorVars) delete process.env[name];
  process.stderr.isTTY = true;
  try {
    const out = await capture(() => runCli(['-d', './a', './b'], { cwd: base, tty: false }));
    deepStrictEqual(/\x1b\[/.test(out), false, JSON.stringify(out));
    match(out, /diff --bismar a\/mod\.txt b\/mod\.txt/);
    // FORCE_COLOR is the escape hatch for `less -R` and friends.
    process.env.FORCE_COLOR = '1';
    const forced = await capture(() => runCli(['-d', './a', './b'], { cwd: base, tty: false }));
    deepStrictEqual(/\x1b\[31m-two/.test(forced), true, JSON.stringify(forced));
  } finally {
    process.stderr.isTTY = stderrTty;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

it('bismar -d reports identical trees instead of empty output', async () => {
  const out = await capture(() => runCli(['-d', './a', './a'], { cwd: base, tty: false }));
  match(out, /no differences: \.\/a and \.\/a ship identical files/);
});

it('-db diffs bundle text and -dbs reports per-export size deltas', async () => {
  const a = './test/vectors/plain';
  const b = './test/vectors/documented';
  const text = await capture(() => runCli(['-db', a, b], { tty: false }));
  match(text, /^--- \.\/test\/vectors\/plain\n\+\+\+ \.\/test\/vectors\/documented\n@@/);
  match(text, /-var bismarTestPlain =/);
  match(text, /\+var bismarTestDocumented =/);

  const min = await capture(() => runCli(['-dm', a, b], { tty: false }));
  match(min, /^--- \.\/test\/vectors\/plain\n\+\+\+ \.\/test\/vectors\/documented\n@@/);
  match(min, /-var bismarTestPlain=/);
  match(min, /\+var bismarTestDocumented=/);
  deepStrictEqual(await capture(() => runCli(['-dbm', a, b], { tty: false })), min);

  // -dbs compares the plain bundles' bytes; adding -m switches the metric to
  // min+gzip. The plain `all` bundles differ by kilobytes (the blob export
  // exists on one side only), so the M row is stable in both metrics.
  const stat = await capture(() => runCli(['-dbs', a, b], { tty: false }));
  match(stat, /^A,@bismar-test\/documented,,0b,\d+b,\+\d+b$/m);
  match(stat, /^D,@bismar-test\/plain,,\d+b,0b,-\d+b$/m);
  match(stat, /^M,index,all,\d+b,\d+b,-\d+b$/m);
  const gzStat = await capture(() => runCli(['-dbms', a, b], { tty: false }));
  match(gzStat, /^M,index,all,\d+b,\d+b,-\d+b$/m);
  // Different metrics, different numbers: plain bytes dwarf min+gzip.
  const allBytes = (out: string): number => Number(/^M,index,all,(\d+)b/m.exec(out)![1]);
  ok(allBytes(stat) > allBytes(gzStat), `${allBytes(stat)} vs ${allBytes(gzStat)}`);

  const sameText = await capture(() => runCli(['-db', a, a], { tty: false }));
  deepStrictEqual(sameText, `no bundle changes: ${a} and ${a} bundle identical\n`);
  const sameSize = await capture(() => runCli(['-dbs', a, a], { tty: false }));
  deepStrictEqual(sameSize, `no bundle size changes: ${a} and ${a} measure identical\n`);
});

it('measured sides install tarballs and leave local dirs in place', async () => {
  const { npmPack, rmTempDir, tempDir } = await import('../src/fs-modify.ts');
  put('mpkg/package.json', JSON.stringify({ name: 'bismar-test-mside', version: '1.0.0' }));
  put('mpkg/index.js', 'module.exports = 42;\n');
  const tmp = tempDir('diff');
  try {
    const tgz = npmPack(join(base, 'mpkg'), join(tmp, 'packed'));
    const side = await diffTarget(tmp, tgz, base);
    ok(side.tarball);
    // A tarball side measures from an install, not the bare extract — the bare
    // extract has no node_modules, so declared deps would silently go external
    // on that side only while a ref side bundles them in.
    const installed = measuredSide(tmp, side);
    match(installed.dir, /node_modules[\\/]bismar-test-mside$/);
    deepStrictEqual(readdirSync(installed.dir).includes('index.js'), true);
    // A local dir measures in place, where its own node_modules resolves deps
    // (same context as `bismar -bs` run inside it).
    const local = { dir: join(base, 'mpkg'), label: '.', localDir: true };
    deepStrictEqual(measuredSide(tmp, local), local);
  } finally {
    rmTempDir(tmp);
  }
});

it('tarball selectors extract; a local dir against a package npm-packs first', async () => {
  // A publishable fixture: the files field ships index.js only, so the test
  // file must vanish from any packed side.
  put(
    'pkg/package.json',
    JSON.stringify({ files: ['index.js'], name: 'fixture', version: '1.0.0' })
  );
  put('pkg/index.js', 'module.exports = 1;\n');
  put('pkg/skipped.test.js', 'never published\n');
  const out = join(base, 'out');
  // Dir-vs-dir stays whole-tree; only a dir facing a package side gets packed.
  const local = { dir: join(base, 'pkg'), label: '.', localDir: true };
  deepStrictEqual(packLocalSides(out, local, local), [local, local]);
  const [a, b] = packLocalSides(out, local, { dir: join(base, 'a'), label: 'npm:x' });
  deepStrictEqual(b.label, 'npm:x');
  deepStrictEqual(a.label, '. (npm pack)');
  deepStrictEqual(readdirSync(a.dir).sort(), ['index.js', 'package.json']);
  ok((a.archiveBytes ?? 0) > 0);
  // The tarball npm pack left behind doubles as the `.tgz` selector fixture:
  // extraction descends through the single `package/` root.
  const packDir = readdirSync(out).find((ent) => ent.startsWith('pack-'))!;
  const [tgz] = readdirSync(join(out, packDir));
  deepStrictEqual(tgz, 'fixture-1.0.0.tgz');
  const side = await diffTarget(out, tgz, join(out, packDir));
  deepStrictEqual(side.label, tgz);
  deepStrictEqual(side.archiveBytes, a.archiveBytes);
  deepStrictEqual(readdirSync(side.dir).sort(), ['index.js', 'package.json']);
  // End to end: tarball vs its source dir diffs clean — proof the unpublished
  // test file was filtered off the local side, not compared.
  const clean = await capture(() =>
    runCli(['-ds', `./out/${packDir}/${tgz}`, './pkg'], { cwd: base, tty: false })
  );
  match(
    clean,
    /no differences: \.\/out\/.*fixture-1\.0\.0\.tgz and \.\/pkg \(npm pack\) ship identical files/
  );
  // Standalone -s packs a local package too. Invalid JS proves this path never
  // asks esbuild to parse what ships, and the files field filters the test file.
  put('pkg/index.js', 'export const broken = ;\n');
  const cache = process.env.npm_config_cache;
  const force = process.env.FORCE_COLOR;
  process.env.npm_config_cache = join(base, 'npm-cache');
  process.env.FORCE_COLOR = '1';
  try {
    const shipped = await capture(() => runCli(['-s', './pkg'], { cwd: base, tty: true }));
    match(shipped, /index\.js[^\n]*0\.02kb/);
    match(shipped, /package\.json/);
    match(shipped, /unpacked · .* packed · 2 files/);
    deepStrictEqual(/skipped\.test\.js|LOC|gzip/.test(shipped), false, shipped);
  } finally {
    if (cache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = cache;
    if (force === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = force;
  }
  await rejects(
    () => runCli(['-d', './missing.tgz', './a'], { cwd: base, tty: false }),
    /missing tarball: \.\/missing\.tgz/
  );
  await rejects(
    () => runCli(['-d', 'x.tgz', '1.0.0', '2.0.0'], { tty: false }),
    /--diff takes exactly two packages: bismar -d <a> <b>/
  );
});

it('ref /path tails scope tree diffs to a shipped file or subtree', () => {
  // An exact file tail: one row, totals weigh the scope — not the package.
  const one = diffTrees(join(base, 'a'), join(base, 'b'), 'mod.txt', 'mod.txt');
  deepStrictEqual(
    one.entries.map((entry) => entry.path),
    ['mod.txt']
  );
  deepStrictEqual([one.same, one.aTotal, one.bTotal], [0, 14, 12]);
  // A directory tail takes the subtree; unchanged files still count as same,
  // which is what separates "identical within scope" from "matched nothing".
  const sub = diffTrees(join(base, 'a'), join(base, 'b'), 'sub', 'sub');
  deepStrictEqual([sub.entries.length, sub.same], [0, 1]);
  // A tail matching neither side yields the empty tree the CLI errors on.
  const none = diffTrees(join(base, 'a'), join(base, 'b'), 'nope.js', 'nope.js');
  deepStrictEqual([none.entries.length, none.same], [0, 0]);
  // Scoped tables drop the two-line footer — it would just restate the rows.
  deepStrictEqual(
    statHuman(one, false, { dir: '', label: '', sel: 'mod.txt' }, { dir: '', label: '' }),
    ['M mod.txt  0.01 → 0.01kb (-14%)']
  );
});

it('bismar -d validates its arguments', async () => {
  // Exactly two selectors — the retired pkg-plus-two-versions form errs too.
  await rejects(
    () => runCli(['-d', './a'], { tty: false }),
    /--diff takes exactly two packages: bismar -d <a> <b>/
  );
  await rejects(
    () => runCli(['-d', 'npm:qr', '0.5.0', '0.6.0'], { tty: false }),
    /--diff takes exactly two packages: bismar -d <a> <b>/
  );
  await rejects(
    () => runCli(['-dms', './a', './b'], { tty: false }),
    /--minify shapes the emitted bundle; use -dbs or drop -m/
  );
  await rejects(
    () => runCli(['-dbl', './a', './b'], { tty: false }),
    /--list replaces the bundle output/
  );
  await rejects(
    () => runCli(['-dbsl', './a', './b'], { tty: false }),
    /--list replaces the bundle output/
  );
  await rejects(
    () => runCli(['-dbs', 'crate:serde@1.0.0', 'crate:serde@1.0.1'], { tty: false }),
    /crate refs have no JS to bundle: crate:serde@1\.0\.0; use -ds for shipped file sizes/
  );
  await rejects(
    () => runCli(['-db', 'crate:serde@1.0.0', 'crate:serde@1.0.1'], { tty: false }),
    /crate refs have no JS to bundle: crate:serde@1\.0\.0; use -d to diff shipped files/
  );
  await rejects(
    () => runCli(['-dbm', 'crate:serde@1.0.0', 'crate:serde@1.0.1'], { tty: false }),
    /crate refs have no JS to minify: crate:serde@1\.0\.0; drop --minify/
  );
  // -ds already lists every changed file, so adding -l changes nothing.
  deepStrictEqual(
    await capture(() => runCli(['-dsl', './a', './b'], { cwd: base, tty: false })),
    await capture(() => runCli(['-ds', './a', './b'], { cwd: base, tty: false }))
  );
  await rejects(
    () => runCli(['-d', './a', './missing'], { cwd: base, tty: false }),
    /missing diff directory: \.\/missing/
  );
  // Bare names never imply npm — scoped or not; the hint points at the prefix.
  await rejects(
    () => runCli(['-d', 'qr@0.5.0', 'qr@0.6.0'], { cwd: base, tty: false }),
    /--diff expects package refs or directories, not qr@0\.5\.0; use npm:qr@0\.5\.0/
  );
  await rejects(
    () => runCli(['-d', '@noble/hashes@1.8.0', './a'], { cwd: base, tty: false }),
    /--diff expects package refs or directories, not @noble\/hashes@1\.8\.0; use npm:@noble\/hashes@1\.8\.0/
  );
});

// Strips colors and control sequences (clear, home, alternate screen).
const strip = (text: string): string => text.replace(/\x1b\[[\d?;]*[a-zA-Z]/g, '');
it('diff navigator lists changed files and pages through a line diff', async () => {
  const input = new PassThrough();
  let raw = '';
  const io = {
    cols: 100,
    input,
    output: {
      write: (text: string) => {
        raw += text;
        return true;
      },
    },
    rows: 16,
  };
  const tree = diffTrees(join(base, 'a'), join(base, 'b'));
  const done = runDiff(
    { dir: join(base, 'a'), label: './a' },
    { dir: join(base, 'b'), label: './b' },
    tree,
    io
  );
  // Down to mod.txt, open its diff, close the pager, quit the navigator.
  input.write('\x1b[B\x1b[B\r');
  input.write('qq');
  await done;
  const text = strip(raw);
  // The summary is a footer in -ds's shape — counts, then sizes — between the
  // file list and the key bar; the title row carries only labels and mode.
  match(text, /\.\/a → \.\/b · diff[^\n]*\n[^\n]*\n[^\n]*M blob\.bin/);
  match(text, /4 files changed[^\n]*\n0\.03 → 0\.03kb \(~0%\) unpacked[^\n]*\n↑↓ move/);
  match(text, /M mod\.txt {2}0\.01 → 0\.01kb \(-14%\)/);
  match(text, /A new\.txt {2}\+0\.01kb/);
  match(text, /@@ -1,3 \+1,3 @@/);
  match(text, /-two/);
  match(text, /\+2/);
});
