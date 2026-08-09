// Tests for the static facts read off an extract: the import surface (`--list`
// on non-JS registry refs) per ecosystem, the files fallback, the CLI guard
// that now lets registry refs through --list, and the manifest repo lookup
// behind the navigator's `r` jump.
import { deepStrictEqual, throws } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test as should } from 'node:test';

// Error offenders and listings paint by ambient TTY; pin machine mode for asserts.
process.env.NO_COLOR = '1';

const { ghRepoOf, sizesCsv, sizesHuman, surfaceOf } = await import('../src/surface.ts');
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
    '2 files, 0.01kb, 123kb archive'
  );
  deepStrictEqual(sizesCsv(join(base, 'sz')), ['Cargo.toml,9b', 'src/lib.rs,5b']);
});

should('every ecosystem manifest yields the github repo it advertises', () => {
  const at = (rel: string): string => join(base, rel);
  const NONE = { eco: '', repo: '' };
  // Cargo: the first github url in key = "value" order — docs.rs is not one.
  put(
    'r-crate/Cargo.toml',
    '[package]\nname = "mini"\ndocumentation = "https://docs.rs/mini"\nrepository = "https://github.com/rusty/mini.git"\n'
  );
  deepStrictEqual(ghRepoOf(at('r-crate'), 'crate:'), { eco: 'crate', repo: 'rusty/mini' });
  // Go modules need no field at all: the import path is the repository, and
  // the major-version suffix is not part of it.
  put('r-go/go.mod', 'module github.com/octo/mini/v2\n\ngo 1.21\n');
  deepStrictEqual(ghRepoOf(at('r-go'), 'go:', 'github.com/octo/mini'), {
    eco: 'go',
    repo: 'octo/mini',
  });
  // Without go.mod the ref name stands in, as it does for the import surface.
  put('r-nomod/mini.go', 'package mini\n');
  deepStrictEqual(ghRepoOf(at('r-nomod'), 'go:', 'github.com/octo/plain'), {
    eco: 'go',
    repo: 'octo/plain',
  });
  // Composer: the declared source beats a homepage pointing elsewhere.
  put(
    'r-php/composer.json',
    JSON.stringify({
      homepage: 'https://seldaek.github.io/monolog',
      support: { source: 'https://github.com/Seldaek/monolog' },
    })
  );
  deepStrictEqual(ghRepoOf(at('r-php'), 'composer:'), { eco: 'composer', repo: 'Seldaek/monolog' });
  // Pypi core metadata: RFC822 headers, label-and-url Project-URL included.
  put(
    'r-py/PKG-INFO',
    'Name: requests\nHome-page: https://requests.readthedocs.io\nProject-URL: Source, https://github.com/psf/requests\n'
  );
  deepStrictEqual(ghRepoOf(at('r-py'), 'pypi:'), { eco: 'pypi', repo: 'psf/requests' });
  // Wheels carry the same headers under dist-info…
  put(
    'r-wheel/flask-3.0.dist-info/METADATA',
    'Name: flask\nHome-page: https://github.com/pallets/flask\n'
  );
  deepStrictEqual(ghRepoOf(at('r-wheel'), 'pypi:'), { eco: 'pypi', repo: 'pallets/flask' });
  // …and sdists built without any metadata still declare urls in pyproject,
  // where a git-url dependency is an array item, not a key = "url" line.
  put(
    'r-pyproject/pyproject.toml',
    '[project]\ndependencies = ["x @ git+https://github.com/other/x"]\n\n[project.urls]\nRepository = "https://github.com/pallets/click"\n'
  );
  deepStrictEqual(ghRepoOf(at('r-pyproject'), 'pypi:'), { eco: 'pypi', repo: 'pallets/click' });
  // Gemspecs stay unparsed: the quoted github url is picked out of the text.
  put(
    'r-gem/mini.gemspec',
    "Gem::Specification.new do |spec|\n  spec.homepage = 'https://rubygems.org/gems/mini'\n  spec.metadata['source_code_uri'] = 'https://github.com/rubyist/mini'\nend\n"
  );
  deepStrictEqual(ghRepoOf(at('r-gem'), 'gem:'), { eco: 'gem', repo: 'rubyist/mini' });
  // A gh: extract is the repository already, and a manifest naming no github
  // repo offers no jump at all.
  put('r-gh/Cargo.toml', '[package]\nrepository = "https://github.com/octo/mini"\n');
  deepStrictEqual(ghRepoOf(at('r-gh'), 'gh:', 'octo/mini'), NONE);
  put('r-gitlab/Cargo.toml', '[package]\nrepository = "https://gitlab.com/octo/mini"\n');
  deepStrictEqual(ghRepoOf(at('r-gitlab'), 'crate:'), NONE);
  deepStrictEqual(ghRepoOf(at('r-missing'), 'crate:'), NONE);
  // Prefixless (a JS package, or a plain directory of unknown ecosystem):
  // package.json first — object urls and npm's bare shorthand both count —
  // then every other manifest, each naming its own ecosystem for the way back.
  put(
    'r-js/package.json',
    JSON.stringify({ repository: { url: 'git+https://github.com/u/r.git' } })
  );
  deepStrictEqual(ghRepoOf(at('r-js')), { eco: 'npm', repo: 'u/r' });
  put('r-short/package.json', JSON.stringify({ repository: 'paulmillr/bismar' }));
  deepStrictEqual(ghRepoOf(at('r-short')), { eco: 'npm', repo: 'paulmillr/bismar' });
  deepStrictEqual(ghRepoOf(at('r-crate')), { eco: 'crate', repo: 'rusty/mini' });
});

should('--list and --size let registry refs through; bundle modes stay guarded', () => {
  deepStrictEqual(parseArgs(['pypi:requests', '--list']).list, true);
  deepStrictEqual(parseArgs(['go:golang.org/x/time', '-l']).paths, ['go:golang.org/x/time']);
  deepStrictEqual(parseArgs(['gem:rails', '--size']).size, true);
  deepStrictEqual(parseArgs(['crate:serde', '-sl']).size, true);
  deepStrictEqual(parseArgs(['gh:octo/mini', '-b']).bundle, true);
  throws(() => parseArgs(['crate:serde', '-m']), /crate refs have no JS to minify/);
});
