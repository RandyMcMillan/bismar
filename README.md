# bismar

> Weigh, browse, and diff packages from any registry — and bundle JS ones into single-file IIFEs with size stats per export

A bismar is the old Viking hand balance for weighing goods. This one:

- `bismar <selector>` opens an fs-style package navigator — npm, jsr,
  crates.io, rubygems, pypi, packagist, github, gitlab, and the go proxy
- `bismar <selector> --bundle` packs the selection into a single-file IIFE
- `bismar <selector> --size` lists the files and bytes that ship
- `bismar <selector> -bs` prints per-export bundle measurements (lines +
  unminified size; `-bsm` for min+gzip)
- `bismar --diff <a> <b>` compares two packages recursively

Non-JS ecosystems are browse/diff/download-only: their code is never executed
or bundled.

Used by [noble cryptography](https://paulmillr.com/noble/) to ensure bundles stay small.

## Usage

> `npm install bismar` — or, without installing, `npx bismar js:preact -bs` from
> any directory

```
usage:
  bismar [<selector>] [--bundle] [--minify] [--size] [--list]
  bismar [-bms] [<selector>]
  bismar --diff <a> <b>

flags:
  <no flag>     open interactive navigator
  -b, --bundle  emit a single-file bundle (JS) / archive (non-JS)
  -m, --minify  (JS only) emit the minified bundle
  -s, --size    list shipped file size stats
      -bs       (JS) bundle sizes
      -bsm      (JS) bundle sizes, minified+gzipped
  -d, --diff    interactive comparison between 2 selectors
      -ds       non-interactive size stats for all files
      -dbs      (JS) diff of bundle sizes
      -dbsm     (JS) diff of bundle sizes, minified+gzipped
  -l, --list    list all public exports
      --clear   clean-up bismar cache
```

### Examples

```sh
bismar js:@noble/hashes           # vim-like pager
bismar rs:serde
bismar gem:sinatra/README.md
bismar gh:@paulmillr              # user repos
bismar gem:sinatra/lib/sinatra.rb > s.rb

bismar -l npm:micro-ftch

bismar -b js:qr > qr.js
bismar -b rs:serde > serde.cargo
bismar -bm js:qr > qr.min.js

bismar -s js:chokidar
bismar -bs npm:micro-ftch
bismar -bsm npm:micro-ftch

bismar -d js:qr@0.5 js:qr@0.6
bismar -ds npm:readdirp@{4,5}
bismar -dbs npm:readdirp@{4,5}
bismar -dbsm npm:readdirp@{4,5}

# hint: non-terminal (non-TTY) emits DIFFERENT, machine-friendly output
bismar -d npm:micro-ftch@{1.0,1.1} | head
bismar -bsm npm:react | sort -t, -k4 -rn
```

### Selectors & namespaces

```
selectors (package / ref / dir / archive):
  npm:qr, npm:qr@0.6, gem:sinatra, ../sinatra, ./qr.tar.bz2

namespaces ("short: long"; both versions work):
  js:   npm         py:   pypi
  jsr:  jsr         php:  packagist
  rs:   crate       gh:   github
  rb:   gem         go:   go proxy
  gitlab: gitlab
```

## Security

`npm install --prefer-offline` is used to preferably fetch bundles from cache.

Downloads at or past 100mb ask for confirmation first — a `gh:` ref can
casually name a 200mb monorepo tarball; off a terminal they are refused, and
`BISMAR_BIG=1` waves them through (scripts, CI).

Cache entries are created in OS temp dir, which OS auto-cleans after reboot;
`bismar --clear` removes them all immediately and reports the reclaimed bytes.
`@noble/hashes@2.2.0` is cached until reboot; `@noble/hashes` resolves to a version
for 15 mins.

Registry requests (downloads, version resolution, searches, profiles) share
one wrapped fetch — [micro-ftch](https://github.com/paulmillr/micro-ftch) with
a concurrency cap, a requests-per-second budget (`BISMAR_RPS` tunes it, `0`
disables), and retries that honor Retry-After — so anonymous rate limits stay
unprovoked; github's anonymous search quota (10/minute) surfaces as a plain
one-line hint. `BISMAR_LOG=file.txt` appends one line per request
(`timestamp method url`) for auditing.

All requests are read-only: GET, plus one HEAD (tarball size garnish, with a
one-byte range GET fallback). bismar never POSTs — and the npm subprocess it
spawns for installs runs with `--no-audit`, which removes npm's one routine
POST, leaving its traffic GET-only too.

The complete list of hosts that fetch can reach — enforced at the fetch layer
(micro-ftch `allowedHosts`): any other host is refused outright, and the check
re-runs on the final post-redirect URL, so a registry answer can't bounce a
request elsewhere. Each base is overridable by its `BISMAR_*` env var;
overriding admits that host instead:

| host                           | used for                                            |
| ------------------------------ | --------------------------------------------------- |
| registry.npmjs.org             | npm search, profiles, packed-size garnish           |
| npm.jsr.io                     | jsr metadata + tarballs (jsr's npm-compat registry) |
| api.jsr.io                     | jsr search, scope profiles                          |
| crates.io (→ static.crates.io) | crate metadata, downloads, search, profiles         |
| rubygems.org                   | gem metadata, downloads, search, owner profiles     |
| pypi.org                       | pypi metadata                                       |
| files.pythonhosted.org         | pypi artifact downloads                             |
| repo.packagist.org             | composer p2 metadata                                |
| packagist.org                  | composer vendor profiles                            |
| api.github.com                 | gh api, search, profiles; composer dist zipballs    |
| codeload.github.com            | gh archive downloads; composer dist zipballs        |
| gitlab.com                     | gitlab api, search, profiles, archives              |
| proxy.golang.org               | go module metadata + zips                           |

`npm:`/`jsr:` ref installs additionally run through the npm CLI, which talks
to its configured registry (registry.npmjs.org and npm.jsr.io by default,
honoring your npm config) — those requests are npm's own and bypass the
wrapped fetch and its log.

Download URLs taken from registry metadata (packagist dist zips, PyPI
artifacts, npm/jsr tarballs) are confined to a known-registry origin before
they are fetched, so a hostile package can't redirect a request at an arbitrary
host — packagist dists must be github zipballs, PyPI artifacts must live on
pythonhosted, and tarball garnish must come from the configured registry. The
default allowlists are https-only; an overridden `BISMAR_*` base (offline
tests, mirrors) admits its own origin.

Three deps are used: esbuild and micro-ftch are pinned, and the syntax
highlighter is vendored and bundled with the package, so none can update
underneath a release.

## License

MIT License (c) 2026 Paul Miller [(https://paulmillr.com)](https://paulmillr.com)
