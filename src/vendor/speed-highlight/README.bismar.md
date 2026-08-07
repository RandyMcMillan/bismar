# Vendored copy

This is a source snapshot of
[`@speed-highlight/core`](https://github.com/speed-highlight/core) at commit
`4a00a9432bb30c84c32134b3d7fb22458c318d17` (upstream version `1.2.23`).

Bismar's copy adds Ruby (`rb`) and PHP (`php`) language definitions. Rust (`rs`)
and Go (`go`) are retained from upstream.

These are the unbuilt upstream sources, consumed by a plain relative import
(`./vendor/speed-highlight/terminal.js`) rather than a package name. There is no
`file:` dependency and nothing to install.

Nothing here is generated, and nothing here is checked in twice. The root `tsc`
compiles these sources along with bismar's own, emitting both the `.js` and the
`.d.ts` to `vendor/speed-highlight/` at the package root. That is also why the
root config sets `allowJs` and not `isolatedDeclarations` — TypeScript refuses
to combine the two (TS5053).

Because everything lives under `src/`, the one import specifier resolves the
same before and after compilation: `tsc` moves `src/` to the package root, so
`src/interactive.ts` -> `src/vendor/...` in development and `interactive.js` ->
`vendor/...` in the built package.

The declarations `tsc` infers from the JSDoc here are what type the import — in
particular `ShjLanguage`, which is what makes the `PreviewLang` union in
`src/interactive.ts` fail to compile if it names a language this copy does not
actually support.
