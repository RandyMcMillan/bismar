// Tests for `bismar -d`: recursive two-package diff — tree classification,
// Myers line diffs, unified/stat CLI output, and the diff navigator.
import { deepStrictEqual, match, rejects } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test as should } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const { diffLines, diffPair, diffTrees, hunksOf, statHuman } = await import('../src/diff.ts');
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

should('diffLines yields minimal ops with common context intact', () => {
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

should('hunksOf groups changes with context and 1-based line numbers', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const ops = diffLines(lines.join('\n'), lines.map((l) => (l === 'l10' ? 'X' : l)).join('\n'));
  const hunks = hunksOf(ops);
  deepStrictEqual(hunks.length, 1);
  deepStrictEqual(
    { aLen: hunks[0].aLen, aStart: hunks[0].aStart, bLen: hunks[0].bLen, bStart: hunks[0].bStart },
    { aLen: 7, aStart: 8, bLen: 7, bStart: 8 }
  );
});

should('diffTrees classifies files and skips dev trees and symlinks', () => {
  const tree = diffTrees(join(base, 'a'), join(base, 'b'));
  deepStrictEqual(
    tree.entries.map((entry) => `${entry.status} ${entry.path}`),
    ['modified blob.bin', 'removed gone.txt', 'modified mod.txt', 'added new.txt']
  );
  // same.txt and sub/deep.txt count as unchanged; skipped trees count nowhere.
  deepStrictEqual(tree.same, 2);
});

should('bismar -d prints a unified diff off a terminal', async () => {
  const out = await capture(() => runCli(['-d', './a', './b'], { cwd: base, tty: false }));
  match(out, /diff --bismar a\/mod\.txt b\/mod\.txt/);
  match(out, /--- a\/mod\.txt\n\+\+\+ b\/mod\.txt\n@@ -1,3 \+1,3 @@\n one\n-two\n\+2\n three/);
  // Added and removed files diff against /dev/null; binary ones say so.
  match(out, /--- \/dev\/null\n\+\+\+ b\/new\.txt\n@@ -0,0 \+1,1 @@\n\+fresh/);
  match(out, /--- a\/gone\.txt\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-bye/);
  match(out, /Binary files a\/blob\.bin and b\/blob\.bin differ/);
});

should('bismar -ds prints stat rows: CSV piped, painted table for humans', async () => {
  const csv = await capture(() => runCli(['-ds', './a', './b'], { cwd: base, tty: false }));
  // Headerless rows, units tagged: status, path, a bytes, b bytes, signed delta.
  match(csv, /^M,blob\.bin,3b,3b,\+0b\n/);
  match(csv, /M,mod\.txt,14b,12b,-2b/);
  match(csv, /D,gone\.txt,4b,0b,-4b/);
  match(csv, /A,new\.txt,0b,6b,\+6b/);
  // The human table shares rows and adds the summary line.
  const human = statHuman(diffTrees(join(base, 'a'), join(base, 'b')), false);
  match(human.join('\n'), /M mod\.txt {2}0\.01kb → 0\.01kb \(-0\.00kb\)/);
  match(
    human.join('\n'),
    /4 files changed: 1 added, 1 removed, 2 modified · 2 unchanged · \+0\.00kb/
  );
});

should('bismar -dl prints just the changed file names, even on a terminal', async () => {
  const want = 'M blob.bin\nD gone.txt\nM mod.txt\nA new.txt\n';
  const out = await capture(() => runCli(['-dl', './a', './b'], { cwd: base, tty: false }));
  deepStrictEqual(out, want);
  // Like -ds, -dl is an output mode: a tty prints the same list, no navigator.
  const tty = await capture(() => runCli(['-dl', './a', './b'], { cwd: base, tty: true }));
  deepStrictEqual(tty, want);
});

should('bismar -d reports identical trees instead of empty output', async () => {
  const out = await capture(() => runCli(['-d', './a', './a'], { cwd: base, tty: false }));
  match(out, /no differences: \.\/a and \.\/a ship identical files/);
});

should('diffPair normalizes the package-plus-two-versions form', () => {
  // Two selectors pass through; three arguments pin one package twice.
  deepStrictEqual(diffPair(['./a', './b']), ['./a', './b']);
  deepStrictEqual(diffPair(['npm:qr', '0.5.0', '0.6.0']), ['npm:qr@0.5.0', 'npm:qr@0.6.0']);
  deepStrictEqual(diffPair(['npm:@noble/hashes', '1.8.0', '2.0.0']), [
    'npm:@noble/hashes@1.8.0',
    'npm:@noble/hashes@2.0.0',
  ]);
  deepStrictEqual(diffPair(['crate:serde', '1.0.218', '1.0.219']), [
    'crate:serde@1.0.218',
    'crate:serde@1.0.219',
  ]);
});

should('bismar -d validates its arguments', async () => {
  await rejects(
    () => runCli(['-d', './a'], { tty: false }),
    /--diff takes two packages, or a package and two versions: bismar -d <a> <b> or bismar -d <pkg> <v1> <v2>/
  );
  await rejects(
    () => runCli(['-d', 'npm:a', '1.0.0', '1.0.1', '1.0.2'], { tty: false }),
    /takes two packages, or a package and two versions/
  );
  // The three-argument form wants a versionless ref plus two plain versions.
  await rejects(
    () => runCli(['-d', './a', './b', './c'], { cwd: base, tty: false }),
    /directories have no versions: \.\/a; pass two directories instead/
  );
  await rejects(
    () => runCli(['-d', 'npm:qr', './b', './c'], { tty: false }),
    /expected a version, not \.\/b; use bismar -d <pkg> <v1> <v2>/
  );
  await rejects(
    () => runCli(['-d', 'npm:qr', 'npm:a', 'npm:b'], { tty: false }),
    /expected a version, not npm:a/
  );
  await rejects(
    () => runCli(['-d', 'npm:qr@0.5.0', '0.5.0', '0.6.0'], { tty: false }),
    /already pinned: npm:qr@0\.5\.0; drop @0\.5\.0 — the two versions follow/
  );
  await rejects(
    () => runCli(['-db', './a', './b'], { tty: false }),
    /--bundle shapes the bundle output, not a diff; drop --bundle or --diff/
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
  await rejects(
    () => runCli(['-d', 'npm:qr@0.6.0/index', './a'], { cwd: base, tty: false }),
    /--diff compares whole packages; drop \/index from npm:qr@0\.6\.0\/index/
  );
});

// Strips colors and control sequences (clear, home, alternate screen).
const strip = (text: string): string => text.replace(/\x1b\[[\d?;]*[a-zA-Z]/g, '');
should('diff navigator lists changed files and pages through a line diff', async () => {
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
  match(text, /\.\/a → \.\/b · diff · 4 files changed/);
  match(text, /M mod\.txt {2}0\.01kb → 0\.01kb \(-0\.00kb\)/);
  match(text, /A new\.txt {2}\+0\.01kb/);
  match(text, /@@ -1,3 \+1,3 @@/);
  match(text, /-two/);
  match(text, /\+2/);
});
