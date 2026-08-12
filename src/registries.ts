/**
Non-JS registry refs (`crate:serde`, `gem:rails`, `pypi:requests`,
`composer:monolog/monolog`, `gh:owner/repo`, `gitlab:group/project`,
`go:golang.org/x/text`):
navigator-only — fetched and extracted so the interactive files view can browse
a package's shipped sources. Nothing here bundles, measures, or executes
package code; extraction goes through fs-modify.ts. All ecosystems share one
flow: parse → resolve version (or pin a git ref) → download → extract → cache.
Also home to the namespace table (aliases, `canonSelector`) and the launcher's
registry search (`searchRegistry`), all through one rate-limited fetch. Download
urls read from registry metadata are confined to known-registry origins first
(`allowUrl`); hardcoded-base fetches (gem/crate/gh/gitlab/go) need no such check.
@module
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type FetchFn, ftch, retry } from 'micro-ftch';
import { cliProcess, envFlag, progressDone, progressShow } from './env.ts';
import {
  appendLog,
  extractArchive,
  extractTar,
  promoteTemp,
  rmTempDir,
  write,
} from './fs-modify.ts';
import { bad, err, explicitPath, fmtBytes, readJson, slug } from './public.ts';
import {
  PINNED,
  readArchiveBytes,
  readVersionTag,
  refsCacheDir,
  refsRoot,
  writeArchiveBytes,
  writeVersionTag,
} from './refs.ts';

// A mainstream browser user-agent: github requires one outright, and several
// registries put anonymous bot-looking agents in stricter rate-limit buckets —
// a stock Chromium string keeps unauthenticated requests in the browser lane.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
// Every registry request flows through one wrapped fetch: a concurrency cap and
// a requests-per-second budget stay polite to anonymous rate limits, and
// 408/429/5xx GETs retry with backoff, honoring Retry-After (403 — github's
// rate-limit answer — is not retried; it surfaces through each caller's miss).
// Built on first use so BISMAR_RPS can tune the budget; 0 drops the spacing
// entirely — local test stand-ins and trusted proxies, where politeness only
// buys latency. Unset or garbage keeps the default.
// Defense in depth atop allowUrl: micro-ftch's allowedHosts makes the wrapped
// fetch itself refuse any host outside the known-registry set (the README's
// host table), and re-checks the final post-redirect URL — a layer allowUrl
// cannot provide. Hosts derive from the configured bases, so an overridden
// BISMAR_* base admits its own host instead of the default's.
const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
};
const allowedHosts = (): string[] =>
  [
    hostOf(crates()),
    // crates.io download redirect target.
    'static.crates.io',
    hostOf(gems()),
    hostOf(pypi()),
    'files.pythonhosted.org',
    hostOf(composer()),
    hostOf(packagist()),
    hostOf(ghApi()),
    hostOf(ghCodeload()),
    hostOf(gitlabApi()),
    hostOf(goProxy()),
    hostOf(npmApi()),
    hostOf(jsrApi()),
    hostOf(jsrNpm()),
  ].filter(Boolean);
let lazyNet: FetchFn | undefined;
let lazyHosts = '';
const net = (): FetchFn => {
  // Rebuilt when the effective host set changes (env-overridden bases vary
  // per test); a stable environment builds exactly once.
  const hosts = allowedHosts();
  const key = hosts.join(',');
  if (!lazyNet || key !== lazyHosts) {
    lazyHosts = key;
    const tuned = Number(process.env.BISMAR_RPS ?? NaN);
    const rps = Number.isFinite(tuned) ? tuned : 8;
    lazyNet = retry(
      ftch(fetch, {
        allowedHosts: hosts,
        concurrencyLimit: 4,
        // micro-ftch's own request hook: BISMAR_LOG=file.txt appends one line
        // per request. The env is read per call, not baked in, so a long
        // session (or a test) can toggle it; unset costs one lookup.
        log: (url, opts) => {
          const file = process.env.BISMAR_LOG;
          if (file)
            appendLog(file, `${new Date().toISOString()} ${opts?.method ?? 'GET'} ${url}\n`);
        },
        ...(rps > 0 ? { rps } : {}),
        timeout: 30_000,
      })
    );
  }
  return lazyNet;
};
type NetResponse = Awaited<ReturnType<FetchFn>>;
// Env-overridable bases for offline tests and proxies, like BISMAR_JSR_REGISTRY.
const base = (envKey: string, fallback: string): string => process.env[envKey] || fallback;
// The origin (`https://registry.npmjs.org`, or `http://127.0.0.1:PORT` for a
// test stand-in) of a configured base: a bad override url contributes nothing,
// matching no target. URL normalizes the port and drops any path.
const originOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '';
  }
};
// Registry metadata carries download urls — packagist dist zips, pypi artifact
// urls, npm/jsr tarballs — that bismar fetches verbatim. Confine each to a
// known-registry origin so a hostile package can't point a fetch at an
// arbitrary host. Matching is on origin (scheme + host + port): the default
// allowlists hold only https origins, so production is https-only, while an
// http override base (tests, proxies) admits its own http origin and nothing
// else. Redirects (crates.io → static.crates.io) are fetch's own and stay
// registry-owned; only the metadata-supplied url is checked here.
const allowUrl = (url: string, origins: string[]): string => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return err(`refusing malformed download url: ${bad(url)}`);
  }
  // No userinfo, and the origin must be allowlisted ('' entries never match).
  if (u.username || u.password || !origins.includes(u.origin))
    err(`refusing download from unexpected host: ${bad(u.host || url)}`);
  return url;
};
const fetchOk = async (url: string, miss: () => never, accept?: string): Promise<NetResponse> => {
  const res = await net()(url, {
    headers: accept ? { accept, 'user-agent': UA } : { 'user-agent': UA },
  });
  // 410 is the go proxy's "no such module"; 403 doubles as github's rate limit.
  if (res.status === 403 || res.status === 404 || res.status === 410) miss();
  if (!res.ok) err(`fetching ${url} failed: HTTP ${res.status}`);
  return res;
};
const jsonOf = async <T>(url: string, miss: () => never): Promise<T> =>
  (await fetchOk(url, miss)).json() as Promise<T>;
// Archives at or past this size need explicit consent before downloading: a
// gh: ref can casually name a 200mb monorepo tarball. BISMAR_BIG=1 skips the
// question (scripts, CI).
export const BIG_ARCHIVE: number = 100 * 1024 * 1024;
// The TUI owns stdin in raw mode while it runs: a line prompt would fight its
// reader, so in-session fetches (the `r` repo hop) refuse oversized archives
// instead of asking.
let bigPolicy: 'ask' | 'refuse' = 'ask';
export const setBigArchivePolicy = (policy: 'ask' | 'refuse'): void => {
  bigPolicy = policy;
};
export const guardBigArchive = async (id: string, bytes: number): Promise<void> => {
  const proc = cliProcess();
  if (bytes < BIG_ARCHIVE || envFlag(proc?.env?.BISMAR_BIG)) return;
  const size = fmtBytes(bytes);
  const tty = !!proc?.stdin?.isTTY && !!proc?.stderr?.isTTY;
  if (!proc || bigPolicy === 'refuse' || !tty)
    return err(
      `refusing large download: ${bad(id)} is ~${size}; confirm on a terminal or set BISMAR_BIG=1`
    );
  // One cooked-mode line on stderr; anything but y/yes cancels.
  progressDone();
  proc.stderr.write(`${bad(id)} is ~${size} — download anyway? [y/N] `);
  const answer: string = await new Promise((res) => {
    const stdin = proc.stdin;
    const onData = (chunk: unknown): void => {
      stdin.off('data', onData);
      stdin.pause();
      res(String(chunk));
    };
    stdin.resume();
    stdin.on('data', onData);
  });
  if (!/^y(es)?$/i.test(answer.trim())) err(`download cancelled: ${bad(id)}`);
};
const bytesOf = async (url: string, miss: () => never, id: string = url): Promise<Uint8Array> => {
  const res = await fetchOk(url, miss);
  // Static registry files announce their size up front; codeload streams
  // without content-length, so the gh fetcher pre-checks via the repo api.
  const len = Number(res.headers?.get?.('content-length'));
  if (len) await guardBigArchive(id, len);
  return new Uint8Array(await res.arrayBuffer());
};
const textOf = async (url: string, miss: () => never, accept: string): Promise<string> =>
  (await fetchOk(url, miss, accept)).text();
const notFound = (reg: Registry, name: string): never =>
  err(`${reg.what} not found: ${bad(name)}; check the name on ${reg.site}`);
const noVersion = (reg: Registry, label: string): never =>
  err(`${reg.what} or version not found: ${bad(label)}; check ${reg.site}`);

type Fetched = { bytes: Uint8Array; ext: string };
type Registry = {
  // Turn typed versions into the registry's own spelling (go: 0.14.0 → v0.14.0).
  canon?: (version: string) => string;
  // Version spelling for error hints.
  example: string;
  // Download `name@version`, extract it into `dir`, and hand back the verbatim
  // archive bytes with their proper file extension.
  fetch: (name: string, version: string, label: string, dir: string) => Promise<Fetched>;
  name: RegExp;
  // Mutable-ref registries (github): canonicalize any ref — or none, meaning
  // HEAD — to an immutable commit id. Replaces `resolve`.
  pin?: (name: string, refspec: string) => Promise<string>;
  // Resolve the floating "latest" to a concrete version ('' when unresolvable).
  resolve?: (name: string) => Promise<string>;
  // Fixed name arity in `/`-segments; set, the segments past it are a `/path`
  // tail (a shipped file or directory). Unset — go: import paths, gitlab:
  // subgroups — names have variable arity, so a tail cannot be split off
  // unambiguously and the whole body stays the name.
  segs?: number;
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
// Allowed download origins per registry (allowUrl): the constant registry CDNs
// the metadata should point at, plus — only when the base is overridden — the
// stand-in/proxy origin, so offline tests and mirrors keep working.
// Packagist dists are github zipballs (api/codeload); other hosts are refused.
const composerOrigins = (): string[] => [
  'https://api.github.com',
  'https://codeload.github.com',
  ...(process.env.BISMAR_COMPOSER_API ? [originOf(composer())] : []),
];
// PyPI forbids external artifact hosting: everything lives on pythonhosted.
const pypiOrigins = (): string[] => [
  'https://files.pythonhosted.org',
  ...(process.env.BISMAR_PYPI_API ? [originOf(pypi())] : []),
];
// Search-only bases: the npm registry search endpoint and jsr's public API
// (installs go through npm's jsr compat registry instead, fs-modify.ts).
const npmApi = (): string => base('BISMAR_NPM_API', 'https://registry.npmjs.org');
const jsrApi = (): string => base('BISMAR_JSR_API', 'https://api.jsr.io');
const ghCodeload = (): string => base('BISMAR_GH_CODELOAD', 'https://codeload.github.com');
// GitLab's v4 api takes url-encoded `group/project` paths (nested subgroups
// included) and serves metadata and archives alike, so one base covers all.
const gitlabApi = (): string => base('BISMAR_GITLAB_API', 'https://gitlab.com/api/v4');
const gitlabProject = (name: string): string =>
  `${gitlabApi()}/projects/${encodeURIComponent(name)}`;
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
      const url = allowUrl(entry.dist.url, composerOrigins());
      const bytes = await bytesOf(url, () => noVersion(reg, label), label);
      extractArchive(bytes, dir);
      return { bytes, ext: '.zip' };
    },
    name: /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i,
    segs: 2,
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
      const bytes = await bytesOf(url, () => noVersion(REGISTRIES['crate:'], label), label);
      extractArchive(bytes, dir);
      return { bytes, ext: '.crate' };
    },
    name: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/,
    segs: 1,
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
      const bytes = await bytesOf(url, () => noVersion(REGISTRIES['gem:'], label), label);
      extractTar(bytes, shell);
      let data: Uint8Array;
      try {
        data = readFileSync(join(shell, 'data.tar.gz'));
      } catch {
        return err(`invalid gem archive for ${bad(label)}: missing data.tar.gz`);
      }
      extractTar(data, dir);
      rmTempDir(shell);
      return { bytes, ext: '.gem' };
    },
    name: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    segs: 1,
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
      // Codeload streams its tarballs chunked, without content-length; the
      // repo api's `size` (kilobytes of the repository) stands in, so a 200mb
      // monorepo asks before the download starts. The metadata is best-effort:
      // rate limits and offline stand-ins skip the check, not the fetch.
      let approx = 0;
      try {
        approx =
          (await jsonOf<{ size?: number }>(`${ghApi()}/repos/${name}`, () => err(''))).size ?? 0;
      } catch {
        // Unknown size: proceed; the guard still fires when headers say more.
      }
      if (approx) await guardBigArchive(label, approx * 1024);
      const url = `${ghCodeload()}/${name}/tar.gz/${version}`;
      const bytes = await bytesOf(url, () => noVersion(REGISTRIES['gh:'], label), label);
      extractArchive(bytes, dir);
      return { bytes, ext: '.tar.gz' };
    },
    name: /^[a-z\d][a-z\d-]*\/[\w.-]+$/i,
    segs: 2,
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
  // GitLab repos, same contract as gh:: any ref pins to a commit id first.
  // Names are group/project with nested subgroups allowed.
  'gitlab:': {
    example: 'main',
    fetch: async (name, version, label, dir) => {
      // Unlike gh:, no size pre-check: the project api hides repository size
      // from anonymous callers. The content-length guard in bytesOf still
      // fires when the archive endpoint announces one.
      const url = `${gitlabProject(name)}/repository/archive.tar.gz?sha=${version}`;
      const bytes = await bytesOf(url, () => noVersion(REGISTRIES['gitlab:'], label), label);
      extractArchive(bytes, dir);
      return { bytes, ext: '.tar.gz' };
    },
    name: /^[a-z\d][\w.-]*(?:\/[\w.-]+)+$/i,
    pin: async (name, refspec) => {
      const id = `gitlab:${name}${refspec ? `@${refspec}` : ''}`;
      // The commit list resolves branches, tags, and shas alike; without
      // ref_name it reads the default branch's tip (the HEAD case).
      const ref = refspec ? `ref_name=${encodeURIComponent(refspec)}&` : '';
      const url = `${gitlabProject(name)}/repository/commits?${ref}per_page=1`;
      const miss = (): never => err(`repository or ref not found: ${bad(id)}; check gitlab.com`);
      const list = await jsonOf<{ id?: string }[]>(url, miss);
      const sha = (Array.isArray(list) && list[0]?.id) || '';
      if (!sha) miss();
      return sha.trim().slice(0, 12);
    },
    site: 'gitlab.com',
    use: 'group/project@ref',
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
      const bytes = await bytesOf(url, () => noVersion(REGISTRIES['go:'], label), label);
      extractArchive(bytes, dir);
      return { bytes, ext: '.zip' };
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
      const url = allowUrl(pick.url, pypiOrigins());
      const bytes = await bytesOf(url, () => noVersion(reg, label), label);
      extractArchive(bytes, dir);
      // Sdists are tarballs (or zips); wheels keep their own extension.
      return {
        bytes,
        ext: url.endsWith('.whl') ? '.whl' : url.endsWith('.zip') ? '.zip' : '.tar.gz',
      };
    },
    name: /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/,
    segs: 1,
    resolve: async (name) => (await pypiMeta(name)).info?.version || '',
    site: 'pypi.org',
    use: 'name@version',
    version: /^\d[\w.!+]*$/,
    what: 'package',
  },
};

// Language-name and short aliases for the same registries: refs normalize to
// the canonical prefix, so labels, cache dirs, and selectors stay one spelling deep.
const ALIASES: Record<string, string> = {
  'cargo:': 'crate:',
  'github:': 'gh:',
  'golang:': 'go:',
  'php:': 'composer:',
  'py:': 'pypi:',
  'python:': 'pypi:',
  'rb:': 'gem:',
  'rs:': 'crate:',
  'ruby:': 'gem:',
  'rust:': 'crate:',
};
const PREFIXES: string[] = [...Object.keys(REGISTRIES), ...Object.keys(ALIASES)];
// JS refs parse in refs.ts, but the namespace table lives here: `js:` is the
// alias spelling for npm refs and must expand before parseNpmRef slices its
// fixed-width prefix.
const JS_NAMESPACES: Record<string, string> = { 'js:': 'npm:', 'jsr:': 'jsr:', 'npm:': 'npm:' };
// Every namespace, canonical spelling first with its aliases alongside — the
// listing an unknown-namespace error prints, one namespace per line.
const namespaceLines = (): string => {
  const aliasesOf = (canon: string): string[] =>
    [...Object.entries(JS_NAMESPACES), ...Object.entries(ALIASES)]
      .filter(([alias, target]) => target === canon && alias !== canon)
      .map(([alias]) => alias)
      .sort();
  return ['npm:', 'jsr:', ...Object.keys(REGISTRIES)]
    .map((canon) => {
      const aliases = aliasesOf(canon);
      return aliases.length ? `${canon} (or ${aliases.join(' ')})` : canon;
    })
    .join('\n');
};
// A `ns:` head always reads as a namespace — the filesystem class is spelled
// `./`, `../`, or absolute, and colons appear nowhere else in selectors — so an
// unknown one is a typo to correct with the full listing, never a module to
// look up. JS aliases expand here (`js:x` → `npm:x`); registry aliases keep the
// typed spelling, which parseRegistryRef normalizes and error hints echo.
export const canonSelector = (raw: string): string => {
  if (explicitPath(raw)) return raw;
  const colon = raw.indexOf(':');
  if (colon < 0 || raw.slice(0, colon).includes('/')) return raw;
  const ns = raw.slice(0, colon + 1);
  const js = JS_NAMESPACES[ns];
  if (js) return js + raw.slice(ns.length);
  if (ns in REGISTRIES || ns in ALIASES) return raw;
  return err(`unknown namespace: ${bad(ns)}; use one of:\n${namespaceLines()}`);
};

// Launcher search: one request per submitted query, top ten hits, all through
// the shared rate-limited fetch. Keyed by canonical prefix; pypi is absent —
// its search api was retired in 2021, so the launcher opens exact names there.
// deps/tgzBytes start unset and fill in via jsHitStats (JS registries only).
export type SearchHit = {
  deps?: number;
  desc: string;
  name: string;
  tgzBytes?: number;
  version: string;
};
const hitOf = (name: string, version: string, desc: string | null | undefined): SearchHit => ({
  // Descriptions render on one listing row; newlines would break the frame math.
  desc: (desc ?? '').replace(/\s+/g, ' ').trim(),
  name,
  version,
});
type NpmFound = {
  objects?: { package?: { name?: string; version?: string } }[];
};
type JsrFound = {
  items?: {
    dependencyCount?: number;
    description?: string;
    latestVersion?: string | null;
    name?: string;
    scope?: string;
  }[];
};
type CrateFound = {
  crates?: {
    description?: string | null;
    max_stable_version?: string | null;
    max_version?: string | null;
    name?: string;
    newest_version?: string | null;
  }[];
};
type GemFound = { info?: string; name?: string; version?: string }[];
type GhFound = {
  items?: { description?: string | null; full_name?: string; stargazers_count?: number }[];
};
type GitlabFound = {
  description?: string | null;
  path_with_namespace?: string;
  star_count?: number;
}[];
type Searcher = (q: string, miss: () => never) => Promise<SearchHit[]>;
const SEARCHERS: Record<string, Searcher> = {
  'crate:': async (q, miss) => {
    const meta = await jsonOf<CrateFound>(`${crates()}/api/v1/crates?q=${q}&per_page=10`, miss);
    return (meta.crates ?? []).flatMap((c) =>
      c.name
        ? [
            hitOf(
              c.name,
              c.max_stable_version || c.newest_version || c.max_version || '',
              c.description
            ),
          ]
        : []
    );
  },
  'gem:': async (q, miss) => {
    const meta = await jsonOf<GemFound>(`${gems()}/api/v1/search.json?query=${q}`, miss);
    return meta
      .slice(0, 10)
      .flatMap((g) => (g.name ? [hitOf(g.name, g.version ?? '', g.info)] : []));
  },
  'gh:': async (q, miss) => {
    const meta = await jsonOf<GhFound>(`${ghApi()}/search/repositories?q=${q}&per_page=10`, miss);
    return (meta.items ?? []).flatMap((r) =>
      r.full_name
        ? [
            hitOf(
              r.full_name,
              r.stargazers_count != null ? `${r.stargazers_count}★` : '',
              r.description
            ),
          ]
        : []
    );
  },
  'gitlab:': async (q, miss) => {
    // Anonymous project search has no relevance ordering (similarity needs
    // auth); last_activity_at keeps maintained projects ahead of squatters.
    const url = `${gitlabApi()}/projects?search=${q}&order_by=last_activity_at&per_page=10`;
    const meta = await jsonOf<GitlabFound>(url, miss);
    return (Array.isArray(meta) ? meta : []).flatMap((r) =>
      r.path_with_namespace
        ? [
            hitOf(
              r.path_with_namespace,
              r.star_count != null ? `${r.star_count}★` : '',
              r.description
            ),
          ]
        : []
    );
  },
  'jsr:': async (q, miss) => {
    const meta = await jsonOf<JsrFound>(`${jsrApi()}/packages?query=${q}&limit=10`, miss);
    // dependencyCount rides in on the search response itself: deps are free.
    return (meta.items ?? []).flatMap((p) =>
      p.scope && p.name
        ? [
            {
              ...hitOf(`@${p.scope}/${p.name}`, p.latestVersion ?? '', p.description),
              ...(p.dependencyCount != null ? { deps: p.dependencyCount } : {}),
            },
          ]
        : []
    );
  },
  'npm:': async (q, miss) => {
    const meta = await jsonOf<NpmFound>(`${npmApi()}/-/v1/search?text=${q}&size=10`, miss);
    // No description on purpose: npm listings stay name · version · garnish.
    return (meta.objects ?? []).flatMap((o) =>
      o.package?.name ? [hitOf(o.package.name, o.package.version ?? '', '')] : []
    );
  },
};
export const canSearch = (prefix: string): boolean => prefix in SEARCHERS;

// Profile refs: `prefix:@user` names a person, org, scope, or vendor rather
// than a package — gh:@visionmedia, npm:@noble. Only a bare `@user` head
// qualifies (no path, no version); `@scope/name` stays a package spelling.
export type ProfileRef = { prefix: string; user: string };
const PROFILE_USER = /^[\w.-]+$/;
// Registries whose package names always take several segments (owner/repo,
// vendor/name): there a bare single segment can only be a profile, so the `@`
// sigil is optional — `gh:veorq` reads as `gh:@veorq`. Single-segment-name
// registries (crate:, gem:, pypi:) and npm/jsr keep requiring the sigil, since
// a bare segment there is a package name.
const BARE_PROFILE = new Set(['composer:', 'gh:', 'gitlab:']);
export const parseProfileRef = (raw: string): ProfileRef | undefined => {
  const colon = raw.indexOf(':');
  if (colon <= 0) return undefined;
  const head = raw.slice(0, colon + 1);
  const prefix =
    head === 'npm:' || head === 'jsr:'
      ? head
      : PREFIXES.includes(head)
        ? (ALIASES[head] ?? head)
        : undefined;
  if (!prefix) return undefined;
  const sigil = raw[colon + 1] === '@';
  if (!sigil && !BARE_PROFILE.has(prefix)) return undefined;
  const user = raw.slice(colon + (sigil ? 2 : 1));
  return PROFILE_USER.test(user) ? { prefix, user } : undefined;
};
// Packagist's vendor listing lives on the www host, not the p2 metadata one.
const packagist = (): string => base('BISMAR_PACKAGIST_API', 'https://packagist.org');
type CrateUser = { user?: { id?: number } };
type GhRepo = { description?: string | null; full_name?: string; stargazers_count?: number };
const ghRepoHits = (repos: GhRepo[]): SearchHit[] =>
  repos.flatMap((r) =>
    r.full_name
      ? [
          hitOf(
            r.full_name,
            r.stargazers_count != null ? `${r.stargazers_count}★` : '',
            r.description
          ),
        ]
      : []
  );
const gitlabHits = (projects: GitlabFound): SearchHit[] =>
  (Array.isArray(projects) ? projects : []).flatMap((r) =>
    r.path_with_namespace
      ? [
          hitOf(
            r.path_with_namespace,
            r.star_count != null ? `${r.star_count}★` : '',
            r.description
          ),
        ]
      : []
  );
// One page each, newest activity first where the api can sort: a profile
// listing is a jumping-off point, not an inventory of a 900-repo org.
type Profiler = (user: string, miss: () => never) => Promise<SearchHit[]>;
const PROFILERS: Record<string, Profiler> = {
  'composer:': async (user, miss) => {
    const url = `${packagist()}/packages/list.json?vendor=${encodeURIComponent(user)}`;
    const meta = await jsonOf<{ packageNames?: string[] }>(url, miss);
    return (meta.packageNames ?? []).slice(0, 25).map((name) => hitOf(name, '', ''));
  },
  'crate:': async (user, miss) => {
    // Two hops: crates.io keys the crate listing by numeric user id.
    const who = await jsonOf<CrateUser>(
      `${crates()}/api/v1/users/${encodeURIComponent(user)}`,
      miss
    );
    if (!who.user?.id) miss();
    const url = `${crates()}/api/v1/crates?user_id=${who.user?.id}&per_page=25&sort=recent-updates`;
    const meta = await jsonOf<CrateFound>(url, miss);
    return (meta.crates ?? []).flatMap((c) =>
      c.name
        ? [
            hitOf(
              c.name,
              c.max_stable_version || c.newest_version || c.max_version || '',
              c.description
            ),
          ]
        : []
    );
  },
  'gem:': async (user, miss) => {
    const url = `${gems()}/api/v1/owners/${encodeURIComponent(user)}/gems.json`;
    const meta = await jsonOf<GemFound>(url, miss);
    return meta
      .slice(0, 25)
      .flatMap((g) => (g.name ? [hitOf(g.name, g.version ?? '', g.info)] : []));
  },
  'gh:': async (user, miss) => {
    // The repos api only sorts by dates/name; the search api sorts by stars in
    // the same single request (its anonymous quota is tighter — 10/min, and
    // 403 doubles as its rate-limit answer, hence the wider miss wording).
    const url = `${ghApi()}/search/repositories?q=${encodeURIComponent(`user:${user}`)}&sort=stars&per_page=25`;
    const meta = await jsonOf<GhFound>(url, miss);
    return ghRepoHits(meta.items ?? []);
  },
  'gitlab:': async (user, miss) => {
    // `@name` may be a user or a group; try the user listing, fall back to the
    // group one (which also answers for subgroup-less orgs).
    const tail = `projects?order_by=last_activity_at&per_page=25`;
    try {
      const meta = await jsonOf<GitlabFound>(
        `${gitlabApi()}/users/${encodeURIComponent(user)}/${tail}`,
        miss
      );
      if (Array.isArray(meta) && meta.length) return gitlabHits(meta);
    } catch {
      // Not a user (or an empty one): the group listing decides below.
    }
    return gitlabHits(
      await jsonOf<GitlabFound>(`${gitlabApi()}/groups/${encodeURIComponent(user)}/${tail}`, miss)
    );
  },
  'jsr:': async (user, miss) => {
    const meta = await jsonOf<JsrFound>(
      `${jsrApi()}/scopes/${encodeURIComponent(user)}/packages?limit=25`,
      miss
    );
    return (meta.items ?? []).flatMap((p) =>
      p.scope && p.name
        ? [
            {
              ...hitOf(`@${p.scope}/${p.name}`, p.latestVersion ?? '', p.description),
              ...(p.dependencyCount != null ? { deps: p.dependencyCount } : {}),
            },
          ]
        : []
    );
  },
  'npm:': async (user, miss) => {
    const q = async (text: string, size: number) =>
      (
        await jsonOf<NpmFound>(
          `${npmApi()}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`,
          miss
        )
      ).objects ?? [];
    // maintainer: is the one qualifier the registry search reliably answers
    // (scope: silently matches nothing). Scopes have no listing api at all, so
    // `@x` the scope falls back to a text search filtered to exact members —
    // relevance ranks real members high, and 250 rows is the api's page cap.
    let objects = await q(`maintainer:${user}`, 25);
    if (!objects.length)
      objects = (await q(`@${user}/`, 250))
        .filter((o) => o.package?.name?.startsWith(`@${user}/`))
        .slice(0, 25);
    return objects.flatMap((o) =>
      o.package?.name ? [hitOf(o.package.name, o.package.version ?? '', '')] : []
    );
  },
};
export const canProfile = (prefix: string): boolean => prefix in PROFILERS;
// Display spelling for labels and crumbs: the long registry name. Only gh: has
// a short canonical prefix; the long alias is equally valid to type back in,
// so prettified crumbs stay copy-pasteable selectors.
export const displayLabel = (label: string): string =>
  label.startsWith('gh:') ? `github:${label.slice(3)}` : label;
export const profileHits = async (prefix: string, user: string): Promise<SearchHit[]> => {
  const profile = PROFILERS[prefix];
  if (!profile)
    return err(`no profile listing behind ${bad(prefix)}; open an exact package instead`);
  const miss = (): never =>
    prefix === 'gh:'
      ? err(`profile not found: ${bad(`gh:@${user}`)} — or github's rate limit; retry in a minute`)
      : err(`profile not found: ${bad(`${prefix}@${user}`)}`);
  const hits = await profile(user, miss);
  if (!hits.length) err(`no packages under ${bad(`${prefix}@${user}`)}`);
  return hits;
};

export const searchRegistry = async (prefix: string, query: string): Promise<SearchHit[]> => {
  const search = SEARCHERS[prefix];
  if (!search) return err(`no search api behind ${bad(prefix)}; open an exact name instead`);
  const miss = (): never =>
    prefix === 'gh:'
      ? // Anonymous github search allows 10 queries a minute; 403 is its answer.
        err('github search is rate-limited for anonymous use; wait a minute and retry')
      : err(`search failed for ${bad(query)}; try again shortly`);
  return search(encodeURIComponent(query), miss);
};

// JS search hits garnish in the background: packed tarball bytes and direct
// dependency count, shown after the version. One version doc (npm) or
// abbreviated packument (jsr — which also fills a missing latest version) per
// hit finds deps and the tarball url. Failures answer undefined and leave the
// row bare: garnish, never an error.
const jsrNpm = (): string => base('BISMAR_JSR_REGISTRY', 'https://npm.jsr.io');
type DistDoc = { dependencies?: Record<string, unknown>; dist?: { tarball?: string } };
type JsrPackument = { 'dist-tags'?: { latest?: string }; versions?: Record<string, DistDoc> };
const jsonQuiet = async <T>(
  url: string,
  signal?: AbortSignal,
  accept?: string
): Promise<T | undefined> => {
  const res = await net()(url, {
    headers: accept ? { accept, 'user-agent': UA } : { 'user-agent': UA },
    signal,
  });
  return res.ok ? ((await res.json()) as T) : undefined;
};
// npm's CDN omits content-length on HEAD but honors ranges: a one-byte range
// GET carries the full size in content-range. jsr's CDN answers HEAD directly.
// The tarball url comes from the packument, so it goes through allowUrl too — a
// refused (or missing) url just yields no size garnish, never an error.
const tarballBytes = async (
  url: string | undefined,
  origins: string[],
  signal?: AbortSignal
): Promise<number> => {
  if (!url) return 0;
  try {
    allowUrl(url, origins);
  } catch {
    return 0;
  }
  const head = await net()(url, { headers: { 'user-agent': UA }, method: 'HEAD', signal });
  const direct = Number(head.headers.get('content-length'));
  if (head.ok && direct) return direct;
  const ranged = await net()(url, { headers: { range: 'bytes=0-0', 'user-agent': UA }, signal });
  const total = /\/(\d+)$/.exec(ranged.headers.get('content-range') ?? '');
  return ranged.status === 206 && total ? Number(total[1]) : 0;
};
export type HitStats = { deps?: number; tgzBytes?: number; version?: string };
// Garnish caches machine-wide beside the ref installs: deps and packed bytes
// are immutable per exact version, so repeat searches (and reopened listings)
// skip the metadata round-trips. One file per pkg@version, like the version
// tags — no read-modify-write races; --clear wipes it with the rest.
const statsFile = (label: string): string => join(refsRoot(), '.stats', `${slug(label)}.json`);
const readHitStats = (label: string): HitStats | undefined => {
  try {
    const got = readJson<HitStats>(statsFile(label));
    // Older or hand-mangled entries recompute instead of being trusted.
    if (typeof got?.deps !== 'number') return undefined;
    return {
      deps: got.deps,
      ...(typeof got.tgzBytes === 'number' ? { tgzBytes: got.tgzBytes } : {}),
    };
  } catch {
    return undefined;
  }
};
const writeHitStats = (label: string, stats: HitStats): HitStats => {
  const { deps, tgzBytes } = stats;
  write(statsFile(label), `${JSON.stringify({ deps, tgzBytes })}\n`);
  return stats;
};
export const jsHitStats = async (
  prefix: string,
  hit: SearchHit,
  signal?: AbortSignal
): Promise<HitStats | undefined> => {
  if (prefix !== 'npm:' && prefix !== 'jsr:') return undefined;
  const labelOf = (version: string): string => `${prefix}${hit.name}@${version}`;
  const cached = hit.version ? readHitStats(labelOf(hit.version)) : undefined;
  if (cached) return cached;
  if (prefix === 'npm:') {
    if (!hit.version) return undefined;
    const doc = await jsonQuiet<DistDoc>(`${npmApi()}/${hit.name}/${hit.version}`, signal);
    if (!doc) return undefined;
    const tgzBytes = await tarballBytes(doc.dist?.tarball, [originOf(npmApi())], signal);
    return writeHitStats(labelOf(hit.version), {
      deps: Object.keys(doc.dependencies ?? {}).length,
      ...(tgzBytes ? { tgzBytes } : {}),
    });
  }
  // jsr tarballs live on the npm-compat registry under @jsr/scope__name; the
  // packument also fills a latest version the search response left blank.
  const pack = await jsonQuiet<JsrPackument>(
    `${jsrNpm()}/@jsr/${hit.name.slice(1).replace('/', '__')}`,
    signal,
    'application/vnd.npm.install-v1+json'
  );
  const version = hit.version || pack?.['dist-tags']?.latest || '';
  if (!version) return undefined;
  // A version the search left blank may still be cached from a past query.
  const known = !hit.version ? readHitStats(labelOf(version)) : undefined;
  if (known) return { ...known, version };
  const doc = pack?.versions?.[version];
  if (!doc) return undefined;
  // The search response usually carried dependencyCount already; keep it.
  const deps = hit.deps ?? Object.keys(doc.dependencies ?? {}).length;
  const tgzBytes = await tarballBytes(doc.dist?.tarball, [originOf(jsrNpm())], signal);
  return {
    ...writeHitStats(labelOf(version), { deps, ...(tgzBytes ? { tgzBytes } : {}) }),
    version,
  };
};
// `path` is the `/`-tail past a fixed-arity name: '' when absent, and always
// '' for variable-arity registries (go:, gitlab:), which take no tails.
export type RegistryRef = { name: string; path: string; prefix: string; version: string };
export const isRegistrySelector = (raw: string): boolean =>
  PREFIXES.some((prefix) => raw.startsWith(prefix));
export const parseRegistryRef = (raw: string): RegistryRef => {
  const matched = PREFIXES.find((pre) => raw.startsWith(pre));
  if (!matched) return err(`not a registry ref: ${bad(raw)}`);
  const prefix = ALIASES[matched] ?? matched;
  const reg = REGISTRIES[prefix];
  let body = raw.slice(matched.length);
  // `gh:@user/repo` tolerates the profile sigil on a full ref: registry names
  // never start with `@`, so it is unambiguous (npm/jsr scopes are parsed by
  // parseNpmRef, never here). A bare `@user` stays a profile (parseProfileRef).
  if (body.startsWith('@') && body.includes('/')) body = body.slice(1);
  // Fixed-arity names split a `/path` tail off first, so the version `@` is
  // looked for on the name alone (`crate:serde@1.0.0/src/lib.rs`). Registries
  // whose refspecs may themselves contain slashes (gh branches: feature/x)
  // make `@…/…` ambiguous — there the version wins, and only unversioned refs
  // take a tail (`gh:owner/repo/README.md`).
  let path = '';
  if (reg.segs) {
    const parts = body.split('/');
    if (parts.length > reg.segs && (!reg.version.source.includes('/') || !body.includes('@'))) {
      body = parts.slice(0, reg.segs).join('/');
      path = parts.slice(reg.segs).join('/');
    }
  }
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
  return { name, path, prefix, version };
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
): Promise<{ archiveBytes?: number; label: string; pkgDir: string }> => {
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
  if (hasFiles(pinnedDir))
    return { archiveBytes: readArchiveBytes(label), label, pkgDir: rootOf(pinnedDir) };
  progressShow(`downloading ${label}`);
  const dir = join(outDir, '.refs', slug(label));
  const got = await reg.fetch(ref.name, version, label, dir);
  if (!hasFiles(dir)) err(`empty archive for ${bad(label)}; check ${reg.site}`);
  writeArchiveBytes(label, got.bytes.length);
  saveArchive(label, got);
  // Promote the fresh extract into the machine cache; on a lost race (or any
  // rename failure) the per-run copy serves this session just as well.
  if (promoteTemp(dir, pinnedDir))
    return { archiveBytes: got.bytes.length, label, pkgDir: rootOf(pinnedDir) };
  return { archiveBytes: got.bytes.length, label, pkgDir: rootOf(dir) };
};
// The verbatim archive keeps its registry extension beside the extract dir
// (`bismar-refs/crate/serde-1-0-219.crate`), the same way npm keeps tarballs
// in its own cache: `-b` serves it offline, byte-identical to what the
// registry shipped.
const saveArchive = (label: string, got: Fetched): string =>
  write(`${refsCacheDir(label)}${got.ext}`, got.bytes);
const findArchive = (label: string): string | undefined => {
  const dir = refsCacheDir(label);
  try {
    for (const ent of readdirSync(dirname(dir)))
      if (ent.startsWith(`${basename(dir)}.`)) return join(dirname(dir), ent);
  } catch {
    // No cache subdir for this registry yet.
  }
  return undefined;
};
// `-b <registry-ref>`: hand back the saved archive, fetching only when the
// extract cache predates archive-keeping (the throwaway re-extract stays in
// the per-run temp dir).
export const registryArchive = async (
  outDir: string,
  ref: RegistryRef
): Promise<{ file: string; label: string }> => {
  const got = await registryContext(outDir, ref);
  const cached = findArchive(got.label);
  if (cached) return { file: cached, label: got.label };
  const version = got.label.slice(got.label.lastIndexOf('@') + 1);
  progressShow(`downloading ${got.label}`);
  const dir = join(outDir, '.refs', `${slug(got.label)}-rearchive`);
  const fetched = await REGISTRIES[ref.prefix].fetch(ref.name, version, got.label, dir);
  writeArchiveBytes(got.label, fetched.bytes.length);
  return { file: saveArchive(got.label, fetched), label: got.label };
};
