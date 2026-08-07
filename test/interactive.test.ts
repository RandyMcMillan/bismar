// Tests for `bismar -i`: filesystem-style navigation of modules and exports,
// driven headlessly through the injectable io of runInteractive.
import assert, { deepStrictEqual } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test as should } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const { runInteractive } = await import('../src/interactive.ts');
const { highlightText } = await import('../src/vendor/speed-highlight/terminal.js');

const FIXTURE = resolve('test/vectors/plain');

// Strips colors and control sequences (clear, home, alternate screen).
const strip = (text: string): string => text.replace(/\x1b\[[\d?;]*[a-zA-Z]/g, '');

type Session = {
  done: Promise<void>;
  raw: () => string;
  send: (keys: string) => void;
  text: () => string;
};
const open = (
  selector: string | undefined,
  over: { cols?: number; cwd?: string } = {}
): Session => {
  const input = new PassThrough();
  let raw = '';
  const io = {
    cols: over.cols,
    input,
    output: {
      write: (text: string) => {
        raw += text;
        return true;
      },
    },
    rows: 16,
  };
  return {
    done: runInteractive(selector, { cwd: over.cwd ?? FIXTURE, io }),
    raw: () => raw,
    send: (keys: string) => void input.write(keys),
    text: () => strip(raw),
  };
};
const drive = async (selector: string | undefined, keys: string) => {
  const session = open(selector);
  session.send(keys);
  await session.done;
  return { frames: session.raw(), text: session.text() };
};
// Background auto-measure fills stats in on its own schedule; poll for them.
const waitFor = async (session: Session, re: RegExp): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (re.test(session.text())) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`timed out waiting for ${re}\n${session.text()}`);
};

should('interactive mode navigates modules and exports like a filesystem', async () => {
  const res = await drive(undefined, 'mj\rq');
  // Root frame: package crumb, the `.` package row, and the module row.
  deepStrictEqual(/@bismar-test\/plain/.test(res.text), true, res.text);
  deepStrictEqual(/▸ \./.test(res.text), true, res.text);
  deepStrictEqual(/index\.js/.test(res.text), true, res.text);
  // Opening index.js lists `..` first, then its exports, cursor on the first one.
  deepStrictEqual(/@bismar-test\/plain\/index\.js/.test(res.text), true, res.text);
  deepStrictEqual(/^ {2}\.\.$/m.test(res.text), true, res.text);
  deepStrictEqual(/▸ add/.test(res.text), true, res.text);
  deepStrictEqual(/\n {2}blob/.test(res.text), true, res.text);
  // The alternate screen is entered and restored, cursor re-shown.
  deepStrictEqual(res.frames.includes('\x1b[?1049h'), true);
  deepStrictEqual(res.frames.includes('\x1b[?25h\x1b[?1049l'), true);
});

should('interactive mode measures every row by itself, without s', async () => {
  const session = open(undefined);
  // Measurement starts in the background at launch, behind the files home
  // view; toggling to modules shows the rows already filled (or filling).
  session.send('m');
  await waitFor(session, /index\.js {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  // …and so do export rows after descending.
  session.send('j\r');
  await waitFor(session, /add {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  session.send('q');
  await session.done;
});

should('interactive mode navigates a filesystem selector as its own package', async () => {
  // `./` means the file: one module, its exports enumerated and measurable
  // through the same file-selector spelling, files view rooted at its dir.
  const session = open('./index.js');
  session.send('m');
  await waitFor(session, /index\.js {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  session.send('\r');
  await waitFor(session, /add {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  session.send('q');
  await session.done;
  const text = session.text();
  // The file is the package: its slug is the crumb, no `.` package row.
  deepStrictEqual(/index · files/.test(text), true, text);
  deepStrictEqual(/▸ \. /.test(text), false, text);
});

should('interactive mode forces the npm: prefix for bare names', async () => {
  // Bare unscoped names never imply npm; errors point at the prefixed spelling.
  const timed = <T>(done: Promise<T>) =>
    Promise.race([
      done,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('interactive session did not exit')), 30_000).unref();
      }),
    ]);
  await assert.rejects(
    () => timed(runInteractive('preact', { cwd: FIXTURE })),
    /interactive mode expects a package or file, not preact; use npm:preact for the registry package/
  );
  await assert.rejects(
    () => timed(runInteractive('./nope.js', { cwd: FIXTURE })),
    /missing input file: \.\/nope\.js/
  );
  const empty = mkdtempSync(join(tmpdir(), 'bismar-i-nopkg-'));
  try {
    await assert.rejects(
      () => timed(runInteractive('preact', { cwd: empty })),
      /package not found: preact.*use npm:preact for the registry package/
    );
  } finally {
    rmSync(empty, { force: true, recursive: true });
  }
});

should('interactive mode climbs back up via the .. entry and via h', async () => {
  // k moves from the first export onto `..`; enter on it returns to the root
  // with the module cursor preserved.
  const dots = await drive(undefined, 'mj\rk\rq');
  deepStrictEqual(/▸ index\.js/.test(dots.text), true, dots.text);
  const back = await drive(undefined, 'mj\rhq');
  deepStrictEqual(/▸ index\.js/.test(back.text), true, back.text);
});

should('interactive mode pages through bundled source on enter', async () => {
  const res = await drive(undefined, 'mj\r\rqq');
  // The pager header names the selector; the body is the plain bundle.
  deepStrictEqual(/index\/add · \d+ lines/.test(res.text), true, res.text);
  deepStrictEqual(/var bismarTestPlainIndexAdd = /.test(res.text), true, res.text);
  deepStrictEqual(
    /% · ↑↓\/space scroll · \/search · :goto · q back/.test(res.text),
    true,
    res.text
  );
});

should('interactive mode syntax-highlights paged source when colors are on', async () => {
  process.env.FORCE_COLOR = '1';
  try {
    const res = await drive(undefined, 'mj\r\rqq');
    // Highlight tokens: the `var` keyword painted magenta by the terminal theme.
    deepStrictEqual(res.frames.includes('\x1b[31mvar\x1b[0m'), true);
    // Stripped content stays byte-identical to the plain bundle text.
    deepStrictEqual(/var bismarTestPlainIndexAdd = /.test(res.text), true, res.text);
  } finally {
    delete process.env.FORCE_COLOR;
  }
});

should('vendored highlighter supports Ruby, Rust, Go, PHP, and HTML', async () => {
  const cases = [
    ['rb', 'def greet(name)', 'def'],
    ['rs', 'fn greet(name: &str)', 'fn'],
    ['go', 'func greet(name string)', 'func'],
    ['php', '<?php function greet(string $name)', 'function'],
    ['html', '<main>Hello</main>', 'main'],
  ] as const;
  for (const [lang, source, keyword] of cases) {
    const highlighted = await highlightText(source, lang);
    deepStrictEqual(
      highlighted.includes(`\x1b[31m${keyword}\x1b[0m`),
      true,
      `${lang} was not highlighted: ${JSON.stringify(highlighted)}`
    );
  }
});

should('interactive mode starts in the package-files view with text previews', async () => {
  const res = await drive(undefined, '\rqmq');
  // The home view lists the shipped files with sizes: dirs first, then meta
  // files (changelogs, licenses, readmes, manifests), then the rest; the
  // header carries the package's total footprint.
  deepStrictEqual(
    /@bismar-test\/plain · files · \d+ files, [\d.]+kb/.test(res.text),
    true,
    res.text
  );
  deepStrictEqual(/▸ package\.json {2}[\d.]+kb/.test(res.text), true, res.text);
  deepStrictEqual(/package\.json {2}[\d.]+kb\r?\n {2}_priv\.js/.test(res.text), true, res.text);
  deepStrictEqual(/enter preview · ← up · m modules/.test(res.text), true, res.text);
  // Enter previews the file's own text — no bundling, no global wrapper.
  deepStrictEqual(/package\.json · \d+ lines/.test(res.text), true, res.text);
  deepStrictEqual(/"name": "@bismar-test\/plain"/.test(res.text), true, res.text);
  deepStrictEqual(/var bismarTestPlain/.test(res.text), false, res.text);
  // The trailing m switches to the module view before quitting.
  deepStrictEqual(/▸ \./.test(res.text), true, res.text);
});

should('files view stays put on back at its root instead of leaving', async () => {
  // h (and ← / backspace) climbs directories only; at the files root it is a
  // no-op — the modules view is behind m, and esc exits.
  const res = await drive(undefined, 'hq');
  const last = strip(res.frames.split('\x1b[H').pop() ?? '');
  deepStrictEqual(/@bismar-test\/plain · files/.test(last), true, last);
  // Esc from the files root exits the app: files is the home view.
  const esc = await drive(undefined, '\x1b');
  const escLast = strip(esc.frames.split('\x1b[H').pop() ?? '');
  deepStrictEqual(/@bismar-test\/plain · files/.test(escLast), true, escLast);
  deepStrictEqual(esc.frames.includes('\x1b[?25h\x1b[?1049l'), true);
});

should('mouse clicks and wheel drive the listings; the pager releases tracking', async () => {
  // Wheel down moves the selection like j; clicks on the blank header row and
  // past the listing miss without crashing. j/hjkl were never pressed here, so
  // the second row can only be reached by the wheel.
  const wheel = await drive(undefined, '\x1b[<65;9;9M\x1b[<0;1;2M\x1b[<0;1;15M' + 'q');
  deepStrictEqual(/▸ _priv\.js/.test(wheel.text), true, wheel.text);
  deepStrictEqual(/ · \d+ lines/.test(wheel.text), false, wheel.text);
  // Entries draw from screen row 3: a click on row 5 selects index.js, a second
  // click opens its preview (releases in between are consumed silently), and a
  // report queued while the pager is up decodes to nothing.
  const click = await drive(
    undefined,
    '\x1b[<0;4;5M\x1b[<0;4;5m\x1b[<0;4;5M\x1b[<0;4;5m\x1b[<0;4;5M' + 'qq'
  );
  deepStrictEqual(/▸ index\.js/.test(click.text), true, click.text);
  deepStrictEqual(/index\.js · \d+ lines/.test(click.text), true, click.text);
  // The session takes the mouse with the alternate screen, hands it back while
  // the pager is up (native text selection), retakes it after, and always
  // releases it on the way out.
  deepStrictEqual(click.frames.includes('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h'), true);
  deepStrictEqual(
    click.frames.split('\x1b[?1000h\x1b[?1006h').length,
    3,
    click.frames.slice(0, 80)
  );
  deepStrictEqual(click.frames.includes('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'), true);
  // The modules view speaks the same click contract: select, then descend.
  const mods = await drive(undefined, 'm\x1b[<0;2;4M\x1b[<0;2;4M' + 'q');
  deepStrictEqual(/@bismar-test\/plain\/index\.js/.test(mods.text), true, mods.text);
  deepStrictEqual(/▸ add/.test(mods.text), true, mods.text);
});

should('interactive file preview sanitizes tabs and CRLF line endings', async () => {
  // Tab-indented CRLF files (typescript vendors vscode-jsonrpc like this) must
  // not render wider than the width math counts — that scrolls the terminal
  // and stacks rows onto each other.
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-i-vendor-'));
  try {
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify({
        main: './index.js',
        name: '@bismar-test/vendor',
        private: true,
        type: 'module',
        version: '1.0.0',
      })}\n`
    );
    writeFileSync(join(cwd, 'index.js'), 'export const a = 1;\n');
    writeFileSync(join(cwd, 'vendor.json'), '{\r\n\t"name": "x"\r\n}\r\n');
    const session = open(undefined, { cwd });
    session.send('G\rqq');
    await session.done;
    const text = session.text();
    deepStrictEqual(/vendor\.json · 4 lines/.test(text), true, text);
    // Tabs render as two spaces; the \r of each CRLF is gone from the output.
    deepStrictEqual(/^ {2}"name": "x"$/m.test(text), true, text);
    deepStrictEqual(session.raw().includes('\t'), false);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

should('interactive pager searches with /pattern and jumps with :line', async () => {
  const res = await drive(undefined, 'mj\r\r/defProp\r:1\rqq');
  const frames = res.frames.split('\x1b[H').map((frame) => strip(frame).split('\r\n'));
  // `/defProp` scrolls the window to the matching line…
  const hit = frames.findIndex((rows) => (rows[1] ?? '').includes('var __defProp'));
  deepStrictEqual(hit >= 0, true, res.text);
  // …and `:1` returns to the first line afterwards.
  const back = frames.findIndex(
    (rows, i) => i > hit && (rows[1] ?? '').startsWith('var bismarTestPlainIndexAdd')
  );
  deepStrictEqual(back > hit, true, res.text);
  // The prompt buffers visibly on the footer row while typing.
  deepStrictEqual(res.text.includes('/defProp'), true, res.text);
});

should('interactive pager wraps long lines to the width instead of truncating', async () => {
  // A 20-column terminal: the bundle's `var bismarTestPlainIndexAdd…` line must
  // continue on following rows, not vanish behind an ellipsis.
  const session = open(undefined, { cols: 20 });
  session.send('mj\r\rqq');
  await session.done;
  const text = session.text();
  deepStrictEqual(text.replace(/\r?\n/g, '').includes('var bismarTestPlainIndexAdd'), true, text);
  // Every rendered row fits the width; list rows still truncate via the ellipsis.
  // Frames split on their home sequence — stripping first would glue a frame's
  // footer to the next frame's crumb and fake an overlong row.
  const wide = session
    .raw()
    .split('\x1b[H')
    .flatMap((frame) => strip(frame).split(/\r?\n/))
    .filter((line) => line.length > 19);
  deepStrictEqual(wide, [], text);
});

should('interactive mode handles PgUp/PgDn/Home/End escape sequences', async () => {
  // PgUp at the root must not quit (old parsing let unknown \x1b[5~-style
  // sequences fall through to bare Esc); End then jumps to the last export.
  const res = await drive(undefined, 'm\x1b[5~j\r\x1b[Fq');
  deepStrictEqual(/@bismar-test\/plain\/index\.js/.test(res.text), true, res.text);
  deepStrictEqual(/▸ blob/.test(res.text), true, res.text);
  // In the pager, PgDn scrolls a window: the footer leaves 0%.
  const paged = await drive(undefined, 'mj\r\r\x1b[6~qq');
  deepStrictEqual(/\n(?:[1-9]\d?|100)% · ↑↓\/space scroll/.test(paged.text), true, paged.text);
});

should('esc backs out one level then exits; ctrl-c/ctrl-d exit anywhere', async () => {
  // A broken exit path would hang the session forever; fail loudly instead.
  const timed = (done: Promise<void>) =>
    Promise.race([
      done,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('interactive session did not exit')), 30_000).unref();
      }),
    ]);
  // esc: exports → root → gone; the final frame is the root view.
  const esc = open(undefined);
  esc.send('mj\r\x1b\x1b');
  await timed(esc.done);
  const last = strip(esc.raw().split('\x1b[H').pop() ?? '');
  deepStrictEqual(/@bismar-test\/plain\r?\n/.test(last), true, last);
  deepStrictEqual(/▸ index\.js/.test(last), true, last);
  // ctrl-c closes the whole app even from inside the pager (q there only backs out)…
  const intr = open(undefined);
  intr.send('mj\r\r\x03');
  await timed(intr.done);
  const pagerLast = strip(intr.raw().split('\x1b[H').pop() ?? '');
  deepStrictEqual(/% · ↑↓\/space scroll/.test(pagerLast), true, pagerLast);
  // …and ctrl-d does too.
  const eof = open(undefined);
  eof.send('\x04');
  await timed(eof.done);
});
