// Tests for `bismar -i`: filesystem-style navigation of modules and exports,
// driven headlessly through the injectable io of runInteractive.
import assert, { deepStrictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { test as it } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';
// Politeness waits only add latency against the local search stand-in here.
process.env.BISMAR_RPS = '0';

const { chooseTarget, runInteractive, runPager } = await import('../src/interactive.ts');
const { refsCacheDir, refsMetaFile, refsTagFile, writeCacheIdentity, writeVersionTag } =
  await import('../src/refs.ts');
const { highlightDiffText, highlightText } = await import(
  '../src/vendor/speed-highlight/terminal.js'
);
const { languageFromFilename } = await import('../src/vendor/speed-highlight/detect.js');

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
  over: { cols?: number; cwd?: string; menu?: boolean } = {}
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
    done: runInteractive(selector, { cwd: over.cwd ?? FIXTURE, io, menu: over.menu }),
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
const waitFor = async (session: Pick<Session, 'text'>, re: RegExp): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (re.test(session.text())) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`timed out waiting for ${re}\n${session.text()}`);
};

// Headless chooseTarget harness: drives the launcher menu alone; `state` is
// the parked stage a reopened launcher resumes from.
const openMenu = (dirLabel: string, state: Record<string, unknown> = {}) => {
  const input = new PassThrough();
  let raw = '';
  const io = {
    cols: 80,
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
    done: chooseTarget(dirLabel, io, state),
    send: (keys: string) => void input.write(keys),
    raw: () => raw,
    text: () => strip(raw),
  };
};

const openPager = (text: string, ansi = false): Session => {
  const input = new PassThrough();
  let raw = '';
  const io = {
    cols: 240,
    input,
    output: {
      write: (chunk: string) => {
        raw += chunk;
        return true;
      },
    },
    rows: 16,
  };
  return {
    done: runPager('source', text, { ansi, io }),
    raw: () => raw,
    send: (keys: string) => void input.write(keys),
    text: () => strip(raw),
  };
};

it('launcher menu offers the current dir and the seven registry searches', async () => {
  // Bare `bismar` (menu: true) asks first; enter on the first option browses
  // the current package, and the session follows in the same terminal.
  const session = open(undefined, { menu: true });
  session.send('\rq');
  await session.done;
  const text = session.text();
  deepStrictEqual(/bismar · what to open\?/.test(text), true, text);
  deepStrictEqual(/▸ browse current directory \(plain\)/.test(text), true, text);
  for (const label of [
    'JS/NPM',
    'JS/JSR',
    'Rust/Cargo',
    'Ruby/Gems',
    'Python/PyPi',
    'GitHub',
    'GitLab',
  ])
    deepStrictEqual(text.includes(`search ${label}`), true, `${label}\n${text}`);
  deepStrictEqual(/↑↓ move · enter select · q quit/.test(text), true, text);
  deepStrictEqual(/@bismar-test\/plain · files/.test(text), true, text);
});

it('launcher opens pinned and exact-name queries without searching', async () => {
  // Option order: dir, npm, jsr, crate, gem, pypi, gh, gitlab. A @version pin skips
  // search — search apis know nothing about versions — and type-ahead past the
  // submit is handed to the session that follows.
  const gem = openMenu('x');
  gem.send('jjjj\rrailties@7.1.0\rq');
  deepStrictEqual(await gem.done, { leftover: ['q'], selector: 'gem:railties@7.1.0' });
  deepStrictEqual(/name: railties@7\.1\.0/.test(gem.text()), true, gem.text());
  deepStrictEqual(/e\.g\. railties/.test(gem.text()), true, gem.text());
  const gh = openMenu('x');
  gh.send('jjjjjj\rpaulmillr/qr@main\r');
  deepStrictEqual((await gh.done)?.selector, 'gh:paulmillr/qr@main');
  // G jumps to the last option, now gitlab; a pinned ref opens directly too.
  const gitlab = openMenu('x');
  gitlab.send('G\rgroup/proj@main\r');
  deepStrictEqual((await gitlab.done)?.selector, 'gitlab:group/proj@main');
  // pypi has no search api: enter opens the exact name, and the prompt says so.
  const pypi = openMenu('x');
  pypi.send('jjjjj\rrequests\r');
  deepStrictEqual((await pypi.done)?.selector, 'pypi:requests');
  deepStrictEqual(
    /search Python\/PyPi · exact package name, no search api/.test(pypi.text()),
    true,
    pypi.text()
  );
  deepStrictEqual(/enter open · esc back/.test(pypi.text()), true, pypi.text());
  // A typed canonical prefix stays single instead of doubling up.
  const typed = openMenu('x');
  typed.send('jjjjj\rpypi:requests\r');
  deepStrictEqual((await typed.done)?.selector, 'pypi:requests');
  // Backspace edits the buffer; esc backs out to the menu; q then quits (the
  // caller opens nothing) — and q inside the prompt is just a character.
  const editing = openMenu('x');
  editing.send('jjj\rsqq\x7f\x7fserde\x1bq');
  deepStrictEqual(await editing.done, undefined);
  deepStrictEqual(/name: sq/.test(editing.text()), true, editing.text());
  // ← backs out of the prompt to the menu like esc; backspace keeps editing.
  const arrow = openMenu('x');
  arrow.send('j\rab\x1b[Dq');
  deepStrictEqual(await arrow.done, undefined);
  deepStrictEqual(/name: ab/.test(arrow.text()), true, arrow.text());
  // The menu drew again after the ← (its footer follows the prompt frames).
  const frames = arrow.text();
  deepStrictEqual(frames.lastIndexOf('what to open?') > frames.indexOf('name: ab'), true, frames);
});

it('launcher searches a registry and opens the picked hit', async () => {
  // Local registry stand-ins: search is one request per submitted query.
  const routes: Record<string, string> = {
    '/api/v1/crates?q=serde&per_page=10': JSON.stringify({
      crates: [
        { description: 'A serialization framework', max_stable_version: '1.0.219', name: 'serde' },
        { description: null, max_version: '1.0.140', name: 'serde_json' },
      ],
    }),
    '/api/v1/crates?q=nothing&per_page=10': JSON.stringify({ crates: [] }),
  };
  const server = createServer((req, res) => {
    // The tarball answers HEAD with its packed size, jsr-CDN-style.
    if (req.url === '/preact.tgz') {
      res.setHeader('content-length', '407547');
      return void res.end();
    }
    const body = routes[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      return void res.end('{}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The version is deliberately unpublishable: garnish caches machine-wide per
  // pkg@version, and a real one must never be seeded with stand-in numbers.
  routes['/-/v1/search?text=preact&size=10'] = JSON.stringify({
    objects: [{ package: { description: 'Fast vdom', name: 'preact', version: '0.0.0-bismarui' } }],
  });
  routes['/preact/0.0.0-bismarui'] = JSON.stringify({
    dependencies: { a: '1', b: '2' },
    dist: { tarball: `${base}/preact.tgz` },
  });
  process.env.BISMAR_CRATES_API = base;
  process.env.BISMAR_NPM_API = base;
  try {
    // Submit a query, get the hits listing, pick the second one.
    const session = openMenu('x');
    session.send('jjj\rserde\r');
    await waitFor(session, /2 matches/);
    session.send('j\r');
    deepStrictEqual((await session.done)?.selector, 'crate:serde_json');
    const text = session.text();
    deepStrictEqual(/searching Rust\/Cargo for serde…/.test(text), true, text);
    deepStrictEqual(/serde {2}1\.0\.219 · A serialization framework/.test(text), true, text);
    deepStrictEqual(/▸ serde_json {2}1\.0\.140/.test(text), true, text);
    deepStrictEqual(/↑↓ move · enter open · esc back/.test(text), true, text);
    // JS hits garnish in the background: packed tarball bytes and dep count
    // land after the version once the metadata answers (npm rows carry no
    // description on purpose).
    const js = openMenu('x');
    js.send('j\rpreact\r');
    await waitFor(js, /preact {2}0\.0\.0-bismarui · 2 deps · 398kb tgz(?! ·)/);
    js.send('\r');
    deepStrictEqual((await js.done)?.selector, 'npm:preact');
    // No matches keeps the prompt open with a note instead of a dead end.
    const empty = openMenu('x');
    empty.send('jjj\rnothing\r');
    await waitFor(empty, /no matches for nothing/);
    empty.send('\x1bq');
    deepStrictEqual(await empty.done, undefined);
    // The launcher parks its stage: reopened (as ← from a session does), it
    // resumes on the same hits listing with the same cursor.
    const state: Record<string, unknown> = {};
    const first = openMenu('x', state);
    first.send('jjj\rserde\r');
    await waitFor(first, /2 matches/);
    first.send('j\r');
    deepStrictEqual((await first.done)?.selector, 'crate:serde_json');
    const again = openMenu('x', state);
    await waitFor(again, /2 matches/);
    again.send('k\r');
    deepStrictEqual((await again.done)?.selector, 'crate:serde');
  } finally {
    delete process.env.BISMAR_CRATES_API;
    delete process.env.BISMAR_NPM_API;
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }
});

it('launcher hit listings window and page like every other listing', async () => {
  // 30 hits on a 16-row screen: the listing scrolls behind the cursor instead
  // of overflowing the frame, and PgDn jumps a window like the other views.
  const hits = Array.from({ length: 30 }, (_, i) => ({
    desc: '',
    name: `pkg-${String(i).padStart(2, '0')}`,
    version: '',
  }));
  const state: Record<string, unknown> = {
    results: { cursor: 0, hits, which: { example: 'x', label: 'JS/NPM', prefix: 'npm:' } },
  };
  const menu = openMenu('x', state);
  await waitFor(menu, /pkg-00/);
  deepStrictEqual(/pkg-29/.test(menu.text()), false, menu.text());
  menu.send('\x1b[6~');
  await waitFor(menu, /▸ pkg-12/);
  menu.send('G');
  await waitFor(menu, /▸ pkg-29/);
  // q ≡ esc: the first backs out of the hits (to the menu here — this
  // parked listing has no prompt), the second quits from the menu root.
  menu.send('qq');
  deepStrictEqual(await menu.done, undefined);
});

it('launcher renders hostile registry metadata as inert visible text', async () => {
  const state: Record<string, unknown> = {
    results: {
      cursor: 0,
      hits: [
        {
          desc: 'd\x1b]52;c;eA==\x07\u009b2J',
          name: 'pkg\x1b[31mred\nrow',
          version: '1\x1b[2J',
        },
      ],
      root: true,
      title: 'gh:@x\x1b]8;;https://evil.example\x07',
      which: { example: 'x', label: 'GitHub', prefix: 'gh:' },
    },
  };
  const menu = openMenu('x', state);
  await waitFor(menu, /pkg\u241b\[31mred\u240arow/);
  menu.send('\x1b');
  await menu.done;
  const raw = menu.raw();
  deepStrictEqual(raw.includes('\x1b[31mred'), false, raw);
  deepStrictEqual(raw.includes('\x1b[2J'), false, raw);
  deepStrictEqual(raw.includes('\x1b]8'), false, raw);
  deepStrictEqual(raw.includes('\x1b]52'), false, raw);
  deepStrictEqual(raw.includes('\u009b'), false, raw);
  deepStrictEqual(menu.text().includes('d\u241b]52;c;eA==\u2407\\u009b2J'), true, menu.text());
});

it('search hits paint a zero dep count green, others dim', async () => {
  // A clean, dependency-free install is worth flagging: 0 deps shows green,
  // any other count stays dim like the rest of the garnish.
  process.env.FORCE_COLOR = '1';
  const routes: Record<string, string> = {
    '/-/v1/search?text=x&size=10': JSON.stringify({
      objects: [
        { package: { name: 'clean-pkg', version: '0.0.0-bismarzero' } },
        { package: { name: 'heavy-pkg', version: '0.0.0-bismartwo' } },
      ],
    }),
    '/clean-pkg/0.0.0-bismarzero': JSON.stringify({ dependencies: {} }),
    '/heavy-pkg/0.0.0-bismartwo': JSON.stringify({ dependencies: { a: '1', b: '2' } }),
  };
  const server = createServer((req, res) => {
    const body = routes[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      return void res.end('{}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  process.env.BISMAR_NPM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const menu = openMenu('x');
    menu.send('j\rx\r');
    // Wait for both dep counts to land in the stripped text.
    await waitFor(menu, /clean-pkg[\s\S]*0 deps[\s\S]*heavy-pkg[\s\S]*2 deps/);
    menu.send('\x1b\x1bq');
    await menu.done;
    const frames = menu.raw();
    // Green wraps exactly "0 deps"; the "2 deps" row is never green.
    deepStrictEqual(frames.includes(`\x1b[32m0 deps\x1b[0m`), true, strip(frames));
    deepStrictEqual(/\x1b\[32m2 deps/.test(frames), false, strip(frames));
  } finally {
    delete process.env.FORCE_COLOR;
    delete process.env.BISMAR_NPM_API;
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }
});

it('← from a session root climbs back into the launcher', async () => {
  // Menu-launched sessions treat ← at their root as one more level up: the
  // launcher reopens (parked stage intact) instead of the key dying there.
  const session = open(undefined, { menu: true });
  session.send('\rhq');
  await session.done;
  const frames = session
    .raw()
    .split('\x1b[H')
    .map((frame) => strip(frame));
  const menus = frames.filter((frame) => /what to open\?/.test(frame));
  deepStrictEqual(menus.length >= 2, true, session.text());
  // The session frame sat between the two menu frames.
  deepStrictEqual(/@bismar-test\/plain · files/.test(session.text()), true, session.text());
});

it('launcher browses a package-less directory as plain files', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-i-dir-'));
  try {
    writeFileSync(join(cwd, 'notes.txt'), 'hello\n');
    const session = open(undefined, { cwd, menu: true });
    session.send('\rq');
    await session.done;
    const text = session.text();
    // Files-only session rooted at the directory: footprint in the header, no
    // modules view on offer.
    deepStrictEqual(/bismar-i-dir-[^ ]* · files · 1 file, [\d.]+kb/.test(text), true, text);
    deepStrictEqual(/notes\.txt/.test(text), true, text);
    deepStrictEqual(/m mode/.test(text), false, text);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

it('interactive mode navigates modules and exports like a filesystem', async () => {
  const res = await drive(undefined, 'mj\rqq');
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

it('interactive mode measures every row by itself, without s', async () => {
  const session = open(undefined);
  // Measurement starts in the background at launch, behind the files home
  // view; toggling to modules shows the rows already filled (or filling).
  session.send('m');
  await waitFor(session, /index\.js {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  // …and so do export rows after descending.
  session.send('j\r');
  await waitFor(session, /add {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  session.send('qq');
  await session.done;
});

it('interactive mode navigates a filesystem selector as its own package', async () => {
  // `./` means the file: one module, its exports enumerated and measurable
  // through the same file-selector spelling, files view rooted at its dir.
  const session = open('./index.js');
  session.send('m');
  await waitFor(session, /index\.js {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  session.send('\r');
  await waitFor(session, /add {2}\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/);
  session.send('qq');
  await session.done;
  const text = session.text();
  // The file is the package: its slug is the crumb, no `.` package row.
  deepStrictEqual(/index · files/.test(text), true, text);
  deepStrictEqual(/▸ \. /.test(text), false, text);
});

it('interactive mode forces the npm: prefix for bare names', async () => {
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

it('interactive modules view measures unscoped npm refs', async () => {
  // The pinned label of an unscoped ref (`qr@0.6.0`) is not an npm selector by
  // itself — rows must measure through the prefixed spelling (`npm:qr@0.6.0`),
  // or every row of such a package shows (build failed).
  const session = open('npm:qr');
  session.send('m');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (/\d+ LOC, [\d.]+kb min|\(build failed\)/.test(session.text())) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  session.send('q');
  await session.done;
  deepStrictEqual(/\(build failed\)/.test(session.text()), false, session.text());
  deepStrictEqual(
    /\d+ LOC, [\d.]+kb min, [\d.]+kb gzip/.test(session.text()),
    true,
    session.text()
  );
});

it('interactive mode climbs back up via the .. entry and via h', async () => {
  // k moves from the first export onto `..`; enter on it returns to the root
  // with the module cursor preserved.
  const dots = await drive(undefined, 'mj\rk\rq');
  deepStrictEqual(/▸ index\.js/.test(dots.text), true, dots.text);
  const back = await drive(undefined, 'mj\rhq');
  deepStrictEqual(/▸ index\.js/.test(back.text), true, back.text);
});

it('interactive mode pages through bundled source on enter', async () => {
  const res = await drive(undefined, 'mj\r\rqqq');
  // The pager header names the selector; the body is the plain bundle.
  deepStrictEqual(/index\/add · \d+ lines/.test(res.text), true, res.text);
  deepStrictEqual(/var bismarTestPlainIndexAdd = /.test(res.text), true, res.text);
  deepStrictEqual(
    /% · ↑↓\/space scroll · \/search · :goto · q back/.test(res.text),
    true,
    res.text
  );
});

it('interactive mode syntax-highlights paged source when colors are on', async () => {
  process.env.FORCE_COLOR = '1';
  try {
    const res = await drive(undefined, 'mj\r\rqqq');
    // Highlight tokens: the `var` keyword painted magenta by the terminal theme.
    deepStrictEqual(res.frames.includes('\x1b[31mvar\x1b[0m'), true);
    // Stripped content stays byte-identical to the plain bundle text.
    deepStrictEqual(/var bismarTestPlainIndexAdd = /.test(res.text), true, res.text);
  } finally {
    delete process.env.FORCE_COLOR;
  }
});

it('vendored highlighter supports Python, Ruby, Rust, Go, PHP, HTML, C, and Bash', async () => {
  const cases = [
    ['py', 'def greet(name):', 'def'],
    ['rb', 'def greet(name)', 'def'],
    ['rs', 'fn greet(name: &str)', 'fn'],
    ['go', 'func greet(name string)', 'func'],
    ['php', '<?php function greet(string $name)', 'function'],
    ['html', '<main>Hello</main>', 'main'],
    ['c', 'int main(void) { return 0; }', 'int'],
    ['bash', 'if test -f file; then echo yes; fi', 'if'],
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

it('vendored diff highlighting keeps multiline language colors row-local', async () => {
  const source = [
    '@@ -1,3 +1,3 @@',
    '-/* old',
    '- * value */',
    '+/* new',
    '+ * value */',
    ' const answer = 42;',
  ].join('\n');
  const highlighted = await highlightDiffText(source, 'js');
  deepStrictEqual(highlighted.replace(/\x1b\[[\d;]+m/g, ''), source);
  // Each body line restarts gray after its independently colored diff marker;
  // no multiline comment color is left to bleed into the next rendered row.
  assert.match(highlighted, /\x1b\[31m-\x1b\[0m\x1b\[90m\/\* old\x1b\[0m/);
  assert.match(highlighted, /\x1b\[32m\+\x1b\[0m\x1b\[90m \* value \*\/\x1b\[0m/);
});

it('vendored highlighting never echoes terminal commands from source or diffs', async () => {
  const payload =
    'const x = "\x1b[2J"; // \x1b]8;;https://evil.example\x07link\x1b]8;;\x07 ' +
    '\x1b]52;c;Y2xpcGJvYXJk\x1b\\ \x1bX \u009b2J \x01\n';
  for (const highlighted of [
    await highlightText(payload, 'js'),
    await highlightDiffText(`@@ -1,1 +1,1 @@\n-${payload.trimEnd()}\n+safe`, 'js'),
  ]) {
    deepStrictEqual(highlighted.includes('\x1b[2J'), false, highlighted);
    deepStrictEqual(highlighted.includes('\x1b]8'), false, highlighted);
    deepStrictEqual(highlighted.includes('\x1b]52'), false, highlighted);
    deepStrictEqual(highlighted.includes('\x1bX'), false, highlighted);
    deepStrictEqual(highlighted.includes('\u009b'), false, highlighted);
    // Controls remain inspectable instead of silently disappearing.
    deepStrictEqual(highlighted.includes('\u241b[2J'), true, highlighted);
    deepStrictEqual(highlighted.includes('\\u009b2J'), true, highlighted);
    deepStrictEqual(highlighted.includes('\u2401'), true, highlighted);
  }
});

it('standalone pager distinguishes raw text from trusted highlighted ANSI', async () => {
  const raw = openPager('before\x1b[31mred\x1b[0m\x1b[2Jafter');
  raw.send('q');
  await raw.done;
  deepStrictEqual(raw.raw().includes('\x1b[31mred'), false, raw.raw());
  deepStrictEqual(raw.raw().includes('\x1b[2J'), false, raw.raw());
  deepStrictEqual(
    raw.text().includes('before\u241b[31mred\u241b[0m\u241b[2Jafter'),
    true,
    raw.text()
  );

  const highlighted = openPager('\x1b[31mvar\x1b[0m x = 1;', true);
  highlighted.send('q');
  await highlighted.done;
  deepStrictEqual(highlighted.raw().includes('\x1b[31mvar\x1b[0m'), true, highlighted.raw());
});

it('vendored filename detection covers source extensions and conventional names', () => {
  deepStrictEqual(languageFromFilename('src/component.tsx'), 'ts');
  deepStrictEqual(languageFromFilename('native/main.cpp'), 'c');
  deepStrictEqual(languageFromFilename('Dockerfile'), 'docker');
  deepStrictEqual(languageFromFilename('Rakefile'), 'rb');
  deepStrictEqual(languageFromFilename('notes.txt'), undefined);
});

it('vendored Markdown highlighter highlights common fenced-code language names', async () => {
  for (const [lang, source, keyword] of [
    ['cpp', 'int main() { return 0; }', 'int'],
    ['sh', 'if test -f file; then echo yes; fi', 'if'],
    ['javascript', 'const answer = 42;', 'const'],
    ['typescript', 'interface Answer { value: number }', 'interface'],
    ['python', 'def answer(): return 42', 'def'],
    ['ruby', 'def answer; 42; end', 'def'],
    ['rust', 'fn answer() -> i32 { 42 }', 'fn'],
    ['golang', 'func answer() int { return 42 }', 'func'],
  ] as const) {
    const highlighted = await highlightText(`\`\`\`${lang}\n${source}\n\`\`\``, 'md');
    deepStrictEqual(
      highlighted.includes(`\x1b[31m${keyword}\x1b[0m`),
      true,
      `${lang} fence was not highlighted: ${JSON.stringify(highlighted)}`
    );
  }
});

it('vendored Markdown highlighter paints ATX headings as sections', async () => {
  const highlighted = await highlightText('intro\n### heading\nbody', 'md');
  deepStrictEqual(highlighted.includes('\x1b[35m### heading\x1b[0m'), true, highlighted);
  deepStrictEqual(highlighted.includes('\x1b[35mbody\x1b[0m'), false, highlighted);
});

it('interactive mode syntax-highlights Python, Rakefile, C, C++, and shell previews', async () => {
  process.env.FORCE_COLOR = '1';
  try {
    for (const [name, source, keyword] of [
      ['greet.py', 'def greet(name):\n    return f"Hello, {name}"\n', 'def'],
      ['Rakefile', 'def build\n  puts "building"\nend\n', 'def'],
      ['greet.c', 'int greet(void) { return 1; }\n', 'int'],
      ['greet.cpp', 'int greet() { return 1; }\n', 'int'],
      ['greet.sh', 'if test -n "$USER"; then echo hello; fi\n', 'if'],
    ] as const) {
      const cwd = mkdtempSync(join(tmpdir(), 'bismar-i-highlight-'));
      try {
        writeFileSync(join(cwd, name), source);
        const session = open(undefined, { cwd, menu: true });
        session.send('\r\rqq');
        await session.done;
        deepStrictEqual(session.raw().includes(`\x1b[31m${keyword}\x1b[0m`), true, session.raw());
        deepStrictEqual(session.text().includes(source.split('\n')[0]), true, session.text());
      } finally {
        rmSync(cwd, { force: true, recursive: true });
      }
    }
  } finally {
    delete process.env.FORCE_COLOR;
  }
});

it('interactive mode starts in the package-files view with text previews', async () => {
  const res = await drive(undefined, '\rhmq');
  // The home view lists the shipped files with sizes: dirs first, then the
  // readme and package.json, then the rest; the header carries the package's
  // total footprint.
  deepStrictEqual(
    /@bismar-test\/plain · files · \d+ files, [\d.]+kb/.test(res.text),
    true,
    res.text
  );
  deepStrictEqual(/▸ package\.json {2}[\d.]+kb/.test(res.text), true, res.text);
  deepStrictEqual(/package\.json {2}[\d.]+kb\r?\n {2}_priv\.js/.test(res.text), true, res.text);
  deepStrictEqual(/enter preview · ← up · m mode \(bundles\)/.test(res.text), true, res.text);
  // Enter previews the file's own text — no bundling, no global wrapper.
  deepStrictEqual(/package\.json · \d+ lines/.test(res.text), true, res.text);
  deepStrictEqual(/"name": "@bismar-test\/plain"/.test(res.text), true, res.text);
  deepStrictEqual(/var bismarTestPlain/.test(res.text), false, res.text);
  // The trailing m switches to the module view before quitting.
  deepStrictEqual(/▸ \./.test(res.text), true, res.text);
});

it('files view stays put on back at its root instead of leaving', async () => {
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

it('mouse clicks and wheel drive the listings; the pager releases tracking', async () => {
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
    '\x1b[<0;4;5M\x1b[<0;4;5m\x1b[<0;4;5M\x1b[<0;4;5m\x1b[<0;4;5M' + 'hq'
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
  const mods = await drive(undefined, 'm\x1b[<0;2;4M\x1b[<0;2;4M' + 'qq');
  deepStrictEqual(/@bismar-test\/plain\/index\.js/.test(mods.text), true, mods.text);
  deepStrictEqual(/▸ add/.test(mods.text), true, mods.text);
});

it('files view skips symlinked entries instead of following them', async (t) => {
  // Local trees and legacy caches can contain symlinks aimed anywhere
  // (~/.ssh); the files view must never list — let alone preview or descend
  // into — anything a symlink points at.
  if (process.platform === 'win32') return void t.skip('posix symlinks');
  const outside = mkdtempSync(join(tmpdir(), 'bismar-i-outside-'));
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-i-syml-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'sesame\n');
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify({
        main: './index.js',
        name: '@bismar-test/syml',
        private: true,
        type: 'module',
        version: '1.0.0',
      })}\n`
    );
    writeFileSync(join(cwd, 'index.js'), 'export const a = 1;\n');
    symlinkSync(join(outside, 'secret.txt'), join(cwd, 'leak.txt'));
    symlinkSync(outside, join(cwd, 'leakdir'));
    const session = open(undefined, { cwd });
    session.send('q');
    await session.done;
    const text = session.text();
    deepStrictEqual(/index\.js/.test(text), true, text);
    // Neither the symlinked file nor the symlinked dir shows up at all —
    // and the footprint walk (already lstat-based) agrees: 2 real files.
    deepStrictEqual(/leak/.test(text), false, text);
    deepStrictEqual(/ · files · 2 files, /.test(text), true, text);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

it('interactive file preview sanitizes tabs and CRLF line endings', async () => {
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

it('interactive filenames and preview bytes cannot inject terminal commands', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-i-controls-'));
  // Windows forbids control bytes in filenames; source payload coverage still
  // runs there, while POSIX also exercises a newline + SGR-looking filename.
  const hostileName = process.platform === 'win32' ? 'evil.txt' : 'evil\n\x1b[31mname.txt';
  try {
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify({
        main: './index.js',
        name: '@bismar-test/controls',
        private: true,
        type: 'module',
        version: '1.0.0',
      })}\n`
    );
    writeFileSync(join(cwd, 'index.js'), 'export const a = 1;\n');
    writeFileSync(
      join(cwd, hostileName),
      'SGR \x1b[31mred CSI \x1b[2J OSC8 \x1b]8;;https://evil.example\x07link\x1b]8;;\x07 ' +
        'OSC52 \x1b]52;c;YQ==\x1b\\ malformed \x1bX C1 \u009b2J SOH \x01\n'
    );
    const session = open(undefined, { cols: 240, cwd });
    // package.json leads the file group; the hostile filename sorts next.
    session.send('j\rqq');
    await session.done;
    const raw = session.raw();
    if (process.platform !== 'win32') deepStrictEqual(raw.includes('\x1b[31mname'), false, raw);
    deepStrictEqual(raw.includes('\x1b[31mred'), false, raw);
    deepStrictEqual(raw.includes('\x1b[2J'), false, raw);
    deepStrictEqual(raw.includes('\x1b]8'), false, raw);
    deepStrictEqual(raw.includes('\x1b]52'), false, raw);
    deepStrictEqual(raw.includes('\x1bX'), false, raw);
    deepStrictEqual(raw.includes('\u009b'), false, raw);
    const text = session.text();
    if (process.platform !== 'win32')
      deepStrictEqual(text.includes('evil\u240a\u241b[31mname.txt'), true, text);
    deepStrictEqual(text.includes('SGR \u241b[31mred CSI \u241b[2J'), true, text);
    deepStrictEqual(text.includes('OSC52 \u241b]52;c;YQ==\u241b\\'), true, text);
    deepStrictEqual(text.includes('C1 \\u009b2J SOH \u2401'), true, text);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

it('interactive pager searches with /pattern and jumps with :line', async () => {
  const res = await drive(undefined, 'mj\r\r/defProp\r:1\rqqq');
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

it('interactive pager wraps long lines to the width instead of truncating', async () => {
  // A 20-column terminal: the bundle's `var bismarTestPlainIndexAdd…` line must
  // continue on following rows, not vanish behind an ellipsis.
  const session = open(undefined, { cols: 20 });
  session.send('mj\r\rqqq');
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

it('interactive mode handles PgUp/PgDn/Home/End escape sequences', async () => {
  // PgUp at the root must not quit (old parsing let unknown \x1b[5~-style
  // sequences fall through to bare Esc); End then jumps to the last export.
  const res = await drive(undefined, 'm\x1b[5~j\r\x1b[Fqq');
  deepStrictEqual(/@bismar-test\/plain\/index\.js/.test(res.text), true, res.text);
  deepStrictEqual(/▸ blob/.test(res.text), true, res.text);
  // In the pager, PgDn scrolls a window: the footer leaves 0%.
  const paged = await drive(undefined, 'mj\r\r\x1b[6~qqq');
  deepStrictEqual(/\n(?:[1-9]\d?|100)% · ↑↓\/space scroll/.test(paged.text), true, paged.text);
  // Modifier-tagged CSI variants fold onto their plain keys: Ctrl-PgDn pages
  // to the bottom of the modules listing instead of decoding to nothing.
  const ctrl = await drive(undefined, 'm\x1b[6;5~q');
  const ctrlLast = strip((ctrl.frames.split('\x1b[H').pop() ?? '').toString());
  deepStrictEqual(/▸ index\.js/.test(ctrlLast), true, ctrlLast);
});

it('esc backs out one level then exits; ctrl-c/ctrl-d exit anywhere', async () => {
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
  // ctrl-c closes the whole app even from inside the pager, like q…
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

it('a ref /path tail deep-links the files view', async () => {
  // Seed a pinned machine-cache install through the same collision-resistant
  // key and identity marker as the implementation, so it works fully offline.
  const cacheLabel = 'bismar-fake-nav@9.9.9';
  const refDir = refsCacheDir(cacheLabel);
  const pkgDir = join(refDir, 'node_modules', 'bismar-fake-nav');
  rmSync(refDir, { force: true, recursive: true });
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(
    join(refDir, 'package.json'),
    JSON.stringify({ dependencies: { 'bismar-fake-nav': '9.9.9' }, private: true })
  );
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ exports: { '.': './index.js' }, name: 'bismar-fake-nav', version: '9.9.9' })
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export const twice = (n) => n * 2;\n');
  writeFileSync(join(pkgDir, 'src', 'util.ts'), 'export const twice = (n: number) => n * 2;\n');
  writeCacheIdentity(cacheLabel);
  try {
    // An exact shipped file opens the session with its preview pager up. That
    // preview is the session root: the user asked for this file, so q quits…
    const file = open('npm:bismar-fake-nav@9.9.9/src/util.ts');
    await waitFor(file, /n: number/);
    deepStrictEqual(/← files · q quit/.test(file.text()), true, file.text());
    file.send('q');
    await file.done;
    deepStrictEqual(file.raw().includes('\x1b[?25h\x1b[?1049l'), true);
    // …esc quits the same way (backing out of the root is leaving)…
    const esc = open('npm:bismar-fake-nav@9.9.9/src/util.ts');
    await waitFor(esc, /n: number/);
    esc.send('\x1b');
    await esc.done;
    // …while ← climbs into the file's own directory listing underneath.
    const climb = open('npm:bismar-fake-nav@9.9.9/src/util.ts');
    await waitFor(climb, /n: number/);
    climb.send('h');
    await waitFor(climb, /bismar-fake-nav@9\.9\.9\/src · files/);
    // A reopened preview is no longer the root: q/esc back out to the
    // listing; two more climb to the home root and exit.
    climb.send('\r');
    await waitFor(climb, /:goto · q back/);
    climb.send('\x1bqq');
    await climb.done;
    // The esc landed on the listing before q quit: the final frame is files.
    const lastClimb = strip(climb.raw().split('\x1b[H').pop() ?? '');
    deepStrictEqual(/· files/.test(lastClimb), true, lastClimb);
    // A directory tail opens the session on that subtree's listing.
    const dir = open('npm:bismar-fake-nav@9.9.9/src');
    await waitFor(dir, /bismar-fake-nav@9\.9\.9\/src · files/);
    deepStrictEqual(/util\.ts/.test(dir.text()), true, dir.text());
    dir.send('qq');
    await dir.done;
    // A tail matching nothing is a typo'd path: error out before the TUI opens,
    // never a silently whole-package browse.
    const miss = open('npm:bismar-fake-nav@9.9.9/nope');
    await assert.rejects(miss.done, /no shipped file matches \/nope; drop the tail to browse/);
    deepStrictEqual(miss.raw().includes('\x1b[?1049h'), false, 'TUI must not open');
    // A tail that names a module hints its shipped-file spelling instead.
    const asMod = open('npm:bismar-fake-nav@9.9.9/index');
    await assert.rejects(
      asMod.done,
      /no shipped file matches \/index; the module's file ships as \/index\.js/
    );
  } finally {
    rmSync(refDir, { force: true, recursive: true });
    rmSync(refsMetaFile(cacheLabel), { force: true });
  }
});

it('profile refs seed the launcher listing; @user searches one from the prompt', async () => {
  // Seeded session (bismar gh:@user): the launcher opens on the results stage.
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
  const done = runInteractive(undefined, {
    cwd: FIXTURE,
    io,
    profile: {
      hits: [{ desc: 'Minimal QR', name: 'paulmillr/qr', version: '12★' }],
      prefix: 'gh:',
      user: 'paulmillr',
    },
  });
  const seeded = { text: () => strip(raw) };
  // The crumb is the profile itself, spelled with the long registry name.
  await waitFor(seeded, /github:@paulmillr · 1 listed/);
  await waitFor(seeded, /paulmillr\/qr.*12★.*Minimal QR/);
  // The seeded listing is the session root: q and esc exit — never into the
  // menu, which this session never came from — while ← (a navigation key)
  // stays put instead of exiting.
  deepStrictEqual(/↑↓ move · enter open · q quit/.test(seeded.text()), true, seeded.text());
  input.write('\x1b[D');
  const alive = await Promise.race([
    done.then(() => 'done'),
    new Promise((res) => setTimeout(() => res('alive'), 200)),
  ]);
  deepStrictEqual(alive, 'alive', 'left-arrow must not exit the root listing');
  input.write('\x1b');
  await done;
  deepStrictEqual(/what to open\?/.test(seeded.text()), false, seeded.text());

  // Opening a hit keeps the profile as the session crumb's head, with the
  // redundant owner collapsed: `npm:@fake · bismar-fake-prof@9.9.9`. Offline:
  // a seeded pinned install plus a fresh version tag resolve the floating hit.
  const cacheLabel = 'bismar-fake-prof@9.9.9';
  const tagLabel = 'bismar-fake-prof';
  const refDir = refsCacheDir(cacheLabel);
  const pkgDir = join(refDir, 'node_modules', 'bismar-fake-prof');
  rmSync(refDir, { force: true, recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(refDir, 'package.json'),
    JSON.stringify({ dependencies: { 'bismar-fake-prof': '9.9.9' }, private: true })
  );
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ exports: { '.': './index.js' }, name: 'bismar-fake-prof', version: '9.9.9' })
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export const one = 1;\n');
  writeCacheIdentity(cacheLabel);
  writeVersionTag(tagLabel, '9.9.9');
  try {
    const input2 = new PassThrough();
    let raw2 = '';
    const io2 = {
      cols: 100,
      input: input2,
      output: {
        write: (text: string) => {
          raw2 += text;
          return true;
        },
      },
      rows: 16,
    };
    const done2 = runInteractive(undefined, {
      cwd: FIXTURE,
      io: io2,
      profile: {
        hits: [{ desc: '', name: 'bismar-fake-prof', version: '9.9.9' }],
        prefix: 'npm:',
        user: 'fake',
      },
    });
    const opened = { text: () => strip(raw2) };
    await waitFor(opened, /npm:@fake · 1 listed/);
    input2.write('\r');
    await waitFor(opened, /npm:@fake · bismar-fake-prof@9\.9\.9 · files/);
    input2.write('\x03');
    await done2;
  } finally {
    rmSync(refDir, { force: true, recursive: true });
    rmSync(refsMetaFile(cacheLabel), { force: true });
    rmSync(refsTagFile(tagLabel), { force: true });
  }

  // The search prompt: a bare @user lists that profile instead of name search.
  const routes: Record<string, string> = {
    '/api/v1/users/vision': JSON.stringify({ user: { id: 7 } }),
    '/api/v1/crates?user_id=7&per_page=25&sort=recent-updates': JSON.stringify({
      crates: [{ description: 'QR toolkit', max_stable_version: '1.2.3', name: 'vision-qr' }],
    }),
  };
  const server = createServer((req, res) => {
    const body = routes[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      return void res.end('{}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const prev = process.env.BISMAR_CRATES_API;
  process.env.BISMAR_CRATES_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const menu = openMenu('x');
    menu.send('jjj\r'); // crate search box
    await waitFor(menu, /search Rust\/Cargo/);
    // The prompt advertises the profile spelling.
    deepStrictEqual(/e\.g\. serde or @user/.test(menu.text()), true, menu.text());
    menu.send('@vision\r');
    await waitFor(menu, /vision-qr.*1\.2\.3.*QR toolkit/);
    // The prompt-entered profile crumbs the same way as the CLI-seeded one.
    deepStrictEqual(/crate:@vision · 1 listed/.test(menu.text()), true, menu.text());
    // Enter opens the picked crate like any search hit, carrying the profile
    // crumb along as the session's head.
    menu.send('\r');
    deepStrictEqual(await menu.done, {
      leftover: [],
      selector: 'crate:vision-qr',
      via: 'crate:@vision',
    });
  } finally {
    if (prev === undefined) delete process.env.BISMAR_CRATES_API;
    else process.env.BISMAR_CRATES_API = prev;
    server.closeAllConnections();
    await new Promise((res) => server.close(res));
  }
});
