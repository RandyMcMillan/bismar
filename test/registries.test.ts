// Tests for registry refs (crate:/gem:/pypi:) — parsing, the navigator-only CLI
// guard, the zip reader, and files-only interactive sessions, driven against
// local registry stand-ins.
import { deepStrictEqual, rejects, throws } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test as it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';
// The requests-per-second politeness budget only buys latency against the
// local stand-in servers here; 0 drops the spacing timers entirely.
process.env.BISMAR_RPS = '0';

const {
  BIG_ARCHIVE,
  guardBigArchive,
  jsHitStats,
  MAX_METADATA_BYTES,
  parseProfileRef,
  parseRegistryRef,
  profileHits,
  searchRegistry,
  setBigArchivePolicy,
} = await import('../src/registries.ts');
const { parseArgs, runCli } = await import('../src/bismar.ts');
const { cacheKey, readVersionTag, refsCacheDir, refsRoot, refsTagFile, TAG_TTL_MS } = await import(
  '../src/refs.ts'
);
const { extractZip, tempDir } = await import('../src/fs-modify.ts');
const { runInteractive } = await import('../src/interactive.ts');

// Strips colors and control sequences (clear, home, alternate screen).
const strip = (text: string): string => text.replace(/\x1b\[[\d?;]*[a-zA-Z]/g, '');

type Session = {
  done: Promise<void>;
  raw: () => string;
  send: (keys: string) => void;
  text: () => string;
};
const open = (selector: string | undefined, cwd: string = tmpdir(), cols?: number): Session => {
  const input = new PassThrough();
  let raw = '';
  const io = {
    input,
    output: {
      write: (text: string) => {
        raw += text;
        return true;
      },
    },
    cols,
    rows: 16,
  };
  return {
    done: runInteractive(selector, { cwd, io }),
    raw: () => raw,
    send: (keys: string) => void input.write(keys),
    text: () => strip(raw),
  };
};
// A previous run's machine cache would skip the fetch path; start cold.
const coldCache = (...labels: string[]): void => {
  for (const label of labels) {
    rmSync(refsCacheDir(label), { force: true, recursive: true });
    for (const ext of ['.crate', '.gem', '.tar.gz', '.zip', '.whl'])
      rmSync(`${refsCacheDir(label)}${ext}`, { force: true });
    rmSync(refsTagFile(label.replace(/@[^@]*$/, '')), { force: true });
  }
};
const serve = async (
  routes: Record<string, () => { body: Buffer | string; json?: boolean }>
): Promise<{ port: number; server: Server }> => {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (!route) {
      res.statusCode = 404;
      return void res.end('{}');
    }
    const { body, json } = route();
    if (json) res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return { port: (server.address() as AddressInfo).port, server };
};
const closeServer = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise((res) => server.close(res));
};

// Hand-built zip (store nothing, deflate everything): enough structure for the
// reader — local headers, central directory, EOCD. CRCs stay zero; the reader
// never checks them.
const zipOf = (files: [string, string][]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt32LE(data.length, 18); // compressed size
    lh.writeUInt32LE(Buffer.byteLength(text), 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(Buffer.byteLength(text), 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(off, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    locals.push(Buffer.concat([lh, nameBuf, data]));
    off += locals[locals.length - 1].length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
};

it('registry refs parse names and exact versions only', () => {
  deepStrictEqual(parseRegistryRef('crate:serde'), {
    name: 'serde',
    path: '',
    prefix: 'crate:',
    version: '',
  });
  deepStrictEqual(parseRegistryRef('crate:once_cell@1.20.0'), {
    name: 'once_cell',
    path: '',
    prefix: 'crate:',
    version: '1.20.0',
  });
  // Gem versions are dotted but not semver; pypi versions are PEP 440.
  deepStrictEqual(parseRegistryRef('gem:rails@7.1.3.4'), {
    name: 'rails',
    path: '',
    prefix: 'gem:',
    version: '7.1.3.4',
  });
  deepStrictEqual(parseRegistryRef('gem:concurrent-ruby@1.2.0.rc1').version, '1.2.0.rc1');
  deepStrictEqual(parseRegistryRef('pypi:requests'), {
    name: 'requests',
    path: '',
    prefix: 'pypi:',
    version: '',
  });
  deepStrictEqual(parseRegistryRef('pypi:numpy@2.0.0b1').version, '2.0.0b1');
  deepStrictEqual(parseRegistryRef('pypi:pip@1.0.post1').version, '1.0.post1');
  // Language-name aliases normalize to the canonical prefix…
  deepStrictEqual(parseRegistryRef('rust:serde@1.0.219'), {
    name: 'serde',
    path: '',
    prefix: 'crate:',
    version: '1.0.219',
  });
  deepStrictEqual(parseRegistryRef('ruby:rails').prefix, 'gem:');
  deepStrictEqual(parseRegistryRef('python:requests').prefix, 'pypi:');
  // …short aliases too: cargo/rs → crate, rb → gem, py → pypi.
  deepStrictEqual(parseRegistryRef('cargo:serde').prefix, 'crate:');
  deepStrictEqual(parseRegistryRef('rs:serde@1.0.219').prefix, 'crate:');
  deepStrictEqual(parseRegistryRef('rb:rails').prefix, 'gem:');
  deepStrictEqual(parseRegistryRef('py:requests').prefix, 'pypi:');
  // …while error hints echo the spelling the user typed.
  throws(() => parseRegistryRef('ruby:rails@>=7'), /pin an exact version like ruby:rails@1\.0\.0/);
  throws(() => parseRegistryRef('python:-x'), /invalid package ref.*use python:name@version/);
  // Multi-segment names: packagist vendor/name, github owner/repo, go import paths.
  deepStrictEqual(parseRegistryRef('composer:monolog/monolog'), {
    name: 'monolog/monolog',
    path: '',
    prefix: 'composer:',
    version: '',
  });
  deepStrictEqual(parseRegistryRef('php:laravel/framework@v9.0.0').prefix, 'composer:');
  deepStrictEqual(parseRegistryRef('gh:paulmillr/noble-hashes@feature/x'), {
    name: 'paulmillr/noble-hashes',
    path: '',
    prefix: 'gh:',
    version: 'feature/x',
  });
  deepStrictEqual(parseRegistryRef('github:octo/mini').prefix, 'gh:');
  deepStrictEqual(parseRegistryRef('gitlab:inkscape/inkscape@master'), {
    name: 'inkscape/inkscape',
    path: '',
    prefix: 'gitlab:',
    version: 'master',
  });
  // GitLab allows nested subgroups in project paths.
  deepStrictEqual(parseRegistryRef('gitlab:group/sub/proj').name, 'group/sub/proj');
  throws(
    () => parseRegistryRef('gitlab:justgroup'),
    /invalid repository ref.*use gitlab:group\/project@ref/
  );
  // Fixed-arity refs take `/path` tails: the shipped file or directory the
  // flagless modes open. Versions ride on the name, before the tail — except
  // gh, whose refspecs may contain slashes, so there the version wins and only
  // unversioned refs take a tail.
  deepStrictEqual(parseRegistryRef('crate:serde@1.0.219/src/lib.rs'), {
    name: 'serde',
    path: 'src/lib.rs',
    prefix: 'crate:',
    version: '1.0.219',
  });
  deepStrictEqual(parseRegistryRef('gem:rails/lib').path, 'lib');
  deepStrictEqual(parseRegistryRef('pypi:requests@2.32.0/README.md').path, 'README.md');
  deepStrictEqual(parseRegistryRef('gh:paulmillr/qr/README.md'), {
    name: 'paulmillr/qr',
    path: 'README.md',
    prefix: 'gh:',
    version: '',
  });
  deepStrictEqual(parseRegistryRef('gh:paulmillr/qr@feature/x').path, '');
  // Variable-arity names (go import paths, gitlab subgroups) take no tails.
  deepStrictEqual(parseRegistryRef('go:golang.org/x/text/rate').path, '');
  deepStrictEqual(parseRegistryRef('gitlab:group/sub/proj').path, '');
  deepStrictEqual(parseRegistryRef('golang:golang.org/x/text').prefix, 'go:');
  // go versions canonicalize to the proxy's v-prefixed spelling.
  deepStrictEqual(parseRegistryRef('go:golang.org/x/text@0.14.0').version, 'v0.14.0');
  deepStrictEqual(parseRegistryRef('go:golang.org/x/text@v0.14.0').version, 'v0.14.0');
  throws(
    () => parseRegistryRef('composer:monolog'),
    /invalid package ref.*use composer:vendor\/name@version/
  );
  // Past the fixed vendor/name arity, extra segments are a shipped-path tail.
  deepStrictEqual(parseRegistryRef('composer:a/b/c'), {
    name: 'a/b',
    path: 'c',
    prefix: 'composer:',
    version: '',
  });
  throws(() => parseRegistryRef('gh:justowner'), /invalid repository ref.*use gh:owner\/repo@ref/);
  throws(
    () => parseRegistryRef('go:golang.org/x/text@latest'),
    /pin an exact version like go:golang\.org\/x\/text@v1\.0\.0/
  );
  throws(() => parseRegistryRef('crate:'), /invalid crate ref/);
  // A slash past a one-segment name is a shipped-path tail now, not a typo.
  deepStrictEqual(parseRegistryRef('crate:serde/de').path, 'de');
  // `@user/repo` tolerates the profile sigil on a full ref; a bare `@user`
  // stays a profile and never parses here.
  deepStrictEqual(parseRegistryRef('gh:@octo/mini').name, 'octo/mini');
  deepStrictEqual(parseRegistryRef('gitlab:@group/sub/proj').name, 'group/sub/proj');
  throws(() => parseRegistryRef('gh:@octo'), /invalid repository ref/);
  throws(() => parseRegistryRef('gem:rails lib'), /invalid gem ref/);
  throws(() => parseRegistryRef('pypi:-requests'), /invalid package ref/);
  // Ranges and partial versions would need each ecosystem's resolver; refuse them.
  throws(() => parseRegistryRef('crate:serde@1'), /pin an exact version/);
  throws(() => parseRegistryRef('crate:serde@^1.0.0'), /pin an exact version/);
  throws(() => parseRegistryRef('gem:rails@>=7'), /pin an exact version/);
  throws(() => parseRegistryRef('pypi:requests@latest'), /pin an exact version/);
});

it('archives at or past 100mb need consent before downloading', async () => {
  // The prompt branch keys off the ambient streams, so pin them off-terminal:
  // run from a real terminal this would stop for a y/N answer nobody types.
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const stderr = process.stderr as unknown as { isTTY?: boolean };
  const prevIn = stdin.isTTY;
  const prevErr = stderr.isTTY;
  stdin.isTTY = false;
  stderr.isTTY = false;
  try {
    // Small downloads never ask, in any mode.
    await guardBigArchive('gh:small/repo', BIG_ARCHIVE - 1);
    // Off a terminal (as pinned here) there is nobody to ask: refuse with the override.
    await rejects(
      () => guardBigArchive('gh:paulmillr/qr-code-vectors', BIG_ARCHIVE * 2),
      /refusing large download: gh:paulmillr\/qr-code-vectors is ~200mb; confirm on a terminal or set BISMAR_BIG=1/
    );
    // The TUI policy (raw-mode stdin) refuses instead of prompting into the screen.
    setBigArchivePolicy('refuse');
    try {
      await rejects(() => guardBigArchive('gh:big/repo', BIG_ARCHIVE), /refusing large download/);
    } finally {
      setBigArchivePolicy('ask');
    }
    // BISMAR_BIG=1 waves everything through (scripts, CI).
    process.env.BISMAR_BIG = '1';
    try {
      await guardBigArchive('gh:big/repo', BIG_ARCHIVE * 10);
    } finally {
      delete process.env.BISMAR_BIG;
    }
  } finally {
    stdin.isTTY = prevIn;
    stderr.isTTY = prevErr;
  }
});

it('registry metadata is aborted at its streaming body limit', async () => {
  let sent = 0;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const write = (): void => {
      while (sent <= MAX_METADATA_BYTES + chunk.length) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', write);
      }
      res.end();
    };
    write();
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  process.env.BISMAR_CRATES_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await rejects(
      () => searchRegistry('crate:', 'oversized'),
      /refusing oversized registry response.*limit is 16\.0mb/
    );
    // The wrapper cancelled near the configured cap; it did not buffer an
    // arbitrary server stream before applying policy.
    deepStrictEqual(sent <= MAX_METADATA_BYTES + 256 * 1024, true, String(sent));
  } finally {
    delete process.env.BISMAR_CRATES_API;
    await closeServer(server);
  }
});

it('ref cache files one subdirectory per registry', () => {
  deepStrictEqual(
    refsCacheDir('crate:serde@1.0.219'),
    join(refsRoot(), 'crate', cacheKey('serde@1.0.219'))
  );
  deepStrictEqual(
    refsCacheDir('gem:rails@7.1.3'),
    join(refsRoot(), 'gem', cacheKey('rails@7.1.3'))
  );
  // Bare npm labels file under npm/; jsr labels keep their own shelf.
  deepStrictEqual(refsCacheDir('qr@0.6.0'), join(refsRoot(), 'npm', cacheKey('qr@0.6.0')));
  deepStrictEqual(
    refsCacheDir('jsr:@std/bytes@1.0.5'),
    join(refsRoot(), 'jsr', cacheKey('@std/bytes@1.0.5'))
  );
  // Lossy display slugs no longer alias distinct cache identities.
  deepStrictEqual(refsCacheDir('npm:a+b@1.0.0') === refsCacheDir('npm:a-b@1.0.0'), false);
  deepStrictEqual(refsCacheDir('a+b@1.0.0') === refsCacheDir('a-b@1.0.0'), false);
  deepStrictEqual(refsTagFile('gh:a+b') === refsTagFile('gh:a-b'), false);
});

it('registry refs take every output mode except minify', () => {
  // -b emits the saved registry archive; only minify-shaped output is refused.
  deepStrictEqual(parseArgs(['crate:serde', '-b']).bundle, true);
  deepStrictEqual(parseArgs(['crate:serde', '-bs']).size, true);
  deepStrictEqual(parseArgs(['-bs', 'crate:serde', 'crate:tokio']).paths.length, 2);
  deepStrictEqual(parseArgs(['composer:monolog/monolog', '-b']).paths, [
    'composer:monolog/monolog',
  ]);
  throws(
    () => parseArgs(['gem:rails', '--minify']),
    /gem refs have no JS to minify.*drop --minify/
  );
  throws(() => parseArgs(['pypi:requests', '--minify']), /pypi refs have no JS to minify/);
  throws(() => parseArgs(['gh:octo/mini', '--minify']), /gh refs have no JS to minify/);
  throws(() => parseArgs(['go:golang.org/x/text', '-bm']), /go refs have no JS to minify/);
  // Short aliases speak the rule in the spelling the user typed.
  throws(() => parseArgs(['cargo:serde', '-m']), /cargo refs have no JS to minify/);
  // Stdout holds exactly one artifact.
  throws(
    () => parseArgs(['-b', 'crate:serde', 'crate:tokio']),
    /registry archives emit one at a time/
  );
  // Interactive is the default mode, so bare registry refs just work.
  deepStrictEqual(parseArgs(['crate:serde']).interactive, true);
  deepStrictEqual(parseArgs(['gem:rails']).interactive, true);
  deepStrictEqual(parseArgs(['python:requests']).interactive, true);
  deepStrictEqual(parseArgs(['rb:rails']).interactive, true);
  deepStrictEqual(parseArgs(['py:requests']).interactive, true);
  deepStrictEqual(parseArgs(['gh:octo/mini@dev']).interactive, true);
});

it('search parses hits from every registry api behind a browser agent', async () => {
  const agents: (string | undefined)[] = [];
  const routes: Record<string, string> = {
    '/-/v1/search?text=pre&size=10': JSON.stringify({
      objects: [
        { package: { description: 'Fast 3kB alternative', name: 'preact', version: '10.20.0' } },
        { package: { name: 'preact-render-to-string', version: '6.0.0' } },
      ],
    }),
    '/packages?query=bytes&limit=10': JSON.stringify({
      items: [{ description: 'Byte helpers', latestVersion: '1.0.6', name: 'bytes', scope: 'std' }],
    }),
    '/api/v1/crates?q=serde&per_page=10': JSON.stringify({
      crates: [
        {
          description: 'A serialization\nframework',
          max_stable_version: '1.0.219',
          name: 'serde',
        },
        { description: null, max_version: '1.0.140', name: 'serde_json' },
      ],
    }),
    '/api/v1/search.json?query=rail': JSON.stringify([
      { info: 'Ruby on Rails', name: 'railties', version: '7.1.3' },
    ]),
    '/search/repositories?q=qr&per_page=10': JSON.stringify({
      items: [
        { description: 'QR code generator', full_name: 'paulmillr/qr', stargazers_count: 123 },
      ],
    }),
    '/projects?search=inkscape&order_by=last_activity_at&per_page=10': JSON.stringify([
      { description: 'Vector editor', path_with_namespace: 'inkscape/inkscape', star_count: 42 },
      { description: null, path_with_namespace: null },
    ]),
  };
  const server = createServer((req, res) => {
    agents.push(req.headers['user-agent']);
    const body = routes[req.url ?? ''];
    if (!body) {
      res.statusCode = 404;
      return void res.end('{}');
    }
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const bases = [
    'BISMAR_NPM_API',
    'BISMAR_JSR_API',
    'BISMAR_CRATES_API',
    'BISMAR_GEMS_API',
    'BISMAR_GH_API',
    'BISMAR_GITLAB_API',
  ];
  for (const key of bases)
    process.env[key] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // npm hits carry no description by design; the jsr/crate/gem/gh ones do.
    deepStrictEqual(await searchRegistry('npm:', 'pre'), [
      { desc: '', name: 'preact', version: '10.20.0' },
      { desc: '', name: 'preact-render-to-string', version: '6.0.0' },
    ]);
    deepStrictEqual(await searchRegistry('jsr:', 'bytes'), [
      { desc: 'Byte helpers', name: '@std/bytes', version: '1.0.6' },
    ]);
    // Multi-line descriptions collapse onto one row; stable versions win.
    deepStrictEqual(await searchRegistry('crate:', 'serde'), [
      { desc: 'A serialization framework', name: 'serde', version: '1.0.219' },
      { desc: '', name: 'serde_json', version: '1.0.140' },
    ]);
    deepStrictEqual(await searchRegistry('gem:', 'rail'), [
      { desc: 'Ruby on Rails', name: 'railties', version: '7.1.3' },
    ]);
    deepStrictEqual(await searchRegistry('gh:', 'qr'), [
      { desc: 'QR code generator', name: 'paulmillr/qr', version: '123★' },
    ]);
    // Hits missing a path drop out instead of rendering blank rows.
    deepStrictEqual(await searchRegistry('gitlab:', 'inkscape'), [
      { desc: 'Vector editor', name: 'inkscape/inkscape', version: '42★' },
    ]);
    // pypi retired its search api in 2021; the launcher opens exact names there.
    await rejects(() => searchRegistry('pypi:', 'requests'), /no search api behind pypi:/);
    // Every request went out as a mainstream browser, never as a bot.
    deepStrictEqual(agents.length, 6, String(agents.length));
    for (const ua of agents) {
      deepStrictEqual(ua?.startsWith('Mozilla/5.0 '), true, ua);
      deepStrictEqual(/ Chrome\/\d+/.test(ua ?? ''), true, ua);
      deepStrictEqual(/bismar|bot|curl|node/i.test(ua ?? ''), false, ua);
    }
  } finally {
    for (const key of bases) delete process.env[key];
    await closeServer(server);
  }
});

it('js hit stats find packed tarball bytes and dep counts, then cache', async () => {
  // Versions are deliberately unpublishable: the stats cache is machine-wide,
  // and a real pkg@version must never be seeded with stand-in numbers.
  rmSync(join(refsRoot(), '.stats'), { force: true, recursive: true });
  let base = '';
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/preact/0.0.0-bismar') {
      res.setHeader('content-type', 'application/json');
      return void res.end(
        JSON.stringify({ dependencies: { a: '1' }, dist: { tarball: `${base}/preact.tgz` } })
      );
    }
    if (url === '/preact.tgz') {
      // npm-style CDN: HEAD says nothing useful; a range GET carries the total.
      if (req.method === 'HEAD') return void res.end();
      if (req.headers.range === 'bytes=0-0') {
        res.statusCode = 206;
        res.setHeader('content-range', 'bytes 0-0/407547');
        return void res.end('x');
      }
    }
    if (url === '/@jsr/std__bytes') {
      res.setHeader('content-type', 'application/json');
      return void res.end(
        JSON.stringify({
          'dist-tags': { latest: '0.0.0-bismar' },
          versions: { '0.0.0-bismar': { dist: { tarball: `${base}/bytes.tgz` } } },
        })
      );
    }
    if (url === '/bytes.tgz' && req.method === 'HEAD') {
      // jsr-style CDN answers HEAD with the size directly.
      res.setHeader('content-length', '11881');
      return void res.end();
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BISMAR_NPM_API = base;
  process.env.BISMAR_JSR_REGISTRY = base;
  try {
    deepStrictEqual(
      await jsHitStats('npm:', { desc: '', name: 'preact', version: '0.0.0-bismar' }),
      { deps: 1, tgzBytes: 407547 }
    );
    // jsr: search already carried deps; the packument fills the missing latest
    // version and its tarball answers HEAD.
    deepStrictEqual(
      await jsHitStats('jsr:', { deps: 0, desc: '', name: '@std/bytes', version: '' }),
      { deps: 0, tgzBytes: 11881, version: '0.0.0-bismar' }
    );
    // Non-JS registries have no garnish — and no requests are made for them.
    deepStrictEqual(
      await jsHitStats('crate:', { desc: '', name: 'serde', version: '1.0.0' }),
      undefined
    );
    // Stats cache per pkg@version: with the registries unreachable, versioned
    // lookups still answer from disk (a blank jsr version needs the packument
    // to resolve, so only the pinned spelling is offline-safe).
    process.env.BISMAR_NPM_API = 'http://127.0.0.1:9';
    process.env.BISMAR_JSR_REGISTRY = 'http://127.0.0.1:9';
    deepStrictEqual(
      await jsHitStats('npm:', { desc: '', name: 'preact', version: '0.0.0-bismar' }),
      { deps: 1, tgzBytes: 407547 }
    );
    deepStrictEqual(
      await jsHitStats('jsr:', { desc: '', name: '@std/bytes', version: '0.0.0-bismar' }),
      { deps: 0, tgzBytes: 11881 }
    );
  } finally {
    delete process.env.BISMAR_NPM_API;
    delete process.env.BISMAR_JSR_REGISTRY;
    await closeServer(server);
  }
});

it('bismar -v prints resolved versions with their registry release dates', async () => {
  const fresh = new Date(Date.now() - 22 * 3_600_000).toISOString();
  const { port, server } = await serve({
    '/qr': () => ({
      body: JSON.stringify({ time: { '0.6.0': '2020-08-06T12:00:00.000Z', '0.7.0': fresh } }),
      json: true,
    }),
    '/scopes/scope/packages/x/versions/1.2.3': () => ({
      body: JSON.stringify({ createdAt: '2021-01-02T03:04:05.000Z' }),
      json: true,
    }),
  });
  process.env.BISMAR_NPM_API = `http://127.0.0.1:${port}`;
  process.env.BISMAR_JSR_API = `http://127.0.0.1:${port}`;
  const capture = async (argv: string[]): Promise<string> => {
    const prevLog = console.log;
    let out = '';
    console.log = (...args: unknown[]) => {
      out += `${args.join(' ')}\n`;
    };
    try {
      await runCli(argv, { tty: false });
    } finally {
      console.log = prevLog;
    }
    return out;
  };
  try {
    // Old releases read as a UTC calendar date, fresh ones (<24h) as an age.
    deepStrictEqual(await capture(['-v', 'npm:qr@0.6.0']), '0.6.0 from 6 Aug 2020\n');
    deepStrictEqual(await capture(['-v', 'npm:qr@0.7.0']), '0.7.0 from 22h ago\n');
    deepStrictEqual(await capture(['-v', 'jsr:@scope/x@1.2.3']), '1.2.3 from 2 Jan 2021\n');
    // A version the registry has no timestamp for prints bare, never errors.
    deepStrictEqual(await capture(['-v', 'npm:qr@9.9.9']), '9.9.9\n');
  } finally {
    delete process.env.BISMAR_NPM_API;
    delete process.env.BISMAR_JSR_API;
    await closeServer(server);
  }
});

it('github search rate limits surface as a one-line hint, not a retry storm', async () => {
  // Anonymous github search allows 10 queries a minute and answers 403; that
  // must map to a friendly message after exactly one request (403 never retries).
  let asked = 0;
  const server = createServer((_req, res) => {
    asked += 1;
    res.statusCode = 403;
    res.end('{}');
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  process.env.BISMAR_GH_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await rejects(
      () => searchRegistry('gh:', 'qr'),
      /github search is rate-limited for anonymous use; wait a minute and retry/
    );
    deepStrictEqual(asked, 1);
  } finally {
    delete process.env.BISMAR_GH_API;
    await closeServer(server);
  }
});

it('zip reader extracts members and refuses traversal', () => {
  const dir = tempDir('check');
  try {
    extractZip(zipOf([['pkg/a.py', 'A = 1\n']]), join(dir, 'ok'));
    deepStrictEqual(readFileSync(join(dir, 'ok', 'pkg', 'a.py'), 'utf8'), 'A = 1\n');
    throws(() => extractZip(zipOf([['../evil.txt', 'x']]), join(dir, 'bad')), /unsafe zip member/);
    throws(() => extractZip(zipOf([['/abs.txt', 'x']]), join(dir, 'bad')), /unsafe zip member/);
    throws(() => extractZip(Buffer.from('not a zip'), join(dir, 'bad')), /invalid zip/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it('interactive crate ref downloads, extracts, and browses files only', async () => {
  // A minimal `.crate`: gzipped tar with the standard `name-version/` top dir,
  // built by system tar as an interoperability fixture for the internal parser.
  const fix = mkdtempSync(join(tmpdir(), 'bismar-crate-fix-'));
  mkdirSync(join(fix, 'mini-0.1.0', 'src'), { recursive: true });
  writeFileSync(
    join(fix, 'mini-0.1.0', 'Cargo.toml'),
    '[package]\nname = "mini"\nversion = "0.1.0"\nrepository = "https://github.com/rusty/mini"\n'
  );
  writeFileSync(
    join(fix, 'mini-0.1.0', 'src', 'lib.rs'),
    'pub fn add(a: u64, b: u64) -> u64 {\n    a + b\n}\n'
  );
  execFileSync('tar', ['-czf', join(fix, 'mini.crate'), '-C', fix, 'mini-0.1.0']);
  const { port, server } = await serve({
    '/api/v1/crates/mini': () => ({
      body: JSON.stringify({ crate: { max_stable_version: '0.1.0' } }),
      json: true,
    }),
    '/api/v1/crates/mini/0.1.0/download': () => ({
      body: readFileSync(join(fix, 'mini.crate')),
    }),
  });
  try {
    process.env.BISMAR_CRATES_API = `http://127.0.0.1:${port}`;
    coldCache('crate:mini@0.1.0');

    // Pinned ref: enter src/, preview lib.rs, esc closes the pager, h climbs
    // back, m is a no-op, esc exits from the root.
    const session = open('crate:mini@0.1.0');
    session.send('\r\r\x1bhm\x1b');
    await session.done;
    const text = session.text();
    // The session opens straight into the files view under the pinned label,
    // with the package footprint in the header and per-directory footprints.
    deepStrictEqual(/crate:mini@0\.1\.0 · files · 2 files, [\d.]+kb/.test(text), true, text);
    deepStrictEqual(/▸ src\/ {2}1 file, [\d.]+kb/.test(text), true, text);
    deepStrictEqual(/Cargo\.toml {2}[\d.]+kb/.test(text), true, text);
    // …with no modules view on offer, and no size stats anywhere.
    deepStrictEqual(/m mode/.test(text), false, text);
    deepStrictEqual(/measuring|LOC/.test(text), false, text);
    // A crate naming its repository in Cargo.toml offers the same `r` jump JS
    // packages get; the extract has no package.json to read it from.
    deepStrictEqual(/← up · r github · q quit/.test(text), true, text);
    // Enter descends into src/ and previews the Rust source as plain text.
    deepStrictEqual(/crate:mini@0\.1\.0\/src · files/.test(text), true, text);
    deepStrictEqual(/src\/lib\.rs · 4 lines/.test(text), true, text);
    deepStrictEqual(/pub fn add\(a: u64, b: u64\) -> u64 \{/.test(text), true, text);
    // The trailing m must not leave the files view: the last frame is still it.
    const last = strip(session.raw().split('\x1b[H').pop() ?? '');
    deepStrictEqual(/crate:mini@0\.1\.0 · files/.test(last), true, last);

    // Versionless ref: latest resolves through the API and reuses the extract cache.
    const latest = open('crate:mini');
    latest.send('q');
    await latest.done;
    deepStrictEqual(/crate:mini@0\.1\.0 · files/.test(latest.text()), true, latest.text());

    // Alias spelling: same session, same canonical label, same caches.
    const alias = open('rust:mini@0.1.0');
    alias.send('q');
    await alias.done;
    deepStrictEqual(/crate:mini@0\.1\.0 · files/.test(alias.text()), true, alias.text());

    // -b emits the saved archive verbatim, byte-identical to the served .crate.
    let out = Buffer.alloc(0);
    const prevWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      out = Buffer.concat([out, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(['-b', 'crate:mini@0.1.0'], { tty: false });
    } finally {
      process.stdout.write = prevWrite;
    }
    deepStrictEqual(out.equals(readFileSync(join(fix, 'mini.crate'))), true);
    // -bs asks for that same artifact's stat instead of its bytes or a refusal.
    const prevStatLog = console.log;
    let askedStat = '';
    console.log = (...args: unknown[]) => {
      askedStat += `${args.join(' ')}\n`;
    };
    try {
      await runCli(['-bs', 'crate:mini@0.1.0'], { tty: false });
    } finally {
      console.log = prevStatLog;
    }
    deepStrictEqual(
      askedStat,
      `mini-0.1.0.crate,${readFileSync(join(fix, 'mini.crate')).length}b\n`
    );
    // A terminal refuses the bytes and hints the redirect with a real filename,
    // plus a stat row with the archive's size, like the JS bundle fallback.
    const prevExit = process.exitCode;
    const prevErr = console.error;
    const prevLog = console.log;
    let hint = '';
    let stat = '';
    console.error = (...args: unknown[]) => {
      hint += args.join(' ');
    };
    console.log = (...args: unknown[]) => {
      stat += args.join(' ');
    };
    try {
      await runCli(['-b', 'crate:mini@0.1.0'], { tty: true });
    } finally {
      console.error = prevErr;
      console.log = prevLog;
    }
    deepStrictEqual(process.exitCode, 1, hint);
    process.exitCode = prevExit;
    deepStrictEqual(
      /use redirect: bismar -b crate:mini@0\.1\.0 > mini-0\.1\.0\.crate/.test(hint),
      true,
      hint
    );
    deepStrictEqual(/^mini-0\.1\.0\.crate {2}[\d.]+kb$/.test(stat), true, stat);

    // Unknown crates fail with the registry story, before any screen is taken.
    await rejects(() => runInteractive('crate:nope', { cwd: tmpdir() }), /crate not found: nope/);
  } finally {
    delete process.env.BISMAR_CRATES_API;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('interactive gem ref unwraps the data layer of the gem shell', async () => {
  // A `.gem` is a PLAIN tar shell around data.tar.gz (the shipped files) and
  // metadata.gz; only the data layer should surface in the files view.
  const fix = mkdtempSync(join(tmpdir(), 'bismar-gem-fix-'));
  mkdirSync(join(fix, 'data', 'lib'), { recursive: true });
  writeFileSync(join(fix, 'data', 'lib', 'mini.rb'), "module Mini\n  VERSION = '0.2.0'\nend\n");
  writeFileSync(join(fix, 'data', 'README.md'), '# minigem\n');
  execFileSync('tar', ['-czf', join(fix, 'data.tar.gz'), '-C', join(fix, 'data'), '.']);
  writeFileSync(join(fix, 'metadata.gz'), deflateRawSync(Buffer.from('stub')));
  execFileSync('tar', ['-cf', join(fix, 'minigem.gem'), '-C', fix, 'data.tar.gz', 'metadata.gz']);
  const { port, server } = await serve({
    '/api/v1/gems/minigem.json': () => ({ body: JSON.stringify({ version: '0.2.0' }), json: true }),
    '/downloads/minigem-0.2.0.gem': () => ({ body: readFileSync(join(fix, 'minigem.gem')) }),
  });
  try {
    process.env.BISMAR_GEMS_API = `http://127.0.0.1:${port}`;
    coldCache('gem:minigem@0.2.0');
    // Versionless: resolve latest, download, unwrap; then browse lib/mini.rb.
    const session = open('gem:minigem');
    session.send('\r\rq\x1b\x1b');
    await session.done;
    const text = session.text();
    deepStrictEqual(/gem:minigem@0\.2\.0 · files/.test(text), true, text);
    deepStrictEqual(/▸ lib\//.test(text), true, text);
    deepStrictEqual(/README\.md {2}[\d.]+kb/.test(text), true, text);
    // The shell layer never surfaces: no data.tar.gz, no metadata.gz.
    deepStrictEqual(/data\.tar\.gz|metadata\.gz|\.gem-shell/.test(text), false, text);
    deepStrictEqual(/lib\/mini\.rb · 4 lines/.test(text), true, text);
    deepStrictEqual(/VERSION = '0\.2\.0'/.test(text), true, text);
    await rejects(() => runInteractive('gem:nope', { cwd: tmpdir() }), /gem not found: nope/);
  } finally {
    delete process.env.BISMAR_GEMS_API;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('interactive composer ref resolves via p2 and extracts the dist zip', async () => {
  // Packagist dists are github-style zipballs: one hashed top dir, files below.
  const dist = zipOf([
    ['mini-pkg-1a2b3c/composer.json', '{\n  "name": "mini/pkg"\n}\n'],
    ['mini-pkg-1a2b3c/src/Mini.php', '<?php\nfinal class Mini {}\n'],
  ]);
  const { port, server } = await serve({
    '/dist/1.1.0.zip': () => ({ body: dist }),
    '/p2/mini/pkg.json': () => ({
      body: JSON.stringify({
        packages: {
          'mini/pkg': [
            { dist: { url: `http://127.0.0.1:${port}/dist/1.1.0.zip` }, version: '1.1.0' },
            { dist: { url: `http://127.0.0.1:${port}/dist/1.0.0.zip` }, version: '1.0.0' },
          ],
        },
      }),
      json: true,
    }),
  });
  try {
    process.env.BISMAR_COMPOSER_API = `http://127.0.0.1:${port}`;
    coldCache('composer:mini/pkg@1.1.0');
    // php: alias in, canonical composer: label out; newest version wins.
    const session = open('php:mini/pkg');
    session.send('\r\rq\x1b\x1b');
    await session.done;
    const text = session.text();
    deepStrictEqual(/composer:mini\/pkg@1\.1\.0 · files/.test(text), true, text);
    deepStrictEqual(/▸ src\//.test(text), true, text);
    deepStrictEqual(/composer\.json {2}[\d.]+kb/.test(text), true, text);
    deepStrictEqual(/src\/Mini\.php · 3 lines/.test(text), true, text);
    deepStrictEqual(/final class Mini \{\}/.test(text), true, text);
    await rejects(
      () => runInteractive('composer:mini/nope', { cwd: tmpdir() }),
      /package not found: mini\/nope.*packagist\.org/
    );
  } finally {
    delete process.env.BISMAR_COMPOSER_API;
    await closeServer(server);
  }
});

it('registry dist urls are confined to allowlisted hosts', async () => {
  // A hostile package points its dist at an off-registry host: the fetch is
  // refused by host before any bytes are read. With BISMAR_COMPOSER_API set,
  // the stand-in's own origin is allowed, so a same-origin dist still works —
  // but a cross-origin one (evil.example, or plain http elsewhere) is not.
  const dist = zipOf([['ok-1a2b3c/composer.json', '{\n  "name": "ok/pkg"\n}\n']]);
  const { port, server } = await serve({
    '/dist/ok.zip': () => ({ body: dist }),
    '/p2/evil/pkg.json': () => ({
      body: JSON.stringify({
        packages: {
          'evil/pkg': [{ dist: { url: 'https://evil.example/pkg.zip' }, version: '1.0.0' }],
        },
      }),
      json: true,
    }),
    '/p2/ok/pkg.json': () => ({
      body: JSON.stringify({
        packages: {
          'ok/pkg': [{ dist: { url: `http://127.0.0.1:${port}/dist/ok.zip` }, version: '1.0.0' }],
        },
      }),
      json: true,
    }),
  });
  try {
    process.env.BISMAR_COMPOSER_API = `http://127.0.0.1:${port}`;
    coldCache('composer:evil/pkg@1.0.0', 'composer:ok/pkg@1.0.0');
    await rejects(
      () => runInteractive('composer:evil/pkg', { cwd: tmpdir() }),
      /refusing download from unexpected host: evil\.example/
    );
    // The same-origin dist (via the override) still opens fine.
    const ok = open('composer:ok/pkg');
    ok.send('q\x1b');
    await ok.done;
    deepStrictEqual(/composer:ok\/pkg@1\.0\.0 · files/.test(ok.text()), true, ok.text());
  } finally {
    delete process.env.BISMAR_COMPOSER_API;
    await closeServer(server);
  }
});

it('js garnish ignores a tarball url on an unexpected host', async () => {
  // A packument whose tarball points off-registry: the size garnish is dropped
  // (deps still count from the doc), never surfacing as an error. The version
  // is unpublishable so the machine stats cache is never seeded for a real one.
  rmSync(join(refsRoot(), '.stats'), { force: true, recursive: true });
  const server = createServer((req, res) => {
    if (req.url === '/preact/0.0.0-bismarhost') {
      res.setHeader('content-type', 'application/json');
      return void res.end(
        JSON.stringify({
          dependencies: { a: '1' },
          dist: { tarball: 'https://evil.example/x.tgz' },
        })
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  process.env.BISMAR_NPM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Deps come through; the off-host tarball contributes no tgzBytes, no throw.
    deepStrictEqual(
      await jsHitStats('npm:', { desc: '', name: 'preact', version: '0.0.0-bismarhost' }),
      { deps: 1 }
    );
  } finally {
    delete process.env.BISMAR_NPM_API;
    await closeServer(server);
  }
});

it('interactive gh ref pins any refspec to a commit sha before caching', async () => {
  const sha = '1a2b3c4d5e6f7890123456789abcdef012345678';
  const short = sha.slice(0, 12);
  const sha256ShapedRef = 'a'.repeat(64);
  const fix = mkdtempSync(join(tmpdir(), 'bismar-gh-fix-'));
  mkdirSync(join(fix, `mini-${short}`, 'src'), { recursive: true });
  writeFileSync(join(fix, `mini-${short}`, 'README.md'), '# mini\n');
  writeFileSync(join(fix, `mini-${short}`, 'src', 'index.js'), 'export const mini = 1;\n');
  execFileSync('tar', ['-czf', join(fix, 'mini.tar.gz'), '-C', fix, `mini-${short}`]);
  const { port, server } = await serve({
    [`/octo/mini/tar.gz/${sha}`]: () => ({ body: readFileSync(join(fix, 'mini.tar.gz')) }),
    // The api returns a bare sha under the vnd.github.sha accept type.
    '/repos/octo/mini/commits/dev': () => ({ body: sha }),
    [`/repos/octo/mini/commits/${short}`]: () => ({ body: sha }),
    [`/repos/octo/mini/commits/${sha256ShapedRef}`]: () => ({ body: sha }),
    '/repos/octo/mini/commits/HEAD': () => ({ body: sha }),
  });
  try {
    process.env.BISMAR_GH_API = `http://127.0.0.1:${port}`;
    process.env.BISMAR_GH_CODELOAD = `http://127.0.0.1:${port}`;
    coldCache(`gh:octo/mini@${sha}`);
    rmSync(refsTagFile('gh:octo/mini'), { force: true });
    rmSync(refsTagFile('gh:octo/mini@dev'), { force: true });
    // No ref means HEAD; the label retains the immutable full commit id.
    const session = open('gh:octo/mini');
    session.send('q');
    await session.done;
    const text = session.text();
    deepStrictEqual(new RegExp(`github:octo/mini@${sha} · files`).test(text), true, text);
    deepStrictEqual(/README\.md {2}[\d.]+kb/.test(text), true, text);
    // Alias + explicit branch: same sha, same label, warm extract cache.
    const branch = open('github:octo/mini@dev');
    branch.send('q');
    await branch.done;
    deepStrictEqual(
      new RegExp(`github:octo/mini@${sha} · files`).test(branch.text()),
      true,
      branch.text()
    );
    // A user-supplied abbreviated SHA is still mutable/ambiguous input: resolve
    // it through the API and retain the canonical 40-character commit id.
    rmSync(refsTagFile(`gh:octo/mini@${short}`), { force: true });
    const abbreviated = open(`gh:octo/mini@${short}`);
    abbreviated.send('q');
    await abbreviated.done;
    deepStrictEqual(
      new RegExp(`github:octo/mini@${sha} · files`).test(abbreviated.text()),
      true,
      abbreviated.text()
    );
    // GitHub is SHA-1-only today: a 64-hex spelling is still resolved as a
    // refspec instead of being trusted as an immutable GitHub object id.
    rmSync(refsTagFile(`gh:octo/mini@${sha256ShapedRef}`), { force: true });
    const sha256Shaped = open(`gh:octo/mini@${sha256ShapedRef}`);
    sha256Shaped.send('q');
    await sha256Shaped.done;
    deepStrictEqual(
      new RegExp(`github:octo/mini@${sha} · files`).test(sha256Shaped.text()),
      true,
      sha256Shaped.text()
    );
    await rejects(
      () => runInteractive('gh:octo/nope', { cwd: tmpdir() }),
      /repository or ref not found: gh:octo\/nope/
    );
  } finally {
    delete process.env.BISMAR_GH_API;
    delete process.env.BISMAR_GH_CODELOAD;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('version tags stretch to double life under ttlScale (gh ref→commit pins)', () => {
  const tagFile = refsTagFile('gh:octo/ttl');
  mkdirSync(join(refsRoot(), '.tags'), { recursive: true });
  // Backdated between 1× and 2× the TTL: expired at the normal scale, still
  // live at gh's doubled one.
  writeFileSync(
    tagFile,
    JSON.stringify({
      at: Date.now() - Math.round(TAG_TTL_MS * 1.5),
      label: 'gh:octo/ttl',
      v: 2,
      version: 'abc123def4567890abc123def4567890abc123de',
    })
  );
  try {
    deepStrictEqual(readVersionTag('gh:octo/ttl'), undefined);
    deepStrictEqual(readVersionTag('gh:octo/ttl', 2), 'abc123def4567890abc123def4567890abc123de');
  } finally {
    rmSync(tagFile, { force: true });
  }
});

it('interactive gitlab ref pins any refspec to a commit sha before caching', async () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  // gitlab.com/paulmillr/git-sha256-repo-test, captured from the commits API.
  const sha256 = 'cf2cb382e176c7ff84175ec1ec0095fa7db513cda27c13ed587dd12e6e77b112';
  const short256 = sha256.slice(0, 8);
  const short = sha.slice(0, 12);
  const fix = mkdtempSync(join(tmpdir(), 'bismar-gitlab-fix-'));
  mkdirSync(join(fix, `mini-${short}`, 'src'), { recursive: true });
  writeFileSync(join(fix, `mini-${short}`, 'README.md'), '# mini\n');
  writeFileSync(join(fix, `mini-${short}`, 'src', 'index.js'), 'export const mini = 1;\n');
  execFileSync('tar', ['-czf', join(fix, 'mini.tar.gz'), '-C', fix, `mini-${short}`]);
  // Project paths reach the v4 api url-encoded; commits come back as JSON lists
  // (no ref_name reads the default branch's tip, the HEAD case).
  const commits = () => ({ body: JSON.stringify([{ id: sha }]), json: true });
  const commits256 = () => ({ body: JSON.stringify([{ id: sha256 }]), json: true });
  const { port, server } = await serve({
    [`/projects/octo%2Fmini/repository/archive.tar.gz?sha=${sha}`]: () => ({
      body: readFileSync(join(fix, 'mini.tar.gz')),
    }),
    '/projects/octo%2Fmini/repository/commits?per_page=1': commits,
    '/projects/octo%2Fmini/repository/commits?ref_name=dev&per_page=1': commits,
    [`/projects/paulmillr%2Fgit-sha256-repo-test/repository/archive.tar.gz?sha=${sha256}`]: () => ({
      body: readFileSync(join(fix, 'mini.tar.gz')),
    }),
    '/projects/paulmillr%2Fgit-sha256-repo-test/repository/commits?per_page=1': commits256,
    [`/projects/paulmillr%2Fgit-sha256-repo-test/repository/commits?ref_name=${short256}&per_page=1`]:
      commits256,
  });
  try {
    process.env.BISMAR_GITLAB_API = `http://127.0.0.1:${port}`;
    coldCache(`gitlab:octo/mini@${sha}`);
    coldCache(`gitlab:paulmillr/git-sha256-repo-test@${sha256}`);
    rmSync(refsTagFile('gitlab:octo/mini'), { force: true });
    rmSync(refsTagFile('gitlab:octo/mini@dev'), { force: true });
    // No ref means the default branch; the label retains the immutable full commit id.
    const session = open('gitlab:octo/mini');
    session.send('q');
    await session.done;
    const text = session.text();
    deepStrictEqual(new RegExp(`gitlab:octo/mini@${sha} · files`).test(text), true, text);
    deepStrictEqual(/README\.md {2}[\d.]+kb/.test(text), true, text);
    // Explicit branch: same sha, same label, warm extract cache.
    const branch = open('gitlab:octo/mini@dev');
    branch.send('q');
    await branch.done;
    deepStrictEqual(
      new RegExp(`gitlab:octo/mini@${sha} · files`).test(branch.text()),
      true,
      branch.text()
    );
    // GitLab supports both Git object formats. A canonical SHA-256 id is
    // already immutable and goes straight to the archive endpoint; a default
    // branch whose API pin returns the same 64-character id is accepted too.
    const exact256 = open(`gitlab:paulmillr/git-sha256-repo-test@${sha256}`, tmpdir(), 160);
    exact256.send('q');
    await exact256.done;
    deepStrictEqual(
      new RegExp(`gitlab:paulmillr/git-sha256-repo-test@${sha256} · files`).test(exact256.text()),
      true,
      exact256.text()
    );
    const head256 = open('gitlab:paulmillr/git-sha256-repo-test', tmpdir(), 160);
    head256.send('q');
    await head256.done;
    deepStrictEqual(
      new RegExp(`gitlab:paulmillr/git-sha256-repo-test@${sha256} · files`).test(head256.text()),
      true,
      head256.text()
    );
    rmSync(refsTagFile(`gitlab:paulmillr/git-sha256-repo-test@${short256}`), { force: true });
    const abbreviated256 = open(`gitlab:paulmillr/git-sha256-repo-test@${short256}`, tmpdir(), 160);
    abbreviated256.send('q');
    await abbreviated256.done;
    deepStrictEqual(
      new RegExp(`gitlab:paulmillr/git-sha256-repo-test@${sha256} · files`).test(
        abbreviated256.text()
      ),
      true,
      abbreviated256.text()
    );
    await rejects(
      () => runInteractive('gitlab:octo/nope', { cwd: tmpdir() }),
      /repository or ref not found: gitlab:octo\/nope/
    );
  } finally {
    delete process.env.BISMAR_GITLAB_API;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('files view jumps to the github repo named by package.json and back', async () => {
  const sha = 'fedcba9876543210fedcba9876543210fedcba98';
  const short = sha.slice(0, 12);
  const fix = mkdtempSync(join(tmpdir(), 'bismar-repo-fix-'));
  // A local JS package whose manifest names a github repo…
  const pkgDir = join(fix, 'pkg');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    `${JSON.stringify({
      main: './index.js',
      name: '@bismar-test/repo-jump',
      private: true,
      repository: 'github:octo/mini',
      type: 'module',
      version: '1.0.0',
    })}\n`
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export const a = 1;\n');
  // …and the repo tree itself, carrying files the npm tarball would strip.
  mkdirSync(join(fix, `mini-${short}`, 'docs'), { recursive: true });
  writeFileSync(join(fix, `mini-${short}`, 'README.md'), '# mini repo\n');
  writeFileSync(join(fix, `mini-${short}`, 'docs', 'notes.md'), 'repo-only notes\n');
  execFileSync('tar', ['-czf', join(fix, 'repo.tar.gz'), '-C', fix, `mini-${short}`]);
  const { port, server } = await serve({
    [`/octo/mini/tar.gz/${sha}`]: () => ({ body: readFileSync(join(fix, 'repo.tar.gz')) }),
    '/repos/octo/mini/commits/HEAD': () => ({ body: sha }),
  });
  try {
    process.env.BISMAR_GH_API = `http://127.0.0.1:${port}`;
    process.env.BISMAR_GH_CODELOAD = `http://127.0.0.1:${port}`;
    coldCache(`gh:octo/mini@${sha}`);
    const session = open(undefined, pkgDir);
    session.send('r\x1bq');
    await session.done;
    const text = session.text();
    // The home files view advertises the jump, naming where it lands…
    deepStrictEqual(/· m mode \(bundles\) · r github/.test(text), true, text);
    // …r lands in the pinned repo tree, with repo-only files on show…
    deepStrictEqual(new RegExp(`github:octo/mini@${sha} · files`).test(text), true, text);
    deepStrictEqual(/▸ docs\//.test(text), true, text);
    // …where the hint names the way back by the package's own ecosystem.
    const repoFrame =
      session
        .raw()
        .split('\x1b[H')
        .map(strip)
        .find((f) => /▸ docs\//.test(f)) ?? '';
    deepStrictEqual(/· m mode \(bundles\) · r get back to npm/.test(repoFrame), true, repoFrame);
    // …and esc at the repo root returns to the package side, not out of the app.
    const last = strip(session.raw().split('\x1b[H').pop() ?? '');
    deepStrictEqual(/@bismar-test\/repo-jump · files/.test(last), true, last);
  } finally {
    delete process.env.BISMAR_GH_API;
    delete process.env.BISMAR_GH_CODELOAD;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('files view jumps from a registry extract to the repo its manifest names', async () => {
  // The same hop, with no package.json anywhere: a crate extract names its
  // repository in Cargo.toml, and the gh: side carries what the archive strips.
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const short = sha.slice(0, 12);
  const fix = mkdtempSync(join(tmpdir(), 'bismar-crate-repo-'));
  mkdirSync(join(fix, 'mini-0.2.0', 'src'), { recursive: true });
  writeFileSync(
    join(fix, 'mini-0.2.0', 'Cargo.toml'),
    '[package]\nname = "mini"\nversion = "0.2.0"\nrepository = "https://github.com/rusty/mini.git"\n'
  );
  writeFileSync(join(fix, 'mini-0.2.0', 'src', 'lib.rs'), 'pub fn x() {}\n');
  execFileSync('tar', ['-czf', join(fix, 'mini.crate'), '-C', fix, 'mini-0.2.0']);
  mkdirSync(join(fix, `mini-${short}`, 'benches'), { recursive: true });
  writeFileSync(join(fix, `mini-${short}`, 'benches', 'bench.rs'), 'fn main() {}\n');
  writeFileSync(join(fix, `mini-${short}`, 'README.md'), '# mini\n');
  execFileSync('tar', ['-czf', join(fix, 'repo.tar.gz'), '-C', fix, `mini-${short}`]);
  const { port, server } = await serve({
    '/api/v1/crates/mini/0.2.0/download': () => ({ body: readFileSync(join(fix, 'mini.crate')) }),
    '/repos/rusty/mini/commits/HEAD': () => ({ body: sha }),
    [`/rusty/mini/tar.gz/${sha}`]: () => ({ body: readFileSync(join(fix, 'repo.tar.gz')) }),
  });
  try {
    process.env.BISMAR_CRATES_API = `http://127.0.0.1:${port}`;
    process.env.BISMAR_GH_API = `http://127.0.0.1:${port}`;
    process.env.BISMAR_GH_CODELOAD = `http://127.0.0.1:${port}`;
    coldCache('crate:mini@0.2.0', `gh:rusty/mini@${sha}`);
    const session = open('crate:mini@0.2.0');
    session.send('r\x1bq');
    await session.done;
    const text = session.text();
    // Files-only sessions have no mode toggle, so the jump stands alone…
    deepStrictEqual(/← up · r github · q quit/.test(text), true, text);
    // …r lands in the pinned repo tree, with repo-only files on show…
    deepStrictEqual(new RegExp(`github:rusty/mini@${sha} · files`).test(text), true, text);
    deepStrictEqual(/▸ benches\//.test(text), true, text);
    // …where the way back is labelled by the ecosystem that named the repo.
    const repoFrame =
      session
        .raw()
        .split('\x1b[H')
        .map(strip)
        .find((f) => /▸ benches\//.test(f)) ?? '';
    // On the repo side q ≡ esc backs to the crate side, so the hint says so.
    deepStrictEqual(/← up · r get back to crate · q back/.test(repoFrame), true, repoFrame);
    // …and esc at the repo root returns to the crate side, not out of the app.
    const last = strip(session.raw().split('\x1b[H').pop() ?? '');
    deepStrictEqual(/crate:mini@0\.2\.0 · files/.test(last), true, last);
  } finally {
    delete process.env.BISMAR_CRATES_API;
    delete process.env.BISMAR_GH_API;
    delete process.env.BISMAR_GH_CODELOAD;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('interactive go ref unwinds the nested import path of module zips', async () => {
  // Go module zips nest every file under module@version/…; the sole-directory
  // descent must unwind the whole chain (golang.org → x → mini@v0.5.0).
  const modZip = zipOf([
    ['golang.org/x/mini@v0.5.0/go.mod', 'module golang.org/x/mini\n'],
    ['golang.org/x/mini@v0.5.0/mini.go', 'package mini\n\nconst V = "0.5.0"\n'],
  ]);
  const { port, server } = await serve({
    '/golang.org/x/mini/@latest': () => ({
      body: JSON.stringify({ Version: 'v0.5.0' }),
      json: true,
    }),
    '/golang.org/x/mini/@v/v0.5.0.zip': () => ({ body: modZip }),
  });
  try {
    process.env.BISMAR_GO_PROXY = `http://127.0.0.1:${port}`;
    coldCache('go:golang.org/x/mini@v0.5.0');
    const session = open('go:golang.org/x/mini');
    session.send('\rq\x1b');
    await session.done;
    const text = session.text();
    deepStrictEqual(/go:golang\.org\/x\/mini@v0\.5\.0 · files/.test(text), true, text);
    deepStrictEqual(/▸ go\.mod {2}[\d.]+kb/.test(text), true, text);
    deepStrictEqual(/go\.mod · 2 lines/.test(text), true, text);
    deepStrictEqual(/module golang\.org\/x\/mini/.test(text), true, text);
    // The v-less pinned spelling canonicalizes and hits the same warm cache.
    const vless = open('golang:golang.org/x/mini@0.5.0');
    vless.send('q');
    await vless.done;
    deepStrictEqual(
      /go:golang\.org\/x\/mini@v0\.5\.0 · files/.test(vless.text()),
      true,
      vless.text()
    );
    // Unknown modules (the real proxy answers 410 Gone) read as not-found.
    await rejects(
      () => runInteractive('go:x.org/nope', { cwd: tmpdir() }),
      /module not found: x\.org\/nope.*pkg\.go\.dev/
    );
  } finally {
    delete process.env.BISMAR_GO_PROXY;
    await closeServer(server);
  }
});

it('interactive pypi ref prefers sdists and falls back to wheel zips', async () => {
  // 0.3.0 publishes sdist + wheel (sdist must win: tars carry the readable tree);
  // 0.4.0 is wheel-only and exercises the zip reader end to end.
  const fix = mkdtempSync(join(tmpdir(), 'bismar-pypi-fix-'));
  mkdirSync(join(fix, 'mini_py-0.3.0', 'mini_py'), { recursive: true });
  writeFileSync(join(fix, 'mini_py-0.3.0', 'PKG-INFO'), 'Name: mini-py\nVersion: 0.3.0\n');
  writeFileSync(join(fix, 'mini_py-0.3.0', 'mini_py', '__init__.py'), 'VERSION = "0.3.0"\n');
  execFileSync('tar', ['-czf', join(fix, 'sdist.tar.gz'), '-C', fix, 'mini_py-0.3.0']);
  const wheel = zipOf([
    ['mini_py/__init__.py', 'VERSION = "0.4.0"\n'],
    ['mini_py-0.4.0.dist-info/METADATA', 'Name: mini-py\nVersion: 0.4.0\n'],
  ]);
  const at = (path: string): string => `http://127.0.0.1:${port}${path}`;
  const { port, server } = await serve({
    '/files/mini_py-0.3.0.tar.gz': () => ({ body: readFileSync(join(fix, 'sdist.tar.gz')) }),
    '/files/mini_py-0.4.0-py3-none-any.whl': () => ({ body: wheel }),
    '/pypi/mini-py/0.3.0/json': () => ({
      body: JSON.stringify({
        urls: [
          {
            filename: 'mini_py-0.4.0-py3-none-any.whl',
            packagetype: 'bdist_wheel',
            url: at('/files/mini_py-0.4.0-py3-none-any.whl'),
          },
          {
            filename: 'mini_py-0.3.0.tar.gz',
            packagetype: 'sdist',
            url: at('/files/mini_py-0.3.0.tar.gz'),
          },
        ],
      }),
      json: true,
    }),
    '/pypi/mini-py/0.4.0/json': () => ({
      body: JSON.stringify({
        urls: [
          {
            filename: 'mini_py-0.4.0-py3-none-any.whl',
            packagetype: 'bdist_wheel',
            url: at('/files/mini_py-0.4.0-py3-none-any.whl'),
          },
        ],
      }),
      json: true,
    }),
    '/pypi/mini-py/json': () => ({
      body: JSON.stringify({ info: { version: '0.3.0' } }),
      json: true,
    }),
  });
  try {
    process.env.BISMAR_PYPI_API = `http://127.0.0.1:${port}`;
    coldCache('pypi:mini-py@0.3.0', 'pypi:mini-py@0.4.0');

    // Versionless resolves to 0.3.0 and lands in the sdist tree (PKG-INFO at root).
    const sdist = open('pypi:mini-py');
    sdist.send('q');
    await sdist.done;
    const sdistText = sdist.text();
    deepStrictEqual(/pypi:mini-py@0\.3\.0 · files/.test(sdistText), true, sdistText);
    deepStrictEqual(/PKG-INFO {2}[\d.]+kb/.test(sdistText), true, sdistText);

    // Pinned wheel-only release: the zip extracts, python sources preview.
    const whl = open('pypi:mini-py@0.4.0');
    whl.send('\r\rq\x1b\x1b');
    await whl.done;
    const text = whl.text();
    deepStrictEqual(/pypi:mini-py@0\.4\.0 · files/.test(text), true, text);
    deepStrictEqual(/▸ mini_py\//.test(text), true, text);
    deepStrictEqual(/mini_py-0\.4\.0\.dist-info\//.test(text), true, text);
    deepStrictEqual(/mini_py\/__init__\.py · 2 lines/.test(text), true, text);
    deepStrictEqual(/VERSION = "0\.4\.0"/.test(text), true, text);
    await rejects(() => runInteractive('pypi:nope', { cwd: tmpdir() }), /package not found: nope/);
  } finally {
    delete process.env.BISMAR_PYPI_API;
    await closeServer(server);
    rmSync(fix, { force: true, recursive: true });
  }
});

it('the wrapped fetch refuses hosts outside the registry allowlist pre-send', async () => {
  // A registry answer that redirects off the known-host set must die BEFORE
  // any request leaves: redirects are followed hop by hop (follow()), so the
  // allowedHosts check runs pre-send on every hop. The victim listens on an
  // unlisted port and must see zero requests — erroring after contacting it
  // would pass a naive error assert while still leaking the probe.
  let victimHits = 0;
  const victim = createServer((_req, res) => {
    victimHits++;
    res.end('leaked');
  });
  await new Promise<void>((res) => victim.listen(0, '127.0.0.1', res));
  const victimUrl = `http://127.0.0.1:${(victim.address() as AddressInfo).port}/steal`;
  const bouncer = createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', victimUrl);
    res.end();
  });
  await new Promise<void>((res) => bouncer.listen(0, '127.0.0.1', res));
  const prev = process.env.BISMAR_CRATES_API;
  process.env.BISMAR_CRATES_API = `http://127.0.0.1:${(bouncer.address() as AddressInfo).port}`;
  try {
    await rejects(() => searchRegistry('crate:', 'serde'), /host not allowed: 127\.0\.0\.1:/);
    deepStrictEqual(victimHits, 0, 'the disallowed host must never be contacted');
  } finally {
    if (prev === undefined) delete process.env.BISMAR_CRATES_API;
    else process.env.BISMAR_CRATES_API = prev;
    await closeServer(bouncer);
    await closeServer(victim);
  }
});

it('profile refs parse, list via registry apis, and print piped', async () => {
  // `prefix:@user` is a profile; only a bare user head qualifies.
  deepStrictEqual(parseProfileRef('gh:@visionmedia'), { prefix: 'gh:', user: 'visionmedia' });
  // Multi-segment-name registries read a bare single segment as a profile too.
  deepStrictEqual(parseProfileRef('gh:visionmedia'), { prefix: 'gh:', user: 'visionmedia' });
  deepStrictEqual(parseProfileRef('gitlab:inkscape'), { prefix: 'gitlab:', user: 'inkscape' });
  deepStrictEqual(parseProfileRef('composer:monolog'), { prefix: 'composer:', user: 'monolog' });
  // …while single-segment-name registries keep requiring the sigil.
  deepStrictEqual(parseProfileRef('crate:serde'), undefined);
  deepStrictEqual(parseProfileRef('npm:qr'), undefined);
  deepStrictEqual(parseProfileRef('rs:@dtolnay'), { prefix: 'crate:', user: 'dtolnay' });
  deepStrictEqual(parseProfileRef('npm:@noble'), { prefix: 'npm:', user: 'noble' });
  deepStrictEqual(parseProfileRef('jsr:@std'), { prefix: 'jsr:', user: 'std' });
  deepStrictEqual(parseProfileRef('npm:@scope/name'), undefined);
  deepStrictEqual(parseProfileRef('gh:@a@main'), undefined);
  deepStrictEqual(parseProfileRef('gh:@'), undefined);
  deepStrictEqual(parseProfileRef('lodash'), undefined);
  // pypi parses as a namespace but has no profile api behind it.
  await rejects(() => profileHits('pypi:', 'x'), /no profile listing behind pypi:/);
  let ghProfileFetches = 0;
  const { port, server } = await serve({
    '/api/v1/users/vision': () => ({ body: JSON.stringify({ user: { id: 7 } }), json: true }),
    '/api/v1/crates?user_id=7&per_page=25&sort=recent-updates': () => ({
      body: JSON.stringify({
        crates: [
          { description: 'QR toolkit', max_stable_version: '1.2.3', name: 'vision-qr' },
          { description: null, max_version: '0.1.0', name: 'vision-x' },
        ],
      }),
      json: true,
    }),
    '/-/v1/search?text=maintainer%3Anoble&size=25': () => ({
      body: JSON.stringify({ objects: [] }),
      json: true,
    }),
    // gh profiles go through the search api: star-sorted in one request.
    '/search/repositories?q=user%3Avision&sort=stars&per_page=25': () => {
      ghProfileFetches++;
      return {
        body: JSON.stringify({
          items: [
            { description: 'Popular', full_name: 'vision/big', stargazers_count: 900 },
            { description: null, full_name: 'vision/small', stargazers_count: 3 },
          ],
        }),
        json: true,
      };
    },
    '/-/v1/search?text=%40noble%2F&size=250': () => ({
      body: JSON.stringify({
        objects: [
          { package: { name: '@noble/hashes', version: '2.3.0' } },
          { package: { name: 'noble-other', version: '1.0.0' } },
        ],
      }),
      json: true,
    }),
  });
  const csApi = process.env.BISMAR_CRATES_API;
  const npmApi = process.env.BISMAR_NPM_API;
  const ghApi = process.env.BISMAR_GH_API;
  process.env.BISMAR_CRATES_API = `http://127.0.0.1:${port}`;
  process.env.BISMAR_NPM_API = `http://127.0.0.1:${port}`;
  process.env.BISMAR_GH_API = `http://127.0.0.1:${port}`;
  rmSync(join(refsRoot(), '.profiles'), { force: true, recursive: true });
  try {
    const ghHits = [
      { desc: 'Popular', name: 'vision/big', version: '900★' },
      { desc: '', name: 'vision/small', version: '3★' },
    ];
    deepStrictEqual(await profileHits('gh:', 'vision'), ghHits);
    deepStrictEqual(ghProfileFetches, 1);
    // gh listings cache machine-wide: a repeat within the TTL skips the api.
    deepStrictEqual(await profileHits('gh:', 'vision'), ghHits);
    deepStrictEqual(ghProfileFetches, 1);
    // An expired stamp (past 2× the version-tag TTL) refetches...
    const profileFile = join(refsRoot(), '.profiles', `${cacheKey('gh:vision')}.json`);
    writeFileSync(
      profileFile,
      JSON.stringify({ at: Date.now() - 31 * 60_000, hits: ghHits, label: 'gh:vision', v: 2 })
    );
    deepStrictEqual(await profileHits('gh:', 'vision'), ghHits);
    deepStrictEqual(ghProfileFetches, 2);
    // ...and so does any mangled row: surprises are cache misses, never errors.
    writeFileSync(
      profileFile,
      JSON.stringify({ at: Date.now(), hits: [{ name: 5 }], label: 'gh:vision', v: 2 })
    );
    deepStrictEqual(await profileHits('gh:', 'vision'), ghHits);
    deepStrictEqual(ghProfileFetches, 3);
    // BISMAR_LOG appends one line per network request, read per call.
    const logFile = join(tmpdir(), 'bismar-test-net-log.txt');
    rmSync(logFile, { force: true });
    process.env.BISMAR_LOG = logFile;
    try {
      await profileHits('crate:', 'vision');
      const logged = readFileSync(logFile, 'utf8');
      deepStrictEqual(
        /^\S+ GET http:\/\/127\.0\.0\.1:\d+\/api\/v1\/users\/vision$/m.test(logged),
        true,
        logged
      );
      deepStrictEqual(/GET .*crates\?user_id=7/.test(logged), true, logged);
    } finally {
      delete process.env.BISMAR_LOG;
      rmSync(logFile, { force: true });
    }
    // crates.io keys listings by numeric user id: two hops, one listing.
    deepStrictEqual(await profileHits('crate:', 'vision'), [
      { desc: 'QR toolkit', name: 'vision-qr', version: '1.2.3' },
      { desc: '', name: 'vision-x', version: '0.1.0' },
    ]);
    // npm `@x`: maintained packages first; a scope with no such maintainer
    // falls back to a text search filtered to exact scope members.
    deepStrictEqual(await profileHits('npm:', 'noble'), [
      { desc: '', name: '@noble/hashes', version: '2.3.0' },
    ]);
    // Piped, the flagless profile prints bounded name,version,desc rows.
    const prevLog = console.log;
    let out = '';
    console.log = (...args: unknown[]) => {
      out += `${args.join(' ')}\n`;
    };
    try {
      await runCli(['crate:@vision'], { tty: false });
    } finally {
      console.log = prevLog;
    }
    deepStrictEqual(out, 'vision-qr,1.2.3,QR toolkit\nvision-x,0.1.0,\n');
  } finally {
    if (csApi === undefined) delete process.env.BISMAR_CRATES_API;
    else process.env.BISMAR_CRATES_API = csApi;
    if (npmApi === undefined) delete process.env.BISMAR_NPM_API;
    else process.env.BISMAR_NPM_API = npmApi;
    if (ghApi === undefined) delete process.env.BISMAR_GH_API;
    else process.env.BISMAR_GH_API = ghApi;
    await closeServer(server);
  }
});
