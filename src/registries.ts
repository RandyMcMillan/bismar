/**
Non-JS registry refs (`crate:serde`, `gem:rails`, `pypi:requests`,
`composer:monolog/monolog`, `gh:owner/repo`, `go:golang.org/x/text`):
navigator-only — fetched and extracted so the interactive files view can browse
a package's shipped sources. Nothing here bundles, measures, or executes
package code; extraction goes through fs-modify.ts. All ecosystems share one
flow: parse → resolve version (or pin a git ref) → download → extract → cache.
@module
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { progressShow } from './env.ts';
import { extractArchive, extractTar, promoteTemp, rmTempDir } from './fs-modify.ts';
import { bad, err, slug } from './public.ts';
import { PINNED, readVersionTag, refsCacheDir, writeVersionTag } from './refs.ts';

// crates.io's API policy asks tools to identify themselves, github requires a
// user-agent outright; the header is harmless everywhere else.
const UA = 'bismar (https://github.com/paulmillr/jsbt)';
// Env-overridable bases for offline tests and proxies, like BISMAR_JSR_REGISTRY.
const base = (envKey: string, fallback: string): string => process.env[envKey] || fallback;
const fetchOk = async (url: string, miss: () => never, accept?: string): Promise<Response> => {
  const res = await fetch(url, {
    headers: accept ? { accept, 'user-agent': UA } : { 'user-agent': UA },
  });
  // 410 is the go proxy's "no such module"; 403 doubles as github's rate limit.
  if (res.status === 403 || res.status === 404 || res.status === 410) miss();
  if (!res.ok) err(`fetching ${url} failed: HTTP ${res.status}`);
  return res;
};
const jsonOf = async <T>(url: string, miss: () => never): Promise<T> =>
  (await fetchOk(url, miss)).json() as Promise<T>;
const bytesOf = async (url: string, miss: () => never): Promise<Uint8Array> =>
  new Uint8Array(await (await fetchOk(url, miss)).arrayBuffer());
const textOf = async (url: string, miss: () => never, accept: string): Promise<string> =>
  (await fetchOk(url, miss, accept)).text();
const notFound = (reg: Registry, name: string): never =>
  err(`${reg.what} not found: ${bad(name)}; check the name on ${reg.site}`);
const noVersion = (reg: Registry, label: string): never =>
  err(`${reg.what} or version not found: ${bad(label)}; check ${reg.site}`);

type Registry = {
  // Turn typed versions into the registry's own spelling (go: 0.14.0 → v0.14.0).
  canon?: (version: string) => string;
  // Version spelling for error hints.
  example: string;
  // Download `name@version` and extract it into `dir`.
  fetch: (name: string, version: string, label: string, dir: string) => Promise<void>;
  name: RegExp;
  // Mutable-ref registries (github): canonicalize any ref — or none, meaning
  // HEAD — to an immutable commit id. Replaces `resolve`.
  pin?: (name: string, refspec: string) => Promise<string>;
  // Resolve the floating "latest" to a concrete version ('' when unresolvable).
  resolve?: (name: string) => Promise<string>;
  site: string;
  // Ref shape for error hints, e.g. 'vendor/name@version'.
  use: string;
  version: RegExp;
  what: string;
};

const crates = (): string => base('BISMAR_CRATES_API', 'https://crates.io');
type CrateMeta = { crate?: { max_stable_version?: string | null; newest_version?: string | null } };
const gems = (): string => base('BISMAR_GEMS_API', 'https://rubygems.org');
type GemMeta = { version?: string };
const pypi = (): string => base('BISMAR_PYPI_API', 'https://pypi.org');
type PypiMeta = { info?: { version?: string }; urls?: { packagetype?: string; url?: string }[] };
// Memoized per run, like p2: the name-level meta serves resolve (latest version)
// and, when the versions line up, fetch (that release's artifact list).
const pypiMetaCache = new Map<string, Promise<PypiMeta>>();
const pypiMeta = (name: string): Promise<PypiMeta> => {
  let got = pypiMetaCache.get(name);
  if (!got) {
    const url = `${pypi()}/pypi/${name}/json`;
    got = jsonOf<PypiMeta>(url, () => notFound(REGISTRIES['pypi:'], name));
    pypiMetaCache.set(name, got);
  }
  return got;
};
const composer = (): string => base('BISMAR_COMPOSER_API', 'https://repo.packagist.org');
type P2Entry = { dist?: { url?: string }; version?: string };
type P2Meta = { packages?: Record<string, P2Entry[]> };
// Packagist p2 metadata is "minified": each entry lists only the fields that
// changed from the previous one; expansion is a progressive shallow merge.
const expandP2 = (list: P2Entry[]): P2Entry[] => {
  let prev: P2Entry = {};
  return list.map((entry) => (prev = { ...prev, ...entry }));
};
// Memoized per run: a versionless ref hits p2 from resolve (pick the latest)
// and again from fetch (find that version's dist) — one download serves both.
const p2Cache = new Map<string, Promise<P2Entry[]>>();
const p2 = (name: string): Promise<P2Entry[]> => {
  let got = p2Cache.get(name);
  if (!got) {
    const url = `${composer()}/p2/${name}.json`;
    got = jsonOf<P2Meta>(url, () => notFound(REGISTRIES['composer:'], name)).then((meta) =>
      expandP2(meta.packages?.[name] ?? [])
    );
    p2Cache.set(name, got);
  }
  return got;
};
const ghApi = (): string => base('BISMAR_GH_API', 'https://api.github.com');
const ghCodeload = (): string => base('BISMAR_GH_CODELOAD', 'https://codeload.github.com');
// Module paths escape uppercase as !lowercase in proxy URLs (github.com/!azure).
const goProxy = (): string => base('BISMAR_GO_PROXY', 'https://proxy.golang.org');
const goEsc = (path: string): string => path.replace(/[A-Z]/g, (ch) => `!${ch.toLowerCase()}`);

export const REGISTRIES: Record<string, Registry> = {
  // Packagist names are vendor/name; dists are zips (usually github zipballs).
  // Both 3.9.0 and v9.0.0 spellings exist on the registry, so version matches
  // ignore the leading v.
  'composer:': {
    example: '1.0.0',
    fetch: async (name, version, label, dir) => {
      const reg = REGISTRIES['composer:'];
      const bare = (v: string): string => v.replace(/^v/, '');
      const entry = (await p2(name)).find((e) => bare(e.version || '') === bare(version));
      if (!entry?.dist?.url) return noVersion(reg, label);
      extractArchive(await bytesOf(entry.dist.url, () => noVersion(reg, label)), dir);
    },
    name: /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i,
    resolve: async (name) => {
      // Newest first; prefer the newest stable, like crates' max_stable_version.
      const list = await p2(name);
      const stable = list.find((e) => !/[-.](alpha|beta|rc|dev)/i.test(e.version || ''));
      return (stable ?? list[0])?.version || '';
    },
    site: 'packagist.org',
    use: 'vendor/name@version',
    version: /^v?\d[\w.+-]*$/,
    what: 'package',
  },
  // crates.io names: ASCII alphanumerics plus -/_, max 64 chars; `.crate` files
  // are gzipped tars with a single `name-version/` top dir.
  'crate:': {
    example: '1.0.0',
    fetch: async (name, version, label, dir) => {
      const url = `${crates()}/api/v1/crates/${name}/${version}/download`;
      extractArchive(await bytesOf(url, () => noVersion(REGISTRIES['crate:'], label)), dir);
    },
    name: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/,
    resolve: async (name) => {
      const url = `${crates()}/api/v1/crates/${name}`;
      const meta = await jsonOf<CrateMeta>(url, () => notFound(REGISTRIES['crate:'], name));
      // Stable when one exists; pre-release-only crates fall back to the newest.
      return meta.crate?.max_stable_version || meta.crate?.newest_version || '';
    },
    site: 'crates.io',
    use: 'name@version',
    version: PINNED,
    what: 'crate',
  },
  // A `.gem` is a plain tar shell around `data.tar.gz` (the shipped files),
  // `metadata.gz`, and checksums; only the data layer is worth browsing.
  // Versions are dotted but not semver: 7.1.3.4, 7.0.0.rc1.
  'gem:': {
    example: '1.0.0',
    fetch: async (name, version, label, dir) => {
      const url = `${gems()}/downloads/${name}-${version}.gem`;
      const shell = join(dir, '.gem-shell');
      extractTar(await bytesOf(url, () => noVersion(REGISTRIES['gem:'], label)), shell);
      let data: Uint8Array;
      try {
        data = readFileSync(join(shell, 'data.tar.gz'));
      } catch {
        return err(`invalid gem archive for ${bad(label)}: missing data.tar.gz`);
      }
      extractTar(data, dir);
      rmTempDir(shell);
    },
    name: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    resolve: async (name) => {
      const url = `${gems()}/api/v1/gems/${name}.json`;
      const meta = await jsonOf<GemMeta>(url, () => notFound(REGISTRIES['gem:'], name));
      return meta.version || '';
    },
    site: 'rubygems.org',
    use: 'name@version',
    version: /^\d+(?:\.[a-zA-Z0-9]+)*$/,
    what: 'gem',
  },
  // Repos, not releases: any ref — branch, tag, sha, or none (HEAD) — pins to a
  // commit id first, so labels stay copy-pasteable and the cache never goes
  // stale for longer than the 15-minute tag. Tarballs come from codeload.
  'gh:': {
    example: 'main',
    fetch: async (name, version, label, dir) => {
      const url = `${ghCodeload()}/${name}/tar.gz/${version}`;
      extractArchive(await bytesOf(url, () => noVersion(REGISTRIES['gh:'], label)), dir);
    },
    name: /^[a-z\d][a-z\d-]*\/[\w.-]+$/i,
    pin: async (name, refspec) => {
      const id = `gh:${name}${refspec ? `@${refspec}` : ''}`;
      const url = `${ghApi()}/repos/${name}/commits/${refspec || 'HEAD'}`;
      const sha = await textOf(
        url,
        () =>
          err(
            `repository or ref not found: ${bad(id)}; check github.com (unauthenticated github api calls are also rate-limited)`
          ),
        'application/vnd.github.sha'
      );
      return sha.trim().slice(0, 12);
    },
    site: 'github.com',
    use: 'owner/repo@ref',
    version: /^[\w./-]+$/,
    what: 'repository',
  },
  // The go proxy speaks a tiny protocol: /@latest for resolution, /@v/<v>.zip
  // for content. Zips nest the full import path (module@version/...), which the
  // sole-directory descent in rootOf unwinds.
  'go:': {
    canon: (version) => (version.startsWith('v') ? version : `v${version}`),
    example: 'v1.0.0',
    fetch: async (name, version, label, dir) => {
      const url = `${goProxy()}/${goEsc(name)}/@v/${goEsc(version)}.zip`;
      extractArchive(await bytesOf(url, () => noVersion(REGISTRIES['go:'], label)), dir);
    },
    name: /^[a-z0-9][\w.-]*(?:\/[\w.~-]+)*$/i,
    resolve: async (name) => {
      const url = `${goProxy()}/${goEsc(name)}/@latest`;
      const meta = await jsonOf<{ Version?: string }>(url, () => notFound(REGISTRIES['go:'], name));
      return meta.Version || '';
    },
    site: 'pkg.go.dev',
    use: 'module/path@vX.Y.Z',
    version: /^v\d[\w.+-]*$/,
    what: 'module',
  },
  // PyPI serves per-version artifact lists; sdists carry the readable tree
  // (readme, setup files), wheels are the installable fallback when a release
  // has no sdist. Versions are PEP 440: 1.26.4, 2.0.0b1, 1.0.post1, 1!2.0.
  'pypi:': {
    example: '1.0.0',
    fetch: async (name, version, label, dir) => {
      const reg = REGISTRIES['pypi:'];
      // The name-level meta resolve just downloaded usually carries the latest
      // release's artifact list already; reuse it when it does (proxies may
      // strip `urls`) instead of re-fetching per-version metadata.
      const named = pypiMetaCache.get(name) ? await pypiMeta(name) : undefined;
      const meta =
        named?.info?.version === version && named.urls?.length
          ? named
          : await jsonOf<PypiMeta>(`${pypi()}/pypi/${name}/${version}/json`, () =>
              noVersion(reg, label)
            );
      const urls = meta.urls ?? [];
      const pick =
        urls.find((u) => u.packagetype === 'sdist') ??
        urls.find((u) => u.packagetype === 'bdist_wheel');
      if (!pick?.url)
        return err(`no sdist or wheel published for ${bad(label)}; check ${reg.site}`);
      extractArchive(await bytesOf(pick.url, () => noVersion(reg, label)), dir);
    },
    name: /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
    resolve: async (name) => (await pypiMeta(name)).info?.version || '',
    site: 'pypi.org',
    use: 'name@version',
    version: /^\d[\w.!+]*$/,
    what: 'package',
  },
};

// Language-name aliases for the same registries: refs normalize to the canonical
// prefix, so labels, cache dirs, and selectors stay one spelling deep.
const ALIASES: Record<string, string> = {
  'github:': 'gh:',
  'golang:': 'go:',
  'php:': 'composer:',
  'python:': 'pypi:',
  'ruby:': 'gem:',
  'rust:': 'crate:',
};
const PREFIXES: string[] = [...Object.keys(REGISTRIES), ...Object.keys(ALIASES)];
export type RegistryRef = { name: string; prefix: string; version: string };
export const isRegistrySelector = (raw: string): boolean =>
  PREFIXES.some((prefix) => raw.startsWith(prefix));
export const parseRegistryRef = (raw: string): RegistryRef => {
  const matched = PREFIXES.find((pre) => raw.startsWith(pre));
  if (!matched) return err(`not a registry ref: ${bad(raw)}`);
  const prefix = ALIASES[matched] ?? matched;
  const reg = REGISTRIES[prefix];
  const body = raw.slice(matched.length);
  const at = body.lastIndexOf('@');
  const name = at > 0 ? body.slice(0, at) : body;
  let version = at > 0 ? body.slice(at + 1) : '';
  // Name shape is per-registry: packagist and github take vendor/name, go takes
  // whole import paths; the rest refuse slashes outright. Hints echo the
  // spelling the user typed, alias or canonical.
  if (!reg.name.test(name)) err(`invalid ${reg.what} ref: ${bad(raw)}; use ${matched}${reg.use}`);
  // Only exact versions or "latest": ranges would need each ecosystem's resolver.
  if (version) {
    version = reg.canon?.(version) ?? version;
    if (!reg.version.test(version))
      err(
        `invalid ${reg.what} version: ${bad(raw)}; pin an exact version like ${matched}${name}@${reg.example}`
      );
  }
  return { name, prefix, version };
};

// Extracted root: descend sole-directory chains — crates and sdists wrap one
// `name-version/` top dir, go module zips nest the whole import path. Gems and
// wheels ship their files at the root and stay put.
const rootOf = (dir: string): string => {
  for (;;) {
    const ents = readdirSync(dir);
    if (ents.length !== 1 || !statSync(join(dir, ents[0])).isDirectory()) return dir;
    dir = join(dir, ents[0]);
  }
};
const hasFiles = (dir: string): boolean => existsSync(dir) && readdirSync(dir).length > 0;
const SHA = /^[0-9a-f]{7,40}$/;
// Fetch + extract a registry ref, reusing the pinned machine cache (`bismar-refs`,
// same as npm refs): exact versions are immutable on their registries, so a warm
// run touches neither the network nor an extractor. Versionless refs re-resolve
// "latest" at most every 15 minutes via the shared tag cache.
export const registryContext = async (
  outDir: string,
  ref: RegistryRef
): Promise<{ label: string; pkgDir: string }> => {
  const reg = REGISTRIES[ref.prefix];
  let version = ref.version;
  if (reg.pin) {
    // Branches and tags move: pin them to an immutable commit id, keyed per ref,
    // so the extract cache never serves a tree staler than the 15-minute tag.
    const key = `${ref.prefix}${ref.name}${version ? `@${version}` : ''}`;
    if (!SHA.test(version)) {
      const tagged = readVersionTag(key);
      if (tagged && SHA.test(tagged)) version = tagged;
      else {
        progressShow(`resolving ${key}`);
        version = await reg.pin(ref.name, ref.version);
        if (!SHA.test(version)) err(`cannot resolve ${bad(key)}; check ${reg.site}`);
        writeVersionTag(key, version);
      }
    }
  } else {
    if (!version) {
      const tagged = readVersionTag(`${ref.prefix}${ref.name}`);
      if (tagged && reg.version.test(tagged)) version = tagged;
    }
    if (!version) {
      progressShow(`resolving ${ref.prefix}${ref.name}`);
      version = (await reg.resolve?.(ref.name)) ?? '';
      if (!reg.version.test(version))
        err(
          `cannot resolve latest version of ${bad(ref.name)}; pin one: ${ref.prefix}${ref.name}@${reg.example}`
        );
      writeVersionTag(`${ref.prefix}${ref.name}`, version);
    }
  }
  const label = `${ref.prefix}${ref.name}@${version}`;
  const pinnedDir = refsCacheDir(label);
  if (hasFiles(pinnedDir)) return { label, pkgDir: rootOf(pinnedDir) };
  progressShow(`downloading ${label}`);
  const dir = join(outDir, '.refs', slug(label));
  await reg.fetch(ref.name, version, label, dir);
  if (!hasFiles(dir)) err(`empty archive for ${bad(label)}; check ${reg.site}`);
  // Promote the fresh extract into the machine cache; on a lost race (or any
  // rename failure) the per-run copy serves this session just as well.
  if (promoteTemp(dir, pinnedDir)) return { label, pkgDir: rootOf(pinnedDir) };
  return { label, pkgDir: rootOf(dir) };
};
