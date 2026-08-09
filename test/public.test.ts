import { deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';

// The progress test asserts plain stderr text; pin machine mode for standalone runs.
process.env.NO_COLOR = '1';

import {
  csvEnabled,
  progressDone,
  progressOff,
  progressReset,
  progressShow,
  progressUpdate,
  stdoutColor,
} from '../src/env.ts';
import { dtsPath, exportPath, jsPath, publicEntries, readPkg } from '../src/public.ts';
import { test as should } from 'node:test';

should('csvEnabled keys off stdout alone, not the still-attached stderr tty', () => {
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

should('stdoutColor keys off stdout alone, not the still-attached stderr tty', () => {
  // `bismar -d pkg v1 v2 | less` pipes the diff while stderr keeps the terminal
  // for progress lines: the text lands on stdout, so stdout decides.
  deepStrictEqual(stdoutColor({}, false), false);
  deepStrictEqual(stdoutColor({}, true), true);
  deepStrictEqual(stdoutColor({ NO_COLOR: '1' }, true), false);
  // Force flags win either way — this is how `| less -R` gets its color back.
  deepStrictEqual(stdoutColor({ FORCE_COLOR: '1' }, false), true);
  deepStrictEqual(stdoutColor({ CLICOLOR_FORCE: '1' }, false), true);
});

should('public path helpers walk nested export condition objects', () => {
  const value = {
    import: { default: './index.mjs' },
    require: './index.cjs',
    types: './index.d.ts',
  };
  deepStrictEqual(jsPath(value), './index.mjs');
  deepStrictEqual(dtsPath(value), './index.d.ts');
});

should('public declaration paths fall back from JS leaves', () => {
  deepStrictEqual(jsPath({ browser: './browser.js' }), './browser.js');
  deepStrictEqual(dtsPath({ node: './node.cjs' }), './node.d.ts');
  deepStrictEqual(dtsPath('./types.d.mts'), './types.d.mts');
});

should('exportPath walks export maps with caller-owned leaf policy', () => {
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

should('readPkg normalizes export maps and legacy package entries', () => {
  deepStrictEqual(readPkg(resolve('test/vectors/documented/package.json')), {
    exports: { '.': 'index.js' },
    name: '@bismar-test/documented',
    self: false,
    types: 'index.d.mts',
    version: '1.0.0',
  });
  deepStrictEqual(readPkg(resolve('test/vectors/jsr-src/package.json')).self, true);
});

should('publicEntries lists sorted public JS export entries with package specs', () => {
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

should('progress line appears after a silent second, updates in place, clears', async () => {
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
