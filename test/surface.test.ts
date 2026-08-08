// Tests for the static import surface (`--list` on non-JS registry refs):
// per-ecosystem listers over fixture trees, the files fallback, and the CLI
// guard that now lets registry refs through --list.
import { deepStrictEqual, throws } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as should } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const { sizesCsv, sizesHuman, surfaceOf } = await import('../src/surface.ts');
const { parseArgs } = await import('../src/bismar.ts');

const base = mkdtempSync(join(tmpdir(), 'bismar-surfacetest-'));
after(() => rmSync(base, { force: true, recursive: true }));
const put = (rel: string, data: string): string => {
  const file = join(base, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, data);
  return file;
};

should('go surface maps package dirs to import paths under the go.mod module', () => {
  put('go/go.mod', 'module golang.org/x/time\n\ngo 1.21\n');
  put('go/rate/rate.go', '// Package rate limits.\npackage rate\n');
  put('go/rate/rate_test.go', 'package rate\n');
  put('go/rate/testdata/x.go', 'package rate\n');
  put('go/internal/clock/clock.go', 'package clock\n');
  put('go/cmd/timer/main.go', 'package main\n');
  put('go/_tools/gen.go', 'package gen\n');
  put('go/LICENSE', 'MIT\n');
  deepStrictEqual(surfaceOf('go:', 'golang.org/x/time', join(base, 'go'), false), [
    'import "golang.org/x/time/rate"',
  ]);
  // Without go.mod the ref name is the module path; a root package lists too.
  put('nomod/timex.go', 'package timex\n');
  deepStrictEqual(surfaceOf('go:', 'example.com/timex', join(base, 'nomod'), false), [
    'import "example.com/timex"',
  ]);
});

should('composer surface expands PSR-4 namespaces to one class per file', () => {
  put(
    'php/composer.json',
    JSON.stringify({ autoload: { 'psr-4': { 'Monolog\\': 'src/Monolog' } } })
  );
  put('php/src/Monolog/Logger.php', '<?php\n');
  put('php/src/Monolog/Handler/StreamHandler.php', '<?php\n');
  put('php/src/Monolog/not-a-class.php', '<?php\n');
  put('php/src/Monolog/Logger.php.bak', 'noise');
  deepStrictEqual(surfaceOf('composer:', 'monolog/monolog', join(base, 'php'), false), [
    'use Monolog\\Handler\\StreamHandler;',
    'use Monolog\\Logger;',
  ]);
});

should('pypi surface prefers top_level.txt and falls back to package layout', () => {
  put('py1/requests-2.32.0.dist-info/top_level.txt', 'requests\n');
  put('py1/requests/__init__.py', '');
  put('py1/requests/api.py', '');
  deepStrictEqual(surfaceOf('pypi:', 'requests', join(base, 'py1'), false), ['import requests']);
  // No metadata: dirs holding __init__.py — src/ wins when it exists, and
  // shipped tests/ trees never read as import surface.
  put('py2/src/flask/__init__.py', '');
  put('py2/tests/__init__.py', '');
  put('py2/setup.py', '');
  deepStrictEqual(surfaceOf('pypi:', 'flask', join(base, 'py2'), false), ['import flask']);
  // src-layout sdists keep their egg-info under src/ (requests does).
  put('py3/src/requests.egg-info/top_level.txt', 'requests\n');
  put('py3/src/requests/__init__.py', '');
  put('py3/tests/__init__.py', '');
  deepStrictEqual(surfaceOf('pypi:', 'requests', join(base, 'py3'), false), ['import requests']);
});

should('gem surface answers lib/ files as require paths', () => {
  put('gem/lib/rails.rb', '');
  put('gem/lib/rails/all.rb', '');
  put('gem/lib/rails/version.rb', '');
  put('gem/README.md', '');
  deepStrictEqual(surfaceOf('gem:', 'railties', join(base, 'gem'), false), [
    "require 'rails'",
    "require 'rails/all'",
    "require 'rails/version'",
  ]);
});

should('crate and gh fall back to the shipped file listing, as do empty surfaces', () => {
  put('crate/Cargo.toml', '[package]\nname = "serde"\n');
  put('crate/src/lib.rs', 'pub fn x() {}\n');
  deepStrictEqual(surfaceOf('crate:', 'serde', join(base, 'crate'), false), [
    'Cargo.toml',
    'src/lib.rs',
  ]);
  // A gem with no lib/ tells the same story with its files.
  put('gem2/ext/native.c', '');
  deepStrictEqual(surfaceOf('gem:', 'odd', join(base, 'gem2'), false), ['ext/native.c']);
});

should('registry sizes list every shipped file and close with a total', () => {
  put('sz/Cargo.toml', '12345678\n');
  put('sz/src/lib.rs', '1234\n');
  deepStrictEqual(sizesHuman(join(base, 'sz'), false), [
    'Cargo.toml  0.01kb',
    'src/lib.rs  0.00kb',
    '',
    '2 files, 0.01kb',
  ]);
  // A known download size joins the total; extracts predating the meta omit it.
  deepStrictEqual(
    sizesHuman(join(base, 'sz'), false, 125553).at(-1),
    '2 files, 0.01kb, 122.61kb archive'
  );
  deepStrictEqual(sizesCsv(join(base, 'sz')), ['Cargo.toml,9b', 'src/lib.rs,5b']);
});

should('--list and --size let registry refs through; bundle modes stay guarded', () => {
  deepStrictEqual(parseArgs(['pypi:requests', '--list']).list, true);
  deepStrictEqual(parseArgs(['go:golang.org/x/time', '-l']).paths, ['go:golang.org/x/time']);
  deepStrictEqual(parseArgs(['gem:rails', '--size']).size, true);
  deepStrictEqual(parseArgs(['crate:serde', '-sl']).size, true);
  deepStrictEqual(parseArgs(['gh:octo/mini', '-b']).bundle, true);
  throws(() => parseArgs(['crate:serde', '-m']), /crate refs have no JS to minify/);
});
