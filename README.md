# bismar

> Bundle JS packages into single files and measure min+gzip size of every export

A bismar is the old Norse hand balance for weighing goods. This one has three features:

- `bismar <selector>` opens fs-style package navigator, friendly to keyboard
  shortcuts
- `bismar <selector> --bundle` packs the selection into a single-file IIFE
  bundle on stdout
- `bismar <selector> --size` prints min+gzip size stats of the same bundles:
  it weighs the bundle

Used by [noble cryptography](https://paulmillr.com/noble/) to ensure bundles stay small.

## Usage

> `npm install bismar` — or, without installing, `npx bismar npm:preact --size` from
> any directory

```
flags:
  -b, --bundle       emit the single-file IIFE bundle on stdout
  -s, --size         print size stats instead of a bundle
      --size-sorted  module bundles first, then exports, by gzip size
  -l, --list         print every public export as an import statement, no bundling
  -m, --minify       emit the minified bundle
  -c, --checksum     print the bundle's sha256 hex instead of its bytes
```

```sh
$ bismar @scure/base -b > scure-base.js            # whole package
$ bismar @scure/base --minify > sb.min.js          # minified
$ bismar @scure/base --checksum                    # sha256 sum

$ bismar @scure/base --list                        # {base58} from '@scure/base'
$ bismar npm:micro-key-producer@0.8.0 --size       # size stats
$ bismar jsr:@std/bytes --size-sorted
$ bismar -s @noble/hashes/sha2.js/sha256

# interactive package navigator (the default mode)
$ bismar @noble/curves
$ bismar crate:serde                               # browse a crates.io package's files
$ bismar gem:railties                              # same for rubygems…
$ bismar pypi:requests                             # …pypi…
$ bismar composer:monolog/monolog                  # …and packagist
$ bismar gh:paulmillr/qr                           # github repo at HEAD, or @branch/@tag/@sha
$ bismar go:golang.org/x/time                      # go modules via proxy.golang.org
$ bismar rust:serde                                # rust: ruby: python: php: github: golang:

# multiple arguments
$ bismar -b @scure/base @scure/bip39@2.x >both.js  # two packages in one
$ bismar -b @noble/hashes/{sha2.js,sha3.js} >sh.js # one pkg, its two files
$ bismar -s @noble/hashes/sha3.js npm:js-sha3      # compare

# local
$ bismar --size
$ bismar -b > full.js                              # whole package
$ bismar -b src/util.js > util.js                  # any JS file, even a private one
$ bismar -s src/util.js                            # …its size stats too
$ bismar -b ./index.js > index.bundle.js           # ./ forces the file over the module
```

Selector grammar, three visually distinct classes: `npm:x` / `jsr:@scope/x` /
`crate:x` / … reach a registry (bare `@scope/x` also reads as npm — nothing
local can spell it); `./x`, `../x`, and absolute paths mean the filesystem; any
other bare name means the local package's public surface. A bare path with a JS
extension that exists on disk — and names no public module — also resolves as a
file; the published surface always outranks the disk behind it, and `./` is the
escape hatch that flips it. File selectors take an optional trailing export
(`./src/util.js/twice`) and mix freely with modules and refs. Registry refs
need no local package.json.

Bundling (`-b`; also implied by `--minify`) writes a single-file
IIFE declaring a global variable to stdout; on a terminal it refuses to dump
bundle bytes and tells you to redirect or pass `--size`.

`--size` measures every public export fully in-memory: nothing is installed into
the project and `test/build` is never touched. Package refs install into an OS
temp dir; pinned versions cache machine-wide along with their measured sizes.
Non-interactive environments (pipes, CI logs, LLM agents) get CSV instead of a
table; force with `BISMAR_CSV=1`.

`bismar` (or `bismar npm:preact`, or `bismar ./src/util.js`) opens a
filesystem-style navigator — the default
mode — starting in the package's shipped files: browse directories (each shows
its file count and total size, the package footprint sits in the header),
preview any file with syntax highlighting, and press `r` to hop into the
package's github repository (when package.json names one) — repos carry what
npm tarballs strip. `m` switches to the modules view (`f` returns to files):
modules are directories, exports are files, every row measures itself in the
background, and `enter` on an export pages through its highlighted bundled
source. Arrows or `hjkl` move, `q` quits; the mouse works in listings too —
click to select, click again to open, wheel to scroll — while the source view
leaves it native so selecting and copying text keeps working. Nothing is
written to the filesystem.

## Security

`npm install --prefer-offline` is used to preferably fetch bundles from cache.

Cache entries are created in OS temp dir, which OS auto-cleans after reboot.
`@noble/hashes@2.2.0` is cached until reboot; `@noble/hashes` resolves to a version
for 15 mins.

Two deps are used: esbuild is pinned, and the syntax highlighter is vendored and
bundled with the package, so neither can update underneath a release.

## License

MIT License (c) 2026 Paul Miller [(https://paulmillr.com)](https://paulmillr.com)
