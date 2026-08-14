// Tests for the `bismar` binary's `size` command; `bismar bundle` in bundle.test.ts.
import { deepStrictEqual } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test as it } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const BASE = resolve('.');
const ROOT = join(BASE, 'test/vectors');
process.env.npm_config_audit = 'false';
process.env.npm_config_fund = 'false';
process.env.npm_config_loglevel = 'silent';
process.env.npm_config_progress = 'false';
process.env.npm_config_update_notifier = 'false';
const { runCli: runBismar } = await import('../src/bismar.ts');
const { npmInstall } = await import('../src/fs-modify.ts');
const {
  foreignSelector,
  refsCacheDir,
  refsMetaFile,
  refsTagFile,
  writeCacheIdentity,
  writeVersionTag,
} = await import('../src/refs.ts');
const { buildFirst, fillExports, loadEsbuild, measureRows, readModules, runSize } = await import(
  '../src/size.ts'
);

const fixture = (name: string) => join(ROOT, name);
const cleanup = (cwd: string) => {
  const build = join(cwd, 'test/build');
  rmSync(join(build, 'node_modules'), { force: true, recursive: true });
  rmSync(join(build, 'package-lock.json'), { force: true });
  if (!existsSync(build)) return;
  for (const ent of readdirSync(build))
    if (ent.startsWith('.__')) rmSync(join(build, ent), { force: true, recursive: true });
};
const capture = async (fn: () => Promise<void>) => {
  const prevLog = console.log;
  const prevErr = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...args) => {
    stdout += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.map((arg) => String(arg)).join(' ')}\n`;
  };
  try {
    await fn();
    return { error: undefined, ok: true, stderr, stdout };
  } catch (error) {
    stderr += `${(error as Error).message}\n`;
    return { error: error as Error, ok: false, stderr, stdout };
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
};
const run = async (cwd: string, fn: () => Promise<void>) => {
  cleanup(cwd);
  const res = await capture(fn);
  cleanup(cwd);
  return res;
};
const all = (res: { stderr: string; stdout: string }) =>
  [res.stdout, res.stderr].filter(Boolean).join('\n');
const plain = (res: { stderr: string; stdout: string }) =>
  all(res).replace(/\x1b\[\d+(;\d+)*m/g, '');
const withEnv = async <T>(key: string, value: string | undefined, fn: () => Promise<T>) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

it('size command prints stats even with JSBT_QUIET and skips the audit', async () => {
  const cwd = fixture('documented');
  const res = await withEnv('JSBT_QUIET', '1', () =>
    run(cwd, () => runBismar(['-bs'], { color: false, cwd }))
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/module,export/.test(out), false, out);
  deepStrictEqual(/@bismar-test\/documented,,/.test(out), true, out);
  deepStrictEqual(/,_internal,/.test(out), false, out);
  deepStrictEqual(/bundle_path|_tree_shaking_|%/.test(res.stdout), false, out);
  deepStrictEqual(/\[(?:ERROR|WARN)\]/.test(out), false, out);
  deepStrictEqual(/checks? (?:started|finished)/.test(out), false, out);
  deepStrictEqual(/Tip:/.test(out), false, out);
});

it('size command selector rows are in-memory only', async () => {
  const cwd = fixture('documented');
  const res = await run(cwd, () => runBismar(['-bs', 'index'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/module,export/.test(out), false, out);
  deepStrictEqual(/index,,\d+loc,/.test(out), true, out);
  deepStrictEqual(/bundle_path|\/tmp\//.test(out), false, out);
  // Nothing is kept: the flag is gone along with the files.
  const legacy = await run(cwd, () => runBismar(['-bs', '--keep'], { color: false, cwd }));
  deepStrictEqual(legacy.ok, false);
  deepStrictEqual(/unknown option: --keep/.test(plain(legacy)), true, plain(legacy));
});

it('size command works without a test/build template', async () => {
  const cwd = fixture('plain');
  try {
    const res = await run(cwd, () => runBismar(['-bs'], { color: false, cwd }));
    const out = plain(res);
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/module,export/.test(out), false, out);
    deepStrictEqual(/@bismar-test\/plain,,/.test(out), true, out);
    // Output is unsorted: natural order puts the package row first. Sorting is
    // the shell's job over the CSV, e.g. `| sort -t, -k4 -rn`.
    deepStrictEqual(out.indexOf('@bismar-test/plain,,') < out.indexOf('index,add,'), true, out);
    const badSort = await run(cwd, () => runBismar(['-bs', '--sort=gzip'], { color: false, cwd }));
    deepStrictEqual(badSort.ok, false);
    deepStrictEqual(/unknown option: --sort=gzip/.test(plain(badSort)), true, plain(badSort));
    deepStrictEqual(/,_internal,/.test(out), false, out);
    // `_underscore`-prefixed subpath exports are internal too and get no module rows.
    deepStrictEqual(/_priv/.test(out), false, out);
    // Machine mode carries raw bytes only; the data-heavy marker is table-only.
    deepStrictEqual(/data-heavy/.test(out), false, out);
    const tableRes = await withEnv('FORCE_COLOR', '1', () =>
      run(cwd, () => runBismar(['-bs'], { cwd }))
    );
    const tableOut = plain(tableRes);
    deepStrictEqual(tableRes.ok, true, all(tableRes));
    // The incompressible base64 blob makes its rows big and poorly compressible.
    deepStrictEqual(/blob.*data-heavy/.test(tableOut), true, tableOut);
    deepStrictEqual(/add.*data-heavy/.test(tableOut), false, tableOut);
  } finally {
    rmSync(join(cwd, 'node_modules'), { force: true, recursive: true });
    rmSync(join(cwd, 'package-lock.json'), { force: true });
  }
});

it('size command needs no dependencies installed in the target repo', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-size-no-deps-'));
  try {
    // No node_modules at all: esbuild resolves near bismar itself (it's a real
    // dependency) and export enumeration needs no typescript.
    writeFileSync(
      join(cwd, 'package.json'),
      `${JSON.stringify(
        {
          main: './index.js',
          module: './index.js',
          name: '@bismar-test/no-deps',
          private: true,
          sideEffects: false,
          type: 'module',
          version: '1.0.0',
        },
        undefined,
        2
      )}\n`
    );
    writeFileSync(join(cwd, 'index.js'), 'export const add = (a, b) => a + b;\n');
    const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
    const out = plain(res);
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/@bismar-test\/no-deps,,/.test(out), true, out);
    deepStrictEqual(/index,add,/.test(out), true, out);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

it('size command filters specific module/export paths', async () => {
  const cwd = fixture('plain');
  const res = await capture(() => runBismar(['-bs', 'index/add'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/module,export/.test(out), false, out);
  deepStrictEqual(/index,add,\d+loc,/.test(out), true, out);
  deepStrictEqual(/index,,|,blob,/.test(out), false, out);

  // Selectors accept extensions, package-name prefixes, and bare modules.
  for (const spec of ['index.js/add', 'index.ts/add', '@bismar-test/plain/index.js/add']) {
    const alias = await capture(() => runBismar(['-bs', spec], { color: false, cwd }));
    const aout = plain(alias);
    deepStrictEqual(alias.ok, true, `${spec}\n${all(alias)}`);
    deepStrictEqual(/index,add,/.test(aout), true, `${spec}\n${aout}`);
  }
  // `./` is no longer module sugar: it addresses the file itself, and rows keep
  // the selector's own spelling.
  const file = await capture(() => runBismar(['-bs', './index.js/add'], { color: false, cwd }));
  const fout = plain(file);
  deepStrictEqual(file.ok, true, all(file));
  deepStrictEqual(/\.\/index\.js,add,\d+loc,/.test(fout), true, fout);
  const bare = await capture(() => runBismar(['-bs', 'index'], { color: false, cwd }));
  const bout = plain(bare);
  deepStrictEqual(bare.ok, true, all(bare));
  deepStrictEqual(/index,,\d/.test(bout), true, bout);

  const multi = await capture(() =>
    runBismar(['-bs', 'index/add', 'index/blob'], { color: false, cwd })
  );
  const mout = plain(multi);
  deepStrictEqual(multi.ok, true, all(multi));
  deepStrictEqual(/selection,,\d+loc,/.test(mout), true, mout);
  deepStrictEqual(/index,add,/.test(mout), true, mout);
  deepStrictEqual(/index,blob,/.test(mout), true, mout);

  // Wrong export names surface from esbuild during bundling (enumeration is skipped).
  const bad = await capture(() => runBismar(['-bs', 'index/nope'], { color: false, cwd }));
  deepStrictEqual(bad.ok, false);
  deepStrictEqual(
    /index has no export: nope; use one of:\nindex\/add\nindex\/blob/.test(plain(bad)),
    true,
    plain(bad)
  );
  // No dangling table/CSV header when the selector fails.
  deepStrictEqual(/module,export/.test(plain(bad)), false, plain(bad));
  // Dash-typos in export names get caught before esbuild sees invalid syntax.
  const dashed = await capture(() => runBismar(['-bs', 'index/some-name'], { color: false, cwd }));
  deepStrictEqual(dashed.ok, false);
  deepStrictEqual(
    /invalid export name: some-name .*did you mean index\/some_name\?/.test(plain(dashed)),
    true,
    plain(dashed)
  );
  // A bare name that is not a local module but not a valid npm name either stays a
  // local unknown-module error (valid names fall through to the registry instead).
  const badMod = await capture(() => runBismar(['-bs', 'nope!'], { color: false, cwd }));
  deepStrictEqual(badMod.ok, false);
  deepStrictEqual(
    /unknown module: "nope!"; use one of:\nindex/.test(plain(badMod)),
    true,
    plain(badMod)
  );
});

it('size command keeps bare names local and hints the npm: prefix', async () => {
  const cwd = fixture('plain');
  // Registry access is explicit: a bare unscoped name stays a local error, with
  // the prefixed spelling suggested when the name could exist on the registry.
  const bare = await capture(() => runBismar(['-bs', 'nopemod/whatever'], { color: false, cwd }));
  deepStrictEqual(bare.ok, false);
  deepStrictEqual(/unknown module: "nopemod"/.test(plain(bare)), true, plain(bare));
  deepStrictEqual(
    /or npm:nopemod\/whatever for the registry package/.test(plain(bare)),
    true,
    plain(bare)
  );
  // The explicit prefix still routes to npm — prove it via an unreachable
  // registry and a cold cache, keeping the test offline.
  const cache = mkdtempSync(join(tmpdir(), 'bismar-size-cache-'));
  try {
    const res = await withEnv('npm_config_cache', cache, () =>
      withEnv('npm_config_registry', 'http://127.0.0.1:9', () =>
        withEnv('npm_config_fetch_retries', '0', () =>
          withEnv('npm_config_fetch_retry_maxtimeout', '100', () =>
            capture(() => runBismar(['-bs', 'npm:nopemod/whatever'], { color: false, cwd }))
          )
        )
      )
    );
    deepStrictEqual(res.ok, false);
    deepStrictEqual(/installing npm ref nopemod failed/.test(plain(res)), true, plain(res));
  } finally {
    rmSync(cache, { force: true, recursive: true });
  }
});

it('size command resolves jsr refs via the jsr registry scope', async () => {
  const cwd = fixture('plain');
  // Malformed refs fail fast, offline: jsr names are always scoped.
  const bare = await capture(() => runBismar(['-bs', 'jsr:noscope'], { color: false, cwd }));
  deepStrictEqual(bare.ok, false);
  deepStrictEqual(
    /invalid jsr ref: jsr:noscope; use jsr:@scope\/name@version\/module\/export/.test(plain(bare)),
    true,
    plain(bare)
  );
  // Installs route through the @jsr scope registry (env-overridable): prove it via
  // an unreachable registry and a cold cache, keeping the test offline.
  const cache = mkdtempSync(join(tmpdir(), 'bismar-size-cache-'));
  try {
    const res = await withEnv('BISMAR_JSR_REGISTRY', 'http://127.0.0.1:9', () =>
      withEnv('npm_config_cache', cache, () =>
        withEnv('npm_config_fetch_retries', '0', () =>
          withEnv('npm_config_fetch_retry_maxtimeout', '100', () =>
            capture(() => runBismar(['-bs', 'jsr:@bismar-test/nope'], { color: false, cwd }))
          )
        )
      )
    );
    deepStrictEqual(res.ok, false);
    deepStrictEqual(
      /installing jsr ref jsr:@bismar-test\/nope failed/.test(plain(res)),
      true,
      plain(res)
    );
  } finally {
    rmSync(cache, { force: true, recursive: true });
  }
});

it('size command gives friendly hints for selector slips', async () => {
  const cwd = fixture('plain');
  // A mistyped module extension is neither an export name nor an unknown module.
  const typo = await capture(() => runBismar(['-bs', 'index.t2/add'], { color: false, cwd }));
  deepStrictEqual(typo.ok, false);
  deepStrictEqual(
    /unknown module: index\.t2; did you mean index\/add\?/.test(plain(typo)),
    true,
    plain(typo)
  );
  // Same for npm refs, in copy-pasteable selector form (tsdoc is cached by other tests).
  const refTypo = await capture(() =>
    runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0/index.t2'], { color: false, cwd })
  );
  deepStrictEqual(refTypo.ok, false);
  deepStrictEqual(
    /unknown module: index\.t2; did you mean @microsoft\/tsdoc@0\.16\.0\?/.test(plain(refTypo)),
    true,
    plain(refTypo)
  );
  // An explicit extension names a module; a bogus one lists modules instead of being
  // retried as a root export (`invalid export name: 123456.js` would be nonsense).
  const extMod = await capture(() =>
    runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0/123456.js'], { color: false, cwd })
  );
  deepStrictEqual(extMod.ok, false);
  deepStrictEqual(
    /unknown module: 123456; use one of:\n@microsoft\/tsdoc@0\.16\.0$/m.test(plain(extMod)),
    true,
    plain(extMod)
  );
  // The same bogus filter on --list errors too instead of printing nothing.
  const extList = await capture(() =>
    runBismar(['--list', 'npm:@microsoft/tsdoc@0.16.0/123456.js'], { color: false, cwd })
  );
  deepStrictEqual(extList.ok, false);
  deepStrictEqual(
    /unknown module: 123456; use one of:\n@microsoft\/tsdoc@0\.16\.0$/m.test(plain(extList)),
    true,
    plain(extList)
  );
  const localList = await capture(() => runBismar(['--list', 'nope!mod'], { color: false, cwd }));
  deepStrictEqual(localList.ok, false);
  deepStrictEqual(
    /unknown module: "nope!mod"; use one of:\nindex/.test(plain(localList)),
    true,
    plain(localList)
  );
  // Slash slips are harmless: trailing slash means the module, doubles collapse.
  const trailing = await capture(() => runBismar(['-bs', 'index/'], { color: false, cwd }));
  deepStrictEqual(trailing.ok, true, all(trailing));
  deepStrictEqual(/index,,\d/.test(plain(trailing)), true, plain(trailing));
  const doubled = await capture(() => runBismar(['-bs', 'index//add'], { color: false, cwd }));
  deepStrictEqual(doubled.ok, true, all(doubled));
  deepStrictEqual(/index,add,\d/.test(plain(doubled)), true, plain(doubled));
});

// Scratch package in a temp dir with real deps symlinked in, mirroring the entry-point
// shapes of top npm packages (ms, express, chalk, yargs, preact) without the network.
const withScratchPkg = async (
  files: Record<string, string>,
  fn: (cwd: string) => Promise<void>
) => {
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-size-scratch-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), text);
    }
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    for (const dep of ['typescript', 'esbuild'])
      symlinkSync(join(BASE, 'node_modules', dep), join(cwd, 'node_modules', dep), 'junction');
    await fn(cwd);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
};
const scratchJson = (extra: Record<string, unknown>) =>
  `${JSON.stringify({ name: '@bismar-test/scratch', private: true, version: '1.0.0', ...extra })}\n`;

it('installed ref manifests cannot select entries outside their package', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'bismar-size-confined-entry-'));
  try {
    const install = join(parent, 'install');
    const pkgDir = join(install, 'node_modules', 'unsafe-ref');
    const pkgFile = join(pkgDir, 'package.json');
    const outside = join(parent, 'outside.js');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'safe.js'), 'export const safe = 1;\n');
    writeFileSync(outside, 'export const secret = 1;\n');
    symlinkSync(outside, join(pkgDir, 'linked.js'));
    writeFileSync(
      pkgFile,
      scratchJson({
        exports: {
          '.': './safe.js',
          './linked': './linked.js',
          './outside': '../../../outside.js',
        },
        name: 'unsafe-ref',
        type: 'module',
      })
    );
    const pkg = (await import('../src/public.ts')).readPkg(pkgFile);
    const local = { cwd: pkgDir, outDir: parent, pkg, pkgDir, pkgFile };

    // An explicitly selected local checkout retains its historical monorepo
    // semantics, including package entries that point beyond the package dir.
    deepStrictEqual(
      readModules(local).map((mod) => mod.module),
      ['index', 'linked', 'outside']
    );
    // The same manifest as a downloaded ref accepts only the ordinary entry.
    deepStrictEqual(
      readModules({ ...local, sandboxRoot: install }).map((mod) => mod.module),
      ['index']
    );
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

it('installed ref manifest paths cannot inject generated bundle source', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bismar-size-generated-source-'));
  const suffix = scratch.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const name = `bismar-test-source${suffix}`;
  const version = '9.9.9';
  const label = `${name}@${version}`;
  const refDir = refsCacheDir(label);
  // Without JS-string encoding, the quote closes the generated module specifier
  // and the remainder injects an executable statement into the bundle entry.
  const entry = "entry';throw Error('BISMAR_INJECTED');let trailing='.js";
  try {
    const pkgDir = join(refDir, 'node_modules', name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, entry), 'export const safe = 1;\n');
    writeFileSync(
      join(pkgDir, 'package.json'),
      `${JSON.stringify({ main: `./${entry}`, name, type: 'module', version })}\n`
    );
    writeCacheIdentity(label);
    const built = await buildFirst({
      cwd: fixture('plain'),
      only: [`npm:${name}@${version}`],
      outDir: scratch,
    });
    deepStrictEqual(!!built, true);
    deepStrictEqual(Buffer.from(built!.min).includes('BISMAR_INJECTED'), false);
  } finally {
    rmSync(refDir, { force: true, recursive: true });
    rmSync(refsMetaFile(label), { force: true });
    rmSync(scratch, { force: true, recursive: true });
  }
});

it('installed ref export enumeration cannot follow imports outside its install', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'bismar-size-confined-list-'));
  try {
    const install = join(parent, 'install');
    const pkgDir = join(install, 'node_modules', 'unsafe-ref');
    const outside = join(parent, 'outside.js');
    const entry = join(pkgDir, 'index.js');
    const namedEntry = join(pkgDir, 'named.js');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(outside, 'export const secret = 1;\n');
    writeFileSync(entry, "export { secret } from '../../../outside.js';\n");
    writeFileSync(namedEntry, 'const x = 1; export { x as "not-an-identifier" };\n');
    const plainMod = {
      dir: 'index',
      exports: [],
      file: entry,
      key: '.',
      module: 'index',
      spec: './index.js',
    };
    const confinedMod = { ...plainMod, exports: [], sandboxRoot: install };
    const namedMod = { ...plainMod, exports: [], file: namedEntry, spec: './named.js' };
    const build = loadEsbuild().build;

    await fillExports(build, [plainMod]);
    await fillExports(build, [confinedMod]);
    await fillExports(build, [namedMod]);
    deepStrictEqual(plainMod.exports, ['secret']);
    deepStrictEqual(confinedMod.exports, []);
    deepStrictEqual(namedMod.exports, []);
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

it('installed ref bundles reject symlinked imports outside their install', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bismar-size-confined-build-'));
  const suffix = scratch.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const name = `bismar-test-sandbox${suffix}`;
  const version = '9.9.9';
  const label = `${name}@${version}`;
  const refDir = refsCacheDir(label);
  try {
    const pkgDir = join(refDir, 'node_modules', name);
    const outside = join(scratch, 'outside.js');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(outside, 'export const secret = 1;\n');
    symlinkSync(outside, join(pkgDir, 'linked.js'));
    writeFileSync(join(pkgDir, 'index.js'), "export { secret } from './linked.js';\n");
    writeFileSync(
      join(pkgDir, 'package.json'),
      `${JSON.stringify({ main: './index.js', name, type: 'module', version })}\n`
    );
    writeCacheIdentity(label);

    const cwd = fixture('plain');
    const res = await capture(() =>
      runBismar(['-bs', `npm:${name}@${version}/index/secret`], { color: false, cwd })
    );
    deepStrictEqual(res.ok, false, all(res));
    deepStrictEqual(
      /refusing import outside installed package: \.\/linked\.js/.test(plain(res)),
      true,
      plain(res)
    );
  } finally {
    rmSync(refDir, { force: true, recursive: true });
    rmSync(refsMetaFile(label), { force: true });
    rmSync(scratch, { force: true, recursive: true });
  }
});

it('size command handles legacy and modern package entry shapes', async () => {
  const cjs = "'use strict';\nexports.add = (a, b) => a + b;\n";
  const esm = 'export const add = (a, b) => a + b;\n';
  // Extensionless legacy main (ms).
  await withScratchPkg(
    { 'index.js': cjs, 'package.json': scratchJson({ main: './index' }) },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/@bismar-test\/scratch,,\d+loc,/.test(plain(res)), true, plain(res));
    }
  );
  // No entry fields at all: node's legacy ./index.js default (express).
  await withScratchPkg({ 'index.js': cjs, 'package.json': scratchJson({}) }, async (cwd) => {
    const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/@bismar-test\/scratch,,\d+loc,/.test(plain(res)), true, plain(res));
  });
  // Root conditions object (chalk) — and the module must not be named "default".
  await withScratchPkg(
    {
      'main.js': esm,
      'package.json': scratchJson({ exports: { default: './main.js' }, type: 'module' }),
    },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,add,\d+loc,/.test(plain(res)), true, plain(res));
      deepStrictEqual(/default,/.test(plain(res)), false, plain(res));
    }
  );
  // String exports sugar.
  await withScratchPkg(
    { 'main.js': esm, 'package.json': scratchJson({ exports: './main.js', type: 'module' }) },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,add,\d+loc,/.test(plain(res)), true, plain(res));
    }
  );
  // .mjs entry (yargs).
  await withScratchPkg(
    { 'index.mjs': esm, 'package.json': scratchJson({ main: './index.mjs' }) },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,add,\d+loc,/.test(plain(res)), true, plain(res));
    }
  );
  // Alias keys (`./a` + `./a.js`, classnames/dotenv) list once; a root `./index.js` key
  // stays `index` instead of degenerating into a module named `.`; exports pointing at
  // files absent from the tarball (ramda's ./dist) are skipped, not fatal.
  await withScratchPkg(
    {
      'a.js': esm,
      'index.js': esm,
      'package.json': scratchJson({
        exports: {
          '.': './index.js',
          './a': './a.js',
          './a.js': './a.js',
          './gone': './dist/gone.js',
          './index.js': './index.js',
        },
        type: 'module',
      }),
    },
    async (cwd) => {
      const res = await capture(() => runBismar(['--list'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      const lines = plain(res).trim().split('\n');
      // Listings spell the consumer import: the exports-map key under the package
      // name (`.` is the package itself); extensionless keys (`./a`) stay bare.
      deepStrictEqual(
        lines,
        ["{add} from '@bismar-test/scratch'", "{add} from '@bismar-test/scratch/a'"],
        plain(res)
      );
    }
  );
  // Entries that resolve to no JS at all must error, not measure an empty shim.
  await withScratchPkg(
    { 'package.json': scratchJson({ main: './style.css' }), 'style.css': 'body {}\n' },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, false);
      deepStrictEqual(
        /no importable JS modules found in @bismar-test\/scratch/.test(plain(res)),
        true,
        plain(res)
      );
    }
  );
  // Deps exporting a name only under the `node` condition (execa's unicorn-magic,
  // concurrently's rxjs default-import) trigger one retry with node conditions.
  await withScratchPkg(
    {
      'index.js': "export { thing } from 'cond-dep';\n",
      'node_modules/cond-dep/default.js': 'export const other = 1;\n',
      'node_modules/cond-dep/node.js': 'export const thing = 1;\n',
      'node_modules/cond-dep/package.json': `${JSON.stringify({
        // Condition order matters: node before default, like real packages.
        exports: { '.': { node: './node.js', default: './default.js' } },
        name: 'cond-dep',
        type: 'module',
        version: '1.0.0',
      })}\n`,
      'package.json': scratchJson({ main: './index.js', type: 'module' }),
    },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,thing,\d+loc,/.test(plain(res)), true, plain(res));
      deepStrictEqual(/note: retrying with node conditions/.test(plain(res)), true, plain(res));
    }
  );
  // Undeclared optional imports become external with a note (preact's compat/server).
  await withScratchPkg(
    {
      'index.js':
        "import missing from 'bismar-test-not-installed';\nexport const use = () => missing;\n",
      'package.json': scratchJson({ main: './index.js', type: 'module' }),
    },
    async (cwd) => {
      const res = await capture(() => runBismar(['-bs'], { color: false, cwd }));
      deepStrictEqual(res.ok, true, all(res));
      deepStrictEqual(/index,use,\d+loc,/.test(plain(res)), true, plain(res));
      deepStrictEqual(
        /note: treating unresolvable import bismar-test-not-installed as external/.test(plain(res)),
        true,
        plain(res)
      );
      // onNote diverts the notes off stderr (interactive mode: a stray stderr line
      // scrolls the TUI's alternate screen) and the run-wide sink dedupes repeats.
      const notes: string[] = [];
      const quiet = await capture(() =>
        runSize({ cwd, onNote: (text) => void notes.push(text), outDir: cwd, silent: true })
      );
      deepStrictEqual(quiet.ok, true, all(quiet));
      deepStrictEqual(quiet.stderr, '', quiet.stderr);
      deepStrictEqual(notes, [
        'note: treating unresolvable import bismar-test-not-installed as external',
      ]);
    }
  );
});

it('size command rejects exports of CJS modules that have no exports', async () => {
  // esbuild cannot statically validate named imports against CommonJS, so a bogus name
  // would otherwise "build" into a permanently-undefined property read (npm:noble-hashes
  // is the real-world shape: its entry just throws). The build warning becomes an error.
  const cwd = fixture('cjs');
  const res = await capture(() => runBismar(['-bs', 'index/whatever'], { color: false, cwd }));
  deepStrictEqual(res.ok, false);
  deepStrictEqual(
    /index has no export: whatever; use --list to see modules and exports/.test(plain(res)),
    true,
    plain(res)
  );
  deepStrictEqual(
    /will always be undefined|No matching export/.test(plain(res)),
    false,
    plain(res)
  );
});

it('size command paints export names in listings and errors', async () => {
  const cwd = fixture('plain');
  // Unknown-export listings paint `/export` green, matching size-line labels.
  const bad = await withEnv('FORCE_COLOR', '1', () =>
    capture(() => runBismar(['-bs', 'index/nope'], { cwd }))
  );
  deepStrictEqual(bad.ok, false);
  deepStrictEqual(all(bad).includes('\x1b[36mindex\x1b[0m/\x1b[32madd\x1b[0m'), true, all(bad));
  deepStrictEqual(all(bad).includes('\x1b[31mnope\x1b[0m'), true, all(bad));
  // --list keeps the palette in import syntax: export green, package yellow.
  const list = await withEnv('FORCE_COLOR', '1', () =>
    capture(() => runBismar(['--list'], { cwd }))
  );
  deepStrictEqual(list.ok, true, all(list));
  deepStrictEqual(
    all(list).includes("{\x1b[32madd\x1b[0m} from '\x1b[33m@bismar-test/plain\x1b[0m'"),
    true,
    all(list)
  );
  // npm refs paint the same way — and a lone ref lists versionless.
  const ref = await withEnv('FORCE_COLOR', '1', () =>
    capture(() => runBismar(['--list', 'npm:@microsoft/tsdoc@0.16.0'], { cwd }))
  );
  deepStrictEqual(ref.ok, true, all(ref));
  deepStrictEqual(
    all(ref).includes("{\x1b[32mTSDocParser\x1b[0m} from '\x1b[33m@microsoft/tsdoc\x1b[0m'"),
    true,
    all(ref)
  );
});

it('size command --list prints import statements without bundling', async () => {
  const cwd = fixture('plain');
  const res = await capture(() => runBismar(['--list'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^\{add\} from '@bismar-test\/plain'$/m.test(out), true, out);
  deepStrictEqual(/^\{blob\} from '@bismar-test\/plain'$/m.test(out), true, out);
  deepStrictEqual(/all|Tip:|module,export/.test(out), false, out);
  const filtered = await capture(() => runBismar(['--list', 'index'], { color: false, cwd }));
  deepStrictEqual(
    /^\{add\} from '@bismar-test\/plain'$/m.test(plain(filtered)),
    true,
    plain(filtered)
  );
  // A lone npm ref lists versionless — import statements name no version.
  const ref = await capture(() =>
    runBismar(['--list', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  const rout = plain(ref);
  deepStrictEqual(ref.ok, true, all(ref));
  deepStrictEqual(/^\{TSDocParser\} from '@microsoft\/tsdoc'$/m.test(rout), true, rout);
  deepStrictEqual(/@0\.16\.0/.test(rout), false, rout);
  deepStrictEqual(/from '@bismar-test\/plain'/.test(rout), false, rout);
  // The same package entered at two versions keeps the pinned labels apart.
  const both = await capture(() =>
    runBismar(['--list', 'npm:@microsoft/tsdoc@0.15.1', 'npm:@microsoft/tsdoc@0.16.0'], {
      color: false,
      cwd,
    })
  );
  const bout = plain(both);
  deepStrictEqual(both.ok, true, all(both));
  deepStrictEqual(/^\{TSDocParser\} from '@microsoft\/tsdoc@0\.15\.1'$/m.test(bout), true, bout);
  deepStrictEqual(/^\{TSDocParser\} from '@microsoft\/tsdoc@0\.16\.0'$/m.test(bout), true, bout);
  deepStrictEqual(/from '@microsoft\/tsdoc'/.test(bout), false, bout);
});

it('size command lists external refs from a module-less package', async () => {
  // A fresh `npm init -y` package points main at a file that never existed; an
  // all-ref selection touches no local modules, so it must not demand any.
  await withScratchPkg({ 'package.json': scratchJson({ main: 'index.js' }) }, async (cwd) => {
    const res = await capture(() =>
      runBismar(['--list', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
    );
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(
      /^\{TSDocParser\} from '@microsoft\/tsdoc'$/m.test(plain(res)),
      true,
      plain(res)
    );
  });
});

it('size command --list caches pinned ref enumeration in bismar.db.json', async () => {
  const cwd = fixture('plain');
  const db = join(refsCacheDir('@microsoft/tsdoc@0.16.0'), 'bismar.db.json');
  rmSync(db, { force: true });
  const argv = ['--list', 'npm:@microsoft/tsdoc@0.16.0'];
  const first = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(first.ok, true, all(first));
  deepStrictEqual(existsSync(db), true);
  // A corrupt db is recomputed and rewritten, never trusted.
  writeFileSync(db, 'not json');
  const second = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(second.ok, true, all(second));
  deepStrictEqual(plain(second), plain(first));
  const parsed = JSON.parse(readFileSync(db, 'utf8'));
  deepStrictEqual(parsed.v, 1);
  deepStrictEqual(parsed.modules[0].exports.includes('TSDocParser'), true);
  deepStrictEqual(parsed.modules[0].file, 'index.js');
  // The db-served listing matches the freshly computed one.
  const third = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(plain(third), plain(first));
});

it('size command serves pinned ref sizes from the machine cache', async () => {
  const cwd = fixture('plain');
  const db = join(refsCacheDir('@microsoft/tsdoc@0.16.0'), 'bismar.db.json');
  rmSync(db, { force: true });
  const argv = ['-bs', 'npm:@microsoft/tsdoc@0.16.0/index/TSDocParser'];
  const first = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(first.ok, true, all(first));
  // The measuring run wrote its row under the unbranded key, stamped with both
  // the file-format version and the sizes semantics version.
  const parsed = JSON.parse(readFileSync(db, 'utf8'));
  deepStrictEqual(Array.isArray(parsed.sizes.rows['index/TSDocParser']), true);
  deepStrictEqual(typeof parsed.sizes.esbuild, 'string');
  deepStrictEqual(parsed.v, 1);
  deepStrictEqual(parsed.sizes.v, 1);
  // Poison the cached row; a warm run must serve it verbatim, without esbuild.
  parsed.sizes.rows['index/TSDocParser'] = [1, 11, 7, 21];
  writeFileSync(db, JSON.stringify(parsed));
  const second = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(second.ok, true, all(second));
  deepStrictEqual(
    /^@microsoft\/tsdoc@0\.16\.0,TSDocParser,1loc,21b$/m.test(plain(second)),
    true,
    plain(second)
  );
  // -m flips the same cached row to its min+gzip pair.
  const minArgv = ['-bsm', 'npm:@microsoft/tsdoc@0.16.0/index/TSDocParser'];
  const minified = await capture(() => runBismar(minArgv, { color: false, cwd }));
  deepStrictEqual(minified.ok, true, all(minified));
  deepStrictEqual(
    /^@microsoft\/tsdoc@0\.16\.0,TSDocParser,11b,7b$/m.test(plain(minified)),
    true,
    plain(minified)
  );
  // A different esbuild version invalidates the poison: real numbers come back.
  parsed.sizes.esbuild = '0.0.0';
  // Top-level fields this bismar doesn't know (a newer version's data) must
  // survive the rewrite instead of being silently dropped.
  parsed.future = { keep: true };
  writeFileSync(db, JSON.stringify(parsed));
  const third = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(plain(third), plain(first));
  const rewritten = JSON.parse(readFileSync(db, 'utf8'));
  deepStrictEqual(rewritten.sizes.esbuild === '0.0.0', false);
  deepStrictEqual(rewritten.future, { keep: true });
  // A bumped sizes semantics version invalidates the same way: cached rows from
  // a bismar whose numbers mean something else are misses, never served.
  parsed.sizes.esbuild = rewritten.sizes.esbuild;
  parsed.sizes.v = 0;
  parsed.sizes.rows['index/TSDocParser'] = [1, 11, 7, 21];
  writeFileSync(db, JSON.stringify(parsed));
  const fourth = await capture(() => runBismar(argv, { color: false, cwd }));
  deepStrictEqual(plain(fourth), plain(first));
  // Bundle emission never reads the poisoned cache — it needs real bytes.
  parsed.sizes.v = 1;
  parsed.sizes.rows['index/TSDocParser'] = [1, 11, 7, 21];
  writeFileSync(db, JSON.stringify(parsed));
  // -b streams bytes through stdout.write, which capture() does not hook. tty is
  // pinned off: a terminal refuses the bytes and prints the stat row instead, so
  // an ambient TTY would decide which branch this asserts.
  let bytes = '';
  const prevWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    bytes += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stdout.write;
  try {
    const emitted = await capture(() =>
      runBismar(['-b', 'npm:@microsoft/tsdoc@0.16.0/index/TSDocParser'], {
        color: false,
        cwd,
        tty: false,
      })
    );
    deepStrictEqual(emitted.ok, true, all(emitted));
  } finally {
    process.stdout.write = prevWrite;
  }
  // Real bundle bytes, not the 11 poisoned ones.
  deepStrictEqual(/TSDocParser/.test(bytes), true);
  deepStrictEqual(bytes.length > 1000, true);
});

it('unknown-module errors on multi-module refs list real selector ids', async () => {
  const cwd = fixture('plain');
  // Seed a pinned machine-cache install and matching identity marker so the
  // fake package works fully offline.
  const label = 'bismar-fake@9.9.9';
  const refDir = refsCacheDir(label);
  const pkgDir = join(refDir, 'node_modules', 'bismar-fake');
  rmSync(refDir, { force: true, recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(refDir, 'package.json'),
    JSON.stringify({ dependencies: { 'bismar-fake': '9.9.9' }, private: true })
  );
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      exports: { '.': './index.js', './extra.js': './extra.js' },
      name: 'bismar-fake',
      version: '9.9.9',
    })
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export const one = 1;\n');
  writeFileSync(join(pkgDir, 'extra.js'), 'export const two = 2;\n');
  writeCacheIdentity(label);
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'src', 'util.ts'), 'export const three = 3;\n');
  writeFileSync(join(pkgDir, 'LICENSE'), 'MIT\n');
  try {
    const res = await capture(() =>
      runBismar(['-bs', 'npm:bismar-fake@9.9.9/nope/x'], { color: false, cwd })
    );
    deepStrictEqual(res.ok, false);
    const out = plain(res);
    // The listing carries branded selector ids — never map-index artifacts
    // (`bismar-fake@9.9.9/0`), the refRename-into-map regression.
    deepStrictEqual(
      /unknown module: nope; use one of:\nbismar-fake@9\.9\.9\/extra\nbismar-fake@9\.9\.9\/index/.test(
        out
      ),
      true,
      out
    );
    deepStrictEqual(/9\.9\.9\/\d/.test(out), false, out);
    // Tails that name shipped files bridge to the flagless grammar instead of
    // dead-ending as unknown modules/exports — one hint per failure shape:
    // a deep path (unknown module), a non-identifier root file (invalid
    // export), and an identifier-shaped root file (esbuild no-such-export).
    for (const tail of ['src/util.ts', 'package.json', 'LICENSE']) {
      const hinted = await capture(() =>
        runBismar(['-bs', `npm:bismar-fake@9.9.9/${tail}`], { color: false, cwd })
      );
      deepStrictEqual(hinted.ok, false, tail);
      deepStrictEqual(
        new RegExp(
          `names a shipped file, not (a module/export|an export); drop the flags to open it: bismar npm:bismar-fake@9\\.9\\.9/${tail.replaceAll('/', '\\/').replaceAll('.', '\\.')}`
        ).test(plain(hinted)),
        true,
        `${tail}\n${plain(hinted)}`
      );
    }
  } finally {
    rmSync(refDir, { force: true, recursive: true });
    rmSync(refsMetaFile(label), { force: true });
  }
});

it('bare -s honors a /path scope on refs and fails on a miss', async () => {
  const cwd = fixture('plain');
  // The tail scopes the listing by diff's rule: this exact shipped file.
  const one = await capture(() =>
    runBismar(['-s', 'npm:@microsoft/tsdoc@0.16.0/package.json'], { color: false, cwd })
  );
  deepStrictEqual(one.ok, true, all(one));
  deepStrictEqual(/^package\.json,\d+b\n$/.test(one.stdout), true, one.stdout);
  // A scope matching nothing is a typo'd path, never a silently unscoped listing.
  const miss = await capture(() =>
    runBismar(['-s', 'npm:@microsoft/tsdoc@0.16.0/retry'], { color: false, cwd })
  );
  deepStrictEqual(miss.ok, false);
  deepStrictEqual(
    /no shipped file matches \/retry; drop the tail to list files/.test(plain(miss)),
    true,
    plain(miss)
  );
});

it('size command pins floating refs through a fresh tag, re-resolves stale ones', async () => {
  const cwd = fixture('plain');
  // Prime the pinned machine cache, then cut the registry off: everything the
  // fresh-tag path needs must already be on disk.
  const prime = await capture(() =>
    runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0/index/TSDocParser'], { color: false, cwd })
  );
  deepStrictEqual(prime.ok, true, all(prime));
  const tag = refsTagFile('@microsoft/tsdoc');
  const argv = ['-bs', 'npm:@microsoft/tsdoc/index/TSDocParser'];
  await withEnv('npm_config_registry', 'http://127.0.0.1:9', () =>
    withEnv('npm_config_fetch_retries', '0', () =>
      withEnv('npm_config_fetch_retry_maxtimeout', '100', async () => {
        // Fresh tag: the floating spec reuses the pinned install, fully offline.
        writeVersionTag('@microsoft/tsdoc', '0.16.0');
        const fresh = await capture(() => runBismar(argv, { color: false, cwd }));
        deepStrictEqual(fresh.ok, true, all(fresh));
        deepStrictEqual(
          /^@microsoft\/tsdoc@0\.16\.0,TSDocParser,\d+loc,\d+b$/m.test(plain(fresh)),
          true,
          plain(fresh)
        );
        // Stale tag: latest must re-resolve, which the dead registry refuses.
        writeFileSync(
          tag,
          `${JSON.stringify({
            at: Date.now() - 16 * 60_000,
            label: '@microsoft/tsdoc',
            v: 2,
            version: '0.16.0',
          })}\n`
        );
        const stale = await capture(() => runBismar(argv, { color: false, cwd }));
        deepStrictEqual(stale.ok, false, all(stale));
        deepStrictEqual(/@microsoft\/tsdoc/.test(all(stale)), true, all(stale));
      })
    )
  );
  rmSync(tag, { force: true });
});

it('size command measures external npm refs alongside local exports', async () => {
  const cwd = fixture('plain');
  // @microsoft/tsdoc@0.16.0 is a repo devDependency, so the npm cache serves it offline.
  const res = await capture(() =>
    runBismar(['-bs', 'index/add', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/index,add,\d+loc,/.test(out), true, out);
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0,,\d+loc,/m.test(out), true, out);
  // The combined selection row includes both, despite different resolution roots.
  deepStrictEqual(/selection,,\d+loc,/.test(out), true, out);

  const bad = await capture(() =>
    runBismar(['-bs', 'npm:git+ssh://evil/x'], { color: false, cwd })
  );
  deepStrictEqual(bad.ok, false);
  deepStrictEqual(/invalid npm ref/.test(plain(bad)), true, plain(bad));

  // The npm: prefix stays available as an explicit disambiguator, with identical output.
  const prefixed = await capture(() =>
    runBismar(['-bs', 'index/add', 'npm:@microsoft/tsdoc@0.16.0/TSDocParser'], {
      color: false,
      cwd,
    })
  );
  deepStrictEqual(prefixed.ok, true, all(prefixed));
  deepStrictEqual(
    /^@microsoft\/tsdoc@0\.16\.0,TSDocParser,\d+loc,/m.test(plain(prefixed)),
    true,
    plain(prefixed)
  );

  // Unknown ref exports get the same friendly listing as local ones, in selector form —
  // never a raw esbuild "No matching export" error with temp-dir paths.
  const miss = await capture(() =>
    runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0/index/NopeParser'], { color: false, cwd })
  );
  const missOut = plain(miss);
  deepStrictEqual(miss.ok, false);
  deepStrictEqual(
    /@microsoft\/tsdoc@0\.16\.0 has no export: NopeParser; use one of:/.test(missOut),
    true,
    missOut
  );
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0\/TSDocParser$/m.test(missOut), true, missOut);
  deepStrictEqual(/No matching export|bismar-size-/.test(missOut), false, missOut);
});

it('size command expands a single bare package selector to the full table', async () => {
  const cwd = fixture('plain');
  // Browse mode: one bare package ref prints the same breakdown a no-arg run prints
  // inside that package — package total plus per-module and per-export rows.
  const res = await capture(() =>
    runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0,,\d+loc,/m.test(out), true, out);
  deepStrictEqual(/^index,TSDocParser,\d+loc,/m.test(out), true, out);
  // `.` and the package's own name alias the local no-arg table the same way.
  for (const sel of ['.', '@bismar-test/plain']) {
    const self = await capture(() => runBismar(['-bs', sel], { color: false, cwd }));
    const sout = plain(self);
    deepStrictEqual(self.ok, true, `${sel}\n${all(self)}`);
    deepStrictEqual(/^@bismar-test\/plain,,\d+loc,/m.test(sout), true, `${sel}\n${sout}`);
    deepStrictEqual(/^index,add,\d+loc,/m.test(sout), true, `${sel}\n${sout}`);
  }
  // In a multi-selector run the same bare package stays a single total row.
  const multi = await capture(() =>
    runBismar(['-bs', '.', 'npm:@microsoft/tsdoc@0.16.0'], { color: false, cwd })
  );
  const mout = plain(multi);
  deepStrictEqual(multi.ok, true, all(multi));
  deepStrictEqual(/^@bismar-test\/plain,,\d+loc,/m.test(mout), true, mout);
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0,,\d+loc,/m.test(mout), true, mout);
  deepStrictEqual(/^index,add,/m.test(mout), false, mout);
});

it('size command expands a single module selector to its exports', async () => {
  const cwd = fixture('plain');
  // Local module browse: the module row plus one row per export, no package row.
  const res = await capture(() => runBismar(['-bs', 'index.js'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/^index,,\d+loc,/m.test(out), true, out);
  deepStrictEqual(/^index,add,\d+loc,/m.test(out), true, out);
  deepStrictEqual(/^index,blob,\d+loc,/m.test(out), true, out);
  deepStrictEqual(/@bismar-test\/plain,,/.test(out), false, out);
  // Ref module browse brands rows with the pinned label; no package row either.
  const ref = await capture(() =>
    runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0/index'], { color: false, cwd })
  );
  const rout = plain(ref);
  deepStrictEqual(ref.ok, true, all(ref));
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0\/index,,\d+loc,/m.test(rout), true, rout);
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0\/index,TSDocParser,\d+loc,/m.test(rout), true, rout);
  deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0,,/m.test(rout), false, rout);
  // Selectors with an export part stay comparison mode: one row only.
  const exp = await capture(() => runBismar(['-bs', 'index/add'], { color: false, cwd }));
  const eout = plain(exp);
  deepStrictEqual(exp.ok, true, all(exp));
  deepStrictEqual(/^index,add,\d+loc,/m.test(eout), true, eout);
  deepStrictEqual(/^index,,/m.test(eout), false, eout);
});

it('size command measures npm refs without a local package.json', async () => {
  // npm-first from anywhere: a directory without package.json still measures refs.
  const cwd = mkdtempSync(join(tmpdir(), 'bismar-size-nopkg-'));
  try {
    const res = await capture(() =>
      runBismar(['-bs', 'npm:@microsoft/tsdoc@0.16.0/TSDocParser'], { color: false, cwd })
    );
    const out = plain(res);
    deepStrictEqual(res.ok, true, all(res));
    deepStrictEqual(/^@microsoft\/tsdoc@0\.16\.0,TSDocParser,\d+loc,/m.test(out), true, out);
    // `./` means the filesystem now; a missing file fails as exactly that.
    const local = await capture(() => runBismar(['-bs', './index.js/add'], { color: false, cwd }));
    deepStrictEqual(local.ok, false);
    deepStrictEqual(
      /missing input file: \.\/index\.js\/add/.test(plain(local)),
      true,
      plain(local)
    );
    // A bare name in a package-less dir points at the registry spelling.
    const bare = await capture(() => runBismar(['-bs', 'preact/hooks'], { color: false, cwd }));
    deepStrictEqual(bare.ok, false);
    deepStrictEqual(
      /package not found: preact\/hooks.*use npm:preact\/hooks for the registry package/.test(
        plain(bare)
      ),
      true,
      plain(bare)
    );
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

it('size command measures a single file via the ./ selector', async () => {
  // `./` always means the filesystem — even when a public module shares the name.
  const cwd = fixture('plain');
  const res = await capture(() => runBismar(['-bs', './index.js'], { color: false, cwd }));
  const out = plain(res);
  deepStrictEqual(res.ok, true, all(res));
  deepStrictEqual(/module,export/.test(out), false, out);
  // The file is the module: per-export rows plus ALL, but no package-level row.
  deepStrictEqual(/index,,\d/.test(out), true, out);
  deepStrictEqual(/index,add,/.test(out), true, out);
  deepStrictEqual(/index,blob,/.test(out), true, out);
  deepStrictEqual(/@bismar-test/.test(out), false, out);
});

it('npm install failures surface stderr with a stable prefix', async () => {
  // Run-dir deps assemble via symlinks; npm runs only on cold cache, so exercise the
  // failure surface directly at the fs-modify boundary.
  const tmp = mkdtempSync(join(tmpdir(), 'bismar-size-npmfail-'));
  const cache = mkdtempSync(join(tmpdir(), 'bismar-size-cache-'));
  try {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify(
        { dependencies: { '@bismar-test/definitely-missing': '9.9.9' }, private: true },
        undefined,
        2
      )}\n`
    );
    await withEnv('npm_config_cache', cache, () =>
      withEnv('npm_config_registry', 'http://127.0.0.1:9', () =>
        withEnv('npm_config_fetch_retries', '0', () =>
          withEnv('npm_config_fetch_retry_maxtimeout', '100', async () => {
            let message = '';
            try {
              npmInstall(tmp);
            } catch (error) {
              message = (error as Error).message;
            }
            deepStrictEqual(/^npm install failed/.test(message), true, message);
          })
        )
      )
    );
  } finally {
    rmSync(tmp, { force: true, recursive: true });
    rmSync(cache, { force: true, recursive: true });
  }
});

it('size rows carry the selector spellings they are addressed by', async () => {
  const cwd = fixture('plain');
  const rows = await measureRows({ cwd });
  deepStrictEqual(
    rows.map((row) => row.label),
    ['@bismar-test/plain', 'index.js', 'index.js/add', 'index.js/blob']
  );
  // moduleLabel is that module's own whole-module row label: an export row differs from
  // it by the `/name` suffix alone, so neither has to be sliced back out of the other.
  deepStrictEqual(
    rows.map((row) => row.moduleLabel),
    ['@bismar-test/plain', 'index.js', 'index.js', 'index.js']
  );
  // The printed table and the reported row are one measurement, not two that agree by
  // convention: a budget compared against gzBytes is comparing what `bismar -bsm` shows,
  // and plainBytes what plain `-bs` shows.
  const shown = await run(cwd, () => runBismar(['-bs'], { color: false, cwd }));
  const shownMin = await run(cwd, () => runBismar(['-bsm'], { color: false, cwd }));
  for (const row of rows) {
    const exp = row.export === 'all' ? '' : row.export;
    const line = `${row.module},${exp},${row.loc}loc,${row.plainBytes}b`;
    deepStrictEqual(plain(shown).includes(line), true, `${line}\n${plain(shown)}`);
    const minLine = `${row.module},${exp},${row.minBytes}b,${row.gzBytes}b`;
    deepStrictEqual(plain(shownMin).includes(minLine), true, `${minLine}\n${plain(shownMin)}`);
  }
  // Every label round-trips: handed back as a selector it measures that same bundle.
  for (const row of rows) {
    const back = await measureRows({ cwd, localOnly: true, only: [row.label], single: true });
    deepStrictEqual(
      back.map((item) => item.gzBytes),
      [row.gzBytes],
      row.label
    );
  }
});

it('measureRows owns its out dir and can narrow to the combined bundle', async () => {
  const cwd = fixture('plain');
  const owned = () =>
    readdirSync(tmpdir())
      .filter((name) => /^bismar-size-[A-Za-z0-9]{6}$/.test(name))
      .sort();
  const before = owned();
  const gzOf = async (only: string[]) =>
    (await measureRows({ cwd, localOnly: true, only, single: true }))[0];
  const combined = await gzOf(['index.js/add', 'index.js/blob']);
  // `single` keeps the bismar-made combined row and drops the per-selector ones.
  deepStrictEqual(combined.label, 'selection');
  const [add, blob] = await Promise.all([gzOf(['index.js/add']), gzOf(['index.js/blob'])]);
  // Imported together they share code: dearer than either alone, cheaper than the sum.
  const sizes = `${combined.gzBytes} vs ${add.gzBytes} + ${blob.gzBytes}`;
  deepStrictEqual(combined.gzBytes > Math.max(add.gzBytes, blob.gzBytes), true, sizes);
  deepStrictEqual(combined.gzBytes < add.gzBytes + blob.gzBytes, true, sizes);
  // None of those calls was given an outDir, so every dir they allocated is gone again.
  deepStrictEqual(owned(), before);
});

it('foreignSelector marks selectors that name another package', () => {
  const pkg = '@bismar-test/plain';
  const cases: [string, boolean][] = [
    ['index.js', false],
    ['index.js/add', false],
    [pkg, false],
    [`${pkg}/sub.js`, false],
    ['npm:qr', true],
    ['jsr:@std/bytes', true],
    ['@other/pkg', true],
    // Near-misses on the package name are still other packages.
    ['@bismar-test/plainer', true],
    // Bare names stay ambiguous on purpose: spelling alone cannot separate a local
    // module from a foreign package, so resolution decides and this keeps quiet.
    ['lodash', false],
  ];
  for (const [raw, expected] of cases) deepStrictEqual(foreignSelector(raw, pkg), expected, raw);
});
