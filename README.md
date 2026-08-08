# bismar

> Bundle JS packages into single files and measure min+gzip size of every export

A bismar is the old Norse hand balance for weighing goods. This one:

- `bismar <selector>` opens an fs-style package navigator — npm, jsr,
  crates.io, rubygems, pypi, packagist, github, and the go proxy
- `bismar <selector> --bundle` packs the selection into a single-file IIFE
- `bismar <selector> --size` prints min+gzip size stats: it weighs the bundle
- `bismar --diff <a> <b>` compares two packages recursively

Used by [noble cryptography](https://paulmillr.com/noble/) to ensure bundles stay small.

## Usage

> `npm install bismar` — or, without installing, `npx bismar npm:preact --size` from
> any directory

```
flags:
  -b, --bundle  emit a single-file IIFE bundle on stdout; non-JS refs emit
                the saved registry archive verbatim
  -m, --minify  emit the minified bundle (JS only)
  -s, --size    min+gzip stats per export; non-JS refs list shipped file sizes
  -l, --list    every public export as an import statement; non-JS refs list
                their import surface (crate:/gh: their files)
  -d, --diff    compare two packages recursively (-ds adds size deltas, -dl names only)
      --clear   remove every bismar cache (ref installs, extracts, archives)

short flags combine: bismar -bm == bismar -b -m
```

```sh
$ bismar                                           # navigator: browse cwd, or search a registry
$ bismar npm:@noble/curves                         # …or open a package directly
$ bismar gh:paulmillr/qr                           # any ecosystem: crate: gem: pypi: composer: go:

$ bismar npm:@scure/base -b > scure-base.js        # bundle (-m: minified)
$ bismar -b src/util.js > util.js                  # any JS file, even a private one
$ bismar -b crate:serde > serde.crate              # non-JS: the registry archive, verbatim

$ bismar npm:preact --size                         # min+gzip stats per export
$ bismar -s jsr:@std/bytes | sort -t, -k5 -rn      # heaviest by gzip, via shell
$ bismar crate:serde --size                        # non-JS: shipped file sizes + total

$ bismar npm:@scure/base --list                    # {base58} from '@scure/base'
$ bismar go:golang.org/x/time -l                   # import "golang.org/x/time/rate"

$ bismar -d npm:qr 0.5.0 0.6.0                     # diff: navigator on a tty, unified diff piped
$ bismar -ds crate:serde 1.0.218 1.0.219           # changed files with size deltas
```

Selectors: `npm:x` / `jsr:@scope/x` / `crate:x` / … reach a registry — the
prefix is always required; `./x`, `../x`, and absolute paths mean the
filesystem; any bare name, scoped or not, means the local package's public
surface. File
selectors take an optional trailing export (`./src/util.js/twice`) and mix
freely with modules and refs; several selectors bundle together.

Bundling (`-b`, or `--minify`) writes a single-file IIFE declaring a global
variable to stdout; on a terminal it refuses to dump bytes and prints the size
stats instead. A non-JS registry ref emits the archive the registry served,
byte-identical (cached beside the extract, like npm keeps tarballs in its own
cache), so the output is checksummable against the registry's digests.

`--size` measures every public export fully in-memory: nothing is installed
into the project. Pipes and CI get headerless CSV rows, each value unit-tagged
so it survives filtering — `dom,frontalCamera,121loc,2464b,1268b` (module,
export, lines, minified bytes, gzipped bytes; force with `BISMAR_CSV=1`).
`sort`/`awk` parse the digits right through the tags: `-k5` sorts by gzip
bytes. Non-JS registry refs have no bundles to weigh — they list shipped file
sizes instead, closed by a total like `33 files, 548.39kb, 81.71kb archive`
(the archive figure is the downloaded package size).

`--list` prints import statements. Non-JS refs derive their static surface
from files and manifests — go import paths, composer PSR-4 classes, pypi
top-level modules, gem require paths — never parsing or executing package
code; `crate:` and `gh:` list shipped files instead.

`--diff` compares shipped files recursively (any ecosystem, or local dirs;
`bismar -d pkg v1 v2` pins one package twice). A terminal gets a navigator —
changed files with size deltas, enter pages the line diff; piped, a unified
diff. `-ds` prints stat rows, `-dl` just the names.

The navigator starts in the package's shipped files: browse and preview with
syntax highlighting, `r` hops to the github repo the manifest names, `m`
switches JS packages to the modules view, where every row measures itself and
enter pages through its bundled source. Arrows/`hjkl`/mouse move, `q` quits;
nothing is ever written to the filesystem.

## Security

`npm install --prefer-offline` is used to preferably fetch bundles from cache.

Downloads at or past 100mb ask for confirmation first — a `gh:` ref can
casually name a 200mb monorepo tarball; off a terminal they are refused, and
`BISMAR_BIG=1` waves them through (scripts, CI).

Cache entries are created in OS temp dir, which OS auto-cleans after reboot;
`bismar --clear` removes them all immediately and reports the reclaimed bytes.
`@noble/hashes@2.2.0` is cached until reboot; `@noble/hashes` resolves to a version
for 15 mins.

Registry requests (downloads, version resolution, searches) share one wrapped
fetch — [micro-ftch](https://github.com/paulmillr/micro-ftch) with a
concurrency cap, a requests-per-second budget (`BISMAR_RPS` tunes it, `0`
disables), and retries that honor Retry-After — so anonymous rate limits stay
unprovoked; github's anonymous search quota (10/minute) surfaces as a plain
one-line hint.

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
