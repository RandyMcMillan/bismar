// The only shipped place allowed to mutate the filesystem or run `npm install`.
// Every mutation happens inside a `bismar-*` OS temp dir, assembled here — mostly via
// symlinks; npm runs only on a cold esbuild cache. bismar never writes into user repos.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Source/manifest writes, plus the verbatim registry archives kept for `-b`.
const EXTS = ['.cjs', '.js', '.json', '.mjs', '.ts', '.crate', '.gem', '.gz', '.zip', '.whl'];
// Never lifecycle scripts or lockfiles: installs land in throwaway bismar temp dirs.
// Audit and funding checks are extra registry roundtrips with no reader here.
const NPM_INSTALL_ARGS = [
  'install',
  '--prefer-offline',
  '--ignore-scripts',
  '--no-package-lock',
  '--no-audit',
  '--no-fund',
] as const;
// Kept in sync with the esbuild dependency of bismar.
const RUN_ESBUILD_SPEC = '^0.28.1';

const err = (msg: string): never => {
  throw new Error(msg);
};
const inBismarTmp = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  const rel = relative(tmpdir(), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return (rel.split(/[\\/]/)[0] || '').startsWith('bismar-');
};
export const assertTemp = (path: string, checkExt = false): string => {
  if (!isAbsolute(path)) err(`expected absolute path: ${path}`);
  if (!inBismarTmp(path)) err(`expected bismar temp path: ${path}`);
  if (checkExt && !EXTS.some((ext) => basename(path).endsWith(ext)))
    err(`refusing unexpected extension: ${path}`);
  return path;
};

// Every directory bismar creates is keeper-private: 0700 keeps other users on
// shared machines out of the persistent caches (bismar-refs, bismar-esbuild-*),
// which would otherwise inherit umask-default modes. The mode caps at 0700 —
// umask can only clear bits further. mkdtemp'd run dirs get 0700 from
// mkdtemp(3) already; this makes the recursive mkdir paths match.
const mkdir = (dir: string): string => (mkdirSync(dir, { mode: 0o700, recursive: true }), dir);

export type TempKind = 'bundle' | 'check' | 'diff' | 'size';
export const tempDir = (kind: TempKind): string => mkdtempSync(join(tmpdir(), `bismar-${kind}-`));
export const rmTempDir = (dir: string): boolean => (
  rmSync(assertTemp(dir), { force: true, recursive: true }),
  true
);

export const write = (file: string, data: string | Uint8Array): string => (
  mkdir(dirname(assertTemp(file, true))),
  writeFileSync(file, data),
  file
);
export const writePkg = (file: string, data: string | Uint8Array): string => {
  if (basename(file) !== 'package.json') err(`expected package.json path: ${file}`);
  mkdir(dirname(assertTemp(file)));
  writeFileSync(file, data);
  return file;
};
export const rm = (file: string): boolean => (
  rmSync(assertTemp(file, true), { force: true }),
  true
);

// jsr refs install through npm's registry-scope mechanism: a per-install-dir
// .npmrc routes the @jsr alias scope to jsr's npm-compatible registry. The file
// content is fixed here (env-overridable for offline tests and proxies) and only
// ever lands inside bismar temp dirs.
export const writeJsrNpmrc = (dir: string): string => {
  const registry = process.env.BISMAR_JSR_REGISTRY || 'https://npm.jsr.io';
  const file = join(assertTemp(dir), '.npmrc');
  mkdir(dir);
  writeFileSync(file, `@jsr:registry=${registry}\n`);
  return file;
};

// Moves a completed install from a per-run dir into the machine-level cache; both
// ends must be bismar temp paths. Returns false when a concurrent run won the race
// (or the rename failed any other way) — callers then just keep using `from`.
export const promoteTemp = (from: string, to: string): boolean => {
  assertTemp(from);
  assertTemp(to);
  try {
    mkdir(dirname(to));
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
};

// Hidden `bismar --clear` sweep: removes every bismar-* dir at the tmpdir root —
// ref installs, esbuild caches, and stale run dirs left by crashed runs. Sizes
// come from lstat, so symlinked run deps never count (or reach into) user repos.
export const clearTempCaches = (): { bytes: number; dirs: number } => {
  const root = tmpdir();
  let bytes = 0;
  let dirs = 0;
  const sizeOf = (path: string): number => {
    try {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st) return 0;
      if (st.isDirectory())
        return readdirSync(path).reduce((sum, ent) => sum + sizeOf(join(path, ent)), 0);
      return st.size;
    } catch {
      // A concurrent run may remove entries mid-walk; count what remains.
      return 0;
    }
  };
  for (const ent of readdirSync(root)) {
    if (!ent.startsWith('bismar-')) continue;
    const dir = join(root, ent);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    bytes += sizeOf(dir);
    rmSync(assertTemp(dir), { force: true, recursive: true });
    dirs++;
  }
  return { bytes, dirs };
};

// Extracts a tarball (crates.io `.crate`, PyPI sdists, `.gem` shells and their
// `data.tar.gz`) into a bismar temp dir via the system tar, which strips absolute
// member paths and refuses `..` traversal by default. The archive streams through
// stdin, so it never lands on disk; gzip is flagged by content, not filename —
// stdin auto-detection varies across tar implementations.
export const extractTar = (bytes: Uint8Array, dir: string): void => {
  mkdir(assertTemp(dir));
  const gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  try {
    execFileSync('tar', [gz ? '-xzf' : '-xf', '-', '-C', dir], {
      input: bytes,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      err('tar not found on PATH; extracting archives needs the system tar');
    const stderr = String((error as { stderr?: unknown }).stderr || '').trim();
    err(`tar extraction failed${stderr ? `:\n${stderr}` : ''}`);
  }
};

// Minimal zip reader for PyPI wheels (plain zips; node ships no zip support):
// walks the central directory, inflates stored/deflated members, and confines
// every member path to `dir`. No zip64 — wheels never get near 4gb.
export const extractZip = (bytes: Uint8Array, dir: string): void => {
  mkdir(assertTemp(dir));
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End-of-central-directory: scan back over the (usually absent) archive comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) err('invalid zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) err('zip64 archives are not supported');
  // Members arrive thousands per wheel, mostly sharing directories: mkdir once each.
  const madeDirs = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) err('invalid zip: bad central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || local === 0xffffffff) err('zip64 archives are not supported');
    // Directory members carry no data; their files materialize the tree below.
    if (name.endsWith('/')) continue;
    const parts = name.split('/');
    if (name.startsWith('/') || name.includes('\\') || parts.includes('..') || parts.includes(''))
      err(`refusing unsafe zip member path: ${name}`);
    if (buf.readUInt32LE(local) !== 0x04034b50) err('invalid zip: bad local file header');
    // The local header's own name/extra lengths can differ from the central copy.
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data =
      method === 0
        ? raw
        : method === 8
          ? inflateRawSync(raw)
          : err(`unsupported zip compression method ${method} for ${name}`);
    const file = join(dir, name);
    const parent = dirname(file);
    if (!madeDirs.has(parent)) {
      mkdir(parent);
      madeDirs.add(parent);
    }
    writeFileSync(file, data);
  }
};

// Zip or tar, by magic bytes: registries mix formats (packagist dists are zips,
// old pypi sdists too) and filenames lie more often than content does.
export const extractArchive = (bytes: Uint8Array, dir: string): void =>
  bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b
    ? extractZip(bytes, dir)
    : extractTar(bytes, dir);

export const npmInstall = (dir: string, refresh = false): void => {
  assertTemp(dir);
  try {
    // `refresh` swaps offline-first for a revalidating fetch: npm's cached
    // packument can predate a just-published version, and --prefer-offline
    // would keep answering ETARGET for it forever.
    const args = refresh
      ? NPM_INSTALL_ARGS.map((arg) => (arg === '--prefer-offline' ? '--prefer-online' : arg))
      : [...NPM_INSTALL_ARGS];
    // --loglevel=error beats the quiet npm_config_loglevel env, so failures stay explained.
    execFileSync('npm', [...args, '--loglevel=error'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '').trim();
    err(`npm install failed${stderr ? `:\n${stderr}` : ''}`);
  }
};

// `npm pack` into a bismar temp dir — the one faithful implementation of npm's
// publish file selection (files field, .npmignore/.gitignore, the always/never
// lists). Reads the source dir, writes only the destination tarball;
// --ignore-scripts keeps prepack/prepare from running, so the tree is packed
// as it sits on disk. Returns the tarball path.
export const npmPack = (srcDir: string, destDir: string): string => {
  mkdir(assertTemp(destDir));
  try {
    execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', destDir, '--loglevel=error'],
      { cwd: srcDir, stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '').trim();
    err(`npm pack failed${stderr ? `:\n${stderr}` : ''}`);
  }
  // npm prints the tarball name, but scoped names came out wrong in some npm
  // versions — the fresh destination dir holding exactly one tarball is surer.
  const made = readdirSync(destDir).filter((ent) => ent.endsWith('.tgz'));
  if (made.length !== 1) err(`npm pack left ${made.length} tarballs in ${destDir}`);
  return join(destDir, made[0]);
};

// Creates a directory symlink inside a bismar temp dir; existing links are left alone.
const linkDir = (target: string, linkPath: string): void => {
  assertTemp(linkPath);
  if (existsSync(linkPath)) return;
  mkdir(dirname(linkPath));
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};
// One esbuild install per machine and pinned version, primed by npm on first use.
export const esbuildCacheModules = (): string => {
  const dir = join(tmpdir(), `bismar-esbuild-${RUN_ESBUILD_SPEC.replace(/[^\w.]+/g, '')}`);
  const modules = join(dir, 'node_modules');
  if (existsSync(join(modules, 'esbuild'))) return modules;
  writePkg(
    join(dir, 'package.json'),
    `${JSON.stringify({ dependencies: { esbuild: RUN_ESBUILD_SPEC }, private: true }, null, 2)}\n`
  );
  try {
    npmInstall(dir);
  } catch (error) {
    // A concurrent prime may have won the race; only fail when esbuild is truly absent.
    if (!existsSync(join(modules, 'esbuild'))) throw error;
  }
  return modules;
};
// Assembles the run dir's node_modules via symlinks (matching how npm links `file:`
// deps), so the hot path never spawns npm. Falls back to a real install on any failure.
// `extras` are allowlisted bare package names linked from the project's own
// node_modules; their manifest specs stay `file:` paths, so even the fallback install
// never fetches third-party code from a registry.
export const installRunDeps = (
  cwd: string,
  name: string,
  dir: string,
  extras: readonly string[] = []
): void => {
  const extraDeps = Object.fromEntries(
    extras.map((dep) => [dep, `file:${join(cwd, 'node_modules', dep)}`])
  );
  writePkg(
    join(assertTemp(dir), 'package.json'),
    `${JSON.stringify(
      {
        dependencies: { ...extraDeps, [name]: `file:${cwd}`, esbuild: RUN_ESBUILD_SPEC },
        private: true,
        type: 'module',
      },
      null,
      2
    )}\n`
  );
  const modules = join(dir, 'node_modules');
  const linked = (dep: string): boolean => existsSync(join(modules, dep));
  if (linked(name) && linked('esbuild') && extras.every(linked)) return;
  try {
    const cache = esbuildCacheModules();
    linkDir(cwd, join(modules, name));
    for (const dep of extras) linkDir(join(cwd, 'node_modules', dep), join(modules, dep));
    linkDir(join(cache, 'esbuild'), join(modules, 'esbuild'));
    const scoped = join(cache, '@esbuild');
    if (existsSync(scoped))
      for (const ent of readdirSync(scoped))
        linkDir(join(scoped, ent), join(modules, '@esbuild', ent));
  } catch {
    npmInstall(dir);
  }
};

export const __TEST: {
  inBismarTmp: (path: string) => boolean;
  npmInstallArgs: () => string[];
} = {
  inBismarTmp: inBismarTmp,
  npmInstallArgs: () => [...NPM_INSTALL_ARGS],
};
