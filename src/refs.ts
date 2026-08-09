/**
External npm/jsr package refs: selector classification, ref parsing, installs
into bismar-owned dirs, and the per-ref measurement cache (`bismar.db.json`).
Destructive ops and `npm install` go through `fs-modify.ts` only.
@module
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { progressShow } from './env.ts';
import { npmInstall, promoteTemp, write, writeJsrNpmrc, writePkg } from './fs-modify.ts';
import { bad, err, type Pkg, readJson, readPkg, readText, slug } from './public.ts';

// External refs: `@noble/hashes@2.2.0/sha2.js/sha256` measures another package
// (or another version of this one). Each distinct ref installs into its own
// `<tmp>/.refs/<slug>` dir under its real name, so self-referencing imports resolve
// and two versions of one package can coexist side by side.
export type ExternalRef = {
  bare: string;
  jsr: boolean;
  label: string;
  path: string;
  version: string;
};
export const parseNpmRef = (raw: string): ExternalRef => {
  // Both prefixes are four chars; jsr refs keep theirs in the label so cache dirs,
  // display ids, and re-parsed selectors never collide with a same-named npm package.
  const jsr = raw.startsWith('jsr:');
  const body = raw.slice('npm:'.length);
  const parts = body.split('/');
  const nameParts = body.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  const name = nameParts.join('/');
  const at = name.lastIndexOf('@');
  const version = at > 0 ? name.slice(at + 1) : '';
  const bare = at > 0 ? name.slice(0, at) : name;
  // Registry specs only: file/git specs would resolve paths or run scripts.
  const validName = /^(@[\w.-]+\/)?[\w.-]+$/.test(bare);
  if (!validName || (body.startsWith('@') && parts.length < 2) || /[:+]/.test(version))
    err(
      jsr
        ? `invalid jsr ref: ${bad(raw)}; use jsr:@scope/name@version/module/export`
        : `invalid npm ref: ${bad(raw)}; use npm:name@version/module/export`
    );
  // jsr names are always scoped; a bare one can never exist on the registry.
  if (jsr && !bare.startsWith('@'))
    err(`invalid jsr ref: ${bad(raw)}; use jsr:@scope/name@version/module/export`);
  return {
    bare,
    jsr,
    label: jsr ? `jsr:${name}` : name,
    path: parts.slice(nameParts.length).join('/'),
    version,
  };
};
// Exact pinned versions are immutable on the registry, so their installs live in a
// machine-level cache (like the esbuild cache; the OS reclaims it on reboot) and warm
// queries skip npm entirely. Ranges, dist-tags, and versionless refs re-resolve at
// most every 15 minutes: a tag file remembers what the floating spec resolved to,
// and the resolving install itself is promoted into the machine cache.
export const PINNED: RegExp = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const TAG_TTL_MS = 15 * 60_000;
// jsr's npm-compat registry serves packages as @jsr/scope__name, and their tarballs
// self-reference that name in package.json and deep imports — so refs install under
// it verbatim; only labels and selectors keep the friendly jsr:@scope/name spelling.
const installName = (ref: ExternalRef): string =>
  ref.jsr ? `@jsr/${ref.bare.slice(1).replace('/', '__')}` : ref.bare;
const installedAt = (base: string, ref: ExternalRef): string =>
  join(base, 'node_modules', installName(ref), 'package.json');
// Deep import paths must use the real install name: friendly labels (jsr:@scope/name)
// never exist under node_modules, so specs by real name keep self-referencing
// imports resolvable. Specs already under the package's own name stay untouched.
export const realSpec = (ref: ExternalRef, spec: string, pkgName: string): string =>
  spec.startsWith(pkgName) ? spec : `${installName(ref)}/${spec.replace(/^\.\//, '')}`;
// The machine-wide ref cache root: one label-keyed dir per pinned install,
// shared by npm/jsr refs here and every registry ecosystem (registries.ts),
// filed one subdirectory per registry — bismar-refs/gem/, bismar-refs/crate/…
// — with bare npm labels (`qr@0.6.0`) under npm/.
export const refsCacheDir = (label: string): string => {
  const colon = label.indexOf(':');
  const prefix = colon > 0 ? label.slice(0, colon) : 'npm';
  const rest = colon > 0 ? label.slice(colon + 1) : label;
  return join(tmpdir(), 'bismar-refs', prefix, slug(rest));
};
// For originally-pinned refs this reproduces ref.label, so both spellings of one
// version (`qr@0.6.0` and a fresh-tagged `qr`) share a single cache dir.
const pinnedDirOf = (ref: ExternalRef, version: string): string =>
  refsCacheDir(`${ref.jsr ? 'jsr:' : ''}${ref.bare}@${version}`);
// Tag files are keyed by display label (`npm:qr`, `crate:serde`), so every
// ecosystem's floating "latest" shares one TTL cache without colliding.
const tagFile = (label: string): string =>
  join(tmpdir(), 'bismar-refs', '.tags', `${slug(label)}.json`);
export const readVersionTag = (label: string): string | undefined => {
  try {
    const tag = readJson<{ at: number; version: string }>(tagFile(label));
    if (
      typeof tag.version === 'string' &&
      typeof tag.at === 'number' &&
      Date.now() - tag.at < TAG_TTL_MS
    )
      return tag.version;
  } catch {
    // Missing or corrupt: resolve below.
  }
  return undefined;
};
export const writeVersionTag = (label: string, version: string): void =>
  void write(tagFile(label), `${JSON.stringify({ at: Date.now(), version })}\n`);
// Pinned archives are immutable, so their downloaded byte size persists beside
// the tag cache (never inside the extract dir, whose sole-dir descent and file
// listings must stay pristine). Extracts predating the meta file simply omit
// the stat.
const metaFile = (label: string): string =>
  join(tmpdir(), 'bismar-refs', '.meta', `${slug(label)}.json`);
export const readArchiveBytes = (label: string): number | undefined => {
  try {
    const bytes = readJson<{ archiveBytes?: unknown }>(metaFile(label)).archiveBytes;
    return typeof bytes === 'number' && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};
export const writeArchiveBytes = (label: string, bytes: number): void =>
  void write(metaFile(label), `${JSON.stringify({ archiveBytes: bytes })}\n`);
const installRef = (outDir: string, ref: ExternalRef): string => {
  const version = PINNED.test(ref.version)
    ? ref.version
    : (readVersionTag(ref.label) ?? ref.version);
  const pinned = PINNED.test(version);
  const dir = pinned ? pinnedDirOf(ref, version) : join(outDir, '.refs', slug(ref.label));
  if (pinned && existsSync(installedAt(dir, ref))) return dir;
  // Immediate, not delayed: the synchronous npm install blocks the event loop,
  // so a timer armed now could only ever fire after the wait is already over.
  progressShow(`installing ${ref.label}`);
  if (ref.jsr) writeJsrNpmrc(dir);
  writePkg(
    join(dir, 'package.json'),
    `${JSON.stringify(
      { dependencies: { [installName(ref)]: version || 'latest' }, private: true },
      null,
      2
    )}\n`
  );
  // The two everyday registry failures get one-liners; anything else keeps npm's story.
  const explain = (error: Error): never => {
    const msg = error.message;
    const site = ref.jsr ? 'jsr.io' : 'npmjs.com';
    if (msg.includes('code ETARGET'))
      err(`no such version: ${bad(ref.label)}; check the version on ${site}`);
    if (msg.includes('code E404'))
      err(`package not found: ${bad(ref.bare)}; check the name on ${site}`);
    return err(`installing ${ref.jsr ? 'jsr' : 'npm'} ref ${ref.label} failed: ${msg}`);
  };
  try {
    npmInstall(dir);
  } catch (error) {
    // A concurrent prime may have won the race; only fail when the ref is truly absent.
    if (pinned && existsSync(installedAt(dir, ref))) return dir;
    const msg = (error as Error).message;
    // A "missing" version or package may just be npm's offline-first cache
    // holding a packument older than the release; ask the registry once for
    // real before declaring it absent.
    if (!msg.includes('code ETARGET') && !msg.includes('code E404')) explain(error as Error);
    try {
      npmInstall(dir, true);
    } catch (again) {
      explain(again as Error);
    }
  }
  if (!pinned) {
    // The floating spec just resolved; remember the answer and promote the fresh
    // install into the machine cache so the pinned path is warm for 15 minutes.
    const got = readPkg(installedAt(dir, ref)).version;
    if (PINNED.test(got)) {
      writeVersionTag(ref.label, got);
      const target = pinnedDirOf(ref, got);
      if (!existsSync(target) && promoteTemp(dir, target)) return target;
    }
  }
  return dir;
};
// Registry access is explicit: only the `npm:`/`jsr:` prefixes reach the
// registry (explicitRef); every bare name — scoped or not — stays local.
const NPM_BARE = /^[a-z0-9][\w.-]*$/i;
// Bare names never imply npm; when one could exist on the registry, errors
// point at the prefixed spelling ('' when it could not).
export const npmHintOf = (raw: string): string => {
  // A scoped name needs its scope and a name segment to exist on the registry.
  if (raw.startsWith('@')) return raw.includes('/') ? `npm:${raw}` : '';
  const seg = raw.split('/')[0];
  const at = seg.lastIndexOf('@');
  return NPM_BARE.test(at > 0 ? seg.slice(0, at) : seg) ? `npm:${raw}` : '';
};
// The standard hint tail for those errors — one spelling across every caller.
export const npmHintUse = (raw: string): string => {
  const hint = npmHintOf(raw);
  return hint ? `use ${hint} for the registry package` : '';
};
// A bare selector in a package-less directory can only be a mistake: there is
// no local surface, and bare names never imply npm — say where to go.
export const noPkgErr = (raw: string, baseDir: string): never => {
  const use = npmHintUse(raw);
  return err(
    `package not found: ${bad(raw)}; no package.json in ${baseDir}${use ? ` — ${use}` : ''}`
  );
};
export const explicitRef = (raw: string): boolean =>
  raw.startsWith('npm:') || raw.startsWith('jsr:');
export const asRef = (raw: string): string => (explicitRef(raw) ? raw : `npm:${raw}`);
// Pinned ref installs are immutable, so both their export enumeration and their
// measured sizes cache alongside them (`bismar.db.json`): a warm `--list` skips
// enumeration, and a warm `--size` skips esbuild entirely. Sizes are keyed by the
// esbuild version that produced them; a different esbuild discards them. Unversioned
// or invalid dbs are recomputed and rewritten, never trusted.
const REF_DB = 'bismar.db.json';
export type RefDbMod = { exports: string[]; file: string; module: string };
// rows: unbranded `module/export` id -> [loc, minified bytes, gzipped bytes].
export type RefDbSizes = { esbuild: string; rows: Record<string, [number, number, number]> };
export type RefDb = { modules?: RefDbMod[]; sizes?: RefDbSizes; v?: number };
// Uncached on purpose: files are tiny, and rereading keeps long interactive
// sessions honest about what other processes wrote. Hot loops read once per dir.
export const refDb = (refDir: string): RefDb => {
  try {
    const raw = JSON.parse(readText(join(refDir, REF_DB))) as RefDb;
    if (raw.v !== 1) return {};
    // Older dbs predate the `file` field; recompute them instead of trusting the shape.
    const modules =
      Array.isArray(raw.modules) && raw.modules.every((mod) => mod && typeof mod.file === 'string')
        ? raw.modules
        : undefined;
    const sizes =
      raw.sizes &&
      typeof raw.sizes === 'object' &&
      typeof raw.sizes.esbuild === 'string' &&
      !!raw.sizes.rows &&
      typeof raw.sizes.rows === 'object'
        ? raw.sizes
        : undefined;
    return { modules, sizes };
  } catch {
    // Missing or corrupt: recompute on demand.
    return {};
  }
};
// Read-modify-write keeps the other half (modules vs sizes) intact; concurrent
// processes may lose each other's last write, which only costs a re-measure.
export const saveRefDb = (refDir: string, patch: Partial<RefDb>): void =>
  void write(join(refDir, REF_DB), `${JSON.stringify({ ...refDb(refDir), ...patch, v: 1 })}\n`);
// Display label for a ref: versionless refs (`npm:qr`) adopt the installed version
// (`qr@0.6.0`), so output is pinned and copy-pasteable; jsr refs keep their prefix.
const refLabel = (ref: ExternalRef, pkg: Pkg): string =>
  ref.version || !pkg.version ? ref.label : `${ref.jsr ? 'jsr:' : ''}${ref.bare}@${pkg.version}`;
// Install a ref and locate its package: the shared setup for listing and measuring.
export const installedRef = (
  outDir: string,
  ref: ExternalRef
): { label: string; pkg: Pkg; pkgDir: string; pkgFile: string; refDir: string } => {
  const refDir = installRef(outDir, ref);
  const pkgFile = installedAt(refDir, ref);
  const pkg = readPkg(pkgFile);
  return { label: refLabel(ref, pkg), pkg, pkgDir: dirname(pkgFile), pkgFile, refDir };
};
// Selector-form id for a ref module: the pinned label (`qr@0.6.0`) rides along
// everywhere a ref surfaces — size rows, CSV, error ids, listings — so output stays
// copy-pasteable. Single-file packages drop the redundant /index segment; the
// package-wide row (module === pkg name, measurement only) collapses the same way.
export const soleIndexOf = (mods: { module: string }[]): boolean =>
  mods.length === 1 && mods[0].module === 'index';
// `leaf` is the displayed tail (module name by default, file basename for
// file-flavored ids); `module` alone decides whether the id collapses.
export const refRename =
  (
    label: string,
    soleIndex: boolean,
    pkgName: string = ''
  ): ((module: string, leaf?: string) => string) =>
  (module: string, leaf: string = module): string =>
    (!!pkgName && module === pkgName) || (soleIndex && module === 'index')
      ? label
      : `${label}/${leaf}`;
