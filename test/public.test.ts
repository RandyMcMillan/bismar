import { deepStrictEqual, throws } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The progress test asserts plain stderr text; pin machine mode for standalone runs.
process.env.NO_COLOR = '1';

import { test as it } from 'node:test';
import {
  color,
  csvCell,
  csvEnabled,
  paint,
  progressDone,
  progressOff,
  progressReset,
  progressShow,
  progressUpdate,
  stdoutColor,
  terminalAnsi,
  terminalText,
} from '../src/env.ts';
import {
  dtsPath,
  exportPath,
  jsPath,
  publicEntries,
  readPkg,
  resolveInside,
} from '../src/public.ts';

it('csvEnabled keys off stdout alone, not the still-attached stderr tty', () => {
  // `bismar -s pkg | sort` pipes stdout while stderr stays on the terminal:
  // the rows land on stdout, so stdout decides. Explicit env objects bypass
  // the ambient NO_COLOR pin above.
  deepStrictEqual(csvEnabled({}, false), true);
  deepStrictEqual(csvEnabled({}, true), false);
  deepStrictEqual(csvEnabled({ BISMAR_CSV: '1' }, true), true);
  deepStrictEqual(csvEnabled({ NO_COLOR: '1' }, true), true);
  // FORCE_COLOR is the escape hatch that keeps the table even through a pipe.
  deepStrictEqual(csvEnabled({ FORCE_COLOR: '1' }, false), false);
});

it('stdoutColor keys off stdout alone, not the still-attached stderr tty', () => {
  // `bismar -d pkg v1 v2 | less` pipes the diff while stderr keeps the terminal
  // for progress lines: the text lands on stdout, so stdout decides.
  deepStrictEqual(stdoutColor({}, false), false);
  deepStrictEqual(stdoutColor({}, true), true);
  deepStrictEqual(stdoutColor({ NO_COLOR: '1' }, true), false);
  // Force flags win either way — this is how `| less -R` gets its color back.
  deepStrictEqual(stdoutColor({ FORCE_COLOR: '1' }, false), true);
  deepStrictEqual(stdoutColor({ CLICOLOR_FORCE: '1' }, false), true);
});

it('terminal text makes C0/C1 and escape protocols visible', () => {
  const hostile = `a\0\t\n\r\x1b\x7f\u0085b`;
  deepStrictEqual(terminalText(hostile), 'a\u2400\u2409\u240a\u240d\u241b\u2421\\u0085b');
  deepStrictEqual(terminalText('a\r\n\tb\rc', { multiline: true, tabs: 2 }), 'a\n  b\u240dc');

  const composed =
    `${color.red}owned${color.reset}` +
    '\x1b[2J\x1b]8;;https://evil.example\x07link\x1b]8;;\x07' +
    '\x1b]52;c;Y2xpcGJvYXJk\x1b\\\x1bX\u009b2J';
  const safe = terminalAnsi(composed);
  deepStrictEqual(safe.startsWith(`${color.red}owned${color.reset}`), true, safe);
  deepStrictEqual(safe.includes('\x1b[2J'), false, safe);
  deepStrictEqual(safe.includes('\x1b]'), false, safe);
  deepStrictEqual(safe.includes('\x1bX'), false, safe);
  deepStrictEqual(safe.includes('\u009b'), false, safe);
  deepStrictEqual(safe.includes('\u241b[2J'), true, safe);
  deepStrictEqual(safe.includes('\\u009b2J'), true, safe);

  // Even an SGR-looking sequence supplied as paint payload is inert. Only the
  // wrapper introduced by paint remains an actual escape sequence.
  deepStrictEqual(
    paint('before\x1b[31mafter', color.blue),
    `${color.blue}before\u241b[31mafter${color.reset}`
  );

  // Forced CSV can still target a TTY: colors are stripped, payload controls
  // are visible, and an owned newline keeps its ordinary CSV quoting semantics.
  deepStrictEqual(
    csvCell(`${color.red}red${color.reset}\x1b]52;c;eA==\x07\nnext`),
    '"red\u241b]52;c;eA==\u2407\nnext"'
  );
});

it('public path helpers walk nested export condition objects', () => {
  const value = {
    import: { default: './index.mjs' },
    require: './index.cjs',
    types: './index.d.ts',
  };
  deepStrictEqual(jsPath(value), './index.mjs');
  deepStrictEqual(dtsPath(value), './index.d.ts');
});

it('public declaration paths fall back from JS leaves', () => {
  deepStrictEqual(jsPath({ browser: './browser.js' }), './browser.js');
  deepStrictEqual(dtsPath({ node: './node.cjs' }), './node.d.ts');
  deepStrictEqual(dtsPath('./types.d.mts'), './types.d.mts');
});

it('exportPath walks export maps with caller-owned leaf policy', () => {
  const value = {
    import: './esm.mjs',
    node: { default: './node.js' },
    require: './cjs.cjs',
  };
  deepStrictEqual(
    exportPath(value, (path) => (path.endsWith('.js') ? path : '')),
    './node.js'
  );
  deepStrictEqual(
    exportPath(value, (path) => (path.endsWith('.cjs') ? path : '')),
    './cjs.cjs'
  );
});

it('readPkg normalizes export maps and legacy package entries', () => {
  deepStrictEqual(readPkg(resolve('test/vectors/documented/package.json')), {
    exports: { '.': 'index.js' },
    name: '@bismar-test/documented',
    self: false,
    types: 'index.d.mts',
    version: '1.0.0',
  });
  deepStrictEqual(readPkg(resolve('test/vectors/jsr-src/package.json')).self, true);
});

it('readPkg tolerates entryless binary packages only when asked', () => {
  // npm binary packages (@esbuild/darwin-arm64) ship no exports/main/index.js;
  // file-tree consumers (diff, shipped sizes) read them with entryOptional.
  const dir = mkdtempSync(join(tmpdir(), 'bismar-pubtest-'));
  try {
    const pkgFile = join(dir, 'package.json');
    writeFileSync(pkgFile, JSON.stringify({ name: 'bin-only', version: '1.0.0' }));
    throws(() => readPkg(pkgFile), /missing exports or main\/module entry/);
    deepStrictEqual(readPkg(pkgFile, true), {
      exports: {},
      name: 'bin-only',
      self: false,
      types: '',
      version: '1.0.0',
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it('resolveInside rejects lexical and symlink escapes from package roots', () => {
  const parent = mkdtempSync(join(tmpdir(), 'bismar-inside-'));
  try {
    const root = join(parent, 'pkg');
    const outside = join(parent, 'outside.js');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.js'), 'export {}\n');
    writeFileSync(outside, 'export const secret = 1;\n');
    symlinkSync(outside, join(root, 'linked.js'));
    symlinkSync(root, join(parent, 'pkg-alias'), 'dir');

    deepStrictEqual(resolveInside(root, './src/../src/index.js'), join(root, 'src', 'index.js'));
    deepStrictEqual(
      resolveInside(join(parent, 'pkg-alias'), './src/index.js'),
      join(root, 'src', 'index.js')
    );
    deepStrictEqual(resolveInside(root, '../outside.js'), undefined);
    deepStrictEqual(resolveInside(root, outside), undefined);
    deepStrictEqual(resolveInside(root, './linked.js'), undefined);
    deepStrictEqual(resolveInside(root, './missing.js'), undefined);
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

it('publicEntries lists sorted public JS export entries with package specs', () => {
  deepStrictEqual(
    publicEntries({
      cwd: '/tmp/pkg',
      pkg: {
        exports: {
          './z': './z.js',
          './types': './types.d.ts',
          '.': { import: './index.js', types: './index.d.ts' },
          './a': { default: './a.mjs' },
          private: './private.js',
        },
        name: '@scope/pkg',
        self: true,
        types: '',
        version: '1.0.0',
      },
      pkgFile: '/tmp/pkg/package.json',
    }),
    [
      {
        jsRel: './index.js',
        key: '.',
        spec: '@scope/pkg',
        value: { import: './index.js', types: './index.d.ts' },
      },
      { jsRel: './a.mjs', key: './a', spec: '@scope/pkg/a', value: { default: './a.mjs' } },
      { jsRel: './z.js', key: './z', spec: '@scope/pkg/z', value: './z.js' },
    ]
  );
});

it('progress line appears after a silent second, updates in place, clears', async () => {
  // The startup indicator writes straight to process.stderr, gated on its TTY-ness;
  // stub both to observe it. NO_COLOR is pinned above, so the text stays plain.
  const stderr = process.stderr as unknown as {
    isTTY?: boolean;
    write: (text: string) => boolean;
  };
  const prevWrite = stderr.write;
  const prevTty = stderr.isTTY;
  let out = '';
  // The test reporter writes to this same stream and may drain a batch of its own
  // lines mid-test (node 22 flushes later than 24+ does), so keep only the progress
  // writes — every one of them starts by clearing the line — and let the rest through
  // to the real stream instead of swallowing the reporter's output.
  stderr.write = (text: string) =>
    String(text).startsWith('\r\x1b[K')
      ? ((out += text), true)
      : prevWrite.call(process.stderr, text);
  stderr.isTTY = true;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  try {
    progressReset();
    progressUpdate('installing x');
    // Nothing within the first second; fast runs never see the line.
    deepStrictEqual(out, '');
    await sleep(1150);
    deepStrictEqual(out, '\r\x1b[KLoading… installing x');
    // Later updates rewrite the same line immediately.
    progressUpdate('bundling 1/3');
    deepStrictEqual(out.endsWith('\r\x1b[KLoading… bundling 1/3'), true, out);
    // Done clears the line so real output starts on a clean row.
    progressDone();
    deepStrictEqual(out.endsWith('bundling 1/3\r\x1b[K'), true, out);
    // Known-slow sync work (npm install) shows immediately, no delay to wait out.
    progressShow('installing y');
    deepStrictEqual(out.endsWith('\r\x1b[KLoading… installing y'), true, out);
    progressDone();
    // Package labels flow through this line. OSC clipboard/hyperlink commands,
    // CSI erases, malformed ESC, line breaks, and C1 CSI are all visible text.
    progressShow('x\x1b[2J\x1b]52;c;YQ==\x07\n\x1bX\u009b2J');
    deepStrictEqual(out.includes('\x1b]52'), false, out);
    deepStrictEqual(out.includes('\x1b[2J'), false, out);
    deepStrictEqual(
      out.endsWith('x\u241b[2J\u241b]52;c;YQ==\u2407\u240a\u241bX\\u009b2J'),
      true,
      out
    );
    progressDone();
    // Muted (TUI) and non-TTY runs write nothing at all.
    out = '';
    progressOff();
    progressUpdate('muted');
    progressReset();
    stderr.isTTY = false;
    progressUpdate('piped');
    await sleep(1150);
    deepStrictEqual(out, '');
  } finally {
    stderr.write = prevWrite;
    stderr.isTTY = prevTty;
    progressReset();
  }
});
